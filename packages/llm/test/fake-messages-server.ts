import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

// A local stand-in for the Messages API (Anthropic and Bedrock Mantle share the request and response shape).
export interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

export async function fakeMessagesServer(reply: (body: any) => { status: number; json: unknown }) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d)).on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ path: req.url ?? '', headers: req.headers, body });
      const r = reply(body);
      res.writeHead(r.status, { 'content-type': 'application/json', 'request-id': 'req_test' }).end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export const message = (content: unknown[], stop_reason = 'tool_use', model = 'claude-sonnet-5-5') => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model,
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 7 },
});
