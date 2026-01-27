// lib/faceServer.ts
export async function embedFace(file: File): Promise<number[]> {
  const fd = new FormData();
  fd.append("file", file, file.name);

  const res = await fetch("/api/embed", { method: "POST", body: fd });

  // 응답을 최대한 자세히 확보
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // json 파싱 실패시 raw로 남김
  }

  if (!res.ok || !json?.ok) {
    const detail = json?.error || json?.data?.detail || text || "embed failed";
    throw new Error(detail);
  }

  // ✅ face-server 응답은 json.data.faces[0].embedding 형태
  const faces = json?.data?.faces;
  const emb = faces?.[0]?.embedding;

  if (!Array.isArray(emb)) {
    // 얼굴이 없는 경우: {faces: []}
    if (Array.isArray(faces) && faces.length === 0) {
      throw new Error("얼굴을 찾지 못했어요 (faces=[])");
    }
    // 디버깅용으로 구조를 보여주기
    throw new Error("No embedding array in response: " + JSON.stringify(json?.data)?.slice(0, 300));
  }

  return emb as number[];
}
