import { protocolMarkdown } from '../../lib/protocol';

export const dynamic = 'force-static';

/** Served at /protocol.md (next.config rewrite): the protocol as Markdown for agents and tools. Same bytes as /llms-full.txt. */
export function GET() {
  return new Response(protocolMarkdown(), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
}
