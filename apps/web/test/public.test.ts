import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inline, render, slug } from '../lib/markdown';

const pub = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

describe('markdown renderer', () => {
  it('renders headings with ids, lists, code and paragraphs', () => {
    const { html, headings } = render('# Title\n\nPara one\nstill one.\n\n## Two `x`\n\n- a\n- b\n\n1. c\n\n```json\n{ "k": "<v>" }\n```\n');
    expect(headings).toEqual([
      { level: 1, text: 'Title', id: 'title' },
      { level: 2, text: 'Two x', id: 'two-x' },
    ]);
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain('<p>Para one still one.</p>');
    expect(html).toContain('<h2 id="two-x">Two <code>x</code></h2>');
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>');
    expect(html).toContain('<ol><li>c</li></ol>');
    expect(html).toContain('<pre><code class="lang-json">{ &quot;k&quot;: &quot;&lt;v&gt;&quot; }</code></pre>');
  });

  it('escapes HTML everywhere and links only safe schemes', () => {
    expect(inline('<script>x</script> `<b>` **b** [l](/p) [j](javascript:alert) https://a.b/c)')).toBe(
      '&lt;script&gt;x&lt;/script&gt; <code>&lt;b&gt;</code> <strong>b</strong> <a href="/p">l</a> j <a href="https://a.b/c">https://a.b/c</a>)',
    );
    expect(slug('Escalation over HTTP 402')).toBe('escalation-over-http-402');
  });
});

describe('agent-readable files', () => {
  const full = pub('llms-full.txt');
  const summary = pub('llms.txt');

  it('llms.txt follows the convention: H1, blockquote summary, sections of links', () => {
    expect(summary.startsWith('# Claudia\n\n> ')).toBe(true);
    for (const link of ['/llms-full.txt', '/protocol', '/.well-known/agent.json', 'https://preprod.sokosumi.com/']) expect(summary).toContain(link);
    expect(summary).toContain('POST /v1/authority/check');
  });

  it('the full protocol names every shape, header, endpoint and rule', () => {
    for (const s of [
      'ALLOW',
      'ESCALATE',
      'DENY',
      'INTERRUPT_BUDGET_EXHAUSTED',
      'action-ir/v0.1',
      'mandate/v0.1',
      'interrupt_budget',
      'PAYMENT-REQUIRED',
      'PAYMENT-SIGNATURE',
      'PAYMENT-RESPONSE',
      'escalation-price/v0.1',
      'bond/v0.1',
      'brief/v0.1',
      'will_happen',
      'Refund',
      'Capture',
      'GET /v1/authority/{role}?mandate_id=',
      'GET /v1/metrics?mandate_id=',
      'POST /v1/authority/check',
      'MIP-003',
      '/start_job',
      'preprod.sokosumi.com',
    ]) {
      expect(full, s).toContain(s);
    }
  });

  it('every EscalationPrice and Bond field in the protocol matches the core schema', () => {
    const price = /```json\n(\{\n  "schema": "escalation-price\/v0\.1"[\s\S]*?)\n```/.exec(full)?.[1];
    expect(Object.keys(JSON.parse(price ?? '{}'))).toEqual([
      'schema',
      'approval_id',
      'network',
      'asset',
      'amount',
      'escrow_address',
      'action_hash',
      'approver_key_hash',
      'locked_until_ms',
      'interrupt_budget',
    ]);
    const bond = /```json\n(\{\n  "schema": "bond\/v0\.1"[\s\S]*?)\n```/.exec(full)?.[1];
    expect(Object.keys(JSON.parse(bond ?? '{}'))).toEqual([
      'schema',
      'approval_id',
      'action_hash',
      'mandate_id',
      'amount',
      'asset',
      'escrow_address',
      'tx_hash',
      'output_index',
      'locked_until_ms',
      'status',
      'outcome_tx_hash',
    ]);
  });

  it('the protocol renders without losing a heading', () => {
    const { headings } = render(full);
    expect(headings.filter((h) => h.level === 2).map((h) => h.text)).toEqual([
      'Invariant',
      'Outcomes',
      'Action IR (action-ir/v0.1)',
      'Mandate (mandate/v0.1)',
      'Escalation over HTTP 402',
      'Bond rules',
      'Decision Brief (brief/v0.1)',
      'Verification and the vault',
      'Endpoints',
      'Masumi listing (MIP-003)',
      'Where to look',
    ]);
  });
});

describe('agent card', () => {
  it('names the service, endpoints, bond price and Masumi fee on cardano-preprod', async () => {
    const { GET } = await import('../app/.well-known/agent.json/route');
    const card = await GET(new Request('https://example.test/.well-known/agent.json')).json();
    expect(card.url).toBe('https://example.test');
    expect(card.endpoints.check.url).toBe('https://example.test/api/fixture/v1/authority/check');
    expect(card.name).toBe('Claudia');
    expect(card.network).toBe('cardano-preprod');
    expect(card.outcomes).toEqual(['ALLOW', 'ESCALATE', 'DENY']);
    expect(card.endpoints.check).toEqual({ method: 'POST', url: expect.stringMatching(/\/v1\/authority\/check$/) });
    expect(card.endpoints.authority.url).toContain('/v1/authority/{role}?mandate_id=');
    expect(card.endpoints.metrics.url).toContain('/v1/metrics?mandate_id=');
    expect(card.pricing.interruption_bond).toMatchObject({ amount: '5000000', asset: 'ADA', display: '5 ADA', scheme: 'cardano-escrow' });
    expect(card.pricing.masumi_fee).toMatchObject({ amount: '1', asset: 'tUSDM', listing: 'Human Authority Endpoint', marketplace: 'https://preprod.sokosumi.com/' });
    expect(card.documentation.protocol).toMatch(/\/llms-full\.txt$/);
  });
});

describe('brand', () => {
  it('is Claudia in the tab title, the agent card, and the agent-readable headings', async () => {
    // app/layout.tsx imports fonts and CSS, so its metadata is read as text rather than imported.
    const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
    expect(layout).toContain("title: { default: 'Claudia', template: '%s · Claudia' }");
    const { GET } = await import('../app/.well-known/agent.json/route');
    expect((await GET(new Request('https://example.test/.well-known/agent.json')).json()).name).toBe('Claudia');
    expect(pub('llms.txt').split('\n')[0]).toBe('# Claudia');
    expect(pub('llms-full.txt').split('\n')[0]).toBe('# Claudia protocol');
    for (const name of ['llms.txt', 'llms-full.txt']) expect(pub(name)).not.toContain('Authority Layer');
  });
});
