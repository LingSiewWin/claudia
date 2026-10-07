import type { NextRequest } from 'next/server';
import { dispatch } from '../../../../fixtures/handler';

/*
 * Fixture mode: when no Authority API is configured (NEXT_PUBLIC_API_BASE_URL unset) the browser talks to this
 * route instead, which serves fixtures/recorded.json with the API's own contract. Read paths, Koios and Sepolia
 * stand-ins, and the SSE stream all work; nothing is signed or submitted.
 */
export const dynamic = 'force-dynamic';

const PACE_MS = 250;

async function handle(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await params;
  const url = new URL(`/${path.join('/')}${req.nextUrl.search}`, 'http://fixture');
  const reply = await dispatch(req.method, url, () => req.text(), req.headers.get('last-event-id') ?? undefined);
  if (!('sse' in reply)) return Response.json(reply.body, { status: reply.status });
  const encoder = new TextEncoder();
  let i = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('retry: 1000\n\n'));
      timer = setInterval(() => {
        const e = reply.sse[i++];
        try {
          controller.enqueue(encoder.encode(e ? `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n` : ': idle\n\n'));
        } catch {
          clearInterval(timer);
        }
      }, PACE_MS);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
}

export { handle as GET, handle as POST, handle as OPTIONS };
