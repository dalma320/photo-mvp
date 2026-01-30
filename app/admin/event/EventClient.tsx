"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { db, storage } from "../../../lib/firebaseClient";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  query,
  orderBy,
  limit,
} from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";

type EventMeta = {
  id: string;
  title: string;
  year: number;
  status: "live" | "draft" | "archived";
  location: string;
  distances: string[];
  logoUrl?: string;
  heroUrl?: string;
  moments?: { photoId: string; url: string; path?: string }[];
};

type PhotoDoc = {
  id: string;
  downloadURL: string;
  fullPath: string;
  createdAt?: any;
};

const pill = {
  padding: "6px 10px",
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(0,0,0,0.6)",
  fontSize: 12,
  opacity: 0.9,
} as const;

function safeNum(v: any, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseDistances(s: string) {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeId(s: string) {
  return (s || "").trim();
}

export default function EventClient() {
  const sp = useSearchParams();
  const fromUrl = normalizeId(sp.get("eventId") ?? "");

  // ✅ Step C: autocomplete 선택
  const [eventList, setEventList] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [queryText, setQueryText] = useState<string>("");
  const [openList, setOpenList] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 폼
  const [meta, setMeta] = useState<EventMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string>("");

  // photos/moments
  const [photos, setPhotos] = useState<PhotoDoc[]>([]);
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const [momentIds, setMomentIds] = useState<Set<string>>(new Set());

  const eventId = useMemo(() => normalizeId(selectedId || queryText), [selectedId, queryText]);

  const log = (t: string) => setMsg(t);

  // ✅ 주최사용 업로드 링크 (행사 고정)
const uploadUrl = useMemo(() => {
  if (!eventId) return "";
  const base =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://photo-mvp.vercel.app";
  return `${base}/admin/upload?eventId=${encodeURIComponent(eventId)}`;
}, [eventId]);

const copyUploadUrl = async () => {
  if (!uploadUrl) return;
  try {
    await navigator.clipboard.writeText(uploadUrl);
    setMsg("업로드 링크 복사 완료 ✅");
  } catch {
    setMsg("복사 실패 ❌ 수동으로 복사해줘");
  }
};


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

  // 1) 이벤트 목록 로드 + URL eventId 우선 선택
  useEffect(() => {
    const run = async () => {
      try {
        const snap = await getDocs(collection(db, "events"));
        const ids = snap.docs.map((d) => d.id).sort((a, b) => a.localeCompare(b));
        setEventList(ids);

        // ✅ URL이 있으면 그걸 우선
        if (fromUrl) {
          setSelectedId(fromUrl);
          setQueryText(fromUrl);
          return;
        }

        // 아니면 첫 번째
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
  }, [fromUrl]);


  
  // 2) 이벤트 메타 로드 (없으면 seed)
  useEffect(() => {
    if (!eventId) return;

    const run = async () => {
      setLoading(true);
      setMsg("");
      try {
        const refDoc = doc(db, "events", eventId);
        const snap = await getDoc(refDoc);

        if (!snap.exists()) {
          const seeded: EventMeta = {
            id: eventId,
            title: eventId,
            year: new Date().getFullYear(),
            status: "live",
            location: "",
            distances: [],
            moments: [],
          };
          await setDoc(
            refDoc,
            { ...seeded, createdAt: serverTimestamp(), updatedAt: serverTimestamp() },
            { merge: true }
          );
          setMeta(seeded);
          setMomentIds(new Set());
          setPhotos([]);
          setMsg("새 행사 문서를 자동 생성했어요 (seed).");
          return;
        }

        const v: any = snap.data();
        const loaded: EventMeta = {
          id: eventId,
          title: v.title ?? eventId,
          year: safeNum(v.year, new Date().getFullYear()),
          status: (v.status ?? "live") as any,
          location: v.location ?? "",
          distances: Array.isArray(v.distances) ? v.distances : [],
          logoUrl: v.logoUrl,
          heroUrl: v.heroUrl,
          moments: Array.isArray(v.moments) ? v.moments : [],
        };

        setMeta(loaded);
        setMomentIds(new Set((loaded.moments ?? []).map((m) => m.photoId).filter(Boolean)));
      } catch (e) {
        console.error(e);
        setMsg("메타데이터를 불러오지 못했어요 (권한/규칙 확인).");
      } finally {
        setLoading(false);
      }
    };

    run();
  }, [eventId]);

  // 3) 사진 목록 로드
  const loadPhotos = async () => {
    if (!eventId) return;
    setLoadingPhotos(true);
    try {
      const q1 = query(collection(db, "events", eventId, "photos"), orderBy("createdAt", "desc"), limit(200));
      const snap = await getDocs(q1);
      const list: PhotoDoc[] = snap.docs
        .map((d) => {
          const v: any = d.data();
          return {
            id: d.id,
            downloadURL: v.downloadURL,
            fullPath: v.fullPath,
            createdAt: v.createdAt,
          };
        })
        .filter((x) => typeof x.downloadURL === "string");

      setPhotos(list);
      setMsg(list.length ? `사진 ${list.length}장 불러옴` : "아직 임베딩된 사진이 없어요. (/admin/upload 먼저)");
    } catch (e) {
      console.error(e);
      setMsg("사진 목록을 불러오지 못했어요.");
    } finally {
      setLoadingPhotos(false);
    }
  };

  useEffect(() => {
    setPhotos([]);
  }, [eventId]);

  // 저장
  const saveMeta = async () => {
    if (!meta || !eventId) return;
    setSaving(true);
    setMsg("");
    try {
      await setDoc(
        doc(db, "events", eventId),
        {
          id: eventId,
          title: meta.title?.trim() || eventId,
          year: safeNum(meta.year, new Date().getFullYear()),
          status: meta.status,
          location: meta.location ?? "",
          distances: Array.isArray(meta.distances) ? meta.distances : [],
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      setMsg("저장 완료 ✅");
      // 목록에 없으면 추가
      setEventList((prev) => Array.from(new Set([eventId, ...prev])).sort((a, b) => a.localeCompare(b)));
    } catch (e) {
      console.error(e);
      setMsg("저장 실패 ❌ (권한/규칙 확인)");
    } finally {
      setSaving(false);
    }
  };

  // 로고/히어로 업로드
  const uploadMetaImage = async (kind: "logo" | "hero", file: File) => {
    if (!eventId) return;
    setSaving(true);
    setMsg("");
    try {
      const ext = file.name.split(".").pop() || "jpg";
      const path = `events/${eventId}/meta/${kind}.${ext}`;
      const sref = ref(storage, path);
      await uploadBytes(sref, file);
      const url = await getDownloadURL(sref);

      await updateDoc(doc(db, "events", eventId), {
        [kind === "logo" ? "logoUrl" : "heroUrl"]: url,
        updatedAt: serverTimestamp(),
      });

      setMeta((prev) => (prev ? { ...prev, [kind === "logo" ? "logoUrl" : "heroUrl"]: url } : prev));
      setMsg(`${kind.toUpperCase()} 업로드 완료 ✅`);
    } catch (e) {
      console.error(e);
      setMsg("업로드 실패 ❌");
    } finally {
      setSaving(false);
    }
  };

  // moments
  const toggleMoment = (p: PhotoDoc) => {
    setMomentIds((prev) => {
      const next = new Set(prev);
      if (next.has(p.id)) next.delete(p.id);
      else {
        if (next.size >= 8) return next;
        next.add(p.id);
      }
      return next;
    });
  };

  const applyAutoMoments = () => {
    const ids = new Set<string>(photos.slice(0, 8).map((p) => p.id));
    setMomentIds(ids);
    setMsg("대표사진(모먼츠)을 최신 8장으로 자동 선택했어요.");
  };

  const saveMoments = async () => {
    if (!eventId) return;
    setSaving(true);
    setMsg("");
    try {
      const chosen = photos
        .filter((p) => momentIds.has(p.id))
        .slice(0, 8)
        .map((p) => ({ photoId: p.id, url: p.downloadURL, path: p.fullPath }));

      await updateDoc(doc(db, "events", eventId), {
        moments: chosen,
        updatedAt: serverTimestamp(),
      });

      setMeta((prev) => (prev ? { ...prev, moments: chosen } : prev));
      setMsg(`대표사진 저장 완료 ✅ (${chosen.length}장)`);
    } catch (e) {
      console.error(e);
      setMsg("대표사진 저장 실패 ❌");
    } finally {
      setSaving(false);
    }
  };

  const activeMeta = meta;

  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: 24 }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <div style={{ fontSize: 24, fontWeight: 950 }}>/admin/event</div>
          <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.7 }}>{msg}</div>
        </div>

        {/* ✅ Step C: Autocomplete 이벤트 선택 */}
        <div style={{ border: "1px solid #1f1f1f", borderRadius: 18, background: "#070707", padding: 14 }}>
          <div ref={boxRef} style={{ position: "relative" }}>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>eventId 검색/선택</div>
            <input
              value={queryText}
              onChange={(e) => {
                setQueryText(e.target.value);
                setOpenList(true);
                setSelectedId(""); // 타자칠 때는 선택 상태 해제
              }}
              onFocus={() => setOpenList(true)}
              placeholder="타자로 검색 (예: AAS2026)"
              disabled={saving}
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
                  zIndex: 50,
                  top: 64,
                  left: 0,
                  right: 0,
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "#070707",
                  overflow: "hidden",
                  maxHeight: 280,
                  overflowY: "auto",
                }}
              >
                {filtered.length === 0 ? (
                  <div style={{ padding: 12, fontSize: 12, opacity: 0.75 }}>
                    검색 결과 없음. 그대로 입력한 eventId로 새 행사가 생성(seed)될 수 있어요.
                    <div style={{ marginTop: 8, opacity: 0.9 }}>
                      현재 입력: <b>{normalizeId(queryText) || "-"}</b>
                    </div>
                    <button
                      onClick={() => {
                        const v = normalizeId(queryText);
                        if (!v) return;
                        pickEvent(v); // seed 로직 타게 함
                      }}
                      style={{
                        marginTop: 10,
                        padding: "10px 12px",
                        borderRadius: 12,
                        border: "1px solid rgba(255,255,255,0.18)",
                        background: "rgba(255,255,255,0.06)",
                        color: "#fff",
                        cursor: "pointer",
                        fontWeight: 900,
                      }}
                    >
                      이 ID로 선택
                    </button>
                  </div>
                ) : (
                  filtered.map((id) => (
                    <div
                      key={id}
                      onClick={() => pickEvent(id)}
                      style={{
                        padding: "10px 12px",
                        cursor: "pointer",
                        borderBottom: "1px solid rgba(255,255,255,0.06)",
                        fontSize: 13,
                        opacity: 0.95,
                      }}
                    >
                      {id}
                    </div>
                  ))
                )}
              </div>
            ) : null}

            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.65 }}>
              현재 eventId: <b>{eventId || "-"}</b>
            </div>
          </div>

          {/* 바로가기 */}
          {eventId ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
              <button
                onClick={copyUploadUrl}
               style={{
                  padding: "10px 12px",
                 borderRadius: 999,
                 border: "1px solid rgba(255,255,255,0.18)",
                 background: "transparent",
                 color: "#fff",
                 fontWeight: 900,
                 cursor: "pointer",
               }}
            >
               업로드 링크 복사
            </button>

              <Link
                href={`/e/${encodeURIComponent(eventId)}`}
                style={{ padding: "10px 12px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.18)", color: "#fff", textDecoration: "none", fontWeight: 900 }}
              >
                행사 페이지로 →
              </Link>
              <Link
                href={`/find?eventId=${encodeURIComponent(eventId)}`}
                style={{ padding: "10px 12px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.18)", color: "#fff", textDecoration: "none", fontWeight: 900 }}
              >
                /find 테스트 →
              </Link>
              {/* ✅ 주최사용 고정 업로드 링크 */}
              <Link
                href={`/admin/upload?eventId=${encodeURIComponent(eventId)}`}
                style={{ padding: "10px 12px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.18)", color: "#fff", textDecoration: "none", fontWeight: 900 }}
              >
                주최사용 업로드 링크 →
              </Link>
            </div>
          ) : null}
        </div>

        {/* 메타 편집 */}
        <div style={{ marginTop: 14, border: "1px solid #1f1f1f", borderRadius: 18, background: "#070707", padding: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 950, marginBottom: 10 }}>행사 메타데이터</div>

          {loading ? (
            <div style={{ opacity: 0.75 }}>불러오는 중…</div>
          ) : !activeMeta ? (
            <div style={{ opacity: 0.75 }}>eventId를 선택해줘</div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 12, alignItems: "start" }}>
                <div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>제목</div>
                  <input
                    value={activeMeta.title}
                    onChange={(e) => setMeta({ ...activeMeta, title: e.target.value })}
                    disabled={saving}
                    style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #222", background: "#000", color: "#fff", outline: "none" }}
                  />

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 10 }}>
                    <div>
                      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>연도</div>
                      <input
                        type="number"
                        value={activeMeta.year}
                        onChange={(e) => setMeta({ ...activeMeta, year: Number(e.target.value) })}
                        disabled={saving}
                        style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #222", background: "#000", color: "#fff" }}
                      />
                    </div>
                    

                    <div>
                      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>상태</div>
                      <select
                        value={activeMeta.status}
                        onChange={(e) => setMeta({ ...activeMeta, status: e.target.value as any })}
                        disabled={saving}
                        style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #222", background: "#000", color: "#fff" }}
                      >
                        <option value="live">live</option>
                        <option value="draft">draft</option>
                        <option value="archived">archived</option>
                      </select>
                    </div>

                    <div>
                      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>지역</div>
                      <input
                        value={activeMeta.location}
                        onChange={(e) => setMeta({ ...activeMeta, location: e.target.value })}
                        disabled={saving}
                        style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #222", background: "#000", color: "#fff", outline: "none" }}
                      />
                    </div>
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>거리(쉼표로 구분)</div>
                    <input
                      value={activeMeta.distances.join(", ")}
                      onChange={(e) => setMeta({ ...activeMeta, distances: parseDistances(e.target.value) })}
                      disabled={saving}
                      placeholder="예) 100K, 50K, 25K"
                      style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #222", background: "#000", color: "#fff", outline: "none" }}
                    />
                  </div>
                  <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
                    <button
                      onClick={saveMeta}
                      disabled={saving}
                      style={{
                        padding: "12px 14px",
                        borderRadius: 999,
                        border: "1px solid #1f1f1f",
                        background: saving ? "#222" : "#ff5a2a",
                        color: saving ? "#aaa" : "#000",
                        fontWeight: 950,
                        cursor: saving ? "not-allowed" : "pointer",
                      }}
                    >
                      메타 저장
                    </button>

                    <div style={{ ...pill, opacity: 0.75 }}>eventId: {eventId}</div>
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>로고</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 54, height: 54, borderRadius: 14, border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)", overflow: "hidden", display: "grid", placeItems: "center" }}>
                      {activeMeta.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={activeMeta.logoUrl} alt="logo" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : (
                        <div style={{ fontSize: 11, opacity: 0.6 }}>LOGO</div>
                      )}
                    </div>
                    <input
                      type="file"
                      accept="image/*"
                      disabled={saving}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadMetaImage("logo", f);
                      }}
                    />
                  </div>

                  <div style={{ marginTop: 12, fontSize: 12, opacity: 0.7, marginBottom: 8 }}>대표 이미지(히어로)</div>
                  <div style={{ borderRadius: 16, border: "1px solid rgba(255,255,255,0.14)", overflow: "hidden", background: "rgba(255,255,255,0.06)" }}>
                    <div style={{ height: 140, background: "#000" }}>
                      {activeMeta.heroUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={activeMeta.heroUrl} alt="hero" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : (
                        <div style={{ height: "100%", display: "grid", placeItems: "center", opacity: 0.65 }}>
                          대표 이미지를 업로드해줘
                        </div>
                      )}
                    </div>
                    <div style={{ padding: 10 }}>
                      <input
                        type="file"
                        accept="image/*"
                        disabled={saving}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) uploadMetaImage("hero", f);
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Moments */}
              <div style={{ marginTop: 16, borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 16, fontWeight: 950 }}>대표사진 (Moments)</div>
                  <div style={{ ...pill }}>{momentIds.size}/8 선택됨</div>

                  <button
                    onClick={loadPhotos}
                    disabled={saving || loadingPhotos}
                    style={{
                      marginLeft: "auto",
                      padding: "10px 12px",
                      borderRadius: 999,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "transparent",
                      color: "#fff",
                      cursor: saving || loadingPhotos ? "not-allowed" : "pointer",
                      fontWeight: 900,
                      opacity: 0.9,
                    }}
                  >
                    {loadingPhotos ? "불러오는 중…" : "사진 불러오기"}
                  </button>

                  <button
                    onClick={applyAutoMoments}
                    disabled={saving || photos.length === 0}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 999,
                      border: "1px solid rgba(255,255,255,0.18)",
                      background: "transparent",
                      color: "#fff",
                      cursor: saving || photos.length === 0 ? "not-allowed" : "pointer",
                      fontWeight: 900,
                      opacity: 0.9,
                    }}
                  >
                    최신 8장 자동선택
                  </button>

                  <button
                    onClick={saveMoments}
                    disabled={saving}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 999,
                      border: "1px solid #1f1f1f",
                      background: saving ? "#222" : "#ff5a2a",
                      color: saving ? "#aaa" : "#000",
                      cursor: saving ? "not-allowed" : "pointer",
                      fontWeight: 950,
                    }}
                  >
                    대표사진 저장
                  </button>
                </div>

                {photos.length === 0 ? (
                  <div style={{ marginTop: 10, fontSize: 13, opacity: 0.7 }}>
                    아직 목록이 없어요. <b>/admin/upload</b>에서 사진을 먼저 올린 뒤 “사진 불러오기”를 눌러줘.
                  </div>
                ) : (
                  <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
                    {photos.map((p) => {
                      const on = momentIds.has(p.id);
                      return (
                        <div
                          key={p.id}
                          onClick={() => toggleMoment(p)}
                          style={{
                            borderRadius: 14,
                            border: on ? "1px solid rgba(255,90,42,0.9)" : "1px solid rgba(255,255,255,0.12)",
                            background: "#0b0b0b",
                            overflow: "hidden",
                            cursor: "pointer",
                            position: "relative",
                          }}
                          title="클릭해서 대표사진 토글"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={p.downloadURL} alt={p.fullPath} style={{ width: "100%", height: 110, objectFit: "cover" }} />
                          <div style={{ padding: 8, fontSize: 11, opacity: 0.7 }}>{(p.fullPath || "").split("/").pop()}</div>
                          <div style={{ position: "absolute", top: 8, left: 8, ...pill }}>{on ? "✅ 선택" : "선택"}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* 미리보기 */}
        {activeMeta ? (
          <div style={{ marginTop: 14, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 18, overflow: "hidden" }}>
            <div style={{ padding: 12, background: "rgba(255,255,255,0.04)", fontWeight: 950 }}>미리보기(간단)</div>
            <div style={{ padding: 14, background: "#000" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 52, height: 52, borderRadius: 14, border: "1px solid rgba(255,255,255,0.14)", overflow: "hidden", background: "rgba(255,255,255,0.06)", display: "grid", placeItems: "center" }}>
                  {activeMeta.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={activeMeta.logoUrl} alt="logo" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <div style={{ fontSize: 11, opacity: 0.6 }}>LOGO</div>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 950 }}>{activeMeta.title || activeMeta.id}</div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    {activeMeta.location || "지역 미정"} · {activeMeta.year} · {activeMeta.status}
                    {activeMeta.distances?.length ? ` · ${activeMeta.distances.join("/")}` : ""}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 12, borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,0.12)" }}>
                <div style={{ height: 160, background: "#050505" }}>
                  {activeMeta.heroUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={activeMeta.heroUrl} alt="hero" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <div style={{ height: "100%", display: "grid", placeItems: "center", opacity: 0.65 }}>
                      대표 이미지 없음 (히어로 업로드 추천)
                    </div>
                  )}
                </div>
              </div>

              <div style={{ marginTop: 12, fontWeight: 950 }}>MOMENTS</div>
              <div style={{ marginTop: 8, display: "flex", gap: 10, overflowX: "auto", paddingBottom: 8 }}>
                {(activeMeta.moments ?? []).map((m) => (
                  <div key={m.photoId} style={{ minWidth: 160, borderRadius: 14, overflow: "hidden", border: "1px solid rgba(255,255,255,0.12)" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.url} alt={m.photoId} style={{ width: "100%", height: 100, objectFit: "cover" }} />
                  </div>
                ))}
                {(activeMeta.moments?.length ?? 0) === 0 ? <div style={{ opacity: 0.65, fontSize: 13 }}>대표사진을 선택하면 여기에도 표시돼요.</div> : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );

}
