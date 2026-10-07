import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blockTitle, modeFrom, splitBlocks, wantsPlain } from '../lib/mode';

const pub = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

describe('reader mode', () => {
  it('is human unless the URL says agent', () => {
    expect(modeFrom(undefined)).toBe('human');
    expect(modeFrom('human')).toBe('human');
    expect(modeFrom('agent')).toBe('agent');
    expect(modeFrom(['agent'])).toBe('human');
    expect(modeFrom('AGENT')).toBe('human');
  });

  it('splits both served files into H2 blocks that concatenate back byte for byte', () => {
    for (const name of ['llms.txt', 'llms-full.txt']) {
      const text = pub(name);
      const blocks = splitBlocks(text);
      expect(blocks.length, name).toBeGreaterThan(3);
      expect(blocks.join(''), name).toBe(text);
      expect(blocks.slice(1).every((b) => b.startsWith('## ')), name).toBe(true);
    }
    expect(blockTitle('## Bond rules\n\n- a')).toBe('Bond rules');
    expect(blockTitle('# Claudia\n\n> x')).toBe('Claudia');
  });
});

describe('content negotiation on /', () => {
  const chrome = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  it('keeps HTML for browsers and plain curl', () => {
    expect(wantsPlain(chrome, 'Mozilla/5.0 Chrome/130')).toBe(false);
    expect(wantsPlain('*/*', 'curl/8.7.1')).toBe(false);
    expect(wantsPlain(null, null)).toBe(false);
  });
  it('serves text when the client prefers text/plain or text/markdown', () => {
    expect(wantsPlain('text/plain', 'curl/8.7.1')).toBe(true);
    expect(wantsPlain('text/markdown, text/plain;q=0.9, */*;q=0.1', 'x')).toBe(true);
    expect(wantsPlain('text/html;q=0.5, text/plain', 'x')).toBe(true);
    expect(wantsPlain('text/html, text/plain;q=0.9', 'x')).toBe(false);
  });
  it('serves text to known LLM fetchers whatever they accept', () => {
    for (const ua of ['GPTBot/1.0', 'Mozilla/5.0 (compatible; ClaudeBot/1.0)', 'PerplexityBot', 'Google-Extended', 'anthropic-ai']) {
      expect(wantsPlain(chrome, ua), ua).toBe(true);
    }
  });
  it('rewrites / to /llms.txt through the proxy, and only then', async () => {
    const { NextRequest } = await import('next/server');
    const { proxy } = await import('../proxy');
    const agent = proxy(new NextRequest('https://example.test/', { headers: { accept: 'text/plain' } }));
    expect(agent.headers.get('x-middleware-rewrite')).toBe('https://example.test/llms.txt');
    const browser = proxy(new NextRequest('https://example.test/', { headers: { accept: chrome, 'user-agent': 'Mozilla/5.0' } }));
    expect(browser.headers.get('x-middleware-rewrite')).toBeNull();
  });
});
