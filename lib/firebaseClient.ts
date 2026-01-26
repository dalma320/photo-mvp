// lib/firebaseClient.ts
// ⚠️ Client Component 전용 Firebase 초기화 파일
// - Next.js App Router
// - Firebase Auth / Firestore / Storage 사용

import { initializeApp, getApps, getApp } from "firebase/app"
import { getAuth } from "firebase/auth"
import { getFirestore } from "firebase/firestore"
import { getStorage } from "firebase/storage"

// 🔹 Firebase Client Config (NEXT_PUBLIC_ 필수)
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId:
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
}

// ✅ 중복 초기화 방지 (Next.js Fast Refresh / Turbopack 대응)
export const app = getApps().length ? getApp() : initializeApp(firebaseConfig)

// 🔹 Firebase Services
export const auth = getAuth(app)
export const db = getFirestore(app)
export const storage = getStorage(app)

// 🧪 개발용 디버그 정보
// 필요 없으면 언제든 삭제 가능
export const firebaseDebug = {
  projectId: firebaseConfig.projectId ?? "❌ no projectId",
  storageBucket: firebaseConfig.storageBucket ?? "❌ no bucket",
}
