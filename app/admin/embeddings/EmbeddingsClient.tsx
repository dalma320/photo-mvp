"use client";

import { useMemo, useState } from "react";
import { collection, deleteDoc, doc, getDocs } from "firebase/firestore";
import { db, storage } from "../../../lib/firebaseClient";
import { deleteObject, ref as sref } from "firebase/storage";

type Row = { id: string; fullPath: string; downloadURL: string; bytes?: number; hasEmbedding: boolean };

export default function EmbeddingsClient() {
  const [eventId, setEventId] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [alsoDeleteStorage, setAlsoDeleteStorage] = useState(true);
  const [log, setLog] = useState<string>("");

  const canRun = useMemo(() => eventId.trim().length > 0 && !loading, [eventId, loading]);

  const load = async () => {
    const eid = eventId.trim();
    if (!eid) return;

    setLoading(true);
    setLog("불러오는 중...");
    setSelected(new Set());
    try {
      const snap = await getDocs(collection(db, "events", eid, "photos"));
      const list: Row[] = snap.docs.map((d) => {
        const v: any = d.data();
        return {
          id: d.id,
          fullPath: String(v.fullPath || ""),
          downloadURL: String(v.downloadURL || ""),
          bytes: typeof v.bytes === "number" ? v.bytes : undefined,
          hasEmbedding: Array.isArray(v.embedding) && v.embedding.length > 0,
        };
      });
      setRows(list);
      setLog(`총 ${list.length}개 (embedding 있음: ${list.filter((x) => x.hasEmbedding).length})`);
    } catch (e: any) {
      console.error(e);
      setLog(`실패: ${String(e?.message || e)}`);
    } finally {
      setLoading(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const delOne = async (r: Row) => {
    const eid = eventId.trim();
    // 1) Firestore 문서 삭제
    await deleteDoc(doc(db, "events", eid, "photos", r.id));

    // 2) 옵션: Storage 파일 삭제
    if (alsoDeleteStorage && r.fullPath) {
      try {
        await deleteObject(sref(storage, r.fullPath));
      } catch (e) {
        // 이미 지워졌을 수도 있으니 무시
        console.warn("storage delete fail:", r.fullPath, e);
      }
    }
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    if (!confirm(`선택 ${selected.size}개를 삭제할까? (Firestore 문서${alsoDeleteStorage ? "+Storage" : ""})`)) return;

    setLoading(true);
    setLog("삭제 중...");
    try {
      const map = new Map(rows.map((r) => [r.id, r]));
      let ok = 0;
      for (const id of selected) {
        const r = map.get(id);
        if (!r) continue;
        await delOne(r);
        ok++;
      }
      setLog(`삭제 완료: ${ok}개`);
      await load();
    } catch (e: any) {
      console.error(e);
      setLog(`삭제 실패: ${String(e?.message || e)}`);
    } finally {
      setLoading(false);
    }
  };

  const deleteAll = async () => {
    if (!rows.length) return;
    if (!confirm(`⚠️ 전부 삭제(${rows.length}개) 할까? (Firestore 문서${alsoDeleteStorage ? "+Storage" : ""})`)) return;

    setSelected(new Set(rows.map((r) => r.id)));
    await deleteSelected();
  };

  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: 24 }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <div style={{ fontSize: 24, fontWeight: 950, marginBottom: 12 }}>/admin/embeddings</div>

        <div style={{ border: "1px solid #1f1f1f", borderRadius: 18, background: "#070707", padding: 16 }}>
          <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>eventId</div>
          <input
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
            disabled={loading}
            placeholder="예) AAS2026_2"
            style={{
              width: "100%",
              padding: 12,
              borderRadius: 12,
              border: "1px solid #222",
              background: "#000",
              color: "#fff",
              outline: "none",
              fontSize: 16,
              fontWeight: 900,
            }}
          />

          <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button
              onClick={load}
              disabled={!canRun}
              style={{
                padding: "12px 14px",
                borderRadius: 999,
                border: "1px solid #1f1f1f",
                background: !canRun ? "#222" : "#ff5a2a",
                color: !canRun ? "#aaa" : "#000",
                fontWeight: 950,
                cursor: !canRun ? "not-allowed" : "pointer",
              }}
            >
              목록 불러오기
            </button>

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, opacity: 0.9 }}>
              <input
                type="checkbox"
                checked={alsoDeleteStorage}
                onChange={(e) => setAlsoDeleteStorage(e.target.checked)}
                disabled={loading}
              />
              Storage 파일도 같이 삭제
            </label>

            <button
              onClick={deleteSelected}
              disabled={loading || selected.size === 0}
              style={{
                padding: "12px 14px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "transparent",
                color: selected.size ? "#fff" : "#666",
                fontWeight: 900,
                cursor: loading || selected.size === 0 ? "not-allowed" : "pointer",
                opacity: loading || selected.size === 0 ? 0.5 : 1,
              }}
            >
              선택 삭제 ({selected.size})
            </button>

            <button
              onClick={deleteAll}
              disabled={loading || rows.length === 0}
              style={{
                padding: "12px 14px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "transparent",
                color: rows.length ? "#fff" : "#666",
                fontWeight: 900,
                cursor: loading || rows.length === 0 ? "not-allowed" : "pointer",
                opacity: loading || rows.length === 0 ? 0.5 : 1,
              }}
            >
              전부 삭제
            </button>

            <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.75 }}>{log}</div>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          {rows.length === 0 ? null : (
            <div style={{ border: "1px solid #1f1f1f", borderRadius: 18, background: "#070707", padding: 12 }}>
              <div style={{ display: "grid", gap: 8 }}>
                {rows.map((r) => (
                  <label
                    key={r.id}
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,0.10)",
                      background: "rgba(255,255,255,0.03)",
                      cursor: loading ? "not-allowed" : "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      disabled={loading}
                    />
                    <div style={{ fontSize: 12, opacity: 0.9, flex: 1 }}>
                      <div style={{ fontWeight: 900 }}>
                        {r.hasEmbedding ? "✅" : "❌"} {r.fullPath || "(no path)"}
                      </div>
                      <div style={{ opacity: 0.7 }}>{r.downloadURL ? "URL 있음" : "URL 없음"}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 14, fontSize: 12, opacity: 0.65, lineHeight: 1.6 }}>
          - Storage에서 사진을 지워도 Firestore 문서(embedding)는 남아있을 수 있어요.<br />
          - 이 페이지에서 “Firestore 문서 + (옵션) Storage 파일”을 같이 정리하세요.
        </div>
      </div>
    </main>
  );
}
