"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ref, uploadBytes, getDownloadURL, listAll } from "firebase/storage";
import { storage, db } from "../../lib/firebaseClient";
import * as faceapi from "face-api.js";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";

type PhotoItem = { path: string; url: string };
type MatchItem = PhotoItem & { score: number };

function cosineSimilarity(a: Float32Array, b: Float32Array) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

async function urlToCanvasViaProxy(url: string, maxSize = 640) {
  const proxied = `/api/img?u=${encodeURIComponent(url)}`;
  const res = await fetch(proxied, { cache: "no-store" });
  if (!res.ok) throw new Error(`proxy fetch failed: ${res.status}`);

  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);

  const w = bitmap.width;
  const h = bitmap.height;
  const scale = Math.min(maxSize / w, maxSize / h, 1);
  const tw = Math.round(w * scale);
  const th = Math.round(h * scale);

  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas context 생성 실패");

  ctx.drawImage(bitmap, 0, 0, tw, th);
  bitmap.close();

  return canvas;
}

function makeUid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `uid_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function pillStyle() {
  return {
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(0,0,0,0.6)",
    fontSize: 12,
    opacity: 0.9,
  } as const;
}

export default function FindClient() {
  const sp = useSearchParams();
  const eventId = sp.get("eventId") ?? "";
  const uidFromUrl = sp.get("uid") ?? "";

  const safeEventId = useMemo(() => eventId, [eventId]);

  // ✅ uid는 URL에 없으면 내부에서 만들어서 계속 유지
  const [safeUid, setSafeUid] = useState<string>("");

  // Data
  const [eventPhotos, setEventPhotos] = useState<PhotoItem[]>([]);
  const [loadingEventPhotos, setLoadingEventPhotos] = useState(true);
  const [eventPhotosMsg, setEventPhotosMsg] = useState("");

  // Selfie
  const [file, setFile] = useState<File | null>(null);
  const [selfieUrl, setSelfieUrl] = useState("");
  const [uploading, setUploading] = useState(false);

  // Matching
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchMessage, setMatchMessage] = useState("");
  const [matches, setMatches] = useState<MatchItem[]>([]);
  const [threshold, setThreshold] = useState(0.88);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // 🔥 Matching quality / perf knobs
  const [scanBatchSize] = useState(60); // 60장씩
  const [scanMax] = useState(240); // 최대 240장까지 (원하면 올려)
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const abortRef = useRef(false);

  // Save
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());

  // Lightbox
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // Refs
  const modelsReadyRef = useRef(false);
  const autoRanRef = useRef(false);

  // ✅ eventId 없으면 홈으로 안내
  if (!safeEventId) {
    return (
      <main style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: 24 }}>
        <div style={{ maxWidth: 680, margin: "0 auto" }}>
          <h1 style={{ fontSize: 22, fontWeight: 950, marginBottom: 10 }}>행사를 찾을 수 없어요</h1>
          <div style={{ opacity: 0.75, marginBottom: 16 }}>행사 홈에서 다시 들어와줘!</div>
          <Link href="/" style={{ color: "#fff", textDecoration: "underline", opacity: 0.9 }}>
            행사 목록으로 →
          </Link>
        </div>
      </main>
    );
  }

  // ✅ uid 세팅 + URL에 심기 (사용자에게는 안 보이게 replace)
  useEffect(() => {
    const uid = uidFromUrl || makeUid();
    setSafeUid(uid);

    if (!uidFromUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("uid", uid);
      window.history.replaceState({}, "", url.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uidFromUrl, safeEventId]);

  const ensureModels = async () => {
    if (modelsReadyRef.current) return;
    setMatchMessage("모델 로딩 중... (최초 1회)");
    const base = "/models";
    await faceapi.nets.tinyFaceDetector.loadFromUri(base);
    await faceapi.nets.faceLandmark68TinyNet.loadFromUri(base);
    await faceapi.nets.faceRecognitionNet.loadFromUri(base);
    modelsReadyRef.current = true;
  };

  const loadEventPhotos = async () => {
    try {
      setLoadingEventPhotos(true);
      setEventPhotosMsg("행사 사진 불러오는 중...");
      setEventPhotos([]);

      const folderRef = ref(storage, `events/${safeEventId}/photos`);
      const res = await listAll(folderRef);

      // 최신부터
      const sorted = [...res.items].sort((a, b) => b.name.localeCompare(a.name));

      const urls = await Promise.all(
        sorted.map(async (item) => {
          const url = await getDownloadURL(item);
          return { path: item.fullPath, url };
        })
      );

      setEventPhotos(urls);
      setEventPhotosMsg(urls.length ? `사진 ${urls.length}장 준비됨` : "행사 사진이 아직 없어요.");
    } catch (e) {
      console.error(e);
      setEventPhotos([]);
      setEventPhotosMsg("행사 사진을 불러오지 못했어요. (권한/경로 확인)");
    } finally {
      setLoadingEventPhotos(false);
    }
  };

  const loadSelfieUrlByUid = async (uid: string) => {
    const folderRef = ref(storage, `events/${safeEventId}/selfies`);
    const res = await listAll(folderRef);
    const found = res.items.find((it) => it.name.startsWith(`${uid}.`));
    if (!found) return "";
    return await getDownloadURL(found);
  };

  useEffect(() => {
    loadEventPhotos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeEventId]);

  const abortScan = () => {
    abortRef.current = true;
    setMatchMessage("중단했어요. 다시 시작하려면 셀카를 다시 올려줘!");
    setMatchLoading(false);
  };

  const runMatching = async (uploadedSelfieUrl: string) => {
    if (!eventPhotos.length) {
      setMatchMessage("행사 사진이 아직 없어요. 운영자 업로드를 확인해줘!");
      return;
    }

    abortRef.current = false;

    try {
      setMatchLoading(true);
      setMatches([]);
      setSavingKey(null);
      setSavedKeys(new Set());
      setProgress({ done: 0, total: Math.min(scanMax, eventPhotos.length) });

      setMatchMessage("준비 중...");
      await ensureModels();

      // 1) 셀카 descriptor
      setMatchMessage("셀카 분석 중...");
      const selfieCanvas = await urlToCanvasViaProxy(uploadedSelfieUrl, 640);

      const selfieDet = await faceapi
        .detectSingleFace(selfieCanvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 320 }))
        .withFaceLandmarks(true)
        .withFaceDescriptor();

      if (!selfieDet) {
        setMatchMessage("셀카에서 얼굴을 찾지 못했어요. 얼굴이 크게 나오게 다시 찍어줘!");
        return;
      }
      const selfieDesc = selfieDet.descriptor;

      // 2) 후보를 배치로 점진 탐색
      const total = Math.min(scanMax, eventPhotos.length);
      const pool = eventPhotos.slice(0, total);

      const scoredAll: MatchItem[] = [];
      const TOP_KEEP = 25; // 상위만 유지
      const CONCURRENCY = 2; // 브라우저 안정

      const scoreOne = async (p: PhotoItem): Promise<MatchItem | null> => {
        if (abortRef.current) return null;

        try {
          const canvas = await urlToCanvasViaProxy(p.url, 640);

          const detections = await faceapi
            .detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 320 }))
            .withFaceLandmarks(true)
            .withFaceDescriptors();

          if (!detections || detections.length === 0) return null;

          let best = -1;
          for (const d of detections) {
            const s = cosineSimilarity(selfieDesc, d.descriptor);
            if (s > best) best = s;
          }

          return { ...p, score: best };
        } catch (e) {
          console.warn("analyze failed:", p.path, e);
          return null;
        }
      };

      const keepTop = (arr: MatchItem[]) => {
        arr.sort((a, b) => b.score - a.score);
        if (arr.length > TOP_KEEP) arr.splice(TOP_KEEP);
      };

      for (let start = 0; start < pool.length; start += scanBatchSize) {
        if (abortRef.current) break;

        const end = Math.min(pool.length, start + scanBatchSize);
        const batch = pool.slice(start, end);

        setMatchMessage(`내 사진 찾는 중... (${start + 1}~${end}/${pool.length})`);

        let i = 0;
        while (i < batch.length) {
          if (abortRef.current) break;

          const chunk = batch.slice(i, i + CONCURRENCY);
          const results = await Promise.all(chunk.map(scoreOne));

          for (const r of results) {
            if (r && r.score >= 0) scoredAll.push(r);
          }

          i += CONCURRENCY;
          setProgress({ done: Math.min(pool.length, start + i), total: pool.length });
        }

        keepTop(scoredAll);

        const filtered = scoredAll.filter((x) => x.score >= threshold).sort((a, b) => b.score - a.score);
        const top = filtered.slice(0, 8);

        if (top.length > 0) {
          setMatches(top);
          setMatchMessage(`찾았어! ${top.length}장 (기준선 ${threshold.toFixed(2)})`);
          // 계속 돌면서 더 좋은 결과를 찾되, UI는 이미 보여줌
        } else {
          setMatches([]);
          setMatchMessage(`아직 못 찾았어요… 계속 찾는 중 (기준선 ${threshold.toFixed(2)})`);
        }
      }

      if (abortRef.current) return;

      scoredAll.sort((a, b) => b.score - a.score);
      const finalFiltered = scoredAll.filter((x) => x.score >= threshold);
      const finalTop = finalFiltered.slice(0, 8);
      setMatches(finalTop);

      if (finalTop.length === 0) {
        setMatchMessage(
          `끝까지 찾았지만 결과가 없어요. 기준선을 낮추거나 셀카를 바꿔봐! (기준선 ${threshold.toFixed(2)})`
        );
      } else {
        setMatchMessage(`완료! ${finalTop.length}장 (기준선 ${threshold.toFixed(2)})`);
      }
    } catch (e) {
      console.error(e);
      setMatchMessage("매칭에 실패했어요. 잠시 후 다시 시도해줘!");
    } finally {
      setMatchLoading(false);
    }
  };

  // ✅ 페이지 들어오면: 이미 업로드된 셀카가 있으면 자동 매칭
  useEffect(() => {
    if (!safeUid) return;
    if (loadingEventPhotos) return;
    if (eventPhotos.length === 0) return;
    if (autoRanRef.current) return;

    const run = async () => {
      try {
        autoRanRef.current = true;
        setMatchMessage("셀카 확인 중...");

        const url = await loadSelfieUrlByUid(safeUid);

        if (!url) {
          setMatchMessage("셀카를 업로드하면 바로 찾아줄게!");
          return;
        }

        setSelfieUrl(url);
        await runMatching(url);
      } catch (e) {
        console.error(e);
        setMatchMessage("자동 매칭을 시작하지 못했어요. 셀카를 다시 올려줘!");
      }
    };

    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeUid, loadingEventPhotos, eventPhotos.length]);

  const handleUploadSelfie = async () => {
    if (!file) return alert("셀카 사진을 선택해주세요");
    if (!safeUid) return alert("uid 생성 중... 잠시만!");

    try {
      setUploading(true);
      setMatches([]);
      setMatchMessage("");
      setSelfieUrl("");

      const ext = file.name.split(".").pop() || "jpg";
      const selfiePath = `events/${safeEventId}/selfies/${safeUid}.${ext}`;

      const storageRef2 = ref(storage, selfiePath);
      await uploadBytes(storageRef2, file);

      const url = await getDownloadURL(storageRef2);
      setSelfieUrl(url);

      await runMatching(url);
    } catch (e) {
      console.error(e);
      setMatchMessage("셀카 업로드/매칭에 실패했어요. 다시 시도해줘!");
    } finally {
      setUploading(false);
    }
  };

  const saveMatch = async (m: MatchItem) => {
    const key = `${safeEventId}|${safeUid}|${m.path}`;
    if (savedKeys.has(key)) return;
    if (savingKey) return;

    try {
      setSavingKey(key);
      await addDoc(collection(db, "saved_matches"), {
        eventId: safeEventId,
        uid: safeUid,
        photoPath: m.path,
        photoUrl: m.url,
        score: m.score,
        source: "match_top",
        createdAt: serverTimestamp(),
      });
      setSavedKeys((prev) => new Set(prev).add(key));
    } catch (e) {
      console.error(e);
      alert("저장 실패 (콘솔 확인)");
    } finally {
      setSavingKey(null);
    }
  };

  // ✅ 키보드: ESC/좌우 (라이트박스)
  useEffect(() => {
    if (!lightboxOpen) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxOpen(false);
      if (e.key === "ArrowLeft") setActiveIndex((v) => Math.max(0, v - 1));
      if (e.key === "ArrowRight") setActiveIndex((v) => Math.min(matches.length - 1, v + 1));
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxOpen, matches.length]);

  const openLightbox = (i: number) => {
    setActiveIndex(i);
    setLightboxOpen(true);
  };

  const active = matches[activeIndex];

  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: 24 }}>
      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        {/* Top bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <Link href={`/e/${safeEventId}`} style={{ color: "#fff", opacity: 0.8, textDecoration: "none" }}>
            ← 행사 홈
          </Link>
          <div style={{ fontSize: 18, fontWeight: 950 }}>내 사진 찾기</div>
          <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.6 }}>
            {loadingEventPhotos ? "사진 준비 중…" : eventPhotos.length ? `${eventPhotos.length}장` : ""}
          </div>
        </div>

        {/* Upload card (one-page flow) */}
        <div
          style={{
            borderRadius: 22,
            border: "1px solid #1f1f1f",
            background: "linear-gradient(180deg, #0a0a0a, #000)",
            padding: 18,
          }}
        >
          <div style={{ fontSize: 14, opacity: 0.75, marginBottom: 10 }}>
            셀카를 업로드(또는 촬영)하면 행사 사진에서 내 사진을 찾아줘요.
          </div>

          <div
            style={{
              border: "1px solid #222",
              borderRadius: 18,
              padding: 14,
              background: "#070707",
            }}
          >
            <input
              type="file"
              accept="image/*"
              capture="user"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              disabled={uploading || matchLoading}
              style={{ width: "100%" }}
            />
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
              {file ? `선택됨: ${file.name}` : "정면 얼굴이 잘 보이는 사진이 좋아요"}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
            <button
              onClick={handleUploadSelfie}
              disabled={!file || uploading || matchLoading || !safeUid}
              style={{
                width: "100%",
                padding: 14,
                borderRadius: 999,
                border: "1px solid #1f1f1f",
                background: !file || uploading || matchLoading ? "#222" : "#ff5a2a",
                color: !file || uploading || matchLoading ? "#aaa" : "#000",
                fontWeight: 950,
                cursor: !file || uploading || matchLoading ? "not-allowed" : "pointer",
              }}
            >
              {uploading ? "업로드 중…" : matchLoading ? "찾는 중…" : "내 사진 찾기 시작"}
            </button>

            <Link
              href={`/p?eventId=${encodeURIComponent(safeEventId)}`}
              style={{
                width: "100%",
                padding: 14,
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.22)",
                color: "#fff",
                fontWeight: 900,
                textDecoration: "none",
                display: "block",
                textAlign: "center",
                opacity: 0.95,
              }}
            >
              전체 사진 보기
            </Link>
          </div>

          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.65 }}>{eventPhotosMsg}</div>

          {/* Progress + Abort */}
          {matchLoading ? (
            <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                진행: {progress.done} / {progress.total}
              </div>

              <div
                style={{
                  flex: "1 1 260px",
                  height: 6,
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.12)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                    background: "rgba(255,90,42,0.9)",
                  }}
                />
              </div>

              <button
                onClick={abortScan}
                style={{
                  padding: "8px 10px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.18)",
                  background: "transparent",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                중단
              </button>
            </div>
          ) : null}

          {/* Advanced */}
          <div style={{ marginTop: 14 }}>
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "transparent",
                color: "#fff",
                cursor: "pointer",
                opacity: 0.85,
              }}
            >
              {showAdvanced ? "고급설정 닫기" : "고급설정"}
            </button>
          </div>

          {showAdvanced ? (
            <div
              style={{
                marginTop: 12,
                padding: 12,
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 12,
                maxWidth: 560,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <div style={{ fontSize: 14, opacity: 0.9 }}>
                  유사도 기준선: <b>{threshold.toFixed(2)}</b>
                </div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>(추천: 0.86~0.92)</div>
              </div>

              <input
                type="range"
                min={0.7}
                max={0.99}
                step={0.01}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                style={{ width: "100%", marginTop: 10 }}
                disabled={matchLoading}
              />
              <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>
                기준선을 올리면 “정확도↑, 결과수↓” / 내리면 “결과수↑, 오탐↑”
              </div>

              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.65 }}>
                UID(자동): <b>{safeUid}</b>
              </div>
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.65 }}>
                스캔: {scanBatchSize}장씩 / 최대 {scanMax}장
              </div>
            </div>
          ) : null}
        </div>

        {/* Status */}
        <div style={{ marginTop: 14, opacity: 0.85 }}>{matchMessage}</div>

        {/* Empty state */}
        {!matchLoading && matches.length === 0 ? (
          <div
            style={{
              marginTop: 16,
              borderRadius: 22,
              border: "1px solid #1f1f1f",
              background: "#070707",
              padding: 18,
              opacity: 0.95,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 6 }}>아직 결과가 없어요</div>
            <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 14 }}>
              셀카를 업로드하면 바로 찾아줄게요. 결과가 없으면 고급설정에서 기준선을 조금 낮춰보세요.
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <button
                onClick={() => setShowAdvanced(true)}
                style={{
                  width: "100%",
                  padding: 14,
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.22)",
                  background: "transparent",
                  color: "#fff",
                  fontWeight: 900,
                  cursor: "pointer",
                  opacity: 0.95,
                }}
              >
                기준선 조절
              </button>

              <Link
                href={`/p?eventId=${encodeURIComponent(safeEventId)}`}
                style={{
                  width: "100%",
                  padding: 14,
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.22)",
                  color: "#fff",
                  fontWeight: 900,
                  textDecoration: "none",
                  display: "block",
                  textAlign: "center",
                  opacity: 0.95,
                }}
              >
                전체 사진 보기
              </Link>
            </div>
          </div>
        ) : null}

        {/* Results grid */}
        {matches.length > 0 ? (
          <div
            style={{
              marginTop: 16,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
            {matches.map((m, idx) => {
              const key = `${safeEventId}|${safeUid}|${m.path}`;
              const saved = savedKeys.has(key);
              const saving = savingKey === key;

              return (
                <div
                  key={m.path}
                  style={{
                    border: "1px solid rgba(255,255,255,0.14)",
                    borderRadius: 16,
                    overflow: "hidden",
                    background: "#0b0b0b",
                  }}
                >
                  <div
                    onClick={() => openLightbox(idx)}
                    style={{ cursor: "pointer", position: "relative", background: "#000" }}
                    title="확대 보기"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.url} alt={m.path} style={{ width: "100%", height: 160, objectFit: "cover" }} />
                    <div style={{ position: "absolute", top: 10, left: 10, ...pillStyle() }}>
                      {m.score.toFixed(3)}
                    </div>
                  </div>

                  <div style={{ padding: 12 }}>
                    <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 10 }}>{m.path.split("/").pop()}</div>

                    <div style={{ display: "flex", gap: 10 }}>
                      <button
                        onClick={() => saveMatch(m)}
                        disabled={saved || savingKey !== null}
                        style={{
                          flex: 1,
                          padding: "10px 12px",
                          borderRadius: 12,
                          border: "1px solid rgba(255,255,255,0.18)",
                          background: saved ? "rgba(0,255,0,0.08)" : "transparent",
                          color: "#fff",
                          cursor: saved ? "default" : "pointer",
                          opacity: saved ? 0.9 : 1,
                        }}
                      >
                        {saved ? "✅ 저장됨" : saving ? "저장 중…" : "저장"}
                      </button>

                      <a
                        href={m.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          padding: "10px 12px",
                          borderRadius: 12,
                          border: "1px solid rgba(255,255,255,0.18)",
                          color: "#fff",
                          textDecoration: "none",
                          opacity: 0.9,
                        }}
                      >
                        원본
                      </a>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* ✅ Lightbox (안 잘림) */}
      {lightboxOpen && active ? (
        <div
          onClick={() => setLightboxOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.85)",
            display: "grid",
            placeItems: "center",
            zIndex: 9999,
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(1100px, 96vw)",
              height: "min(760px, 86vh)",
              borderRadius: 18,
              border: "1px solid #222",
              background: "#050505",
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 12,
              overflow: "visible",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={active.url}
              alt="active"
              style={{
                width: "auto",
                height: "auto",
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
                display: "block",
                borderRadius: 12,
                background: "rgba(255,255,255,0.03)",
              }}
            />

            <button
              onClick={() => setLightboxOpen(false)}
              style={{
                position: "absolute",
                top: 10,
                right: 10,
                width: 40,
                height: 40,
                borderRadius: 999,
                border: "1px solid #333",
                background: "rgba(10,10,10,0.7)",
                color: "#fff",
                cursor: "pointer",
                fontSize: 18,
              }}
              aria-label="close"
            >
              ✕
            </button>

            <button
              onClick={() => setActiveIndex((v) => Math.max(0, v - 1))}
              disabled={activeIndex <= 0}
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                width: 44,
                height: 44,
                borderRadius: 999,
                border: "1px solid #333",
                background: "rgba(10,10,10,0.7)",
                color: "#fff",
                cursor: activeIndex <= 0 ? "not-allowed" : "pointer",
                opacity: activeIndex <= 0 ? 0.4 : 1,
                fontSize: 18,
              }}
              aria-label="prev"
            >
              ‹
            </button>

            <button
              onClick={() => setActiveIndex((v) => Math.min(matches.length - 1, v + 1))}
              disabled={activeIndex >= matches.length - 1}
              style={{
                position: "absolute",
                right: 10,
                top: "50%",
                transform: "translateY(-50%)",
                width: 44,
                height: 44,
                borderRadius: 999,
                border: "1px solid #333",
                background: "rgba(10,10,10,0.7)",
                color: "#fff",
                cursor: activeIndex >= matches.length - 1 ? "not-allowed" : "pointer",
                opacity: activeIndex >= matches.length - 1 ? 0.4 : 1,
                fontSize: 18,
              }}
              aria-label="next"
            >
              ›
            </button>

            <div style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)", ...pillStyle() }}>
              {activeIndex + 1} / {matches.length}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
