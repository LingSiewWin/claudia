import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { encodeFxReportPayload, toFxStoredFields } from '../src/fx-codec';
import { readFxBasis } from '../src/fx-reader';
import { FX_FIXTURE } from './fx-codec.test';

const REGISTRY = '0x000000000000000000000000000000000000beef';
const { reportHash } = encodeFxReportPayload(FX_FIXTURE);

const clientReturning = (fields: ReturnType<typeof toFxStoredFields>) =>
  ({
    readContract: async (args: { functionName: string; args: readonly unknown[] }) => {
      expect(args.functionName).toBe('getReport');
      expect(args.args[0]).toBe(`0x${reportHash}`);
      return { fields, blockTime: 1_800_000_000n };
    },
  }) as unknown as PublicClient;

describe('readFxBasis', () => {
  it('rebuilds the report from stored fields and recomputes the key', async () => {
    const out = await readFxBasis(clientReturning(toFxStoredFields(FX_FIXTURE)), REGISTRY, `0x${reportHash}`);
    expect(out.report).toEqual(FX_FIXTURE);
    expect(out.report_hash).toBe(reportHash);
    expect(out.block_time_ms).toBe(1_800_000_000_000);
  });

  it('rejects stored fields whose hash does not match the key', async () => {
    const tampered = { ...toFxStoredFields(FX_FIXTURE), basisBps: 1 };
    await expect(readFxBasis(clientReturning(tampered), REGISTRY, reportHash)).rejects.toThrow(/hash mismatch/);
  });
});
