"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { getDownloadURL, ref } from "firebase/storage";
import { db, storage } from "@/lib/firebaseClient";

type MatchRow = {
  id: string;
  photo_path?: string;
  similarity?: number;
  score?: number;
  [k: string]: any;
};

function toPct(n: any) {
  const v = Number(n ?? 0);
  return v <= 1 ? v * 100 : v;
}

async function fetchLatestSelfieKey(eventId: string, uid: string) {
  // selfies: (event_id, uid) 최신 1개
  const q1 = query(
    collection(db, "selfies"),
    where("event_id", "==", eventId),
    where("uid", "==", uid),
    orderBy("created_at", "desc"),
    limit(1)
  );

  const snap = await getDocs(q1);
  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data() as any;

  // ✅ 우리가 photo_key 방식으로 가기로 했으니 1순위는 photo_key
  // 없으면 doc.id fallback
  return (data.photo_key as string) || doc.id;
}

async function fetchMatchesByUid(eventId: string, uid: string) {
  // matches (event_id, uid) 우선 시도: similarity -> score 순
  const col = collection(db, "matches");

  try {
    const q1 = query(
      col,
      where("event_id", "==", eventId),
      where("uid", "==", uid),
      orderBy("similarity", "desc"),
      limit(50)
    );
    const s1 = await getDocs(q1);
    if (!s1.empty) return s1.docs;
  } catch {}

  try {
    const q2 = query(
      col,
      where("event_id", "==", eventId),
      where("uid", "==", uid),
      orderBy("score", "desc"),
      limit(50)
    );
    const s2 = await getDocs(q2);
    if (!s2.empty) return s2.docs;
  } catch {}

  // eventId 필드로 저장된 경우도 대비
  try {
    const q3 = query(
      col,
      where("eventId", "==", eventId),
      where("uid", "==", uid),
      orderBy("similarity", "desc"),
      limit(50)
    );
    const s3 = await getDocs(q3);
    if (!s3.empty) return s3.docs;
  } catch {}

  return [];
}

async function fetchMatchesBySelfieId(eventId: string, selfieKey: string) {
  // matches (event_id, selfie_id) 조회
  const col = collection(db, "matches");

  try {
    const q1 = query(
      col,
      where("event_id", "==", eventId),
      where("selfie_id", "==", selfieKey),
      orderBy("similarity", "desc"),
      limit(50)
    );
    const s1 = await getDocs(q1);
    if (!s1.empty) return s1.docs;
  } catch {}

  try {
    const q2 = query(
      col,
      where("event_id", "==", eventId),
      where("selfie_id", "==", selfieKey),
      orderBy("score", "desc"),
      limit(50)
    );
    const s2 = await getDocs(q2);
    if (!s2.empty) return s2.docs;
  } catch {}

  // eventId 필드로 저장된 경우도 대비
  try {
    const q3 = query(
      col,
      where("eventId", "==", eventId),
      where("selfie_id", "==", selfieKey),
      orderBy("similarity", "desc"),
      limit(50)
    );
    const s3 = await getDocs(q3);
    if (!s3.empty) return s3.docs;
  } catch {}

  return [];
}

export default function Page() {
  const sp = useSearchParams();
  const eventId = sp.get("eventId") ?? "";
  const uid = sp.get("uid") ?? "";

  const ok = useMemo(() => !!eventId && !!uid, [eventId, uid]);

  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<MatchRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [imgUrls, setImgUrls] = useState<Record<string, string>>({});
  const [selfieKey, setSelfieKey] = useState<string | null>(null);

  const normalize = (docs: any[]) =>
    docs.map((d) => {
      const data = d.data() as any;
      return {
        id: d.id,
        ...data,
        photo_path:
          data.photo_path ??
          data.photoPath ??
          data.storage_path ??
          data.storagePath ??
          data.matched_photo_path,
        similarity: data.similarity,
        score: data.score,
      } as MatchRow;
    });

  const load = async () => {
    if (!ok) return;

    setLoading(true);
    setStatus("조회 중...");
    setRows([]);

    try {
      // 0) 최신 selfieKey 확보 (없을 수도 있음)
      const latestKey = await fetchLatestSelfieKey(eventId, uid);
      setSelfieKey(latestKey);

      // 1) uid 기반 matches 먼저 시도
      const byUidDocs = await fetchMatchesByUid(eventId, uid);
      if (byUidDocs.length) {
        const list = normalize(byUidDocs);
        setRows(list);
        setStatus(`매칭 ${list.length}개 (uid 기준)`);
        return;
      }

      // 2) 없으면 selfie_id(photo_key) 기준으로 시도
      if (latestKey) {
        const bySelfieDocs = await fetchMatchesBySelfieId(eventId, latestKey);
        if (bySelfieDocs.length) {
          const list = normalize(bySelfieDocs);
          setRows(list);
          setStatus(`매칭 ${list.length}개 (selfie_id 기준: ${latestKey})`);
          return;
        }
      }

      setStatus(
        latestKey
          ? `매칭 결과 없음. (selfieKey=${latestKey}) /find에서 셀카 업로드 후 5~10초 기다리고 Refresh!`
          : "selfies 문서가 아직 없어. 먼저 /find에서 셀카 업로드를 해줘!"
      );
    } catch (e: any) {
      console.error(e);
      setStatus(`오류: ${e?.message ?? String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (ok) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, eventId, uid]);

  // 이미지 URL 로드
  useEffect(() => {
    (async () => {
      const need = rows
        .map((r) => r.photo_path)
        .filter((p) => p && !imgUrls[p!]) as string[];

      if (!need.length) return;

      const pairs = await Promise.all(
        need.map(async (path) => {
          try {
            const url = await getDownloadURL(ref(storage, path));
            return [path, url] as const;
          } catch {
            return [path, ""] as const;
          }
        })
      );

      setImgUrls((prev) => {
        const next = { ...prev };
        for (const [p, u] of pairs) if (u) next[p] = u;
        return next;
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  return (
    <div
      style={{
        padding: 24,
        color: "white",
        background: "#0b0b0b",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: 42, margin: 0 }}>내 사진 보기 (TEST)</h1>

      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
        href: {typeof window !== "undefined" ? window.location.href : "(server)"}
      </div>

      {!ok && (
        <div style={{ marginTop: 16, opacity: 0.9 }}>
          <div>URL 파라미터가 필요해.</div>
          <div style={{ marginTop: 6, fontSize: 14, opacity: 0.8 }}>
            예: <code>/p?eventId=...&uid=...</code>
          </div>
        </div>
      )}

      {ok && (
        <>
          <div style={{ marginTop: 16, opacity: 0.95 }}>
            <div>eventId: {eventId}</div>
            <div>uid: {uid}</div>
            <div style={{ marginTop: 6, opacity: 0.8 }}>
              latest selfieKey: {selfieKey ?? "(없음)"}
            </div>

            <div style={{ marginTop: 10 }}>
              <button
                onClick={load}
                disabled={loading}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid #333",
                  background: "#111",
                  color: "white",
                  cursor: "pointer",
                }}
              >
                {loading ? "로딩..." : "Refresh"}
              </button>
              <span style={{ marginLeft: 12, opacity: 0.85 }}>{status}</span>
            </div>
          </div>

          <hr style={{ marginTop: 18, borderColor: "#222" }} />

          <h2 style={{ marginTop: 18, fontSize: 22 }}>매칭 결과</h2>

          {rows.length === 0 ? (
            <p style={{ opacity: 0.8 }}>
              아직 결과가 없으면 /find에서 셀카 업로드 후 잠시 기다려봐.
            </p>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                gap: 16,
                marginTop: 12,
              }}
            >
              {rows.map((r) => {
                const pct = toPct(r.similarity ?? r.score);
                const path = r.photo_path || "";
                const url = imgUrls[path];

                return (
                  <div
                    key={r.id}
                    style={{
                      border: "1px solid #222",
                      borderRadius: 16,
                      overflow: "hidden",
                      background: "#0f0f0f",
                    }}
                  >
                    <div style={{ aspectRatio: "4 / 3", background: "#151515" }}>
                      {url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={url}
                          alt={path}
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "cover",
                          }}
                        />
                      ) : (
                        <div style={{ padding: 14, opacity: 0.7 }}>
                          이미지 로딩 중...
                        </div>
                      )}
                    </div>

                    <div style={{ padding: 12 }}>
                      <div style={{ fontSize: 20, fontWeight: 700 }}>
                        {pct.toFixed(2)}%
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          opacity: 0.75,
                          wordBreak: "break-all",
                          marginTop: 6,
                        }}
                      >
                        {path}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
