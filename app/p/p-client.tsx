"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { listAll, getDownloadURL, ref as storageRef } from "firebase/storage";
import { storage } from "@/lib/firebase";

type PhotoItem = {
  fullPath: string;
  url: string;
};

export default function PClient({ eventId, focus }: { eventId: string; focus: string }) {
  // ✅ URL에서 강제로 읽기(너 프로젝트에서 제일 안정적이었음)
  const [urlEventId, setUrlEventId] = useState("");
  const [urlFocus, setUrlFocus] = useState("");

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const e =
      sp.get("eventId") ||
      sp.get("eventId2") ||
      sp.get("eventid") ||
      sp.get("event") ||
      "";
    const f = sp.get("focus") || "";
    setUrlEventId(e);
    setUrlFocus(f);
  }, []);

  const effectiveEventId = useMemo(() => eventId || urlEventId, [eventId, urlEventId]);
  const effectiveFocus = useMemo(() => focus || urlFocus, [focus, urlFocus]);

  const decodedFocus = useMemo(() => {
    try {
      return effectiveFocus ? decodeURIComponent(effectiveFocus) : "";
    } catch {
      return effectiveFocus ?? "";
    }
  }, [effectiveFocus]);

  const [items, setItems] = useState<PhotoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const refs = useRef<Record<string, HTMLDivElement | null>>({});

  // ✅ Lightbox state
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(0);

  useEffect(() => {
    if (!effectiveEventId) return;

    const run = async () => {
      try {
        setLoading(true);
        setErrMsg(null);

        const folder = storageRef(storage, `events/${effectiveEventId}/photos`);
        const res = await listAll(folder);

        const sorted = [...res.items].sort((a, b) => b.name.localeCompare(a.name));
        const urls = await Promise.all(
          sorted.map(async (item) => {
            const url = await getDownloadURL(item);
            return { fullPath: item.fullPath, url };
          })
        );

        setItems(urls);
      } catch (e: any) {
        console.error(e);
        setItems([]);
        setErrMsg("사진을 불러오지 못했어요. (권한/경로를 확인해 주세요)");
      } finally {
        setLoading(false);
      }
    };

    run();
  }, [effectiveEventId]);

  // ✅ focus가 있으면 해당 카드로 스크롤 + lightbox 인덱스도 맞춰두기
  useEffect(() => {
    if (!decodedFocus) return;
    if (items.length === 0) return;

    const idx = items.findIndex((x) => x.fullPath === decodedFocus);
    if (idx >= 0) setActiveIndex(idx);

    const el = refs.current[decodedFocus];
    if (!el) return;

    const t = setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 200);

    return () => clearTimeout(t);
  }, [decodedFocus, items]);

  // ✅ 키보드 컨트롤 (ESC/좌우)
  useEffect(() => {
    if (!lightboxOpen) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxOpen(false);
      if (e.key === "ArrowLeft") setActiveIndex((v) => Math.max(0, v - 1));
      if (e.key === "ArrowRight") setActiveIndex((v) => Math.min(items.length - 1, v + 1));
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxOpen, items.length]);

  const openAt = (i: number) => {
    setActiveIndex(i);
    setLightboxOpen(true);
  };

  const active = items[activeIndex];

  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: 24 }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <Link
            href={effectiveEventId ? `/e/${effectiveEventId}` : "/"}
            style={{ color: "#fff", opacity: 0.8, textDecoration: "none" }}
          >
            ← 뒤로
          </Link>
          <div style={{ fontSize: 18, fontWeight: 950 }}>전체 사진</div>

          <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.6 }}>
            {items.length ? `${items.length}장` : ""}
          </div>
        </div>

        {!effectiveEventId ? (
          <div style={{ opacity: 0.7 }}>eventId가 없어요. 행사에서 들어와줘!</div>
        ) : loading ? (
          <div style={{ opacity: 0.7 }}>불러오는 중…</div>
        ) : errMsg ? (
          <div style={{ opacity: 0.85 }}>{errMsg}</div>
        ) : items.length === 0 ? (
          <div style={{ opacity: 0.7 }}>사진이 없어요.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
            {items.map((p, idx) => {
              const isFocus = decodedFocus && p.fullPath === decodedFocus;

              return (
                <div
                  key={p.fullPath}
                  ref={(el) => {
                    refs.current[p.fullPath] = el;
                  }}
                  onClick={() => openAt(idx)}
                  style={{
                    cursor: "pointer",
                    borderRadius: 18,
                    overflow: "hidden",
                    border: isFocus ? "2px solid #ffcc00" : "1px solid #222",
                    background: "#0b0b0b",
                    boxShadow: isFocus ? "0 0 0 3px rgba(255,204,0,0.18)" : "none",
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt="photo"
                    style={{ width: "100%", height: 180, objectFit: "cover", display: "block" }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ✅ Lightbox */}
     {/* ✅ Lightbox */}
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

        // ✅ 핵심: 이미지가 “자연 비율”로 들어오도록 내부에 패딩 + 가운데 정렬
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 12,

        // ❗ overflow hidden 제거 (코너 때문에 굳이 필요 없고, 잘림 체감 원인 될 때가 있음)
        overflow: "visible",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={active.url}
        alt="active"
        style={{
          // ✅ 핵심: 100% 강제 금지
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

      {/* Close */}
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

      {/* Prev */}
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

      {/* Next */}
      <button
        onClick={() => setActiveIndex((v) => Math.min(items.length - 1, v + 1))}
        disabled={activeIndex >= items.length - 1}
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
          cursor: activeIndex >= items.length - 1 ? "not-allowed" : "pointer",
          opacity: activeIndex >= items.length - 1 ? 0.4 : 1,
          fontSize: 18,
        }}
        aria-label="next"
      >
        ›
      </button>

      {/* Counter */}
      <div
        style={{
          position: "absolute",
          bottom: 10,
          left: "50%",
          transform: "translateX(-50%)",
          padding: "6px 10px",
          borderRadius: 999,
          border: "1px solid #333",
          background: "rgba(10,10,10,0.7)",
          fontSize: 12,
          opacity: 0.9,
        }}
      >
        {activeIndex + 1} / {items.length}
      </div>
    </div>
  </div>
) : null}

    </main>
  );
}
