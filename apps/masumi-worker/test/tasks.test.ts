import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollectionError, MpsError, mip004InputHash, mip004ResultHashEscaped, type CollectionProof } from '@authority/masumi';
import { afterAll, describe, expect, it } from 'vitest';
import { createAuthorityClient } from '../src/authority';
import { Journal, LEASE_TTL_MS, holdGeneration, tryAcquireLease } from '../src/journal';
import { PAYMENT_COMMENT, advanceTask, pollTasks, taskNonce, type TaskDeps, type TaskRecord } from '../src/tasks';
import { COWORKER, fakeCore } from './fake-core';
import { ENGINE_PUBLIC_KEY, SIGNED_INPUT, SOURCE, WEB, fakeMps, startFakeAuthority } from './fakes';

const TASK = '01a10ef7-d2cf-73d8-b084-47898de89fce';
const NOW = Date.parse('2026-10-07T03:00:00.000Z');
const COLLECTION_TX = '64a9b1a031d220fb48653171fe8989d722ad25c05c8c5e26287ca15e0fa08bed';
const servers: { close: () => Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function setup(
  paid: boolean,
  description: string | null = JSON.stringify(SIGNED_INPUT),
  respond?: Parameters<typeof startFakeAuthority>[0],
) {
  const api = await startFakeAuthority(respond);
  servers.push(api);
  const dir = mkdtempSync(join(tmpdir(), 'tasks-'));
  const leaseDir = mkdtempSync(join(tmpdir(), 'lease-'));
  const mps = fakeMps();
  const core = fakeCore();
  core.addTask(TASK, description);
  const verified: string[] = [];
  expect(tryAcquireLease(leaseDir, 'worker', NOW)).toBe(true);
  const generation = holdGeneration(leaseDir);
  expect(generation).toEqual(expect.any(String));
  const deps: TaskDeps = {
    tasks: new Journal<TaskRecord>(dir),
    core: core.client,
    mps: mps.client,
    authority: createAuthorityClient({ baseUrl: api.url, apiKey: 'k', enginePublicKey: ENGINE_PUBLIC_KEY }),
    source: SOURCE,
    coworkerId: COWORKER,
    paid,
    webUrl: WEB,
    verifyCollection: async (txHash, sellerAddress): Promise<CollectionProof> => {
      verified.push(txHash);
      return { txHash, sellerAddress, unit: 'u', netUnits: '1000000', blockHeight: 1, explorer: `https://preprod.cardanoscan.io/transaction/${txHash}` };
    },
    now: () => NOW,
    log: () => {},
    leaseDir,
    generation,
  };
  const restart = (over: Partial<TaskDeps> = {}): TaskDeps => ({ ...deps, tasks: new Journal<TaskRecord>(dir), ...over });
  const rec = (): TaskRecord => new Journal<TaskRecord>(dir).read(TASK)!;
  const statusEvents = (s: string) => core.events.filter((e) => e.body.status === s);
  const paymentEvents = () => core.events.filter((e) => e.body.masumiPayment !== undefined);
  return { deps, mps, core, api, restart, rec, statusEvents, paymentEvents, verified, leaseDir };
}

describe('execution-only Task', () => {
  it('RUNNING, one authority check, COMPLETED with the exact result; no payment calls', async () => {
    const t = await setup(false);
    await pollTasks(t.deps);
    const r = t.rec();
    expect(r.stage).toBe('completed');
    expect(t.statusEvents('RUNNING')).toHaveLength(1);
    expect(t.statusEvents('COMPLETED')[0]?.body.comment).toBe(r.resultText);
    expect(t.api.calls.map((c) => c.key)).toEqual([`sokosumi:${TASK}`]);
    expect(t.mps.calls).toEqual({ create: 0, resolve: 0, submit: 0 });
  });

  it('plain-English Task is evaluated unsigned: no authorization in the delivered result', async () => {
    const t = await setup(false, 'Pay AWS invoice INV-M-0001');
    await pollTasks(t.deps);
    const result = JSON.parse(t.rec().resultText!) as { authorization: unknown; notice: string };
    expect(t.api.calls[0]?.body).toEqual({ mandate_id: 'M-001', request_text: 'Pay AWS invoice INV-M-0001', execute: false });
    expect(result.authorization).toBeNull();
    expect(result.notice).toBe('unsigned: evaluation only');
  });

  it('invalid input fails the Task without any payment', async () => {
    const t = await setup(true, '{"mandate_id":"M-001","request_text":"x","approve":true}');
    await pollTasks(t.deps);
    expect(t.rec().stage).toBe('failed');
    expect(t.statusEvents('FAILED')).toHaveLength(1);
    expect(t.mps.calls.create).toBe(0);
  });

  it('waits while Core parks the Task for a Vendor access grant', async () => {
    const t = await setup(false);
    t.deps.tasks.write(TASK, { taskId: TASK, stage: 'start-pending', paid: false });
    t.core.tasks.get(TASK)!.status = 'GRANT_PENDING';
    await advanceTask(t.rec(), t.deps);
    expect(t.rec().stage).toBe('start-pending');
    expect(t.core.events).toHaveLength(0);
    t.core.tasks.get(TASK)!.status = 'READY';
    await advanceTask(t.rec(), t.deps);
    expect(t.rec().stage).toBe('completed');
  });

  it('ignores Tasks assigned to another coworker', async () => {
    const t = await setup(false);
    t.core.tasks.clear();
    t.core.addTask('other-task', 'Pay AWS', 'someone-else');
    await pollTasks(t.deps);
    expect(t.core.events).toHaveLength(0);
  });
});

describe('paid Task', () => {
  it('one quote, one payment event, one check, one result submission, then verified collection', async () => {
    const t = await setup(true);
    await pollTasks(t.deps);
    expect(t.rec().stage).toBe('awaiting-funds');
    const nonce = taskNonce(TASK);
    const quote = t.mps.only();
    expect(quote.inputHash).toBe(mip004InputHash({ taskId: TASK, name: 'Authority check', description: JSON.stringify(SIGNED_INPUT) }, nonce));
    const [pay] = t.paymentEvents();
    expect(pay?.body.comment).toBe(PAYMENT_COMMENT);
    expect(pay?.body.masumiPayment).toMatchObject({ blockchainIdentifier: quote.blockchainIdentifier, identifierFromPurchaser: nonce, inputHash: quote.inputHash });
    expect(t.api.calls).toHaveLength(0); // no work before the escrow is funded

    await pollTasks(t.deps); // funds still not locked
    expect(t.api.calls).toHaveLength(0);

    t.mps.lock();
    await pollTasks(t.deps);
    const r = t.rec();
    expect(r.stage).toBe('collection-pending');
    expect(t.mps.only().resultHash).toBe(mip004ResultHashEscaped(r.resultText!, nonce));
    expect(t.statusEvents('COMPLETED')[0]?.body.comment).toBe(r.resultText);

    await pollTasks(t.deps); // Core not settled yet
    expect(t.rec().stage).toBe('collection-pending');
    t.core.settle(COLLECTION_TX);
    t.mps.withdraw(COLLECTION_TX);
    await pollTasks(t.deps);
    expect(t.rec()).toMatchObject({ stage: 'settled', proof: { txHash: COLLECTION_TX, netUnits: '1000000' } });
    expect(t.verified).toEqual([COLLECTION_TX]);

    expect(t.mps.calls.create).toBe(1);
    expect(t.paymentEvents()).toHaveLength(1);
    expect(t.api.calls).toHaveLength(1);
    expect(t.mps.calls.submit).toBe(1);
    expect(t.statusEvents('COMPLETED')).toHaveLength(1);
  });

  it('a crash right after each external write never repeats a charge, a check, or a completion', async () => {
    const t = await setup(true);
    const once = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => {
      let crashed = false;
      return async (...a: A): Promise<R> => {
        const out = await fn(...a);
        if (!crashed) {
          crashed = true;
          throw new Error('crash after the write');
        }
        return out;
      };
    };
    const crashCore = { ...t.deps.core, postEvent: once(t.deps.core.postEvent) };
    // RUNNING is written, then the process dies.
    t.deps.tasks.write(TASK, { taskId: TASK, stage: 'start-pending', paid: true });
    await advanceTask(t.rec(), t.restart({ core: crashCore })).catch(() => {});
    expect(t.rec().stage).toBe('start-pending');
    // The payment event is written, then the process dies.
    await advanceTask(t.rec(), t.restart({ core: { ...t.deps.core, postEvent: once(t.deps.core.postEvent) } })).catch(() => {});
    expect(t.rec().stage).toBe('payment-event-pending');
    await advanceTask(t.rec(), t.restart());
    expect(t.rec().stage).toBe('awaiting-funds');
    t.mps.lock();
    // The check answers, then the process dies before saving it.
    const check = once(t.deps.authority.check);
    await advanceTask(t.rec(), t.restart({ authority: { check } })).catch(() => {});
    // The result hash is submitted, then the process dies.
    await advanceTask(t.rec(), t.restart({ mps: { ...t.deps.mps, submitResult: once(t.deps.mps.submitResult) } })).catch(() => {});
    // COMPLETED is written, then the process dies.
    await advanceTask(t.rec(), t.restart({ core: { ...t.deps.core, postEvent: once(t.deps.core.postEvent) } })).catch(() => {});
    await advanceTask(t.rec(), t.restart());

    expect(t.rec().stage).toBe('collection-pending');
    expect(t.statusEvents('RUNNING')).toHaveLength(1);
    expect(t.mps.calls.create).toBe(1);
    expect(t.paymentEvents()).toHaveLength(1);
    expect(t.api.evaluations()).toBe(1); // the retried check reused the stored decision via Idempotency-Key
    expect(new Set(t.api.calls.map((c) => c.key))).toEqual(new Set([`sokosumi:${TASK}`]));
    expect(t.mps.calls.submit).toBe(1);
    expect(t.statusEvents('COMPLETED')).toHaveLength(1);
  });

  it('an unconfirmable payment event is never posted again', async () => {
    const t = await setup(true);
    await advanceTask({ taskId: TASK, stage: 'start-pending', paid: true }, t.restart({ core: { ...t.deps.core, postEvent: async (id, body) => {
      if (body.masumiPayment) throw new Error('timeout, outcome unknown');
      return t.deps.core.postEvent(id, body);
    } } })).catch(() => {});
    expect(t.rec().stage).toBe('payment-event-pending');
    await advanceTask(t.rec(), t.restart());
    expect(t.rec().stage).toBe('needs-inspection');
    expect(t.paymentEvents()).toHaveLength(0);
  });

  it('signed terms that differ from the request are rejected before anyone is charged', async () => {
    const t = await setup(true);
    const tampered = { ...t.deps.mps, createPayment: async (b: Parameters<typeof t.deps.mps.createPayment>[0]) => ({ ...(await t.deps.mps.createPayment(b)), RequestedFunds: [{ amount: '5000000', unit: b.RequestedFunds[0]!.unit }] }) };
    await pollTasks({ ...t.deps, mps: tampered });
    expect(t.rec().stage).toBe('needs-inspection');
    expect(t.statusEvents('FAILED')).toHaveLength(0);
    expect(t.paymentEvents()).toHaveLength(0);
    await pollTasks(t.restart());
    expect(t.rec().stage).toBe('needs-inspection');
    expect(t.mps.calls.create).toBe(1);
    expect(t.statusEvents('FAILED')).toHaveLength(0);
  });

  it('no check runs once the result deadline is near; the Task fails and the escrow refunds', async () => {
    const t = await setup(true);
    await pollTasks(t.deps);
    t.mps.lock();
    await pollTasks({ ...t.deps, now: () => NOW + 24 * 60_000 });
    expect(t.rec().stage).toBe('failed');
    expect(t.api.calls).toHaveLength(0);
    expect(t.mps.calls.submit).toBe(0);
  });
});

describe('payment request and lease', () => {
  it('crash after creating the payment: restart inspects and does not request a second payment', async () => {
    const t = await setup(true);
    t.deps.tasks.write(TASK, { taskId: TASK, stage: 'start-pending', paid: true });
    const crashing: TaskDeps = {
      ...t.deps,
      mps: {
        ...t.deps.mps,
        createPayment: async (body) => {
          const p = await t.deps.mps.createPayment(body);
          throw new Error('connection reset after the write');
        },
      },
    };
    await advanceTask(t.rec(), crashing);
    expect(t.rec().stage).toBe('needs-inspection');
    await advanceTask(t.rec(), t.restart());
    expect(t.rec().stage).toBe('needs-inspection');
    expect(t.mps.calls.create).toBe(1);
    expect(t.paymentEvents()).toHaveLength(0);
  });

  it('restart from quote-pending with no stored payment: inspects, no second payment', async () => {
    const t = await setup(true);
    t.deps.tasks.write(TASK, {
      taskId: TASK,
      stage: 'quote-pending',
      paid: true,
      request: SIGNED_INPUT,
      nonce: taskNonce(TASK),
      inputHash: 'ab'.repeat(32),
    });
    await advanceTask(t.rec(), t.restart());
    expect(t.rec().stage).toBe('needs-inspection');
    expect(t.mps.calls.create).toBe(0);
  });

  it('retries createPayment on 408 and 429 until it succeeds', async () => {
    const t = await setup(true);
    let n = 0;
    const inner = t.deps.mps;
    const wrapped: TaskDeps = {
      ...t.deps,
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
    await pollTasks(wrapped);
    expect(t.rec().stage).toBe('awaiting-funds');
    expect(n).toBe(3);
    expect(t.mps.calls.create).toBe(1);
  });

  it('createPayment 408 stays quote-pending so a later poll can request the payment once', async () => {
    const t = await setup(true);
    const failing: TaskDeps = {
      ...t.deps,
      mps: {
        ...t.deps.mps,
        createPayment: async () => {
          throw new MpsError('request timeout', 408);
        },
      },
    };
    await pollTasks(failing);
    expect(t.rec()).toMatchObject({ stage: 'quote-pending', createRetryable: true });
    expect(t.paymentEvents()).toHaveLength(0);
    await pollTasks(t.deps);
    expect(t.rec().stage).toBe('awaiting-funds');
    expect(t.mps.calls.create).toBe(1);
  });

  it('createPayment 5xx is uncertain: needs-inspection, no retry on restart', async () => {
    const t = await setup(true);
    const failing: TaskDeps = {
      ...t.deps,
      mps: {
        ...t.deps.mps,
        createPayment: async () => {
          throw new MpsError('server error', 503);
        },
      },
    };
    await pollTasks(failing);
    expect(t.rec().stage).toBe('needs-inspection');
    await pollTasks(t.restart());
    expect(t.rec().stage).toBe('needs-inspection');
    expect(t.mps.calls.create).toBe(0);
    expect(t.paymentEvents()).toHaveLength(0);
  });

  it('a rejected payment request fails the task before anyone is charged', async () => {
    const t = await setup(true);
    const failing: TaskDeps = {
      ...t.deps,
      mps: {
        ...t.deps.mps,
        createPayment: async () => {
          throw new MpsError('rejected', 400);
        },
      },
    };
    await pollTasks(failing);
    expect(t.rec().stage).toBe('failed');
    expect(t.paymentEvents()).toHaveLength(0);
    expect(t.mps.calls.create).toBe(0);
  });

  it('refuses the payment event if the lease generation no longer matches', async () => {
    const t = await setup(true);
    const realCreate = t.deps.mps.createPayment.bind(t.deps.mps);
    const stealing: TaskDeps = {
      ...t.deps,
      mps: {
        ...t.deps.mps,
        createPayment: async (body) => {
          const p = await realCreate(body);
          tryAcquireLease(t.leaseDir, 'other', NOW + LEASE_TTL_MS);
          return p;
        },
      },
    };
    await pollTasks(stealing);
    expect(t.rec().stage).toBe('needs-inspection');
    expect(t.paymentEvents()).toHaveLength(0);
    expect(t.mps.calls.create).toBe(1);
  });

  it('refuses createPayment if the lease generation no longer matches', async () => {
    const t = await setup(true);
    tryAcquireLease(t.leaseDir, 'other', NOW + LEASE_TTL_MS);
    await pollTasks(t.deps);
    expect(t.rec().stage).toBe('needs-inspection');
    expect(t.mps.calls.create).toBe(0);
  });

  it('passes the result deadline into the authority check', async () => {
    const t = await setup(true);
    let seen: number | undefined;
    const real = t.deps.authority.check.bind(t.deps.authority);
    const deps: TaskDeps = {
      ...t.deps,
      authority: {
        check: async (request, key, opts) => {
          seen = opts?.deadlineMs;
          return real(request, key, opts);
        },
      },
    };
    await pollTasks(deps);
    t.mps.lock();
    await pollTasks(deps);
    expect(seen).toBe(Number(t.mps.only().submitResultTime));
    expect(t.rec().stage).toBe('collection-pending');
  });

  it('HTTP 408 stays authority-pending and retries with the same idempotency key', async () => {
    const t = await setup(true, JSON.stringify(SIGNED_INPUT), () => ({ status: 408, json: {} }));
    await pollTasks(t.deps);
    t.mps.lock();
    await pollTasks(t.deps);
    expect(t.rec().stage).toBe('authority-pending');
    await pollTasks(t.deps);
    expect(t.api.calls.map((c) => c.key)).toEqual([`sokosumi:${TASK}`, `sokosumi:${TASK}`]);
    expect(t.mps.calls.submit).toBe(0);
  });

  it('HTTP 429 waits for Retry-After before the next check', async () => {
    const t = await setup(true, JSON.stringify(SIGNED_INPUT), () => ({
      status: 429,
      json: {},
      headers: { 'retry-after': '120' },
    }));
    await pollTasks(t.deps);
    t.mps.lock();
    // retryAfterMs clamps to wall Date.now(); pin the journaled deadline (deadlineMs) far ahead so a 120s wait is not 0.
    const rec = t.rec();
    t.deps.tasks.write(TASK, {
      ...rec,
      payment: { ...rec.payment!, submitResultTime: String(Date.parse('2099-01-01T00:00:00.000Z')) },
    });
    let now = NOW;
    const deps = { ...t.deps, now: () => now };
    await pollTasks(deps);
    expect(t.rec().stage).toBe('authority-pending');
    expect(t.api.calls).toHaveLength(1);
    await pollTasks(deps);
    expect(t.api.calls).toHaveLength(1);
    now += 120_000;
    await pollTasks(deps);
    expect(t.api.calls.map((c) => c.key)).toEqual([`sokosumi:${TASK}`, `sokosumi:${TASK}`]);
  });

  it('refuses the authority check if the lease generation no longer matches', async () => {
    const t = await setup(true);
    await pollTasks(t.deps);
    t.mps.lock();
    tryAcquireLease(t.leaseDir, 'other', NOW + LEASE_TTL_MS);
    await pollTasks(t.deps);
    expect(t.rec().stage).toBe('needs-inspection');
    expect(t.api.calls).toHaveLength(0);
    expect(t.mps.calls.submit).toBe(0);
  });

  it('refuses submit-result if the lease generation no longer matches', async () => {
    const t = await setup(true);
    const realCheck = t.deps.authority.check.bind(t.deps.authority);
    const stealing: TaskDeps = {
      ...t.deps,
      authority: {
        check: async (request, key, opts) => {
          const res = await realCheck(request, key, opts);
          tryAcquireLease(t.leaseDir, 'other', NOW + LEASE_TTL_MS);
          return res;
        },
      },
    };
    await pollTasks(stealing);
    t.mps.lock();
    await pollTasks(stealing);
    expect(t.rec().stage).toBe('needs-inspection');
    expect(t.api.calls).toHaveLength(1);
    expect(t.mps.calls.submit).toBe(0);
  });

  it('FundsOrDatumInvalid and RefundRequested fail the task', async () => {
    const t = await setup(true);
    await pollTasks(t.deps);
    t.mps.only().onChainState = 'FundsOrDatumInvalid';
    await pollTasks(t.deps);
    expect(t.rec().stage).toBe('failed');
    const t2 = await setup(true);
    await pollTasks(t2.deps);
    t2.mps.only().onChainState = 'RefundRequested';
    await pollTasks(t2.deps);
    expect(t2.rec().stage).toBe('failed');
  });

  it('a collection that can never be proved needs inspection and is not retried', async () => {
    const t = await setup(true);
    await pollTasks(t.deps);
    t.mps.lock();
    await pollTasks(t.deps);
    expect(t.rec().stage).toBe('collection-pending');
    t.core.settle(COLLECTION_TX);
    t.mps.withdraw(COLLECTION_TX);
    const bad: TaskDeps = {
      ...t.deps,
      verifyCollection: async () => {
        throw new CollectionError('escrow was not paid to the seller');
      },
    };
    await pollTasks(bad);
    expect(t.rec().stage).toBe('needs-inspection');
    await pollTasks(t.restart());
    expect(t.rec().stage).toBe('needs-inspection');
    expect(t.verified).toEqual([]);
  });
});
