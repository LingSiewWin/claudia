import { EventEmitter } from 'node:events';
import { type AppendInput, appendEvent, type Db, type Sql, type StoredEvent } from '@authority/db';

export interface EventLog {
  /** Appends in its own transaction, then publishes to live subscribers. */
  emit(input: AppendInput): Promise<StoredEvent>;
  /** Appends inside the caller's transaction. Call publish() after the commit. */
  append(q: Sql, input: AppendInput): Promise<StoredEvent>;
  publish(event: StoredEvent): void;
  subscribe(runId: string, fn: (event: StoredEvent) => void): () => void;
}

// In-process fan-out, one API replica; LISTEN/NOTIFY when the API runs more than one.
export function createLog(db: Db, now: () => number): EventLog {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const log: EventLog = {
    append: (q, input) => appendEvent(q, input, now()),
    publish: (event) => void bus.emit(event.run_id, event),
    async emit(input) {
      const event = await db.tx((q) => appendEvent(q, input, now()));
      log.publish(event);
      return event;
    },
    subscribe(runId, fn) {
      bus.on(runId, fn);
      return () => void bus.off(runId, fn);
    },
  };
  return log;
}
