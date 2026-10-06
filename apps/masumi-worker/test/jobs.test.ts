import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MpsError, mip004InputHash, mip004ResultHashEscaped } from '@authority/masumi';
import { afterAll, describe, expect, it } from 'vitest';
import { AuthorityContractError, createAuthorityClient, type AuthorityClient } from '../src/authority';
import { advanceJob, createMip003Handler, jobStatus, startJob, type JobDeps, type JobRecord } from '../src/jobs';
import { Journal, LEASE_TTL_MS, holdGeneration, tryAcquireLease } from '../src/journal';
import { ENGINE_PUBLIC_KEY, SIGNED_INPUT, SOURCE, WEB, authorityResponse, fakeMps, startFakeAuthority } from './fakes';

const ID = 'aabbccddeeff00112233';
const NOW = Date.parse('2026-10-07T03:00:00.000Z');
const MIN = 60_000;
const servers: { close: () => Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function setup(over: Partial<JobDeps> = {}, respond?: Parameters<typeof startFakeAuthority>[0]) {
  const api = await startFakeAuthority(respond);
  servers.push(api);
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  const leaseDir = mkdtempSync(join(tmpdir(), 'lease-'));
  const mps = fakeMps();
  let now = NOW;
  expect(tryAcquireLease(leaseDir, 'worker', now)).toBe(true);
  const generation = holdGeneration(leaseDir);
  expect(generation).toEqual(expect.any(String));
  const deps: JobDeps = {
    jobs: new Journal<JobRecord>(dir),
    mps: mps.client,
    authority: createAuthorityClient({ baseUrl: api.url, apiKey: 'k', enginePublicKey: ENGINE_PUBLIC_KEY }),
    source: SOURCE,
    webUrl: WEB,
    now: () => now,
    log: () => {},
    leaseDir,
    generation,
    ...over,
  };
  // A restart: a fresh journal object on the same directory, same external services and lease.
  const restart = (): JobDeps => ({ ...deps, jobs: new Journal<JobRecord>(dir) });
  return { deps, mps, api, restart, tick: (ms: number) => (now += ms), leaseDir };
}

const start = (deps: JobDeps, input: unknown = SIGNED_INPUT, identifier = ID) =>
  startJob({ identifier_from_purchaser: identifier, input_data: input }, deps);

describe('POST /start_job (idempotent per identifier_from_purchaser)', () => {
  it('returns MIP-003 payment terms with the MIP-004 input hash', async () => {
    const { deps } = await setup();
    const r = await start(deps);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      identifierFromPurchaser: ID,
      input_hash: mip004InputHash(SIGNED_INPUT, ID),
      agentIdentifier: SOURCE.agentIdentifier,
      sellerVKey: SOURCE.sellerVkey,
      paymentSourceType: 'Web3CardanoV2',
      supportedPaymentSourceIndex: 0,
    });
    const body = r.body as { payByTime: number; submitResultTime: number };
    expect(body.submitResultTime - body.payByTime).toBe(15 * MIN); // the signed millisecond values, unchanged
  });

  it('the same identifier and input twice: one payment request, identical response', async () => {
    const { deps, mps } = await setup();
    const a = await start(deps);
    const b = await start(deps);
    expect(b).toEqual(a);
    expect(mps.calls.create).toBe(1);
  });

  it('the same identifier with a different input: 409, no second payment request', async () => {
    const { deps, mps } = await setup();
    await start(deps);
    const r = await start(deps, { mandate_id: 'M-001', request_text: 'Pay AWS invoice INV-M-0003' });
    expect(r.status).toBe(409);
    expect(mps.calls.create).toBe(1);
  });

  it('mixed-case identifier is the same purchase: one payment request', async () => {
    const { deps, mps } = await setup();
    const a = await start(deps, SIGNED_INPUT, 'AABBCCDDEEFF00112233');
    const b = await start(deps, SIGNED_INPUT, 'aabbccddeeff00112233');
    expect(b).toEqual(a);
    expect((a.body as { identifierFromPurchaser: string }).identifierFromPurchaser).toBe(ID);
    expect(mps.calls.create).toBe(1);
  });

  it.each<[string, unknown, string]>([
    ['non-hex identifier', SIGNED_INPUT, 'resume-job-123'],
    ['unknown input field', { ...SIGNED_INPUT, approve: true }, ID],
    ['input is text', 'pay it', ID],
  ])('hostile input (%s) is rejected before any payment request', async (_label, input, identifier) => {
    const { deps, mps } = await setup();
    expect((await start(deps, input, identifier)).status).toBe(400);
    expect(mps.calls.create).toBe(0);
  });

  it('without a confirmed registration it refuses with 503', async () => {
    const { deps } = await setup({ source: null });
    expect((await start(deps)).status).toBe(503);
  });

  it('crash after creating the payment: restart inspects and does not request a second payment', async () => {
    const { deps, mps, restart } = await setup();
    const crashing: JobDeps = {
      ...deps,
      mps: {
        ...deps.mps,
        createPayment: async (body) => {
          const p = await deps.mps.createPayment(body);
          throw new Error('connection reset after the write');
        },
      },
    };
    expect((await start(crashing)).status).toBe(502);
    expect(deps.jobs.read(ID)?.stage).toBe('needs-inspection');
    expect((await start(restart())).status).toBe(409);
    expect(restart().jobs.read(ID)?.stage).toBe('needs-inspection');
    expect(mps.calls.create).toBe(1);
  });

  it('restart from quote-pending with no stored payment: inspects, no second payment', async () => {
    const { deps, mps, restart } = await setup();
    deps.jobs.write(ID, {
      id: '00000000-0000-0000-0000-000000000001',
      identifier: ID,
      inputHash: mip004InputHash(SIGNED_INPUT, ID),
      request: SIGNED_INPUT,
      stage: 'quote-pending',
    });
    expect((await start(restart())).status).toBe(409);
    expect(restart().jobs.read(ID)?.stage).toBe('needs-inspection');
    expect(mps.calls.create).toBe(0);
  });

  it('retries createPayment on 408 and 429 until it succeeds', async () => {
    const { deps, mps } = await setup();
    let n = 0;
    const inner = deps.mps;
    const wrapped: JobDeps = {
      ...deps,
      mps: {
        ...inner,
        createPayment: async (body) => {
          n += 1;
          if (n === 1) throw new MpsError('request timeout', 408);
          if (n === 2) throw new MpsError('rate limited', 429);
          return inner.createPayment(body);
        },
      },
    };
    const r = await start(wrapped);
    expect(r.status).toBe(200);
    expect(n).toBe(3);
    expect(mps.calls.create).toBe(1);
  });

  it('createPayment 5xx is uncertain: needs-inspection, no retry on restart', async () => {
    const { deps, mps, restart } = await setup();
    const failing: JobDeps = {
      ...deps,
      mps: {
        ...deps.mps,
        createPayment: async () => {
          throw new MpsError('server error', 503);
        },
      },
    };
    expect((await start(failing)).status).toBe(502);
    expect(deps.jobs.read(ID)?.stage).toBe('needs-inspection');
    expect((await start(restart())).status).toBe(409);
    expect(mps.calls.create).toBe(0);
  });

  it('refuses createPayment if the lease generation no longer matches', async () => {
    const { deps, mps, leaseDir } = await setup();
    tryAcquireLease(leaseDir, 'other', NOW + LEASE_TTL_MS);
    expect((await start(deps)).status).toBe(502);
    expect(deps.jobs.read(ID)?.stage).toBe('needs-inspection');
    expect(mps.calls.create).toBe(0);
  });
});

describe('job execution', () => {
  it('waits for confirmed FundsLocked, then checks once and submits the MIP-004 result hash once', async () => {
    const { deps, mps, api, restart } = await setup();
    const r = await start(deps);
    const jobId = (r.body as { id: string }).id;
    let job = await advanceJob(deps.jobs.read(ID)!, deps);
    expect(job.stage).toBe('awaiting-payment');
    expect(api.calls).toHaveLength(0);
    mps.lock();
    job = await advanceJob(job, deps);
    expect(job.stage).toBe('completed');
    expect(mps.only().resultHash).toBe(mip004ResultHashEscaped(job.resultText!, ID));
    expect(jobStatus(jobId, deps)).toEqual({ status: 200, body: { status: 'completed', result: job.resultText } });

    // The buyer retries and the worker restarts: stored terms, no new charge, no new check, no second submit.
    expect((await start(restart())).body).toEqual(r.body);
    await advanceJob(restart().jobs.read(ID)!, restart());
    expect(mps.calls.create).toBe(1);
    expect(mps.calls.submit).toBe(1);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.key).toBe(`masumi:${ID}`);
  });

  it('crash after submit-result: the restart sees the stored hash and does not submit again', async () => {
    const { deps, mps, restart } = await setup();
    await start(deps);
    mps.lock();
    const crashing: JobDeps = {
      ...deps,
      mps: {
        ...deps.mps,
        submitResult: async (bid, hash) => {
          await deps.mps.submitResult(bid, hash);
          throw new Error('connection reset after the write');
        },
      },
    };
    expect((await advanceJob(deps.jobs.read(ID)!, crashing)).stage).toBe('submit-pending');
    expect((await advanceJob(restart().jobs.read(ID)!, restart())).stage).toBe('completed');
    expect(mps.calls.submit).toBe(1);
  });

  it('API unavailable: stays authority-pending and retries with the same idempotency key', async () => {
    const { deps, mps, api } = await setup({}, () => ({ status: 503, json: {} }));
    await start(deps);
    mps.lock();
    let job = await advanceJob(deps.jobs.read(ID)!, deps);
    expect(job.stage).toBe('authority-pending');
    job = await advanceJob(job, deps);
    expect(api.calls.map((c) => c.key)).toEqual([`masumi:${ID}`, `masumi:${ID}`]);
    expect(mps.calls.submit).toBe(0);
  });

  it('HTTP 408 stays authority-pending and retries with the same idempotency key', async () => {
    const { deps, mps, api } = await setup({}, () => ({ status: 408, json: {} }));
    await start(deps);
    mps.lock();
    let job = await advanceJob(deps.jobs.read(ID)!, deps);
    expect(job.stage).toBe('authority-pending');
    job = await advanceJob(job, deps);
    expect(api.calls.map((c) => c.key)).toEqual([`masumi:${ID}`, `masumi:${ID}`]);
    expect(mps.calls.submit).toBe(0);
  });

  it('HTTP 429 waits for Retry-After before the next check', async () => {
    const { deps, mps, api, tick } = await setup({}, () => ({
      status: 429,
      json: {},
      headers: { 'retry-after': '120' },
    }));
    await start(deps);
    mps.lock();
    let job = await advanceJob(deps.jobs.read(ID)!, deps);
    expect(job.stage).toBe('authority-pending');
    expect(api.calls).toHaveLength(1);
    job = await advanceJob(job, deps);
    expect(api.calls).toHaveLength(1);
    tick(120_000);
    job = await advanceJob(job, deps);
    expect(api.calls.map((c) => c.key)).toEqual([`masumi:${ID}`, `masumi:${ID}`]);
  });

  it('no check runs when the result deadline is too close (the escrow refunds the buyer)', async () => {
    const { deps, mps, api, tick } = await setup();
    await start(deps);
    mps.lock();
    tick(24 * MIN);
    expect((await advanceJob(deps.jobs.read(ID)!, deps)).stage).toBe('failed');
    expect(api.calls).toHaveLength(0);
  });

  it('a contract violation from the API fails the job instead of selling it', async () => {
    const bad: AuthorityClient = {
      check: async () => {
        throw new AuthorityContractError('authorization returned for an unsigned proposal');
      },
    };
    const { deps, mps } = await setup({ authority: bad });
    await start(deps);
    mps.lock();
    expect((await advanceJob(deps.jobs.read(ID)!, deps)).stage).toBe('failed');
    expect(mps.calls.submit).toBe(0);
  });

  it('refuses delivery when the API decision_hash differs from the worker-computed one', async () => {
    const { deps, mps } = await setup({}, () => ({
      status: 200,
      json: { ...authorityResponse(), decision_hash: '00'.repeat(32) },
    }));
    await start(deps);
    mps.lock();
    expect((await advanceJob(deps.jobs.read(ID)!, deps)).stage).toBe('failed');
    expect(mps.calls.submit).toBe(0);
  });

  it('refuses a signed ALLOW without an authorization record', async () => {
    const { deps, mps } = await setup({}, () => ({
      status: 200,
      json: authorityResponse({ authorization: null }),
    }));
    await start(deps);
    mps.lock();
    expect((await advanceJob(deps.jobs.read(ID)!, deps)).stage).toBe('failed');
    expect(mps.calls.submit).toBe(0);
  });

  it('refuses the authority check if the lease generation no longer matches', async () => {
    const { deps, mps, api, leaseDir } = await setup();
    await start(deps);
    mps.lock();
    tryAcquireLease(leaseDir, 'other', NOW + LEASE_TTL_MS);
    const job = await advanceJob(deps.jobs.read(ID)!, deps);
    expect(job.stage).toBe('needs-inspection');
    expect(api.calls).toHaveLength(0);
    expect(mps.calls.submit).toBe(0);
  });

  it('refuses submit-result if the lease generation no longer matches', async () => {
    const { deps, mps, api, leaseDir } = await setup();
    const realCheck = deps.authority.check.bind(deps.authority);
    const stealing: JobDeps = {
      ...deps,
      authority: {
        check: async (request, key, opts) => {
          const res = await realCheck(request, key, opts);
          tryAcquireLease(leaseDir, 'other', NOW + LEASE_TTL_MS);
          return res;
        },
      },
    };
    await start(stealing);
    mps.lock();
    const job = await advanceJob(stealing.jobs.read(ID)!, stealing);
    expect(job.stage).toBe('needs-inspection');
    expect(api.calls).toHaveLength(1);
    expect(mps.calls.submit).toBe(0);
  });

  it('FundsOrDatumInvalid and RefundRequested fail the job', async () => {
    const { deps, mps } = await setup();
    await start(deps);
    mps.only().onChainState = 'FundsOrDatumInvalid';
    expect((await advanceJob(deps.jobs.read(ID)!, deps)).stage).toBe('failed');
    const { deps: deps2, mps: mps2 } = await setup();
    await start(deps2, SIGNED_INPUT, 'bbccddeeff0011223344');
    mps2.only().onChainState = 'RefundRequested';
    expect((await advanceJob(deps2.jobs.read('bbccddeeff0011223344')!, deps2)).stage).toBe('failed');
  });
});

describe('GET /demo and the input schema default', () => {
  it('404 until a real run is recorded; then the demo and the ALLOW proposal as the default input', async () => {
    const { deps } = await setup();
    const demoFile = join(mkdtempSync(join(tmpdir(), 'demo-')), 'demo.json');
    const server = createServer(createMip003Handler(deps, demoFile));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/demo`)).status).toBe(404);
    const demo = { input: SIGNED_INPUT, output: { result: '{"decision":"ALLOW"}' }, examples: [SIGNED_INPUT] };
    writeFileSync(demoFile, JSON.stringify(demo));
    expect(await (await fetch(`${base}/demo`)).json()).toEqual(demo);
    const schema = (await (await fetch(`${base}/input_schema`)).json()) as { input_data: { id: string; data: { default?: string } }[] };
    expect(schema.input_data.find((f) => f.id === 'proposal')?.data.default).toBe(JSON.stringify(SIGNED_INPUT.proposal));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('MIP-003 HTTP server', () => {
  it('serves availability, input schema, start_job and status', async () => {
    const { deps } = await setup();
    const server = createServer(createMip003Handler(deps, join(tmpdir(), 'no-demo-here.json')));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await (await fetch(`${base}/availability`)).json()).toMatchObject({ status: 'available', type: 'masumi-agent' });
    expect(((await (await fetch(`${base}/input_schema`)).json()) as { input_data: unknown[] }).input_data).toHaveLength(3);
    const started = await fetch(`${base}/start_job`, { method: 'POST', body: JSON.stringify({ identifier_from_purchaser: ID, input_data: SIGNED_INPUT }) });
    const { id } = (await started.json()) as { id: string };
    expect(await (await fetch(`${base}/status?job_id=${id}`)).json()).toEqual({ status: 'awaiting_payment' });
    expect((await fetch(`${base}/status?job_id=00000000-0000-0000-0000-000000000000`)).status).toBe(404);
    expect((await fetch(`${base}/start_job`, { method: 'POST', body: 'x'.repeat(16_385) })).status).toBe(413);
    expect((await fetch(`${base}/start_job`, { method: 'POST', body: '{oops' })).status).toBe(400);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
