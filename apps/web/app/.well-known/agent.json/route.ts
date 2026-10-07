import { config } from '../../../lib/config';

export const dynamic = 'force-dynamic';

/** Agent card: what this service is, where its endpoints are, what an interruption costs, on which network. */
export function GET(request: Request) {
  const site = config.siteUrl ?? new URL(request.url).origin;
  const api = config.publicApiUrl ?? `${site}/api/fixture`;
  return Response.json({
    name: 'Claudia',
    description:
      'The human authority layer for AI agents. Send a signed Action IR; receive ALLOW, ESCALATE or DENY with a Decision Brief. ESCALATE answers HTTP 402: lock a bond in Cardano escrow to interrupt the named human. Reasonable asks are refunded; only the human signature moves funds.',
    url: site,
    documentation: { summary: `${site}/llms.txt`, protocol: `${site}/llms-full.txt`, human: `${site}/protocol` },
    network: 'cardano-preprod',
    mode: config.publicApiUrl ? 'live' : 'fixture',
    endpoints: {
      check: { method: 'POST', url: `${api}/v1/authority/check` },
      authority: { method: 'GET', url: `${api}/v1/authority/{role}?mandate_id={mandate_id}` },
      metrics: { method: 'GET', url: `${api}/v1/metrics?mandate_id={mandate_id}` },
    },
    pricing: {
      interruption_bond: {
        amount: '5000000',
        asset: 'ADA',
        unit: 'lovelace',
        display: '5 ADA',
        scheme: 'cardano-escrow',
        transport: 'x402 v2 (PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE)',
        refund: 'approved or declined as a reasonable ask',
        capture: 'declined as frivolous, paid to an unspendable sink',
      },
      masumi_fee: { amount: '1', asset: 'tUSDM', per: 'job', listing: 'Human Authority Endpoint', marketplace: 'https://preprod.sokosumi.com/', standard: 'MIP-003' },
    },
    outcomes: ['ALLOW', 'ESCALATE', 'DENY'],
    schemas: ['action-ir/v0.1', 'mandate/v0.1', 'escalation-price/v0.1', 'bond/v0.1', 'brief/v0.1', 'verification/v0.1'],
  });
}
