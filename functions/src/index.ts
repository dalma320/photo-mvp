import { onObjectFinalized } from "firebase-functions/v2/storage";
import * as logger from "firebase-functions/logger";

// ✅ Node 18+ (functions v2 runtime)에는 fetch가 내장이라 node-fetch 필요없음
const FACE_SERVER_URL = process.env.FACE_SERVER_URL!;
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";

export const ingestOnPhotoUpload = onObjectFinalized(
  { region: "asia-northeast3" },
  async (event) => {
    const obj = event.data;
    const fullPath = obj.name || "";
    if (!fullPath) return;

    const m = fullPath.match(/^events\/([^/]+)\/photos\/.+/);
    if (!m) return;

    const eventId = m[1];
    logger.info("photo uploaded", { eventId, fullPath });

    const res = await fetch(`${FACE_SERVER_URL}/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(INGEST_TOKEN ? { "x-ingest-token": INGEST_TOKEN } : {}),
      },
      body: JSON.stringify({
        eventId,
        photoPath: fullPath,
        photoUrl: null,
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      logger.error("ingest failed", { status: res.status, txt });
      throw new Error(`ingest failed: ${res.status}`);
    }

    const json = await res.json();
    logger.info("ingest ok", json);
  }
);
