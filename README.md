# Claudia

Agents are infinite. Human attention is not. Claudia is the human authority layer for AI agents: it sits between an AI agent and consequential execution: the agent proposes, a deterministic engine checks the proposal against a mandate, external facts are verified, and funds move only for the exact action a human signed. Interrupting that human costs the agent a bond.

## What it does

- An agent proposes an action as a canonical Action IR (what, how much, to whom, why, under which mandate).
- The authority engine returns one of three outcomes: ALLOW, ESCALATE, DENY. Same inputs, same answer, no model in the loop.
- ESCALATE answers HTTP 402. The agent locks a bond in a Cardano escrow before the request reaches a person. A reasonable request is refunded; a frivolous one is captured by an unspendable sink. The approver never receives bond money.
- Each mandate carries an interrupt budget. Past it, escalations are denied and nobody is paged.
- The human reads a Decision Brief built from the evaluation, not from a chat transcript, and signs with a wallet on their own device.
- A Cardano vault enforces the signed authorization: exact amount, recipient, nonce, expiry, mandate version, approver signature.
- A Chainlink CRE workflow verifies the invoice facts and writes a report to Sepolia. Every decision lands in a hash-chained event log with a receipt anyone can recompute.

## Layout

| Path | Role |
|---|---|
| `packages/core` | Mandate, Action IR, engine, authorization bytes, Decision Brief, bond schemas |
| `contracts/cardano` | Aiken validators: mandate anchor, vault, escalation bond escrow, sink |
| `packages/cardano` | Transaction building, chain reads, bond lock and spend, Lace signing session |
| `packages/db` | Postgres schema, migrations, hash-chained event log |
| `packages/llm` | Provider-neutral model contract (Anthropic, Bedrock) and the proposal loop |
| `packages/stripe` | Read-only vendor invoice view and test-mode settlement |
| `packages/crebit` | Crebit payout rail client with signed, replay-protected requests |
| `apps/api` | Authority API: check, 402 gate, approvals, receipts, metrics, attack lab |
| `apps/agent` | Agent runtime that proposes actions and pays bonds |
| `apps/web` | Console: live run, approvals with brief, mandate, receipts, public authority page |
| `workflows/cre-verifier`, `packages/chainlink`, `contracts/sepolia` (`VerificationRegistry`) | CRE invoice verification and the Sepolia registry |
| `workflows/cre-fx-basis`, `contracts/sepolia` (`FxBasisRegistry`) | CRE FX basis attestation from Chainlink data feeds |
| `apps/masumi-worker`, `apps/masumi-payment`, `packages/masumi` | Masumi listing of the human authority endpoint and its payment service |
| `scripts` | Preprod deploy, bond demo, funding and lab reset scripts |

## Run

Requirements: Node 24+, pnpm, Postgres, Aiken 1.1.24 for contract changes, the CRE CLI for local verification.

```sh
pnpm install
cp .env.example .env            # fill values locally; the env file is never committed
pnpm -r typecheck && pnpm -r test

pnpm --filter @authority/api seed packages/cardano/deployments/preprod.json   # store the deployed mandates
pnpm --filter @authority/api start          # Authority API
pnpm --filter @authority/agent start        # agent runtime
pnpm --filter @authority/web dev            # console; without NEXT_PUBLIC_API_BASE_URL it serves recorded fixtures, no backend
pnpm --filter @authority/web fixture-api    # local fixture API on :8787, paired with `pnpm --filter @authority/web dev:fixture`
```

Cardano preprod: `pnpm --filter @authority/scripts cardano` deploys the anchor and vault for a mandate; `pnpm --filter @authority/scripts bond refund|capture` locks a bond and spends it. CRE: `cd workflows && cre workflow simulate cre-verifier --target local-simulation -e ../.env`.

## How a payment flows

1. The agent signs an Action IR and calls `POST /v1/authority/check`.
2. The engine evaluates mandate constraints. If a `verified_facts` constraint needs evidence, the API triggers the CRE workflow and evaluates again with the report.
3. ALLOW: the engine signs an authorization; the executor submits the vault release. DENY: the reason is logged, nothing moves.
4. ESCALATE: the API replies 402 with a `PAYMENT-REQUIRED` header. The agent locks the bond and retries with `PAYMENT-SIGNATURE`. The API verifies the escrow UTxO, builds the brief, and puts the approval in the human's inbox.
5. The human approves (signs the release, bond refunded) or declines with a reason (bond refunded or captured).
6. The vault validator checks every field of the authorization on chain. The receipt binds action, mandate, verification, brief, decision, and settlement.

## Evidence

Public site: https://claudiahq.vercel.app (recorded fixtures; agent-readable at `/llms.txt`, `/.well-known/agent.json`, `/openapi.json`).

Cardano preprod:

- Masumi registry entry: https://preprod.cardanoscan.io/transaction/fea9e74b95cc0ed76adbbdcd81f1bfd46276cf35c7dc976b2dff48208e32b1f8
- Escalation bond escrow lock: https://preprod.cardanoscan.io/transaction/a6f4b97b0cb893c051792008274eeecf22aa13a1f14c822e87cac27f7d6d69e6
- x402 exact-scheme bond lock: https://preprod.cardanoscan.io/transaction/4ba9ccc5fe684cc84b059be46353c2bf3b8b5d9218b4050b285d16419eaede66

Sepolia (CRE attestations):

- Invoice verification report: https://sepolia.etherscan.io/tx/0xfb197be58fdf69fdce1ba6eb31b45961b2c772d04f390b993a953771b31abb53
- FX basis report: https://sepolia.etherscan.io/tx/0x2549899d0f1884b944320919279ce0ce98539aeaa761b9a210bde332071b78a8

## License

MIT. See `LICENSE`.
