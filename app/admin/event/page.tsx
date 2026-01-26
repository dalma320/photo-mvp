

export const dynamic = 'force-dynamic'
export const revalidate = 0

import { Suspense } from 'react'
import EventClient from './EventClient'

export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: 40 }}>로딩 중...</div>}>
      <EventClient />
    </Suspense>
  )
}
