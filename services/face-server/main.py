from fastapi import FastAPI, UploadFile, File, HTTPException
import numpy as np
import cv2
import os
from typing import Dict, Tuple, List, Any

app = FastAPI()

# -----------------------------
# Tunables (ENV로 조절 가능)
# -----------------------------
# 기본 탐지 det_size 시도 순서 (작은 얼굴일수록 큰 det_size가 유리)
DET_SIZES = [
    (640, 640),
    (960, 960),
    (1280, 1280),
]

# 탐지 임계치(높을수록 엄격). 실패하면 아래로 내려가며 재시도
DET_THRESH_SCHEDULE = [0.55, 0.45, 0.38, 0.32]

# 너무 큰 이미지면 속도를 위해 먼저 축소 (긴 변 기준)
MAX_LONG_EDGE_FOR_FIRST_PASS = int(os.getenv("MAX_LONG_EDGE_FOR_FIRST_PASS", "2200"))

# 실패 시 작은 얼굴 구출용 업스케일 배율 (너무 크면 CPU 부담)
UPSCALE_ON_FAIL = float(os.getenv("UPSCALE_ON_FAIL", "1.35"))

# 최종적으로도 너무 큰 이미지는 이 값 넘기지 않게 제한(메모리/속도)
ABS_MAX_LONG_EDGE = int(os.getenv("ABS_MAX_LONG_EDGE", "3200"))

# InsightFace 모델 (CPU)
MODEL_NAME = os.getenv("INSIGHTFACE_MODEL", "buffalo_l")

# providers 고정(CPU)
PROVIDERS = ["CPUExecutionProvider"]

# -----------------------------
# InsightFace FaceAnalysis 캐시
# det_size/threshold 조합별로 캐싱
# -----------------------------
_face_apps: Dict[Tuple[int, int, float], Any] = {}

def get_face_app(det_size: Tuple[int, int], det_thresh: float):
    """
    det_size, det_thresh 조합별로 FaceAnalysis 인스턴스를 캐싱.
    """
    global _face_apps
    key = (det_size[0], det_size[1], float(det_thresh))
    if key in _face_apps:
        return _face_apps[key]

    from insightface.app import FaceAnalysis

    fa = FaceAnalysis(name=MODEL_NAME, providers=PROVIDERS)
    fa.prepare(ctx_id=0, det_size=det_size)

    # FaceAnalysis는 내부 detector threshold를 이 속성으로 받는 경우가 많음
    # (버전에 따라 다를 수 있어, 실패해도 무시하도록 try)
    try:
        fa.det_thresh = float(det_thresh)
    except Exception:
        pass

    _face_apps[key] = fa
    return fa

# -----------------------------
# Utils
# -----------------------------
def imdecode_bytes(data: bytes):
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    return img

def resize_long_edge(img: np.ndarray, max_long_edge: int) -> np.ndarray:
    h, w = img.shape[:2]
    long_edge = max(h, w)
    if long_edge <= max_long_edge:
        return img
    scale = max_long_edge / float(long_edge)
    nh = max(1, int(round(h * scale)))
    nw = max(1, int(round(w * scale)))
    return cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)

def upscale(img: np.ndarray, factor: float) -> np.ndarray:
    if factor <= 1.0:
        return img
    h, w = img.shape[:2]
    nh = max(1, int(round(h * factor)))
    nw = max(1, int(round(w * factor)))
    # 업스케일은 INTER_CUBIC이 보통 유리
    return cv2.resize(img, (nw, nh), interpolation=cv2.INTER_CUBIC)

def face_area(face) -> float:
    x1, y1, x2, y2 = face.bbox
    return float(max(0.0, (x2 - x1)) * max(0.0, (y2 - y1)))

def face_center_distance_norm(face, img_w: int, img_h: int) -> float:
    """
    이미지 중앙에서 얼굴 중심까지의 거리(0~1 근사)
    셀카는 중앙 근처 얼굴이 대표일 확률이 높아서 가중치로 사용.
    """
    x1, y1, x2, y2 = face.bbox
    cx = float(x1 + x2) / 2.0
    cy = float(y1 + y2) / 2.0
    icx = img_w / 2.0
    icy = img_h / 2.0
    dx = (cx - icx) / float(max(1.0, img_w))
    dy = (cy - icy) / float(max(1.0, img_h))
    dist = (dx * dx + dy * dy) ** 0.5
    # dist는 대략 0~0.7 사이가 흔함. 0~1로 clamp
    return float(min(1.0, max(0.0, dist)))

def pick_best_face(faces: list, img_w: int, img_h: int):
    """
    대표 얼굴 선택:
    - det_score 높을수록 좋음
    - 면적(크기) 클수록 좋음 (단체사진에서도 본인 얼굴이 아주 작을 수 있으므로, 너무 면적만 보지 않음)
    - 중앙 가까울수록 가산 (셀카에서 매우 유리)
    점수 = det_score * 0.70 + sqrt(area_norm) * 0.25 + (1 - center_dist) * 0.05
    """
    if not faces:
        return None

    img_area = float(max(1, img_w * img_h))

    best = None
    best_score = -1e9
    for f in faces:
        ds = float(getattr(f, "det_score", 0.0))
        ar = face_area(f)
        area_norm = min(1.0, ar / img_area)  # 0~1
        area_term = (area_norm ** 0.5)       # 작은 얼굴도 완전 죽이지 않도록 sqrt
        center_term = 1.0 - face_center_distance_norm(f, img_w, img_h)

        score = ds * 0.70 + area_term * 0.25 + center_term * 0.05
        if score > best_score:
            best_score = score
            best = f

    return best

def normalize_embedding(vec: np.ndarray) -> np.ndarray:
    vec = vec.astype(np.float32)
    n = float(np.linalg.norm(vec) + 1e-12)
    return (vec / n).astype(np.float32)

def faces_to_payload(faces: list) -> list:
    out = []
    for f in faces:
        emb = getattr(f, "embedding", None)
        if emb is None:
            continue
        emb = normalize_embedding(np.asarray(emb))
        out.append({
            "bbox": [float(x) for x in f.bbox.tolist()],
            "det_score": float(getattr(f, "det_score", 0.0)),
            "embedding": emb.tolist(),
        })
    return out

# -----------------------------
# Detection pipeline (멀티 패스)
# -----------------------------
def detect_faces_multi_pass(img: np.ndarray) -> Dict[str, Any]:
    """
    여러 det_size / det_thresh로 재시도.
    실패하면 업스케일로 한 번 더 구출 시도.
    """
    tried = []

    # 0) 절대 크기 제한(메모리 폭발 방지)
    img0 = resize_long_edge(img, ABS_MAX_LONG_EDGE)

    # 1) 1차 패스: 너무 큰 이미지는 먼저 축소해서 빠르게
    img_first = resize_long_edge(img0, MAX_LONG_EDGE_FOR_FIRST_PASS)

    def run_pass(input_img: np.ndarray, phase: str):
        h, w = input_img.shape[:2]
        for det_size in DET_SIZES:
            for det_thresh in DET_THRESH_SCHEDULE:
                fa = get_face_app(det_size, det_thresh)
                faces = fa.get(input_img)
                tried.append({
                    "phase": phase,
                    "det_size": list(det_size),
                    "det_thresh": float(det_thresh),
                    "img_w": int(w),
                    "img_h": int(h),
                    "faces": int(len(faces) if faces else 0),
                })
                if faces and len(faces) > 0:
                    return input_img, faces
        return input_img, []

    # 1차
    used_img, faces = run_pass(img_first, "first")
    if faces:
        return {"img": used_img, "faces": faces, "tried": tried}

    # 2차: 원본(ABS_MAX 제한만 적용한 이미지)로 다시 시도
    used_img, faces = run_pass(img0, "full")
    if faces:
        return {"img": used_img, "faces": faces, "tried": tried}

    # 3차: 업스케일로 작은 얼굴 구출
    up = upscale(img0, UPSCALE_ON_FAIL)
    used_img, faces = run_pass(up, "upscale")
    return {"img": used_img, "faces": faces, "tried": tried}

# -----------------------------
# API
# -----------------------------
@app.get("/health")
def health():
    return {"ok": True}

@app.post("/embed")
async def embed(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")

    img = imdecode_bytes(data)
    if img is None:
        raise HTTPException(status_code=400, detail="invalid image")

    # 탐지
    result = detect_faces_multi_pass(img)
    faces = result["faces"]
    tried = result["tried"]
    used_img = result["img"]
    h, w = used_img.shape[:2]

    if not faces:
        # 클라이언트가 원인 파악할 수 있도록 tried를 내려줌
        return {
            "ok": True,
            "faces": [],
            "best_embedding": None,
            "message": "NO_FACE",
            "tried": tried,
            "img_w": int(w),
            "img_h": int(h),
        }

    # faces -> payload(embedding 포함)
    payload_faces = faces_to_payload(faces)

    if not payload_faces:
        return {
            "ok": True,
            "faces": [],
            "best_embedding": None,
            "message": "NO_EMBEDDING",
            "tried": tried,
            "img_w": int(w),
            "img_h": int(h),
        }

    # 대표 얼굴 선택
    best_face = pick_best_face(faces, w, h)
    best_embedding = None
    best_bbox = None
    best_det_score = None

    if best_face is not None and getattr(best_face, "embedding", None) is not None:
        be = normalize_embedding(np.asarray(best_face.embedding))
        best_embedding = be.tolist()
        best_bbox = [float(x) for x in best_face.bbox.tolist()]
        best_det_score = float(getattr(best_face, "det_score", 0.0))
    else:
        # fallback: payload_faces[0]
        best_embedding = payload_faces[0]["embedding"]
        best_bbox = payload_faces[0]["bbox"]
        best_det_score = payload_faces[0]["det_score"]

    return {
        "ok": True,
        "faces": payload_faces,               # (기존 호환) faces[0].embedding 사용 가능
        "best_embedding": best_embedding,     # (신규) 대표 임베딩을 명시적으로 제공
        "best_bbox": best_bbox,
        "best_det_score": best_det_score,
        "faces_count": int(len(payload_faces)),
        "tried": tried,                       # 어떤 설정으로 몇 번 시도했는지 디버깅 가능
        "img_w": int(w),
        "img_h": int(h),
    }
