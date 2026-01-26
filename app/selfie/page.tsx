// app/selfie/page.tsx
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { Suspense } from "react";
import SelfieClient from "./selfie-client";

export default function Page({
  searchParams,
}: {
  searchParams: { eventId?: string };
}) {
  const eventId = searchParams.eventId ?? "";

  return (
    <Suspense fallback={<div style={{ padding: 24, background: "#000", color: "#fff" }}>로딩 중…</div>}>
      <SelfieClient eventId={eventId} />
    </Suspense>
  );
}
