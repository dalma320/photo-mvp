// app/find/page.tsx
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { Suspense } from "react";
import FindClient from "./find-client";

export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>로딩 중...</div>}>
      <FindClient />
    </Suspense>
  );
}
