'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'

type Status = 'idle' | 'loading' | 'success' | 'error'

export default function EventClient() {
  const searchParams = useSearchParams()

  // URL에서 eventId를 받을 수도 있고(옵션), 없으면 기본값 사용
  const eventId = useMemo(() => {
    const q = searchParams.get('eventId')
    return (q && q.trim()) || '26tw_test'
  }, [searchParams])

  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [info, setInfo] = useState<string>('')

  useEffect(() => {
    // ✅ admin 화면은 "빌드 중"이 아니라 "접속 시점"에만 렌더됨 (page.tsx가 force-dynamic)
    // 여기서 Firebase 호출을 하더라도 빌드가 터지지 않게 구조를 만든 상태.
    // (실제 Firebase 로직은 아래 TODO 영역에 붙여 넣으면 됨)

    setStatus('success')
    setInfo(`Admin Event Page Ready. eventId=${eventId}`)
  }, [eventId])

  const handleHardRefresh = () => {
    // ✅ 서버 revalidate 대신, 클라이언트 새로고침으로 충분
    window.location.reload()
  }

  return (
    <div style={{ padding: 40, color: '#fff' }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 8 }}>/admin/event</h1>

      <div style={{ opacity: 0.85, marginBottom: 24 }}>
        현재 eventId: <b>{eventId}</b>
      </div>

      <div
        style={{
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 12,
          padding: 16,
          marginBottom: 16,
          background: 'rgba(255,255,255,0.04)',
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 8 }}>상태</div>
        {status === 'loading' && <div>불러오는 중...</div>}
        {status === 'success' && <div>✅ {info}</div>}
        {status === 'error' && <div style={{ color: '#ff6b6b' }}>❌ {errorMsg}</div>}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <button
          onClick={handleHardRefresh}
          style={{
            padding: '10px 14px',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.2)',
            background: 'rgba(255,255,255,0.06)',
            color: '#fff',
            cursor: 'pointer',
            fontWeight: 700,
          }}
        >
          새로고침
        </button>

        <a
          href={`/find?eventId=${encodeURIComponent(eventId)}&uid=U1`}
          style={{
            padding: '10px 14px',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.2)',
            background: 'rgba(255,255,255,0.06)',
            color: '#fff',
            textDecoration: 'none',
            fontWeight: 700,
          }}
        >
          /find로 테스트 이동
        </a>
      </div>

      <div style={{ marginTop: 28, opacity: 0.8, lineHeight: 1.5 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>TODO (여기에 붙여넣기)</div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>Firestore에서 저장된 매칭 목록 조회</li>
          <li>eventId 필터 / 날짜 정렬 / 다운로드 링크</li>
          <li>운영자용 전체 매칭 결과 확인</li>
        </ul>
        <div style={{ marginTop: 10 }}>
          ⚠️ 주의: 이 파일(use client)에서는 <b>revalidatePath/revalidateTag</b> 같은 서버 함수를 쓰면 안 돼.
        </div>
      </div>
    </div>
  )
}
