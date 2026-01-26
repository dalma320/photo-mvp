import { onObjectFinalized } from "firebase-functions/v2/storage";
import * as logger from "firebase-functions/logger";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { defineSecret } from "firebase-functions/params";

import {
  RekognitionClient,
  DetectFacesCommand,
  IndexFacesCommand,
  SearchFacesByImageCommand,
  CreateCollectionCommand,
  DescribeCollectionCommand,
  type SearchFacesByImageCommandOutput,
} from "@aws-sdk/client-rekognition";

initializeApp();
const db = getFirestore();

// ✅ Firebase Secrets (이미 등록한 값)
const AWS_ACCESS_KEY_ID = defineSecret("AWS_ACCESS_KEY_ID");
const AWS_SECRET_ACCESS_KEY = defineSecret("AWS_SECRET_ACCESS_KEY");
const AWS_REGION = defineSecret("AWS_REGION");

// ✅ Rekognition Collection 이름(고정)
const REKOG_COLLECTION_ID = "photo-mvp-test";

// -----------------------------
// Helpers
// -----------------------------
function now() {
  return new Date();
}

function safeKeyFromPath(path: string) {
  // Rekognition ExternalImageId 안전키(슬래시 제거, 길이 제한)
  return path.replaceAll("/", "_").slice(0, 250);
}

function parseEventId(filePath: string) {
  // events/{eventId}/photos/... 또는 events/{eventId}/selfies/...
  const m = filePath.match(/^events\/([^/]+)\/(photos|selfies)\//);
  return m?.[1] ?? "";
}

async function ensureCollection(client: RekognitionClient) {
  try {
    await client.send(new DescribeCollectionCommand({ CollectionId: REKOG_COLLECTION_ID }));
    return;
  } catch (e: any) {
    const name = e?.name ?? "";
    if (name !== "ResourceNotFoundException") throw e;
  }

  await client.send(new CreateCollectionCommand({ CollectionId: REKOG_COLLECTION_ID }));
  logger.info("Rekognition collection created:", REKOG_COLLECTION_ID);
}

function rekogClient() {
  // ✅ region 값에 공백이 끼면 “hostname component” 에러남 → trim
  const region = (AWS_REGION.value() || "").trim();

  return new RekognitionClient({
    region,
    credentials: {
      accessKeyId: (AWS_ACCESS_KEY_ID.value() || "").trim(),
      secretAccessKey: (AWS_SECRET_ACCESS_KEY.value() || "").trim(),
    },
  });
}

// -----------------------------
// 1) 행사 사진 업로드 트리거
//    Storage: events/{eventId}/photos/{photoKey}.jpg
//    Firestore: photos 문서 storage_path == filePath 찾아서 face_count, photo_key, indexed_faces 업데이트
//    Rekognition: IndexFaces (ExternalImageId = photo_key)
// -----------------------------
export const detectFacesOnUpload = onObjectFinalized(
  {
    region: "asia-northeast1",
    secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION],
  },
  async (event) => {
    const bucket = event.data.bucket;
    const filePath = event.data.name || "";
    if (!filePath) return;

    // ✅ photos 경로만 처리
    if (!filePath.startsWith("events/") || !filePath.includes("/photos/")) {
      logger.info("Skip non-photo path:", filePath);
      return;
    }

    const eventId = parseEventId(filePath);
    if (!eventId) {
      logger.warn("Cannot parse eventId from filePath:", filePath);
      return;
    }

    logger.info("Processing photo:", { bucket, filePath, eventId });

    // Download bytes
    const storage = getStorage();
    const file = storage.bucket(bucket).file(filePath);
    const [buf] = await file.download();

    const client = rekogClient();
    await ensureCollection(client);

    // DetectFaces (옵션, face_count 기록용)
    const detectResp = await client.send(
      new DetectFacesCommand({
        Image: { Bytes: buf },
        Attributes: ["DEFAULT"],
      })
    );
    const faceCount = detectResp.FaceDetails?.length ?? 0;
    logger.info("Detected faces:", faceCount);

    // photos 문서 찾기 (있으면 photo_key 가져오기)
    const snap = await db
      .collection("photos")
      .where("storage_path", "==", filePath)
      .limit(1)
      .get();

    let photoKey = "";
    if (!snap.empty) {
      photoKey = (snap.docs[0].data() as any).photo_key || "";
    }

    // photo_key 없으면 안전키 생성(슬래시 제거)
    if (!photoKey) {
      // ✅ 권장: 파일명 자체가 photo_key라면 아래처럼 파일명만 쓰는 것도 OK
      // const filename = filePath.split("/").pop() || "";
      // photoKey = filename.replace(/\.[^/.]+$/, "") || safeKeyFromPath(filePath);
      photoKey = safeKeyFromPath(filePath);
    }

    // IndexFaces
    const indexed = await client.send(
      new IndexFacesCommand({
        CollectionId: REKOG_COLLECTION_ID,
        Image: { Bytes: buf },
        ExternalImageId: photoKey, // ✅ 핵심: 슬래시 없는 photo_key 사용
        DetectionAttributes: ["DEFAULT"],
        QualityFilter: "AUTO",
        MaxFaces: 10,
      })
    );
    const indexedCount = indexed.FaceRecords?.length ?? 0;
    logger.info("Indexed faces:", indexedCount);

    // photos 문서 없으면 생성, 있으면 업데이트
    if (snap.empty) {
      const created = await db.collection("photos").add({
        event_id: eventId,
        bucket,
        storage_path: filePath,
        photo_key: photoKey,
        face_count: faceCount,
        indexed_faces: indexedCount,
        created_at: now(),
        updated_at: now(),
      });
      logger.info("Created photo doc:", created.id);
      return;
    }

    await snap.docs[0].ref.set(
      {
        event_id: eventId,
        bucket,
        storage_path: filePath,
        photo_key: photoKey,
        face_count: faceCount,
        indexed_faces: indexedCount,
        updated_at: now(),
      },
      { merge: true }
    );
    logger.info("Updated photo doc:", snap.docs[0].id);
  }
);

// -----------------------------
// 2) 셀카 업로드 트리거
//    Storage: events/{eventId}/selfies/{photo_key}.jpg  (프론트에서 photo_key로 업로드)
//    Firestore: selfies 문서(storage_path==filePath 또는 photo_key==...) 찾아서 status 업데이트
//    Rekognition: SearchFacesByImage
//    Firestore: matches 컬렉션에 결과 저장
// -----------------------------
export const matchSelfieOnUpload = onObjectFinalized(
  {
    region: "asia-northeast1",
    secrets: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION],
  },
  async (event) => {
    const bucket = event.data.bucket;
    const filePath = event.data.name || "";
    if (!filePath) return;

    // ✅ selfies 경로만 처리
    if (!filePath.startsWith("events/") || !filePath.includes("/selfies/")) {
      logger.info("Skip non-selfie path:", filePath);
      return;
    }

    const eventId = parseEventId(filePath);
    if (!eventId) {
      logger.warn("Cannot parse eventId from filePath:", filePath);
      return;
    }

    logger.info("Processing selfie:", { bucket, filePath, eventId });

    // Download bytes
    const storage = getStorage();
    const file = storage.bucket(bucket).file(filePath);
    const [buf] = await file.download();

    const client = rekogClient();
    await ensureCollection(client);

    // 1) 해당 selfie 문서 찾기
    //    - 우선 storage_path로 찾고
    //    - 없으면 photo_key로도 한 번 더 시도(프론트가 doc id/키를 달리 만들었을 수 있어서)
    let selfieRef:
      | FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>
      | null = null;

    const selfieSnapByPath = await db
      .collection("selfies")
      .where("storage_path", "==", filePath)
      .limit(1)
      .get();

    if (!selfieSnapByPath.empty) {
      selfieRef = selfieSnapByPath.docs[0].ref;
    } else {
      const filename = filePath.split("/").pop() || "";
      const photoKeyGuess = filename.replace(/\.[^/.]+$/, "") || safeKeyFromPath(filePath);

      const selfieSnapByKey = await db
        .collection("selfies")
        .where("photo_key", "==", photoKeyGuess)
        .where("event_id", "==", eventId)
        .limit(1)
        .get();

      if (!selfieSnapByKey.empty) selfieRef = selfieSnapByKey.docs[0].ref;
    }

    // 없으면 만들어두고 진행 (안전)
    if (!selfieRef) {
      const filename = filePath.split("/").pop() || "";
      const photoKey = filename.replace(/\.[^/.]+$/, "") || safeKeyFromPath(filePath);

      const created = await db.collection("selfies").add({
        event_id: eventId,
        storage_path: filePath,
        photo_key: photoKey,
        status: "processing",
        created_at: now(),
        updated_at: now(),
      });
      selfieRef = created;
      logger.info("Created missing selfie doc:", created.id);
    } else {
      await selfieRef.set({ status: "processing", updated_at: now() }, { merge: true });
    }

    // 2) Rekognition SearchFacesByImage
    let resp: SearchFacesByImageCommandOutput;
    try {
      resp = await client.send(
        new SearchFacesByImageCommand({
          CollectionId: REKOG_COLLECTION_ID,
          Image: { Bytes: buf },
          FaceMatchThreshold: 80, // ✅ 필요하면 70으로 낮춰도 됨
          MaxFaces: 10,
        })
      );
    } catch (e: any) {
      logger.error("SearchFacesByImage failed:", e);
      await selfieRef.set(
        { status: "error", error: e?.message ?? String(e), updated_at: now() },
        { merge: true }
      );
      return;
    }

    const matches = resp.FaceMatches ?? [];
    logger.info("FaceMatches:", matches.length);

    // 3) matches 저장 + selfies 문서 status 업데이트
    const createdMatchIds: string[] = [];

    for (const m of matches) {
      const similarity = m.Similarity ?? 0;
      const matchedPhotoKey = m.Face?.ExternalImageId ?? "";

      if (!matchedPhotoKey) continue;

      // photo_key로 photos 문서 찾기 → storage_path 필요
      const ps = await db
        .collection("photos")
        .where("event_id", "==", eventId)
        .where("photo_key", "==", matchedPhotoKey)
        .limit(1)
        .get();

      if (ps.empty) {
        logger.warn("No photos doc for matched photo_key:", matchedPhotoKey);
        continue;
      }

      const photoPath = (ps.docs[0].data() as any).storage_path ?? "";
      if (!photoPath) continue;

      const doc = await db.collection("matches").add({
        event_id: eventId,
        selfie_id: selfieRef.id,
        photo_key: matchedPhotoKey,
        photo_path: photoPath,
        similarity,
        created_at: now(),
      });

      createdMatchIds.push(doc.id);
    }

    await selfieRef.set(
      {
        status: "done",
        match_count: createdMatchIds.length,
        updated_at: now(),
      },
      { merge: true }
    );

    logger.info("Match done:", { selfieId: selfieRef.id, match_count: createdMatchIds.length });
  }
);
