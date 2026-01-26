"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase";

type EventDoc = {
  title: string;
  subtitle?: string;
  year?: number;
  status?: string;
  logoUrl?: string; // ✅ 로고 이미지 URL
};

export default function HomePage() {
  const [events, setEvents] = useState<Array<{ id: string } & EventDoc>>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");

  useEffect(() => {
    const run = async () => {
      const q = query(collection(db, "events"), orderBy("year", "desc"));
      const snap = await getDocs(q);
      const list = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as EventDoc),
      }));
      setEvents(list);
      setLoading(false);
    };

    run().catch((e) => {
      console.error(e);
      setLoading(false);
    });
  }, []);

  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return events;

    return events.filter((ev) => {
      return (
        (ev.title ?? "").toLowerCase().includes(k) ||
        (ev.subtitle ?? "").toLowerCase().includes(k) ||
        String(ev.year ?? "").includes(k) ||
        (ev.status ?? "").toLowerCase().includes(k)
      );
    });
  }, [events, keyword]);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#000",
        color: "#fff",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <h1 style={{ fontSize: 28, fontWeight: 900, marginBottom: 14 }}>
          행사 찾기
        </h1>

        <input
          placeholder="행사명 / 지역 / 연도 검색 (예: oxfam, inje, 2025)"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{
            width: "100%",
            padding: 14,
            borderRadius: 14,
            border: "1px solid #222",
            background: "#0b0b0b",
            color: "#fff",
            caretColor: "#fff",
            marginBottom: 20,
          }}
        />

        {loading ? (
          <div style={{ opacity: 0.7 }}>불러오는 중…</div>
        ) : (
          <div style={{ display: "grid", gap: 14 }}>
            {filtered.map((ev) => (
              <Link
                key={ev.id}
                href={`/e/${ev.id}`}
                style={{
                  display: "block",
                  textDecoration: "none",
                  color: "#fff",
                  background: "#0b0b0b",
                  border: "1px solid #222",
                  borderRadius: 20,
                  padding: 18,
                }}
              >
                <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                  {/* Logo */}
                  <div
                    style={{
                      width: 54,
                      height: 54,
                      borderRadius: 16,
                      border: "1px solid #222",
                      background: "#111",
                      display: "grid",
                      placeItems: "center",
                      overflow: "hidden",
                      flexShrink: 0,
                    }}
                  >
                    {ev.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                   <img
                     src={ev.logoUrl}
 		     alt="logo"
  		     style={{
  	 	     width: "100%",
 		     height: "100%",
 		     objectFit: "contain",   // ✅ 핵심
  		     padding: 6,             // ✅ 여백 주기
		     background: "#fff",

  }}
/>

                    ) : (
                      <div style={{ opacity: 0.6, fontSize: 12 }}>LOGO</div>
                    )}
                  </div>

                  {/* Text */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12,
                        color: "rgba(255,255,255,0.6)",
                        marginBottom: 6,
                      }}
                    >
                      {ev.year ?? ""} · {ev.status ?? "draft"}
                    </div>

                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 900,
                        marginBottom: 4,
                      }}
                    >
                      {ev.title}
                    </div>

                    <div
                      style={{
                        fontSize: 13,
                        color: "rgba(255,255,255,0.75)",
                      }}
                    >
                      {ev.subtitle ?? ""}
                    </div>
                  </div>
                </div>
              </Link>
            ))}

            {filtered.length === 0 && (
              <div style={{ opacity: 0.7 }}>검색 결과가 없어요.</div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
