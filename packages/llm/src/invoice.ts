import { unitsToDecimal } from './proposal';

/** The invoice fields the model may see (a subset of @authority/stripe InvoiceSummary). */
export interface InvoiceFacts {
  id: string;
  number: string | null;
  status: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  amount_usdm: string;
  currency: string;
  due_date: string | null;
  memo: string | null;
  payout_chain: string | null;
  payout_address: string | null;
}

export function invoiceView(inv: InvoiceFacts, decimals: number) {
  return {
    invoice_id: inv.id,
    invoice_number: inv.number,
    status: inv.status,
    vendor_id: inv.vendor_id,
    vendor_name: inv.vendor_name,
    amount_due_usdm: unitsToDecimal(inv.amount_usdm, decimals),
    billed_currency: inv.currency,
    due_date: inv.due_date,
    memo: inv.memo,
    payout_chain: inv.payout_chain,
    payout_address: inv.payout_address,
  };
}
