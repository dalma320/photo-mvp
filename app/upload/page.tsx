'use client'

import { useState } from 'react'
import { ref, uploadBytes } from 'firebase/storage'
import { storage } from '../../lib/firebaseClient'

export default function UploadPhotosPage() {
  const [eventId, setEventId] = useState('26tw_test')
  const [files, setFiles] = useState<FileList | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  const uploadAll = async () => {
    if (!eventId) return alert('eventId를 입력해줘')
    if (!files || files.length === 0) return alert('업로드할 사진을 선택해줘')

    try {
      setLoading(true)
      setMessage('업로드 중...')

      const tasks = Array.from(files).map(async (file) => {
        const ext = file.name.split('.').pop() || 'jpg'
        const filename = `${crypto.randomUUID()}.${ext}`
        const path = `events/${eventId}/photos/${filename}`

        const r = ref(storage, path)
        await uploadBytes(r, file)
      })

      await Promise.all(tasks)

      setMessage(`✅ 업로드 완료 (${files.length}장)`)
    } catch (e) {
      console.error(e)
      setMessage('❌ 업로드 실패 (콘솔 확인)')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: 40 }}>
      <h1>운영자용: 행사 사진 업로드</h1>

      <div style={{ marginTop: 16 }}>
        <label>Event ID</label>
        <br />
        <input
          value={eventId}
          onChange={(e) => setEventId(e.target.value)}
          style={{ padding: 8, width: 320 }}
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => setFiles(e.target.files)}
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <button onClick={uploadAll} disabled={loading}>
          {loading ? '업로드 중...' : '여러 장 업로드'}
        </button>
      </div>

      <p style={{ marginTop: 20 }}>{message}</p>

      <p style={{ marginTop: 24, opacity: 0.7 }}>
        업로드 경로: <code>events/{'{eventId}'}/photos/...</code>
      </p>
    </div>
  )
}
