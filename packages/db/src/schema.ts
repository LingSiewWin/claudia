// The whole database schema. Idempotent: applying it twice is a no-op.
// JSON documents are stored as RFC 8785 text, never jsonb: jsonb rejects \u0000 and lone surrogates
// (agent-controlled strings may contain both) and normalizes numbers, which would break exact hashing.
export const SCHEMA = `
create table if not exists events (
  seq        bigint primary key,
  run_id     uuid not null,
  action_id  text,
  type       text not null,
  payload    text not null,
  prev_hash  bytea not null,
  hash       bytea not null unique,
  created_at timestamptz not null
);
create index if not exists events_by_run on events (run_id, seq);
create or replace function events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'events are append-only';
end $$;
create or replace trigger events_no_rewrite before update or delete on events
  for each row execute function events_append_only();
create or replace trigger events_no_truncate before truncate on events
  for each statement execute function events_append_only();

create table if not exists runs (
  run_id      uuid primary key,
  kind        text not null check (kind in ('stage', 'lab', 'masumi')),
  mandate_id  text not null,
  attack      text,
  goal        text not null,
  status      text not null check (status in ('pending', 'active', 'finished')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists mandates (
  id            text not null,
  version       int not null,
  doc           text not null,
  hash          text not null,
  binding       text not null,
  delegate_name text not null,
  kind          text not null check (kind in ('stage', 'lab')),
  created_at    timestamptz not null default now(),
  primary key (id, version)
);

create table if not exists idempotency (
  caller       text not null,
  key          text not null,
  request_hash text not null,
  status       int,
  response     text,
  created_at   timestamptz not null default now(),
  primary key (caller, key)
);

create table if not exists nonces (
  vault_hash text primary key,
  counter    numeric(20, 0) not null
);

create table if not exists approvals (
  id           bigserial primary key,
  run_id       uuid not null,
  mandate_id   text not null,
  action_id    text not null,
  proposal     text not null,
  evaluation   text not null,
  status       text not null check (status in ('pending', 'approving', 'authorized', 'declined', 'closed')),
  requested_at timestamptz not null default now()
);

create table if not exists authorizations (
  id            bigserial primary key,
  run_id        uuid not null,
  mandate_id    text not null,
  invoice_id    text,
  action_id     text not null,
  action_hash   text not null,
  digest        text not null unique,
  nonce         numeric(20, 0) not null,
  valid_until   bigint not null,
  record        text not null,
  context       text not null,
  approval_id   bigint,
  status        text not null check (status in ('issued', 'awaiting_cfo', 'queued', 'submitted', 'settled', 'failed', 'expired')),
  unsigned_tx   text,
  tx_hash       text,
  cfo_witness   text,
  error         text,
  stripe_marked boolean not null default false,
  created_at    timestamptz not null default now()
);

-- At most one authorization may ever be able to pay an invoice. The primary key is the reservation; it is taken in
-- the transaction that signs, and released only once the holder provably can no longer settle.
create table if not exists invoice_reservations (
  mandate_id       text not null,
  invoice_id       text not null,
  authorization_id bigint,
  created_at       timestamptz not null default now(),
  primary key (mandate_id, invoice_id)
);

create table if not exists receipts (
  id               bigserial primary key,
  kind             text not null check (kind in ('decision', 'settlement')),
  mandate_id       text not null,
  action_id        text,
  authorization_id bigint,
  body             text not null,
  hash             text not null,
  created_at       timestamptz not null default now()
);

create table if not exists cre_jobs (
  trigger_id text primary key,
  payload    text not null,
  status     text not null check (status in ('queued', 'claimed', 'done', 'expired')),
  output     text,
  created_at timestamptz not null default now()
);

create table if not exists pending_txs (
  tx_hash    text primary key,
  mandate_id text not null,
  kind       text not null check (kind in ('revoke', 'update')),
  version    int not null,
  new_doc    text,
  tx_cbor    text not null,
  created_at timestamptz not null default now()
);
`;
