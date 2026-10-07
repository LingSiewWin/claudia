// Node wrapper for fixtures/handler.ts: `pnpm fixture-api`, the Playwright webServer, and dev:fixture.
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { dispatch } from './handler';

const port = Number(process.env.FIXTURE_API_PORT ?? 8787);
const paceMs = Number(process.env.FIXTURE_SSE_PACE_MS ?? 250);

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function rawBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const last = req.headers['last-event-id'];
  const reply = await dispatch(req.method ?? 'GET', url, () => rawBody(req), Array.isArray(last) ? last[0] : last);
  if (!('sse' in reply)) return json(res, reply.status, reply.body);
  res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 1000\n\n');
  let i = 0;
  const timer = setInterval(() => {
    const e = reply.sse[i++];
    if (e) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    else res.write(': idle\n\n');
  }, paceMs);
  req.on('close', () => clearInterval(timer));
}).listen(port, () => console.log(`fixture API on http://localhost:${port}`));
