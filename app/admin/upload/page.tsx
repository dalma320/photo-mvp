import { Suspense } from 'react'
import UploadClient from './UploadClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: 40 }}>로딩 중...</div>}>
      <UploadClient />
    </Suspense>
  )
}
