export const runtime = 'nodejs'

function isAllowedUrl(u: string) {
  // MVP: https만 허용
  return u.startsWith('https://')
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const u = searchParams.get('u')

  if (!u) return new Response('Missing u', { status: 400 })
  if (!isAllowedUrl(u)) return new Response('URL not allowed', { status: 400 })

  try {
    const upstream = await fetch(u, { cache: 'no-store' })
    if (!upstream.ok) {
      return new Response(`Upstream failed: ${upstream.status}`, { status: 502 })
    }

    const contentType =
      upstream.headers.get('content-type') || 'application/octet-stream'
    const arrayBuffer = await upstream.arrayBuffer()

    return new Response(arrayBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    return new Response(`Proxy error: ${e?.message || 'unknown'}`, {
      status: 500,
    })
  }
}
