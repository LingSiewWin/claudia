import type { ModelInput, ModelTurn } from '@authority/llm';
import { lastResults, promptOf, say, scriptedModel } from '@authority/llm/testing';

// A deterministic accounts-payable clerk standing in for the LLM, for tests: it reads, then proposes from what it read.
// `gullible` decides whether it follows a payout change found in the inbox.

let n = 0;
export const tools = (...calls: [string, unknown][]): ModelTurn => ({
  content: calls.map(([name, input]) => ({ type: 'tool_use' as const, id: `toolu_c${++n}`, name, input })),
  stop: 'tool_use',
  model: 'scripted',
  usage: { input_tokens: 0, output_tokens: 0 },
});

const ADDRESS = /addr_test1[0-9a-z]{20,200}/;

export function clerk(o: { gullible: boolean; rationale?: (number: string) => string; patch?: Record<string, unknown> }) {
  const reads = new Map<string, Record<string, string>>();
  return scriptedModel((input: ModelInput) => {
    const prompt = promptOf(input);
    const results = lastResults(input);
    const turns = input.messages.length;
    if (turns === 1) return tools(['list_open_invoices', {}], ['read_mandate', {}], ['read_vendor_messages', {}]);
    if (results.some((r) => r.name === 'propose_action')) return say(`Done: ${results.find((r) => r.name === 'propose_action')!.content}`);
    for (const r of results) reads.set(r.name, JSON.parse(r.content));
    const invoices = reads.get('list_open_invoices') as unknown as Array<Record<string, string>>;
    const messages = reads.get('read_vendor_messages') as unknown as Array<Record<string, string>>;
    const invoiceNo = /: invoice (\S+)\./.exec(prompt)?.[1];
    if (invoiceNo) {
      const inv = invoices.find((i) => i.invoice_number === invoiceNo);
      if (!inv) return say(`${invoiceNo} is not open.`);
      const change = messages.find((m) => m.body!.includes(invoiceNo) && ADDRESS.test(m.body!));
      const recipient = o.gullible && change ? ADDRESS.exec(change.body!)![0] : inv.payout_address!;
      return tools([
        'propose_action',
        {
          type: 'pay_invoice',
          purpose: 'invoice_payment',
          counterparty_id: inv.vendor_id,
          counterparty_display: inv.vendor_name,
          amount: inv.amount_due_usdm,
          recipient_address: recipient,
          invoice: { invoice_id: inv.invoice_id, invoice_number: invoiceNo },
          rationale: o.rationale?.(invoiceNo) ?? `${invoiceNo} is open: ${inv.memo}.`,
          ...o.patch,
        },
      ]);
    }
    const id = /request (\S+) in/.exec(prompt)?.[1];
    const msg = messages.find((m) => m.id === id)!;
    return tools([
      'propose_action',
      {
        type: 'purchase',
        purpose: 'digital_collectibles',
        counterparty_id: 'nft-marketplace',
        counterparty_display: 'NFT marketplace',
        amount: /for ([0-9.]+) USDM/.exec(msg.body!)![1],
        recipient_address: ADDRESS.exec(msg.body!)![0],
        rationale: o.rationale?.(id!) ?? msg.subject!,
        ...o.patch,
      },
    ]);
  });
}
