'use client'

export default function ListClient() {
  return (
    <div style={{ padding: 40, color: '#fff' }}>
      <h1 style={{ fontSize: 28, fontWeight: 800 }}>/admin/list</h1>
      <p style={{ opacity: 0.85, marginTop: 10 }}>
        여기로 기존 /admin/list UI/로직을 옮겨 넣으면 돼.
      </p>

      <div style={{ marginTop: 18, opacity: 0.75, lineHeight: 1.6 }}>
        ⚠️ 주의: 이 파일(use client)에서는 <b>revalidatePath / revalidateTag</b> 같은 서버 함수를 쓰면 안 돼.
        <br />
        새로고침은 <code>window.location.reload()</code> 또는 <code>router.refresh()</code>를 사용해.
      </div>
    </div>
  )
}
