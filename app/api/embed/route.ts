// app/api/embed/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const base = process.env.FACE_SERVER_URL || process.env.NEXT_PUBLIC_FACE_SERVER_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "FACE_SERVER_URL missing" }, { status: 500 });
  }

  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "multipart/form-data 로 file 필드가 필요해요" },
        { status: 400 }
      );
    }

    const out = new FormData();
    out.set("file", file, file.name);

    const r = await fetch(`${base}/embed`, {
      method: "POST",
      body: out,
    });

    const text = await r.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!r.ok) {
      return NextResponse.json({ ok: false, status: r.status, data }, { status: 502 });
    }

    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
