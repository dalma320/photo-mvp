"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ref, uploadBytes } from "firebase/storage";
import { storage } from "../../lib/firebaseClient";

function makeUid() {
  // 최신 브라우저 OK
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // fallback
  return `uid_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export default function SelfieClient({ eventId }: { eventId: string }) {
  const router = useRouter();

  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canGo = useMemo(() => !!eventId && !!file && !busy, [eventId, file, busy]);

  const onStart = async () => {
    if (!eventId) {
      setErr("eventId가 없어요. 행사 홈에서 다시 들어와줘!");
      return;
    }
    if (!file) {
      setErr("셀카를 선택해줘!");
      return;
    }

    try {
      setBusy(true);
      setErr(null);

      const uid = makeUid();
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();

      // ✅ find-client가 쓰는 경로와 동일하게 저장
      const path = `events/${eventId}/selfies/${uid}.${ext}`;
      const r = ref(storage, path);

      await uploadBytes(r, file);

      // ✅ 업로드 성공 → 결과 페이지로
      router.push(`/find?eventId=${encodeURIComponent(eventId)}&uid=${encodeURIComponent(uid)}`);
    } catch (e) {
      console.error(e);
      setErr("업로드에 실패했어요. 다시 시도해줘!");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: 24 }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        {/* Top */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <Link
            href={eventId ? `/e/${eventId}` : "/"}
            style={{ color: "#fff", opacity: 0.8, textDecoration: "none" }}
          >
            ← 행사 홈
          </Link>
          <div style={{ fontSize: 18, fontWeight: 950 }}>셀카 업로드</div>
        </div>

        {/* Card */}
        <div
          style={{
            borderRadius: 22,
            border: "1px solid #1f1f1f",
            background: "linear-gradient(180deg, #0a0a0a, #000)",
            padding: 18,
          }}
        >
          <div style={{ width: 120, height: 120, borderRadius: 28, border: "2px solid #2a2a2a", display: "grid", placeItems: "center", margin: "0 auto 16px" }}>
            <div style={{ fontSize: 44 }}>🙂</div>
          </div>

          <div style={{ textAlign: "center", fontSize: 16, fontWeight: 950, marginBottom: 6 }}>
            셀카를 올려줘!
          </div>
          <div style={{ textAlign: "center", fontSize: 13, opacity: 0.75, marginBottom: 14 }}>
            업로드 후 행사 사진에서 내 얼굴과 비슷한 사진을 찾아줄게.
          </div>

          <div
            style={{
              border: "1px solid #222",
              borderRadius: 18,
              padding: 14,
              background: "#070707",
              marginBottom: 12,
            }}
          >
            <input
              type="file"
              accept="image/*"
              capture="user"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy}
              style={{ width: "100%" }}
            />
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
              {file ? `선택됨: ${file.name}` : "정면 얼굴이 잘 보이는 사진이 좋아요"}
            </div>
          </div>

          {err ? <div style={{ color: "#ffcc00", marginBottom: 10 }}>{err}</div> : null}

          <button
            onClick={onStart}
            disabled={!canGo}
            style={{
              width: "100%",
              padding: 14,
              borderRadius: 999,
              border: "1px solid #1f1f1f",
              background: canGo ? "#ff5a2a" : "#222",
              color: canGo ? "#000" : "#aaa",
              fontWeight: 950,
              cursor: canGo ? "pointer" : "not-allowed",
            }}
          >
            {busy ? "업로드 중…" : "내 사진 찾기 시작"}
          </button>

          <div style={{ textAlign: "center", marginTop: 10, fontSize: 12, opacity: 0.6 }}>
            결과가 없으면 셀카를 다시 찍어보는 걸 추천해요.
          </div>
        </div>

        {/* Secondary */}
        <div style={{ marginTop: 12 }}>
          <Link
            href={`/p?eventId=${encodeURIComponent(eventId || "")}`}
            style={{
              display: "block",
              padding: 14,
              borderRadius: 999,
              textAlign: "center",
              border: "1px solid rgba(255,255,255,0.22)",
              color: "#fff",
              fontWeight: 900,
              textDecoration: "none",
              opacity: 0.9,
            }}
          >
            전체 사진 먼저 보기
          </Link>
        </div>
      </div>
    </main>
  );
}
