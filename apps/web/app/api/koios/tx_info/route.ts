// Transport only: browsers cannot read Koios (no CORS headers on responses), so this one route forwards the
// request bytes to Koios tx_info and streams the response back untouched. It parses nothing, verifies nothing,
// and adds no claims; the browser recomputes every hash and signature itself (lib/verify.ts).
const KOIOS_TX_INFO = 'https://preprod.koios.rest/api/v1/tx_info';
const MAX_BODY_BYTES = 5120; // Koios public-tier request limit

export async function POST(request: Request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Response.json({ error: 'body too large' }, { status: 413 });
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) return Response.json({ error: 'body too large' }, { status: 413 });
  let upstream: Response;
  try {
    upstream = await fetch(KOIOS_TX_INFO, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      cache: 'no-store',
    });
  } catch {
    return Response.json({ error: 'Koios unreachable' }, { status: 502 });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' },
  });
}
