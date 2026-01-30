// app/admin/embeddings/page.tsx
import EmbeddingsClient from "./EmbeddingsClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function Page() {
  return <EmbeddingsClient />;
}
