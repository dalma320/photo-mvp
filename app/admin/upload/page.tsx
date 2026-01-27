// app/admin/upload/page.tsx
export const dynamic = "force-dynamic";
export const revalidate = 0;

import UploadClient from "./UploadClient";

export default function Page() {
  return <UploadClient />;
}
