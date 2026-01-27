// app/admin/event/page.tsx
export const dynamic = "force-dynamic";
export const revalidate = 0;

import EventClient from "./EventClient";

export default function Page() {
  return <EventClient />;
}
