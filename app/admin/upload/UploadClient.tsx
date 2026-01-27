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
function normalizeId(s: string) {const BUILD_TAG = "UPLOAD_V2_2026-01-28_01";

  return (s || "").trim();
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

  // 업로드
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(0);
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

  const runUpload = async () => {
    const eid = normalizeId(eventId);
    if (!eid) return alert("eventId가 비어있어! 링크/입력을 확인해줘.");
    if (!files.length) return alert("사진을 선택해줘!");

    setUploading(true);
    setDone(0);
    setLogs([]);
    pushLog(`시작: eventId=${eid}, files=${files.length}`);

    try {
      await ensureEventDoc(eid);

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const label = `${i + 1}/${files.length}: ${file.name}`;

        try {
          pushLog(`업로드 중 (${label})`);

          const safeName = file.name.replace(/[^\w.\-()]/g, "_");
          const finalPath = `events/${eid}/photos/${Date.now()}_${i + 1}_${safeName}`;

          const sref = ref(storage, finalPath);
          await uploadBytes(sref, file);
          const downloadURL = await getDownloadURL(sref);
          pushLog(`업로드 완료 ✅ (${label})`, "ok");

          pushLog(`임베딩 생성 중: ${file.name}`);
          const embedding = await embedFace(file);
          if (!Array.isArray(embedding) || embedding.length === 0) {
            throw new Error("No embedding array in response");
          }

          await addDoc(collection(db, "events", eid, "photos"), {
            eventId: eid,
            fullPath: finalPath,
            downloadURL,
            fileName: file.name,
            embedding,
            embDim: embedding.length,
            createdAt: serverTimestamp(),
          });

          pushLog(`임베딩 저장 완료 ✅ (${label})`, "ok");
        } catch (err: any) {
          console.error(err);
          pushLog(`에러 ❌ (${label}): ${err?.message || String(err)}`, "err");
        } finally {
          setDone((prev) => prev + 1);
        }
      }

      pushLog("전체 완료 🎉", "ok");
      router.push(`/admin/event?eventId=${encodeURIComponent(eid)}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: 24 }}>
      <div style={{ maxWidth: 920, margin: "0 auto" }}>
        <div style={{ fontSize: 26, fontWeight: 950, marginBottom: 12 }}>/admin/upload</div>

        <div style={{ border: "1px solid #1f1f1f", borderRadius: 18, background: "#070707", padding: 16 }}>
          {isLocked ? (
            <>
              <div style={{ fontSize: 12, opacity: 0.7 }}>고정된 eventId</div>
              <div style={{ marginTop: 8, padding: 12, borderRadius: 12, border: "1px solid #222", background: "#000", fontWeight: 950 }}>
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
                placeholder="타자로 검색 (예: AAS2026)"
                disabled={uploading}
                style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #222", background: "#000", color: "#fff" }}
              />
              {openList ? (
                <div style={{ position: "absolute", top: 56, left: 0, right: 0, border: "1px solid rgba(255,255,255,0.14)", background: "#070707", borderRadius: 12, overflow: "hidden", maxHeight: 240, overflowY: "auto", zIndex: 50 }}>
                  {filtered.length === 0 ? (
                    <div style={{ padding: 12, fontSize: 12, opacity: 0.75 }}>검색 결과 없음</div>
                  ) : (
                    filtered.map((id) => (
                      <div key={id} onClick={() => pickEvent(id)} style={{ padding: 10, cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                        {id}
                      </div>
                    ))
                  )}
                </div>
              ) : null}
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.65 }}>현재 선택: <b>{eventId || "-"}</b></div>
            </div>
          )}

          <div style={{ marginTop: 14, fontSize: 12, opacity: 0.7, marginBottom: 8 }}>사진 선택 (여러 장 가능)</div>
          <div style={{ border: "1px solid #222", borderRadius: 14, padding: 12, background: "#000" }}>
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={uploading}
              onChange={(e) => setFiles(Array.from(e.target.files || []))}
              style={{ width: "100%" }}
            />
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
              {files.length ? `선택됨: ${files.length}장` : "파일을 선택해줘"}
            </div>
          </div>

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

          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
            진행: {done} / {files.length || 0}
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 950, marginBottom: 10 }}>로그</div>
          <div style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 16, background: "#070707", overflow: "hidden" }}>
            {logs.length === 0 ? (
              <div style={{ padding: 14, opacity: 0.65 }}>아직 로그가 없어요.</div>
            ) : (
              <div style={{ display: "grid", gap: 8, padding: 12 }}>
                {logs.map((l, idx) => (
                  <div key={idx} style={{ border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: "10px 12px", background: "rgba(0,0,0,0.35)" }}>
                    {l.msg}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
