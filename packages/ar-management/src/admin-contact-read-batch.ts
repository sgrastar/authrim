/** Request-local, read-only batching for canonical admin contact projections. */
import type { D1DatabaseSession } from '@cloudflare/workers-types';
import {
  ensureDatabaseAdapter,
  isD1DatabaseLike,
  type DatabaseAdapter,
  type DatabaseSource,
} from '@authrim/ar-lib-core';

const STATEMENTS_PER_BATCH = 50;
const STORE_CONCURRENCY = 4;
const MAX_READ_CALLS = 750;

interface Read {
  sql: string;
  params: unknown[];
  resolve(rows: unknown[]): void;
  reject(error: unknown): void;
}

/** Never returned as an account's PII store: access audits use the real writable adapter. */
export class AdminContactReadBatch {
  private readonly adapters = new Map<DatabaseSource, DatabaseAdapter>();
  private readonly sessions = new Map<DatabaseSource, D1DatabaseSession>();
  private pending = new Map<DatabaseSource, Read[]>();
  private running = false;
  private failure: Error | undefined;
  private readCalls = 0;

  adapter(source: DatabaseSource): DatabaseAdapter {
    const cached = this.adapters.get(source);
    if (cached) return cached;
    const real = ensureDatabaseAdapter(source, 'admin-contact-read');
    const denied = () => {
      throw new Error('admin_contact_read_adapter_is_read_only');
    };
    const adapter: DatabaseAdapter = {
      query: <T>(sql: string, params: unknown[] = []) => this.query<T>(source, sql, params),
      queryOne: async <T>(sql: string, params: unknown[] = []) =>
        (await this.query<T>(source, sql, params))[0] ?? null,
      execute: denied,
      batch: denied,
      transaction: denied,
      close: denied,
      isHealthy: () => real.isHealthy(),
      getType: () => real.getType(),
    };
    this.adapters.set(source, adapter);
    return adapter;
  }

  private query<T>(source: DatabaseSource, sql: string, params: unknown[]): Promise<T[]> {
    if (!/^\s*SELECT\b/iu.test(sql) || params.length > 100) {
      return Promise.reject(new Error('admin_contact_read_query_invalid'));
    }
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<T[]>((resolve, reject) => {
      const reads = this.pending.get(source) ?? [];
      // DatabaseAdapter's generic row contract is the SQL caller's responsibility, as with D1.
      reads.push({ sql, params, resolve: (rows) => resolve(rows as T[]), reject });
      this.pending.set(source, reads);
      if (!this.running) {
        this.running = true;
        queueMicrotask(() => {
          void this.flush();
        });
      }
    });
  }

  private async flush(): Promise<void> {
    const round = this.pending;
    this.pending = new Map();
    const jobs = [...round];
    const completed: Array<{ reads: Read[]; rows: unknown[][] }> = [];
    let next = 0;
    try {
      const settled = await Promise.allSettled(
        Array.from({ length: Math.min(STORE_CONCURRENCY, jobs.length) }, async () => {
          while (next < jobs.length) {
            const [source, group] = jobs[next++];
            for (let offset = 0; offset < group.length; offset += STATEMENTS_PER_BATCH) {
              const reads = group.slice(offset, offset + STATEMENTS_PER_BATCH);
              if (++this.readCalls > MAX_READ_CALLS)
                throw new Error('admin_contact_read_budget_exceeded');
              if (isD1DatabaseLike(source)) {
                let session = this.sessions.get(source);
                if (!session) {
                  session = source.withSession('first-primary');
                  this.sessions.set(source, session);
                }
                const results = await session.batch(
                  reads.map(({ sql, params }) => session.prepare(sql).bind(...params))
                );
                if (
                  results.length !== reads.length ||
                  results.some((result) => !result.success || !Array.isArray(result.results))
                ) {
                  throw new Error('admin_contact_read_batch_failed');
                }
                completed.push({ reads, rows: results.map((result) => result.results) });
              } else {
                // External adapters retain their own read semantics; only D1 exposes read batch results.
                const rows: unknown[][] = [];
                for (const { sql, params } of reads) {
                  rows.push(
                    await source.query(sql, params, { consistencyClass: 'primary_required' })
                  );
                }
                completed.push({ reads, rows });
              }
            }
          }
        })
      );
      const failed = settled.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      // Release the entire round together so canonical projections advance in bulk, not per user.
      for (const { reads, rows } of completed) {
        reads.forEach((read, index) => read.resolve(rows[index]));
      }
    } catch (error) {
      this.failure =
        error instanceof Error
          ? error
          : new Error('admin_contact_read_batch_failed', { cause: error });
      for (const reads of round.values()) for (const read of reads) read.reject(this.failure);
      for (const reads of this.pending.values())
        for (const read of reads) read.reject(this.failure);
      this.pending.clear();
    } finally {
      this.running = false;
      if (this.pending.size) {
        this.running = true;
        queueMicrotask(() => {
          void this.flush();
        });
      }
    }
  }
}
