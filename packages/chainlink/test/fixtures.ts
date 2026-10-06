import type { VerificationReport } from '@authority/core';

export const FIXTURE: VerificationReport = {
  schema: 'verification/v0.1',
  action_hash: '11'.repeat(32),
  invoice_id: 'in_1QxDemoAws0001',
  invoice_hash: '22'.repeat(32),
  verified_amount: '8420000',
  verified_currency: 'usd',
  verified_recipient:
    'addr_test1qpe3z9srjllzq27zndk5nxlcrxs8u6tr3lvs00xk3pcauwend7e3wv3tk360w5k3uz2nkneydscpuwp9t2uwggpsfzgsgehreu',
  status: 'open',
  facts: { exists: true, customer_match: true, status_open: true, amount_match: true, currency_match: true, recipient_match: true },
  result: 'VERIFIED',
  reason: null,
  trigger_id: '6f1c2a9e-7b1d-4c52-9a35-2f4f5d0c9b11',
};
