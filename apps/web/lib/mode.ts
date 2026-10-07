/** The landing page has two readers: a human (the floor) and an agent (file links, a curl line, five facts). */
export type SiteMode = 'human' | 'agent';

export const modeFrom = (mode: string | string[] | undefined): SiteMode => (mode === 'agent' ? 'agent' : 'human');

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
