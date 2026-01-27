"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ref, uploadBytes, getDownloadURL, listAll } from "firebase/storage";
import { storage, db } from "../../lib/firebaseClient";
import { addDoc, collection, serverTimestamp, getDocs } from "firebase/firestore";
import { embedFace } from "../../lib/faceServer";

type PhotoDoc = { id: string; fullPath: string; downloadURL: string; embedding: number[] };
type MatchItem = { id: string; path: string; url: string; score: number };

function cosineSimilarity(a: number[], b: number[]) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
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
  const [safeUid, setSafeUid] = useState<string>("");

  // ✅ Firestore에서 읽어온 “임베딩 포함 행사 사진”
  const [eventPhotos, setEventPhotos] = useState<PhotoDoc[]>([]);
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
  const [threshold, setThreshold] = useState(0.55); // face-server 임베딩은 보통 0.45~0.7 영역에서 튜닝
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Save
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());

  // Lightbox
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const autoRanRef = useRef(false);

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

  // ✅ uid 세팅 + URL에 심기
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

  // ✅ Firestore에서 임베딩 포함 행사 사진 로드
  const loadEventPhotosFromFirestore = async () => {
    try {
      setLoadingEventPhotos(true);
      setEventPhotosMsg("행사 사진(임베딩) 불러오는 중...");
      setEventPhotos([]);

      const snap = await getDocs(collection(db, "events", safeEventId, "photos"));
      const docs: PhotoDoc[] = snap.docs
        .map((d) => {
          const v: any = d.data();
          return {
            id: d.id,
            fullPath: v.fullPath,
            downloadURL: v.downloadURL,
            embedding: v.embedding,
          };
        })
        .filter((x) => Array.isArray(x.embedding) && typeof x.downloadURL === "string");

      setEventPhotos(docs);
      setEventPhotosMsg(docs.length ? `임베딩된 사진 ${docs.length}장 준비됨` : "임베딩된 행사 사진이 아직 없어요. (운영자 업로드 필요)");
    } catch (e) {
      console.error(e);
      setEventPhotos([]);
      setEventPhotosMsg("행사 사진(임베딩)을 불러오지 못했어요. (권한/경로 확인)");
    } finally {
      setLoadingEventPhotos(false);
    }
  };

  useEffect(() => {
    loadEventPhotosFromFirestore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeEventId]);

  const loadSelfieUrlByUid = async (uid: string) => {
    const folderRef = ref(storage, `events/${safeEventId}/selfies`);
    const res = await listAll(folderRef);
    const found = res.items.find((it) => it.name.startsWith(`${uid}.`));
    if (!found) return "";
    return await getDownloadURL(found);
  };

  const runMatching = async (uploadedSelfieFile: File) => {
    if (!eventPhotos.length) {
      setMatchMessage("임베딩된 행사 사진이 아직 없어요. 운영자 업로드를 먼저 해줘!");
      return;
    }

    try {
      setMatchLoading(true);
      setMatches([]);
      setSavingKey(null);
      setSavedKeys(new Set());

      setMatchMessage("셀카 임베딩 생성 중...");
      const q = await embedFace(uploadedSelfieFile);

      setMatchMessage("매칭 중...");
      const scored = eventPhotos
        .map((p) => ({
          id: p.id,
          path: p.fullPath,
          url: p.downloadURL,
          score: cosineSimilarity(q, p.embedding),
        }))
        .sort((a, b) => b.score - a.score);

      const filtered = scored.filter((x) => x.score >= threshold).slice(0, 24);
      const top = (filtered.length ? filtered : scored.slice(0, 24)).slice(0, 8);

      setMatches(top);
      setMatchMessage(
        filtered.length
          ? `찾았어! ${top.length}장 (기준선 ${threshold.toFixed(2)})`
          : `기준선 이상은 없지만, 가장 비슷한 사진을 보여줄게 (기준선 ${threshold.toFixed(2)})`
      );
    } catch (e) {
      console.error(e);
      setMatchMessage("매칭에 실패했어요. (콘솔 확인)");
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

        // 🔥 중요: URL만 있으면 file을 못 만들기 때문에 자동매칭은 “다시 업로드” 기반이었음
        // 그래서 자동매칭은 UX용 메시지만 두고, 사용자가 다시 올리게 유도하는게 가장 안전함.
        setSelfieUrl(url);
        setMatchMessage("이전에 올린 셀카가 있어요! 아래에서 다시 한 번 ‘내 사진 찾기 시작’을 눌러주세요.");
      } catch (e) {
        console.error(e);
        setMatchMessage("자동 확인에 실패했어요. 셀카를 다시 올려줘!");
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

      // 1) 셀카 Storage 업로드(기록용)
      const ext = file.name.split(".").pop() || "jpg";
      const selfiePath = `events/${safeEventId}/selfies/${safeUid}.${ext}`;

      const storageRef2 = ref(storage, selfiePath);
      await uploadBytes(storageRef2, file);
      const url = await getDownloadURL(storageRef2);
      setSelfieUrl(url);

      // 2) face-server 임베딩 기반 매칭
      await runMatching(file);
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
            {loadingEventPhotos ? "사진 준비 중…" : eventPhotos.length ? `${eventPhotos.length}장(임베딩)` : ""}
          </div>
        </div>

        {/* Upload card */}
        <div
          style={{
            borderRadius: 22,
            border: "1px solid #1f1f1f",
            background: "linear-gradient(180deg, #0a0a0a, #000)",
            padding: 18,
          }}
        >
          <div style={{ fontSize: 14, opacity: 0.75, marginBottom: 10 }}>
            셀카를 업로드하면 (임베딩 기반으로) 내 사진을 찾아줘요.
          </div>

          <div style={{ border: "1px solid #222", borderRadius: 18, padding: 14, background: "#070707" }}>
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
                <div style={{ fontSize: 12, opacity: 0.7 }}>(추천: 0.45~0.70)</div>
              </div>

              <input
                type="range"
                min={0.2}
                max={0.9}
                step={0.01}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                style={{ width: "100%", marginTop: 10 }}
                disabled={matchLoading}
              />

              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.65 }}>
                UID(자동): <b>{safeUid}</b>
              </div>
            </div>
          ) : null}
        </div>

        {/* Status */}
        <div style={{ marginTop: 14, opacity: 0.85 }}>{matchMessage}</div>

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

      {/* Lightbox */}
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
