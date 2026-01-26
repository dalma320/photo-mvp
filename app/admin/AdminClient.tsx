'use client'

export default function AdminClient() {
  return (
    <div style={{ padding: 40, color: '#fff' }}>
      <h1 style={{ fontSize: 28, fontWeight: 800 }}>/admin</h1>
      <ul style={{ marginTop: 14, lineHeight: 1.8 }}>
        <li><a style={{ color: '#fff' }} href="/admin/event">/admin/event</a></li>
        <li><a style={{ color: '#fff' }} href="/admin/list">/admin/list</a></li>
        <li><a style={{ color: '#fff' }} href="/admin/upload">/admin/upload</a></li>
      </ul>
    </div>
  )
}
