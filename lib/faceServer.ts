// lib/faceServer.ts
type InputLike =
  | File
  | Blob
  | ArrayBuffer
  | Uint8Array
  | { arrayBuffer: () => Promise<ArrayBuffer> }
  | string; // dataURL or URL

export type EmbedResult =
  | { ok: true; embedding: number[]; faces?: any[] }
  | { ok: false; code: "NO_FACE" | "NETWORK" | "SERVER" | "UNKNOWN"; message: string; faces?: any[] };

function isArrayBuffer(x: any): x is ArrayBuffer {
  return x && x.constructor && x.constructor.name === "ArrayBuffer";
}
function isUint8Array(x: any): x is Uint8Array {
  return typeof Uint8Array !== "undefined" && x instanceof Uint8Array;
}
function isBlobLike(x: any): x is Blob {
  return typeof Blob !== "undefined" && x instanceof Blob;
}
function isFileLike(x: any): x is File {
  return typeof File !== "undefined" && x instanceof File;
}

async function toBlob(input: InputLike): Promise<Blob> {
  if (isFileLike(input) || isBlobLike(input)) return input;
  if (isArrayBuffer(input)) return new Blob([input]);
  if (isUint8Array(input)) return new Blob([input]);

  if (input && typeof (input as any).arrayBuffer === "function") {
    const ab = await (input as any).arrayBuffer();
    return new Blob([ab]);
  }

  if (typeof input === "string") {
    if (input.startsWith("data:")) return await (await fetch(input)).blob();
    if (input.startsWith("http://") || input.startsWith("https://")) return await (await fetch(input)).blob();
  }

  throw new Error(`embedFace()에 지원하지 않는 타입: ${Object.prototype.toString.call(input)}`);
}

export async function embedFace(fileOrBytes: InputLike): Promise<EmbedResult> {
  try {
    const blob = await toBlob(fileOrBytes);
    const fd = new FormData();
    fd.append("file", blob, "image.jpg");

    const res = await fetch("/api/embed", { method: "POST", body: fd });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, code: "SERVER", message: `embed API 실패: ${res.status} ${t}` };
    }

    const json = (await res.json()) as { ok: boolean; embedding: number[] | null; faces?: any[]; error?: string };
    if (!json.ok) return { ok: false, code: "SERVER", message: json.error || "embed API error", faces: json.faces };

    if (!Array.isArray(json.embedding) || json.embedding.length === 0) {
      return { ok: false, code: "NO_FACE", message: "얼굴을 찾지 못했어요(셀카/사진에 얼굴이 안 보임)", faces: json.faces };
    }

    const emb = json.embedding.map((v) => Number(v)).filter((v) => Number.isFinite(v));
    if (!emb.length) return { ok: false, code: "NO_FACE", message: "얼굴을 찾지 못했어요(임베딩 비어있음)", faces: json.faces };

    return { ok: true, embedding: emb, faces: json.faces };
  } catch (e: any) {
    return { ok: false, code: "UNKNOWN", message: e?.message ?? String(e) };
  }
}
