"use client";

import { useMemo, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  where,
  updateDoc,
  serverTimestamp,
  addDoc,
} from "firebase/firestore";
import { db, storage } from "../../../lib/firebaseClient";
import { deleteObject, ref as sref } from "firebase/storage";
import { embedFace } from "../../../lib/faceServer";

type Row = {
  id: string;
  fullPath: string;
  downloadURL: string;
  filename: string;
  status: "uploaded" | "embedded" | "no_face" | "error";
  errorMessage?: string | null;
  bytes?: number;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export default function IngestClient() {
  const [eventId, setEventId] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState("");

  const [filter, setFilter] = useState<"all" | "failed">("failed");
  const [alsoDeleteStorage, setAlsoDeleteStorage] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [concurrency, setConcurrency] = useState(4);

  const canLoad = useMemo(() => eventId.trim().length > 0 && !loading, [eventId, loading]);
  const eid = eventId.trim();

  const toggle = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const load = async () => {
    if (!eid) return;
    setLoading(true);
    setLog("불러오는 중...");
    clearSelection();

    try {
      // status 필드가 없는 기존 문서도 있을 수 있어서 전체 로드 후 프론트에서 필터링
      const snap = await getDocs(collection(db, "events", eid, "photos"));

      const list: Row[] = snap.docs.map((d) => {
        const v: any = d.data();
        const st = (v.status as Row["status"]) || (Array.isArray(v.embedding) && v.embedding.length ? "embedded" : "uploaded");

        return {
          id: d.id,
          fullPath: String(v.fullPath || ""),
          downloadURL: String(v.downloadURL || ""),
          filename: String(v.filename || ""),
          status: st,
          errorMessage: v.errorMessage ?? null,
          bytes: typeof v.bytes === "number" ? v.bytes : undefined,
        };
      });

      setRows(list);

      const embedded = list.filter((r) => r.status === "embedded").length;
      const failed = list.filter((r) => r.status === "no_face" || r.status === "error").length;
      const uploaded = list.filter((r) => r.status === "uploaded").length;

      setLog(`총 ${list.length}개 | embedded=${embedded} | failed=${failed} | uploaded=${uploaded}`);
    } catch (e: any) {
      console.error(e);
      setLog(`로드 실패: ${String(e?.message || e)}`);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  const visibleRows = useMemo(() => {
    if (filter === "all") return rows;
    return rows.filter((r) => r.status === "no_face" || r.status === "error" || r.status === "uploaded");
  }, [rows, filter]);

  const selectAllVisible = () => {
    setSelected(new Set(visibleRows.map((r) => r.id)));
  };

  const unselectAll = () => clearSelection();

  const updateRowLocal = (id: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  // ✅ 핵심: 특정 doc(사진 1장)에 대해 embedding 재시도
  const ingestOne = async (row: Row) => {
    // 1) 상태를 먼저 uploaded로 리셋(혹은 processing 같은 상태가 있으면 더 좋지만 여기선 간단히)
    await updateDoc(doc(db, "events", eid, "photos", row.id), {
      status: "uploaded",
      errorMessage: null,
      updatedAt: serverTimestamp(),
    });

    // 2) downloadURL을 사용해 임베딩 시도 (faceServer.ts가 URL도 처리 가능)
    const res = await embedFace(row.downloadURL);

    if (!res.ok) {
      const st: Row["status"] = res.code === "NO_FACE" ? "no_face" : "error";

      await updateDoc(doc(db, "events", eid, "photos", row.id), {
        status: st,
        errorMessage: res.message,
        tried: res.tried ?? [],
        updatedAt: serverTimestamp(),
      });

      return { ok: false as const, status: st, message: res.message };
    }

    // 3) 성공: embedding 저장
    await updateDoc(doc(db, "events", eid, "photos", row.id), {
      status: "embedded",
      embedding: res.embedding,
      errorMessage: null,
      tried: res.tried ?? [],
      embeddedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    return { ok: true as const };
  };

  // 병렬 처리(동시성 제한)
  const runQueue = async (targets: Row[]) => {
    const q = [...targets];
    let ok = 0;
    let fail = 0;

    const worker = async (idx: number) => {
      while (q.length) {
        const r = q.shift();
        if (!r) break;

        try {
          updateRowLocal(r.id, { status: "uploaded", errorMessage: null });
          const out = await ingestOne(r);

          if (out.ok) {
            ok += 1;
            updateRowLocal(r.id, { status: "embedded", errorMessage: null });
            setLog((prev) => `${prev}\n✅ ${r.filename || r.id} embedded`);
          } else {
            fail += 1;
            updateRowLocal(r.id, { status: out.status, errorMessage: out.message });
            setLog((prev) => `${prev}\n❌ ${r.filename || r.id} ${out.status}: ${out.message}`);
          }
        } catch (e: any) {
          fail += 1;
          const msg = String(e?.message || e);
          updateRowLocal(r.id, { status: "error", errorMessage: msg });
          setLog((prev) => `${prev}\n❌ ${r.filename || r.id} error: ${msg}`);
        }
      }
      setLog((prev) => `${prev}\nworker#${idx} done`);
    };

    const workers = Array.from({ length: clamp(concurrency, 1, 8) }, (_, i) => worker(i + 1));
    await Promise.all(workers);

    setLog((prev) => `${prev}\n\n완료: ok=${ok}, fail=${fail}`);
  };

  const ingestSelected = async () => {
    if (!eid) return alert("eventId 입력해줘!");
    if (selected.size === 0) return alert("선택된 항목이 없어!");

    const targets = rows.filter((r) => selected.has(r.id));
    if (!targets.length) return alert("선택된 항목이 없어!");

    setLoading(true);
    setLog(`선택 ${targets.length}개 임베딩 재시도 시작...`);

    try {
      await runQueue(targets);
      await load();
    } finally {
      setLoading(false);
    }
  };

  const ingestFailedOnly = async () => {
    if (!eid) return alert("eventId 입력해줘!");
    const targets = rows.filter((r) => r.status === "no_face" || r.status === "error" || r.status === "uploaded");
    if (!targets.length) return alert("재시도할 실패/미처리 항목이 없어!");

    if (!confirm(`실패/미처리 ${targets.length}개를 임베딩 재시도할까?`)) return;

    setLoading(true);
    setLog(`실패/미처리 ${targets.length}개 임베딩 재시도 시작...`);

    try {
      await runQueue(targets);
      await load();
    } finally {
      setLoading(false);
    }
  };

  const deleteSelected = async () => {
    if (!eid) return alert("eventId 입력해줘!");
    if (selected.size === 0) return alert("선택된 항목이 없어!");

    if (!confirm(`선택 ${selected.size}개 삭제할까? (Firestore${alsoDeleteStorage ? " + Storage" : ""})`)) return;

    setLoading(true);
    setLog("삭제 중...");

    try {
      const targets = rows.filter((r) => selected.has(r.id));

      let ok = 0;
      for (const r of targets) {
        // Firestore 문서 삭제
        await deleteDoc(doc(db, "events", eid, "photos", r.id));

        // Storage도 같이 삭제(옵션)
        if (alsoDeleteStorage && r.fullPath) {
          try {
            await deleteObject(sref(storage, r.fullPath));
          } catch (e) {
            // 이미 지워진 경우 무시
            console.warn("storage delete fail:", r.fullPath, e);
          }
        }
        ok += 1;
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

  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: 24 }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <div style={{ fontSize: 24, fontWeight: 950, marginBottom: 12 }}>/admin/ingest</div>

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
              disabled={!canLoad}
              style={{
                padding: "12px 14px",
                borderRadius: 999,
                border: "1px solid #1f1f1f",
                background: !canLoad ? "#222" : "#ff5a2a",
                color: !canLoad ? "#aaa" : "#000",
                fontWeight: 950,
                cursor: !canLoad ? "not-allowed" : "pointer",
              }}
            >
              목록 불러오기
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 12, opacity: 0.7 }}>동시 처리</div>
              <input
                type="number"
                value={concurrency}
                min={1}
                max={8}
                onChange={(e) => setConcurrency(clamp(Number(e.target.value), 1, 8))}
                disabled={loading}
                style={{
                  width: 80,
                  padding: 10,
                  borderRadius: 12,
                  border: "1px solid #222",
                  background: "#000",
                  color: "#fff",
                }}
              />
            </div>

            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as any)}
              disabled={loading}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid #222",
                background: "#000",
                color: "#fff",
              }}
            >
              <option value="failed">실패/미처리만</option>
              <option value="all">전체</option>
            </select>

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, opacity: 0.9 }}>
              <input
                type="checkbox"
                checked={alsoDeleteStorage}
                onChange={(e) => setAlsoDeleteStorage(e.target.checked)}
                disabled={loading}
              />
              삭제 시 Storage도 같이
            </label>

            <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.75, whiteSpace: "pre-line" }}>{log}</div>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              onClick={selectAllVisible}
              disabled={loading || visibleRows.length === 0}
              style={{
                padding: "12px 14px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "transparent",
                color: "#fff",
                fontWeight: 900,
                cursor: loading ? "not-allowed" : "pointer",
                opacity: loading ? 0.5 : 1,
              }}
            >
              보이는 항목 전체 선택
            </button>

            <button
              onClick={unselectAll}
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
              선택 해제
            </button>

            <button
              onClick={ingestSelected}
              disabled={loading || selected.size === 0}
              style={{
                padding: "12px 14px",
                borderRadius: 999,
                border: "1px solid #1f1f1f",
                background: selected.size === 0 ? "#222" : "#ff5a2a",
                color: selected.size === 0 ? "#aaa" : "#000",
                fontWeight: 950,
                cursor: loading || selected.size === 0 ? "not-allowed" : "pointer",
                opacity: loading ? 0.5 : 1,
              }}
            >
              선택 임베딩 재시도 ({selected.size})
            </button>

            <button
              onClick={ingestFailedOnly}
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
              실패/미처리만 일괄 재시도
            </button>

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
              선택 삭제
            </button>
          </div>
        </div>

        {/* 리스트 */}
        <div style={{ marginTop: 14 }}>
          {visibleRows.length === 0 ? (
            <div style={{ opacity: 0.7 }}>표시할 항목이 없어요.</div>
          ) : (
            <div style={{ border: "1px solid #1f1f1f", borderRadius: 18, background: "#070707", padding: 12 }}>
              <div style={{ display: "grid", gap: 8 }}>
                {visibleRows.map((r) => (
                  <label
                    key={r.id}
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,0.10)",
                      background:
                        r.status === "embedded"
                          ? "rgba(0,255,0,0.05)"
                          : r.status === "no_face"
                          ? "rgba(255,180,0,0.06)"
                          : r.status === "error"
                          ? "rgba(255,0,0,0.06)"
                          : "rgba(255,255,255,0.03)",
                      cursor: loading ? "not-allowed" : "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      disabled={loading}
                    />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.95 }}>
                        {r.status === "embedded"
                          ? "✅ embedded"
                          : r.status === "no_face"
                          ? "⚠️ no_face"
                          : r.status === "error"
                          ? "❌ error"
                          : "• uploaded"}
                        {"  "}
                        {r.filename || r.id}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.7 }}>{r.fullPath}</div>
                      {r.errorMessage ? (
                        <div style={{ marginTop: 4, fontSize: 12, opacity: 0.8, whiteSpace: "pre-line" }}>
                          {r.errorMessage}
                        </div>
                      ) : null}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 14, fontSize: 12, opacity: 0.65, lineHeight: 1.6 }}>
          ✅ 사용법<br />
          1) eventId 입력 → “목록 불러오기”<br />
          2) 실패/미처리만 보고 싶으면 필터 “실패/미처리만” 유지<br />
          3) “실패/미처리만 일괄 재시도” 또는 선택 후 “선택 임베딩 재시도”<br />
          4) 필요시 “선택 삭제”(Storage까지 같이 삭제 가능)
        </div>
      </div>
    </main>
  );
}
