import type { CoreClient, CoreEvent, CoreReceipt, CoreTask } from '../src/core';

export const COWORKER = '01a10eea-1f7d-71ec-91e5-e31a0d43ed62';

// In-memory Sokosumi Core for one coworker.
export function fakeCore() {
  const tasks = new Map<string, CoreTask>();
  const events: { taskId: string; body: Record<string, unknown> }[] = [];
  let receipt: CoreReceipt = { blockchainIdentifier: null, claimStatus: null, onChainState: null, settled: false, txHash: null };
  const client: CoreClient = {
    async me() {
      return { id: COWORKER, capabilities: ['tasks'], archivedAt: null };
    },
    async readyTasks() {
      return [...tasks.values()].filter((t) => t.status === 'READY').map((t) => ({ ...t }));
    },
    async getTask(taskId) {
      const t = tasks.get(taskId);
      if (!t) throw new Error(`unknown task ${taskId}`);
      return { ...t };
    },
    async postEvent(taskId, body) {
      const t = tasks.get(taskId);
      if (!t) throw new Error(`unknown task ${taskId}`);
      events.push({ taskId, body });
      if (typeof body.status === 'string') t.status = body.status;
      const mp = body.masumiPayment as { blockchainIdentifier?: string } | undefined;
      if (mp?.blockchainIdentifier) receipt = { ...receipt, blockchainIdentifier: mp.blockchainIdentifier, claimStatus: 'PURCHASED' };
      return { id: `ev-${events.length}` };
    },
    async receipt() {
      return { ...receipt };
    },
    async events(taskId): Promise<CoreEvent[]> {
      return events
        .filter((e) => e.taskId === taskId)
        .map((e, i) => ({ id: `ev-${i + 1}`, status: (e.body.status as string | undefined) ?? null, comment: (e.body.comment as string | undefined) ?? null }));
    },
  };
  return {
    client,
    tasks,
    events,
    addTask(id: string, description: string | null, assigneeId = COWORKER) {
      tasks.set(id, { id, name: 'Authority check', description, status: 'READY', assigneeId, organizationId: null });
    },
    settle(txHash: string) {
      receipt = { ...receipt, onChainState: 'Withdrawn', settled: true, txHash };
    },
  };
}
