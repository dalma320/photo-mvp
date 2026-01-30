// lib/similarity.ts
export function cosineSimilarity(aRaw: any, bRaw: any) {
  if (!Array.isArray(aRaw) || !Array.isArray(bRaw)) return 0;

  const a = aRaw.map((v) => Number(v));
  const b = bRaw.map((v) => Number(v));

  if (!a.length || !b.length) return 0;
  if (a.length !== b.length) {
    console.warn("[cosineSimilarity] length mismatch:", a.length, b.length);
    return 0;
  }

  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}
