import { describe, expect, it, vi } from 'vitest';
import {
  runWithReplicationWriteEffects,
  trackReplicationStorageOperation,
  withReplicationSqlQueries,
  withReplicationStorageBindings,
} from '../write-effects';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function sqlBinding() {
  const failure = new Error('SQL contains confidential values');
  const statement = {
    bind() {
      expect(this).toBe(statement);
      return statement;
    },
    run: vi.fn(() => Promise.reject(failure)),
    all: vi.fn(() => Promise.reject(failure)),
    first: vi.fn(() => Promise.reject(failure)),
    raw: vi.fn(() => Promise.reject(failure)),
  };
  const db = {
    prepare() {
      expect(this).toBe(db);
      return statement;
    },
    batch: vi.fn(async (statements: unknown[]) => {
      expect(statements[0]).toBe(statement);
      return [{ success: false }];
    }),
    exec: vi.fn(() => Promise.reject(failure)),
    withSession: vi.fn(() => ({ prepare: () => statement })),
  };
  return { db, statement, failure };
}

describe('replication storage effect observation', () => {
  it('preserves disabled environment and promise identities', async () => {
    const env = { DB: sqlBinding().db };
    expect(withReplicationStorageBindings(env)).toBe(env);
    const promise = Promise.resolve(7);
    expect(trackReplicationStorageOperation(() => promise)).toBe(promise);
    await expect(promise).resolves.toBe(7);
  });

  it.each(['run', 'all', 'first', 'raw'] as const)(
    'retains uncertainty for a caught D1 %s failure, with native binding receivers',
    async (method) => {
      const { db, failure } = sqlBinding();
      await expect(
        runWithReplicationWriteEffects(async () => {
          const env = withReplicationStorageBindings({ DB: db });
          await expect(env.DB.prepare().bind()[method]()).rejects.toBe(failure);
          return new Response('handled error', { status: 400 });
        })
      ).rejects.toThrow('replication_writer_outcome_unknown');
    }
  );

  it('unwraps native prepared statements in D1 batches and observes unsuccessful results', async () => {
    const { db } = sqlBinding();
    await expect(
      runWithReplicationWriteEffects(async () => {
        const env = withReplicationStorageBindings({ DB: db });
        const result = await env.DB.batch([env.DB.prepare().bind()]);
        expect(result).toEqual([{ success: false }]);
      })
    ).rejects.toThrow('replication_writer_outcome_unknown');
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it('covers sessions and exec without changing read bookmarks or result methods', async () => {
    const { db } = sqlBinding();
    await expect(
      runWithReplicationWriteEffects(async () => {
        const env = withReplicationStorageBindings({ DB: db });
        await env.DB.withSession()
          .prepare()
          .raw()
          .catch(() => undefined);
        await env.DB.exec().catch(() => undefined);
      })
    ).rejects.toThrow('replication_writer_outcome_unknown');
  });

  it.each(['put', 'delete'] as const)(
    'observes caught KV/R2 %s failures without tracing reads',
    async (method) => {
      const store = {
        get: vi.fn(async () => 'read-result'),
        put: vi.fn(() => Promise.reject(new Error('private value'))),
        delete: vi.fn(() => Promise.reject(new Error('private key'))),
      };
      await expect(
        runWithReplicationWriteEffects(async () => {
          const env = withReplicationStorageBindings({ KV: store });
          expect(await env.KV.get()).toBe('read-result');
          await env.KV[method]().catch(() => undefined);
        })
      ).rejects.toThrow('replication_writer_outcome_unknown');
    }
  );

  it('observes created and resumed multipart upload mutation handles', async () => {
    const multipart = {
      uploadPart: vi.fn(() => Promise.reject(new Error('secret part'))),
      complete: vi.fn(() => Promise.reject(new Error('secret upload'))),
    };
    const store = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      createMultipartUpload: vi.fn(async () => multipart),
      resumeMultipartUpload: vi.fn(() => multipart),
    };
    await expect(
      runWithReplicationWriteEffects(async () => {
        const env = withReplicationStorageBindings({ BUCKET: store });
        await (await env.BUCKET.createMultipartUpload()).uploadPart().catch(() => undefined);
        await env.BUCKET.resumeMultipartUpload()
          .complete()
          .catch(() => undefined);
      })
    ).rejects.toThrow('replication_writer_outcome_unknown');
  });

  it('waits for a fire-and-forget storage write before finishing a successful request', async () => {
    const pending = gate();
    const settled: string[] = [];
    const run = runWithReplicationWriteEffects(async () => {
      void trackReplicationStorageOperation(async () => {
        await pending.promise;
        settled.push('write');
      });
      return 'response';
    }).then((value) => {
      settled.push(value);
    });
    await Promise.resolve();
    expect(settled).toEqual([]);
    pending.release();
    await run;
    expect(settled).toEqual(['write', 'response']);
  });

  it('rejects storage attempts by a descendant after its completed request context closed', async () => {
    const start = gate();
    const write = vi.fn(async () => undefined);
    let later!: Promise<unknown>;
    await runWithReplicationWriteEffects(async () => {
      later = start.promise.then(() => trackReplicationStorageOperation(write));
    });
    start.release();
    await expect(later).rejects.toThrow('replication_writer_context_closed');
    expect(write).not.toHaveBeenCalled();
  });

  it('isolates concurrent request uncertainty and preserves a proved storage rejection', async () => {
    const failing = runWithReplicationWriteEffects(async () => {
      await trackReplicationStorageOperation(() => Promise.reject(new Error('unknown'))).catch(
        () => undefined
      );
    });
    const healthy = runWithReplicationWriteEffects(async () => {
      await trackReplicationStorageOperation(
        () => Promise.reject(new Error('definite')),
        () => true
      ).catch(() => undefined);
      return 'healthy';
    });
    await expect(failing).rejects.toThrow('replication_writer_outcome_unknown');
    await expect(healthy).resolves.toBe('healthy');
  });

  it('observes physical SQL queries and separately leased transaction connections even when caught', async () => {
    const client = { query: vi.fn(() => Promise.reject(new Error('possible commit'))) };
    const pool = { connect: vi.fn(async () => client), query: client.query };
    const observed = withReplicationSqlQueries(pool);
    await expect(
      runWithReplicationWriteEffects(async () => {
        const leased = await observed.connect();
        await leased.query().catch(() => undefined);
      })
    ).rejects.toThrow('replication_writer_outcome_unknown');
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('marks synchronous storage failure and failed rejection classifiers uncertain', async () => {
    await expect(
      runWithReplicationWriteEffects(async () => {
        try {
          void trackReplicationStorageOperation(() => {
            throw new Error('sync');
          });
        } catch {
          /* handled */
        }
      })
    ).rejects.toThrow('replication_writer_outcome_unknown');
    await expect(
      runWithReplicationWriteEffects(async () => {
        await trackReplicationStorageOperation(
          () => Promise.reject(new Error('async')),
          () => {
            throw new Error('classifier');
          }
        ).catch(() => undefined);
      })
    ).rejects.toThrow('replication_writer_outcome_unknown');
  });
});
