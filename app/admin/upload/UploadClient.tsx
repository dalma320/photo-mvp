"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import {
  addDoc,
  collection,
  serverTimestamp,
  doc,
  getDoc,
  setDoc,
  getDocs,
} from "firebase/firestore";
import { storage, db } from "../../../lib/firebaseClient";
import { embedFace } from "../../../lib/faceServer";

type LogItem = { msg: string; kind?: "ok" | "err" | "info" };

const BUILD_TAG = "UPLOAD_V3_FOLDER_RESIZE_QUEUE_2026-01-31";

function normalizeId(s: string) {
  return (s || "").trim();
}

function safeFileName(name: string) {
  return name.replace(/[^\w.\-()]/g, "_");
}

function formatBytes(n: number) {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

/**
 * 브라우저에서 이미지 용량 줄이기
 * - 캔버스로 리사이즈(최대 변 길이)
 * - JPEG quality를 내려가며 targetBytes 이하로 맞추기
 *
 * 반환: Blob (jpeg)
 */
async function compressImageToTarget(
  file: File,
  opts: { targetBytes: number; maxSide: number; mime: "image/jpeg"; startQuality: number; minQuality: number }
): Promise<Blob> {
  // 이미 targetBytes 이하라면 그대로 Blob 리턴(원본 유지)
  if (file.size <= opts.targetBytes) return file;

  const imgUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = (e) => reject(e);
      el.src = imgUrl;
    });

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;

    const scale = Math.min(opts.maxSide / w, opts.maxSide / h, 1);
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas ctx 생성 실패");
    ctx.drawImage(img, 0, 0, tw, th);

    const toBlobQ = (q: number) =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("toBlob 실패"))),
          opts.mime,
          q
        );
      });

    // 1차 시도
    let q = opts.startQuality;
    let best = await toBlobQ(q);

    // 이미 충분히 작으면 끝
    if (best.size <= opts.targetBytes) return best;

    // quality를 낮추면서 반복
    // (너무 많은 반복 방지: 8번까지만)
    for (let step = 0; step < 8; step++) {
      q = Math.max(opts.minQuality, q - 0.08);
      const b = await toBlobQ(q);
      best = b;
      if (b.size <= opts.targetBytes) return b;
      if (q <= opts.minQuality) break;
    }

    // target을 못 맞췄더라도, 최선(best)을 리턴
    return best;
  } finally {
    URL.revokeObjectURL(imgUrl);
  }
}

/**
 * 간단한 동시성 제한 큐
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length) as any;
  let nextIndex = 0;

  const runners = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
    while (true) {
      const cur = nextIndex++;
      if (cur >= items.length) break;
      results[cur] = await worker(items[cur], cur);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * fetch/서버호출 타임아웃 래퍼
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: any;
  const timeout = new Promise<T>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timeout (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}

export default function UploadClient() {
  const router = useRouter();
  const sp = useSearchParams();

  // ✅ URL로 eventId 고정
  const lockedEventId = normalizeId(sp.get("eventId") ?? "");
  const isLocked = !!lockedEventId;

  // ✅ autocomplete용 이벤트 목록
  const [eventList, setEventList] = useState<string[]>([]);
  const [queryText, setQueryText] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [openList, setOpenList] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // ✅ 업로드 소스 (파일/폴더)
  const [files, setFiles] = useState<File[]>([]);
  const [pickedMode, setPickedMode] = useState<"files" | "folder">("files");

  // ✅ 업그레이드 옵션
  const [enableCompress, setEnableCompress] = useState(true);
  const [targetMb, setTargetMb] = useState(2); // 기본 2MB
  const [maxSide, setMaxSide] = useState(2200); // 긴변 최대 (너무 작게 하면 얼굴 인식 품질↓)
  const targetBytes = useMemo(() => Math.max(0.2, targetMb) * 1024 * 1024, [targetMb]);

  const [uploadConcurrency, setUploadConcurrency] = useState(4); // 업로드+임베딩 동시 처리 개수
  const [embedTimeoutMs, setEmbedTimeoutMs] = useState(60_000);

  // 진행/로그
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(0);
  const [okCount, setOkCount] = useState(0);
  const [errCount, setErrCount] = useState(0);
  const [logs, setLogs] = useState<LogItem[]>([]);

  const eventId = useMemo(() => {
    if (isLocked) return lockedEventId;
    return normalizeId(selectedId || queryText);
  }, [isLocked, lockedEventId, selectedId, queryText]);

  const canRun = useMemo(() => {
    return eventId.length > 0 && files.length > 0 && !uploading;
  }, [eventId, files, uploading]);

  const pushLog = (msg: string, kind: LogItem["kind"] = "info") => {
    setLogs((prev) => [{ msg, kind }, ...prev]);
  };

  // 이벤트 목록 로드
  useEffect(() => {
    const run = async () => {
      try {
        const snap = await getDocs(collection(db, "events"));
        const ids = snap.docs.map((d) => d.id).sort((a, b) => a.localeCompare(b));
        setEventList(ids);

        if (isLocked) return;

        if (!selectedId && !queryText && ids.length) {
          setSelectedId(ids[0]);
          setQueryText(ids[0]);
        }
      } catch (e) {
        console.error(e);
      }
    };
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocked]);

  // 바깥 클릭 닫기
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current) return;
      if (!boxRef.current.contains(e.target as Node)) setOpenList(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  const filtered = useMemo(() => {
    const q = normalizeId(queryText).toLowerCase();
    if (!q) return eventList.slice(0, 30);
    return eventList.filter((id) => id.toLowerCase().includes(q)).slice(0, 30);
  }, [eventList, queryText]);

  const pickEvent = (id: string) => {
    const v = normalizeId(id);
    setSelectedId(v);
    setQueryText(v);
    setOpenList(false);
  };

  const ensureEventDoc = async (id: string) => {
    const eid = normalizeId(id);
    if (!eid) return;

    const eventRef = doc(db, "events", eid);
    const snap = await getDoc(eventRef);

    if (!snap.exists()) {
      await setDoc(
        eventRef,
        {
          id: eid,
          title: eid,
          status: "live",
          year: new Date().getFullYear(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      pushLog(`행사 문서 생성(seed): events/${eid}`, "ok");
      setEventList((prev) =>
        Array.from(new Set([eid, ...prev])).sort((a, b) => a.localeCompare(b))
      );
    } else {
      await setDoc(eventRef, { updatedAt: serverTimestamp() }, { merge: true });
    }
  };

  /**
   * 파일 목록 정리 (중복 제거 + 이미지 필터 + 너무 큰 리스트도 UI가 버티게)
   */
  const normalizePickedFiles = (input: File[]) => {
    const onlyImages = input.filter((f) => f.type?.startsWith("image/"));
    // 같은 이름/크기/수정시간 기반으로 대충 중복 제거
    const seen = new Set<string>();
    const out: File[] = [];
    for (const f of onlyImages) {
      const key = `${f.name}|${f.size}|${(f as any).lastModified ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    // 너무 많으면 우선 상위 N개만(원하면 늘려)
    const MAX_PICK = 6000;
    return out.slice(0, MAX_PICK);
  };

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>, mode: "files" | "folder") => {
    const list = Array.from(e.target.files || []);
    setPickedMode(mode);
    setFiles(normalizePickedFiles(list));
  };

  const runUpload = async () => {
    const eid = normalizeId(eventId);
    if (!eid) return alert("eventId가 비어있어! 링크/입력을 확인해줘.");
    if (!files.length) return alert("사진을 선택해줘!");

    setUploading(true);
    setDone(0);
    setOkCount(0);
    setErrCount(0);
    setLogs([]);
    pushLog(`빌드: ${BUILD_TAG}`);
    pushLog(`시작: eventId=${eid}, files=${files.length}, mode=${pickedMode}`);
    pushLog(
      `옵션: compress=${enableCompress ? "ON" : "OFF"} target=${enableCompress ? `${targetMb}MB` : "-"} maxSide=${maxSide}px concurrency=${uploadConcurrency}`
    );

    try {
      await ensureEventDoc(eid);

      // 병렬 처리: 한 파일 단위로 (압축→업로드→임베딩→Firestore 저장)
      await runWithConcurrency(
        files,
        Math.max(1, Math.min(16, uploadConcurrency)),
        async (file, index) => {
          const label = `${index + 1}/${files.length}: ${file.name}`;
          try {
            pushLog(`처리 시작 (${label})`);

            // 1) (옵션) 압축
            let blobToUse: Blob = file;
            if (enableCompress && file.size > targetBytes) {
              pushLog(`압축 중... (${label}) ${formatBytes(file.size)} → <= ${formatBytes(targetBytes)}`);
              blobToUse = await compressImageToTarget(file, {
                targetBytes: Math.floor(targetBytes),
                maxSide: Math.max(800, Math.min(5000, maxSide)),
                mime: "image/jpeg",
                startQuality: 0.88,
                minQuality: 0.52,
              });
              pushLog(`압축 완료 ✅ (${label}) ${formatBytes(file.size)} → ${formatBytes(blobToUse.size)}`, "ok");
            }

            // 2) Storage 업로드
            pushLog(`업로드 중... (${label})`);
            const safeName = safeFileName(file.name);
            const finalPath = `events/${eid}/photos/${Date.now()}_${index + 1}_${safeName}`;

            const sref = ref(storage, finalPath);
            await uploadBytes(sref, blobToUse); // Blob 업로드 OK
            const downloadURL = await getDownloadURL(sref);
            pushLog(`업로드 완료 ✅ (${label})`, "ok");

            // 3) 임베딩 생성 (Cloud Run)
            pushLog(`임베딩 생성 중... (${label})`);
            // embedFace는 File/Blob/ArrayBuffer 등을 받는 걸로 만들었을 텐데,
            // 안전하게 Blob을 그대로 전달 (File이 아니어도 OK)
            const embedding = await withTimeout(embedFace(blobToUse as any), embedTimeoutMs, "embedFace");
            if (!Array.isArray(embedding) || embedding.length === 0) {
              throw new Error("No embedding array in response");
            }

            // 4) Firestore 저장
            await addDoc(collection(db, "events", eid, "photos"), {
              eventId: eid,
              fullPath: finalPath,
              downloadURL,
              fileName: file.name,
              bytesOriginal: file.size,
              bytesUploaded: blobToUse.size,
              embedding,
              embDim: embedding.length,
              createdAt: serverTimestamp(),
            });

            pushLog(`임베딩 저장 완료 ✅ (${label})`, "ok");
            setOkCount((v) => v + 1);
          } catch (err: any) {
            console.error(err);
            pushLog(`에러 ❌ (${label}): ${err?.message || String(err)}`, "err");
            setErrCount((v) => v + 1);
          } finally {
            setDone((prev) => prev + 1);
          }
        }
      );

      pushLog("전체 완료 🎉", "ok");
      router.push(`/admin/event?eventId=${encodeURIComponent(eid)}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: 24 }}>
      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 26, fontWeight: 950 }}>/admin/upload</div>
          <div style={{ fontSize: 12, opacity: 0.65 }}>{BUILD_TAG}</div>
        </div>

        <div style={{ border: "1px solid #1f1f1f", borderRadius: 18, background: "#070707", padding: 16 }}>
          {/* eventId */}
          {isLocked ? (
            <>
              <div style={{ fontSize: 12, opacity: 0.7 }}>고정된 eventId</div>
              <div
                style={{
                  marginTop: 8,
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid #222",
                  background: "#000",
                  fontWeight: 950,
                }}
              >
                {lockedEventId}
              </div>
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.6 }}>
                ✅ 이 링크는 행사 고정 업로드용이라 다른 행사로 업로드할 수 없어요.
              </div>
            </>
          ) : (
            <div ref={boxRef} style={{ position: "relative" }}>
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>eventId 검색/선택</div>
              <input
                value={queryText}
                onChange={(e) => {
                  setQueryText(e.target.value);
                  setOpenList(true);
                }}
                onFocus={() => setOpenList(true)}
                placeholder="타자로 검색 (예: AAS2026_2)"
                disabled={uploading}
                style={{
                  width: "100%",
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid #222",
                  background: "#000",
                  color: "#fff",
                  outline: "none",
                }}
              />
              {openList ? (
                <div
                  style={{
                    position: "absolute",
                    top: 56,
                    left: 0,
                    right: 0,
                    border: "1px solid rgba(255,255,255,0.14)",
                    background: "#070707",
                    borderRadius: 12,
                    overflow: "hidden",
                    maxHeight: 240,
                    overflowY: "auto",
                    zIndex: 50,
                  }}
                >
                  {filtered.length === 0 ? (
                    <div style={{ padding: 12, fontSize: 12, opacity: 0.75 }}>검색 결과 없음</div>
                  ) : (
                    filtered.map((id) => (
                      <div
                        key={id}
                        onClick={() => pickEvent(id)}
                        style={{
                          padding: 10,
                          cursor: "pointer",
                          borderBottom: "1px solid rgba(255,255,255,0.06)",
                        }}
                      >
                        {id}
                      </div>
                    ))
                  )}
                </div>
              ) : null}
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.65 }}>
                현재 선택: <b>{eventId || "-"}</b>
              </div>
            </div>
          )}

          {/* pickers */}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>사진 선택 (파일 여러 장 / 폴더 업로드)</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {/* 일반 파일 선택 */}
              <div style={{ border: "1px solid #222", borderRadius: 14, padding: 12, background: "#000" }}>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>파일 여러 장</div>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={uploading}
                  onChange={(e) => onPickFiles(e, "files")}
                  style={{ width: "100%" }}
                />
              </div>

              {/* 폴더 선택 (크롬/엣지 지원) */}
              <div style={{ border: "1px solid #222", borderRadius: 14, padding: 12, background: "#000" }}>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>폴더 업로드 (권장)</div>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={uploading}
                  // @ts-ignore
                  webkitdirectory="true"
                  // @ts-ignore
                  directory="true"
                  onChange={(e) => onPickFiles(e, "folder")}
                  style={{ width: "100%" }}
                />
                <div style={{ marginTop: 8, fontSize: 11, opacity: 0.55 }}>
                  * 폴더 업로드는 Chrome/Edge에서 가장 안정적이에요.
                </div>
              </div>
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
              {files.length ? (
                <>
                  선택됨: <b>{files.length}장</b> (모드: <b>{pickedMode}</b>) · 합계{" "}
                  <b>{formatBytes(files.reduce((a, f) => a + f.size, 0))}</b>
                </>
              ) : (
                "파일/폴더를 선택해줘"
              )}
            </div>
          </div>

          {/* options */}
          <div style={{ marginTop: 16, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 950, marginBottom: 10 }}>업로드 최적화 설정</div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ border: "1px solid rgba(255,255,255,0.10)", borderRadius: 14, padding: 12, background: "rgba(0,0,0,0.35)" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={enableCompress}
                    disabled={uploading}
                    onChange={(e) => setEnableCompress(e.target.checked)}
                  />
                  <div>
                    <div style={{ fontWeight: 900 }}>자동 용량 축소</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>큰 파일만 줄여서 업로드 속도↑ / 비용↓</div>
                  </div>
                </label>

                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, opacity: enableCompress ? 1 : 0.5 }}>
                  <div>
                    <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>목표 용량(MB)</div>
                    <input
                      type="number"
                      min={0.2}
                      step={0.1}
                      value={targetMb}
                      disabled={!enableCompress || uploading}
                      onChange={(e) => setTargetMb(Number(e.target.value))}
                      style={{ width: "100%", padding: 10, borderRadius: 12, border: "1px solid #222", background: "#000", color: "#fff" }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>긴변 최대(px)</div>
                    <input
                      type="number"
                      min={800}
                      step={100}
                      value={maxSide}
                      disabled={!enableCompress || uploading}
                      onChange={(e) => setMaxSide(Number(e.target.value))}
                      style={{ width: "100%", padding: 10, borderRadius: 12, border: "1px solid #222", background: "#000", color: "#fff" }}
                    />
                  </div>
                </div>

                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.65 }}>
                  추천: <b>2MB</b>, 긴변 <b>2000~2600px</b>
                </div>
              </div>

              <div style={{ border: "1px solid rgba(255,255,255,0.10)", borderRadius: 14, padding: 12, background: "rgba(0,0,0,0.35)" }}>
                <div style={{ fontWeight: 900, marginBottom: 8 }}>병렬 처리(속도)</div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>동시 처리 개수</div>
                    <input
                      type="number"
                      min={1}
                      max={16}
                      step={1}
                      value={uploadConcurrency}
                      disabled={uploading}
                      onChange={(e) => setUploadConcurrency(Number(e.target.value))}
                      style={{ width: "100%", padding: 10, borderRadius: 12, border: "1px solid #222", background: "#000", color: "#fff" }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>임베딩 타임아웃(ms)</div>
                    <input
                      type="number"
                      min={10_000}
                      step={5_000}
                      value={embedTimeoutMs}
                      disabled={uploading}
                      onChange={(e) => setEmbedTimeoutMs(Number(e.target.value))}
                      style={{ width: "100%", padding: 10, borderRadius: 12, border: "1px solid #222", background: "#000", color: "#fff" }}
                    />
                  </div>
                </div>

                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.65 }}>
                  추천: 동시 <b>4</b> (와이파이 좋으면 6~8)
                </div>
              </div>
            </div>
          </div>

          {/* action button */}
          <button
            onClick={runUpload}
            disabled={!canRun}
            style={{
              width: "100%",
              marginTop: 14,
              padding: 14,
              borderRadius: 999,
              border: "1px solid #1f1f1f",
              background: canRun ? "#ff5a2a" : "#222",
              color: canRun ? "#000" : "#aaa",
              fontWeight: 950,
              cursor: canRun ? "pointer" : "not-allowed",
            }}
          >
            {uploading ? "처리 중…" : "업로드 + 임베딩 저장 시작"}
          </button>

          {/* progress */}
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div>진행: <b>{done}</b> / <b>{files.length || 0}</b></div>
            <div>성공: <b style={{ color: "#8bff8b" }}>{okCount}</b></div>
            <div>실패: <b style={{ color: "#ff7b7b" }}>{errCount}</b></div>
          </div>

          {/* progress bar */}
          <div style={{ marginTop: 10, height: 8, borderRadius: 999, background: "rgba(255,255,255,0.10)", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${files.length ? Math.round((done / files.length) * 100) : 0}%`,
                background: "rgba(255,90,42,0.95)",
              }}
            />
          </div>
        </div>

        {/* logs */}
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 950, marginBottom: 10 }}>로그</div>
          <div style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 16, background: "#070707", overflow: "hidden" }}>
            {logs.length === 0 ? (
              <div style={{ padding: 14, opacity: 0.65 }}>아직 로그가 없어요.</div>
            ) : (
              <div style={{ display: "grid", gap: 8, padding: 12 }}>
                {logs.map((l, idx) => (
                  <div
                    key={idx}
                    style={{
                      border: "1px solid rgba(255,255,255,0.10)",
                      borderRadius: 12,
                      padding: "10px 12px",
                      background:
                        l.kind === "ok"
                          ? "rgba(0,255,0,0.06)"
                          : l.kind === "err"
                          ? "rgba(255,0,0,0.06)"
                          : "rgba(0,0,0,0.35)",
                      fontSize: 12,
                      opacity: 0.95,
                    }}
                  >
                    {l.msg}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.6, lineHeight: 1.6 }}>
            ✅ 대량 업로드 권장 플로우<br />
            1) 폴더 업로드로 사진 선택 → 2) 업로드+임베딩 저장 → 3) <b>/admin/event</b>에서 Moments 설정 → 4) 행사 페이지 공유
          </div>
        </div>
      </div>
    </main>
  );
}
