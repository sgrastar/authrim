/**
 * Call ledger for security matrix tests.
 *
 * Records every observable transport/persistence call made by a production subject and
 * provides a ledger-backed `ExecutionContext` whose `waitUntil` promises can be drained
 * before assertions. Rejections of drained promises are observable failures.
 */

export type LedgerKind =
  | 'kv.get'
  | 'kv.put'
  | 'kv.delete'
  | 'd1.query'
  | 'd1.queryOne'
  | 'd1.execute'
  | 'r2.get'
  | 'r2.put'
  | 'queue.send'
  | 'do.fetch'
  | 'do.rpc'
  | 'revoke'
  | 'consume'
  | 'register'
  | 'family'
  | 'audit'
  | 'sign'
  | 'event'
  | 'waitUntil'
  | 'ack'
  | 'retry'
  | 'client-auth'
  | 'session'
  | 'tenant-access'
  | 'binding-operation';

export interface LedgerEntry {
  kind: LedgerKind;
  target: string;
  detail?: unknown;
  at: number;
}

export class CallLedger {
  private entries: LedgerEntry[] = [];
  private waitUntilPromises: Promise<unknown>[] = [];
  private drained = false;

  record(kind: LedgerKind, target: string, detail?: unknown): void {
    this.entries.push({ kind, target, detail, at: Date.now() });
  }

  all(): LedgerEntry[] {
    return [...this.entries];
  }

  ofKind(kind: LedgerKind): LedgerEntry[] {
    return this.entries.filter((entry) => entry.kind === kind);
  }

  count(kind: LedgerKind): number {
    return this.ofKind(kind).length;
  }

  has(kind: LedgerKind, targetPredicate?: (target: string) => boolean): boolean {
    return this.entries.some(
      (entry) => entry.kind === kind && (targetPredicate ? targetPredicate(entry.target) : true)
    );
  }

  reset(): void {
    this.entries = [];
    this.waitUntilPromises = [];
    this.drained = false;
  }

  enqueueWaitUntil(promise: Promise<unknown>): void {
    if (this.drained) {
      throw new Error('call ledger: waitUntil enqueued after drain');
    }
    this.waitUntilPromises.push(promise);
  }

  async drain(): Promise<void> {
    const pending = this.waitUntilPromises;
    this.waitUntilPromises = [];
    this.drained = pending.length === 0;
    if (pending.length === 0) {
      this.drained = true;
      return;
    }
    const settled = await Promise.allSettled(pending);
    for (const result of settled) {
      if (result.status === 'rejected') {
        const reason = result.reason;
        this.record(
          'waitUntil',
          'rejection',
          reason instanceof Error ? reason.message : String(reason)
        );
      }
    }
    this.drained = true;
  }
}

export class LedgerExecutionContext {
  constructor(private readonly ledger: CallLedger) {}

  waitUntil(promise: Promise<unknown>): void {
    this.ledger.enqueueWaitUntil(promise);
  }

  passThroughOnException(): void {
    this.ledger.record('waitUntil', 'passThroughOnException');
  }

  get props(): Record<string, never> {
    return {};
  }
}
