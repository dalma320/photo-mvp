// app/p/page.tsx
export const dynamic = "force-dynamic";
export const revalidate = 0;

import PClient from "./p-client";

export default function Page({
  searchParams,
}: {
  searchParams: { eventId?: string; eventId2?: string; focus?: string };
}) {
  const eventId = searchParams.eventId ?? searchParams.eventId2 ?? "";
  const focus = searchParams.focus ?? "";

  return <PClient eventId={eventId} focus={focus} />;
}
