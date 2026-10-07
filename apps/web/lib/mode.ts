/** The landing page has two readers: a human (the floor) and an agent (the files, verbatim). */
export type SiteMode = 'human' | 'agent';

export const modeFrom = (mode: string | string[] | undefined): SiteMode => (mode === 'agent' ? 'agent' : 'human');

/**
 * Split a Markdown file into copyable blocks at its H2 headings. The blocks concatenate back to the exact file:
 * nothing is trimmed, reflowed or escaped, so what the agent page shows is byte for byte what /llms*.txt serves.
 */
export function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  let start = 0;
  const re = /^## /gm;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index === 0) continue;
    blocks.push(text.slice(start, m.index));
    start = m.index;
  }
  blocks.push(text.slice(start));
  return blocks.filter((b) => b.length > 0);
}

/** First line of a block (its heading) as the copy button's label. */
export const blockTitle = (block: string) => (block.split('\n')[0] ?? '').replace(/^#+\s*/, '') || 'block';

const FETCHERS = /GPTBot|ClaudeBot|PerplexityBot|Google-Extended|anthropic-ai|Claude-Web|OAI-SearchBot|Bytespider|CCBot/i;

/** Accept's first non-wildcard type, or the one with the highest q. */
function preferred(accept: string): string | null {
  const ranked = accept
    .split(',')
    .map((part, i) => {
      const [type = '', ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)).find(Boolean);
      return { type: type.trim().toLowerCase(), q: q ? Number(q[1]) : 1, i };
    })
    .filter((x) => x.type && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return ranked[0]?.type ?? null;
}

/** Should `/` answer with llms.txt instead of HTML: the client asked for text first, or is a known LLM fetcher. */
export function wantsPlain(accept: string | null | undefined, userAgent: string | null | undefined): boolean {
  if (userAgent && FETCHERS.test(userAgent)) return true;
  const top = accept ? preferred(accept) : null;
  return top === 'text/plain' || top === 'text/markdown';
}
