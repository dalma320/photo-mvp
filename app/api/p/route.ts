import { NextResponse } from 'next/server'

// ✅ 이 API는 "빌드 중 실행"되어도 에러 안 나게 매우 가볍게 유지.
// 지금 MVP에서는 Supabase 제거 목적 + 추후 확장용 자리만 남김.
export const runtime = 'nodejs'

export async function GET() {
  return NextResponse.json({ ok: true, msg: '/api/p is alive (firebase version)' })
}
