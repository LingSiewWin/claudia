import Stripe from 'stripe';

// A real Stripe client whose HTTP layer is a local function: unit tests never touch the network.
export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: URLSearchParams;
}
export type FakeReply = { status?: number; json: unknown };

export function fakeStripe(handler: (req: FakeRequest) => FakeReply) {
  const calls: FakeRequest[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const req: FakeRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    };
    calls.push(req);
    const reply = handler(req);
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', 'request-id': 'req_fake' },
    });
  };
  const stripe = new Stripe('sk_test_unit', {
    httpClient: Stripe.createFetchHttpClient(fetchFn as typeof fetch),
    maxNetworkRetries: 0,
  });
  return { stripe, calls };
}

export const notFound: FakeReply = {
  status: 404,
  json: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such invoice' } },
};

export function list(data: unknown[], hasMore = false): FakeReply {
  return { json: { object: 'list', data, has_more: hasMore, url: '/v1/invoices' } };
}

// Shape copied from a real test-mode response (2026-10-07), trimmed to the fields this package reads.
export function invoiceJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'in_1UNc2MEFJlYN23C9cgaO3eOu',
    object: 'invoice',
    customer: 'cus_acme',
    status: 'open',
    amount_due: 842,
    currency: 'usd',
    due_date: 1793899222,
    description: 'Cloud compute, September',
    metadata: {
      invoice_number: 'INV-3821',
      demo_set: 'stage',
      vendor_id: 'aws',
      vendor_name: 'AWS (demo vendor)',
      payout_chain: 'cardano-preprod',
      payout_address: 'addr_test1vzs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rgdp5xs6rggfw5wvl',
    },
    ...overrides,
  };
}
