from fastapi import FastAPI, UploadFile, File, HTTPException
import numpy as np
import cv2

app = FastAPI()

_face_app = None

def get_face_app():
    global _face_app
    if _face_app is None:
        # ✅ import를 여기서(지연 로딩) 해서 "시작부터 메모리 폭발/다운"을 줄임
        from insightface.app import FaceAnalysis
        _face_app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
        _face_app.prepare(ctx_id=0, det_size=(640, 640))
    return _face_app

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/embed")
async def embed(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")

    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="invalid image")

    face_app = get_face_app()
    faces = face_app.get(img)

    if not faces:
        return {"faces": []}

    # 가장 큰 얼굴을 대표로
    best = max(faces, key=lambda f: (f.bbox[2]-f.bbox[0])*(f.bbox[3]-f.bbox[1]))

    emb = best.embedding
    emb = (emb / (np.linalg.norm(emb) + 1e-12)).astype(np.float32)

    return {
        "faces": [{
            "bbox": best.bbox.tolist(),
            "det_score": float(getattr(best, "det_score", 0.0)),
            "embedding": emb.tolist(),
        }]
    }
