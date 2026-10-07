# Authority Layer

Delegated, verifiable authority for AI agents. An agent proposes an action; a deterministic engine checks it against a mandate the organization granted; external facts are verified; and an on-chain vault releases funds only for the exact action that was authorized.

Status: under active development.

## Invoice verification workflow

A Chainlink CRE workflow in `workflows/cre-verifier` fetches the Stripe invoice, compares it with the requested payment, and writes a signed report to the Sepolia verification registry.

```sh
cp workflows/secrets.yaml.example workflows/secrets.yaml   # secret names only; values come from .env
cd workflows && cre workflow simulate cre-verifier --target local-simulation -e ../.env
```

Simulation targets can only be run by the operator. A deployed target must list the engine's EVM signing addresses in `authorizedKeys`; the workflow refuses to start without them.
