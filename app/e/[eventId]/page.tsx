"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import { getDownloadURL, listAll, ref as storageRef } from "firebase/storage";
import { db, storage } from "@/lib/firebase";

type EventDoc = {
  title?: string;
  subtitle?: string;
  year?: number;
  status?: string;
  themeColor?: string;
  logoUrl?: string;
};

type Moment = {
  fullPath: string;
  url: string;
};

export default function EventHome() {
  const params = useParams();
  const eventId = params?.eventId as string | undefined;

  const [ev, setEv] = useState<EventDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [moments, setMoments] = useState<Moment[]>([]);
  const [momentsLoading, setMomentsLoading] = useState(true);

  // ✅ 행사 메타 (Firestore)
  useEffect(() => {
    if (!eventId) return;

    const run = async () => {
      try {
        setLoading(true);
        setErrMsg(null);

        const ref = doc(db, "events", eventId);
        const snap = await getDoc(ref);

        if (!snap.exists()) {
          setErrMsg("행사를 찾을 수 없어요.");
          setEv(null);
          return;
        }

        setEv(snap.data() as EventDoc);
      } catch (e) {
        console.error(e);
        setErrMsg("행사 정보를 불러오는 중 오류가 발생했어요.");
      } finally {
        setLoading(false);
      }
    };

    run();
  }, [eventId]);

  // ✅ MOMENTS (Storage 폴더에서 직접)
  useEffect(() => {
    if (!eventId) return;

    const run = async () => {
      try {
        setMomentsLoading(true);

        const folder = storageRef(storage, `events/${eventId}/photos`);
        const res = await listAll(folder);

        const sorted = [...res.items].sort((a, b) => b.name.localeCompare(a.name));
        const top = sorted.slice(0, 8);

        const urls = await Promise.all(
          top.map(async (item) => {
            const url = await getDownloadURL(item);
            return { fullPath: item.fullPath, url };
          })
        );

        setMoments(urls);
      } catch (e) {
        console.error(e);
        setMoments([]);
      } finally {
        setMomentsLoading(false);
      }
    };

    run();
  }, [eventId]);

  if (!eventId || loading) {
    return (
      <main style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: 24 }}>
        불러오는 중…
      </main>
    );
  }

  if (errMsg) {
    return (
      <main style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: 24 }}>
        <div style={{ opacity: 0.85, marginBottom: 12 }}>{errMsg}</div>
        <Link href="/" style={{ color: "#fff", opacity: 0.8, textDecoration: "none" }}>
          ← 행사 목록으로
        </Link>
      </main>
    );
  }

  const accent = ev?.themeColor ?? "#ff5a2a";

  return (
    <main style={{ minHeight: "100vh", background: "#000", color: "#fff", padding: 24 }}>
      <div style={{ maxWidth: 860, margin: "0 auto" }}>
        {/* Top bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link href="/" style={{ color: "#fff", opacity: 0.8, textDecoration: "none", fontSize: 14 }}>
            ← 행사 목록
          </Link>
          <div style={{ fontSize: 12, opacity: 0.6 }}>
            {ev?.year ?? ""} · {ev?.status ?? "draft"}
          </div>
        </div>

        {/* Hero */}
        <div style={{ marginTop: 24, marginBottom: 20 }}>
          <div
            style={{
              width: 96,
              height: 96,
              borderRadius: 28,
              border: "1px solid #222",
              background: "#111",
              display: "grid",
              placeItems: "center",
              overflow: "hidden",
              marginBottom: 14,
            }}
          >
            {ev?.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={ev.logoUrl}
                alt="event logo"
                style={{ width: "100%", height: "100%", objectFit: "contain", padding: 10 }}
              />
            ) : (
              <div style={{ opacity: 0.6, fontSize: 12 }}>LOGO</div>
            )}
          </div>

          <h1 style={{ fontSize: 34, fontWeight: 950, marginBottom: 8 }}>
            {ev?.title ?? "Untitled Event"}
          </h1>

          <div style={{ fontSize: 14, opacity: 0.75 }}>{ev?.subtitle ?? ""}</div>
        </div>

        {/* CTA */}
        <div
          style={{
            borderRadius: 22,
            border: "1px solid #1f1f1f",
            background: "linear-gradient(180deg, #0a0a0a, #000)",
            padding: 20,
          }}
        >
          <div
            style={{
              width: 120,
              height: 120,
              borderRadius: 28,
              border: "2px solid #2a2a2a",
              display: "grid",
              placeItems: "center",
              margin: "0 auto 16px",
            }}
          >
            <div style={{ fontSize: 44 }}>🙂</div>
          </div>

          <Link
            href={`/find?eventId=${eventId}`}
            style={{
              display: "block",
              padding: 16,
              borderRadius: 999,
              textAlign: "center",
              background: accent,
              color: "#000",
              fontWeight: 950,
              textDecoration: "none",
            }}
          >
            FIND YOUR MOMENTS
          </Link>

          <div style={{ textAlign: "center", marginTop: 10, opacity: 0.7 }}>
            셀카를 업로드(또는 촬영)하면 내 사진만 찾아줘요
          </div>
        </div>

        {/* Secondary */}
        <div style={{ marginTop: 12 }}>
          <Link
            href={`/p?eventId=${eventId}`}
            style={{
              display: "block",
              padding: 16,
              borderRadius: 999,
              textAlign: "center",
              border: `1px solid ${accent}`,
              color: accent,
              fontWeight: 900,
              textDecoration: "none",
            }}
          >
            BROWSE ALL PHOTOS
          </Link>
        </div>

        {/* MOMENTS */}
        <section style={{ marginTop: 30, paddingBottom: 30 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 18, fontWeight: 950 }}>MOMENTS</div>

            {/* ✅ 모두보기는 focus 없이 */}
            <Link
              href={`/p?eventId=${eventId}`}
              style={{ color: "#fff", opacity: 0.7, textDecoration: "none" }}
            >
              모두보기 →
            </Link>
          </div>

          {momentsLoading ? (
            <div style={{ opacity: 0.7 }}>사진 불러오는 중…</div>
          ) : moments.length === 0 ? (
            <div style={{ opacity: 0.7 }}>아직 업로드된 사진이 없어요.</div>
          ) : (
            <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 6 }}>
              {moments.map((m) => (
                <Link
                  key={m.fullPath}
                  // ✅ 여기만 focus 붙임 (m은 map 안에 있으니까!)
                  href={`/p?eventId=${eventId}&focus=${encodeURIComponent(m.fullPath)}`}
                  style={{ textDecoration: "none" }}
                >
                  <div
                    style={{
                      width: 180,
                      height: 120,
                      borderRadius: 18,
                      border: "1px solid #222",
                      background: "#0b0b0b",
                      overflow: "hidden",
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.url} alt="moment" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
