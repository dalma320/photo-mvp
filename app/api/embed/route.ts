// app/api/embed/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FaceItem = {
  bbox?: number[];
  det_score?: number;
  embedding?: number[];
};

export async function POST(req: Request) {
  const base = process.env.FACE_SERVER_URL || process.env.NEXT_PUBLIC_FACE_SERVER_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "FACE_SERVER_URL missing" }, { status: 500 });
  }

  try {
    const ct = req.headers.get("content-type") || "";

    // ✅ multipart: file 업로드 기반
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");

      if (!(file instanceof File)) {
        return NextResponse.json({ ok: false, error: "multipart/form-data file 필드가 필요해요" }, { status: 400 });
      }

      const out = new FormData();
      out.set("file", file, file.name);

      const r = await fetch(`${base}/embed`, { method: "POST", body: out });
      const text = await r.text();

      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        return NextResponse.json({ ok: false, error: "face-server JSON 파싱 실패", raw: text }, { status: 502 });
      }

      if (!r.ok) {
        return NextResponse.json({ ok: false, error: "face-server error", status: r.status, data }, { status: 502 });
      }

      const faces: FaceItem[] = Array.isArray(data?.faces) ? data.faces : [];
      const best = faces.find((f) => Array.isArray(f.embedding) && f.embedding.length > 0) || null;

      return NextResponse.json({
        ok: true,
        faces_count: faces.length,
        faces,
        embedding: best?.embedding || null,
        message: faces.length ? "OK" : "NO_FACE",
      });
    }

    // ✅ 혹시 JSON으로 들어오면(확장용)
    const body = await req.json().catch(() => null);
    return NextResponse.json({ ok: false, error: "지원하지 않는 요청 형식", body }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
