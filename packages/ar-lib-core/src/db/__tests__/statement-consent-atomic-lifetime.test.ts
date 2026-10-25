/** Fake clients prove ownership/sequencing only. Actual SQL evidence is in the explicit PG suite. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresAdapter, type PostgresAdapterConfig } from '../adapters/postgres-adapter';

type Client = Awaited<ReturnType<NonNullable<PostgresAdapterConfig['clientFactory']>>>;
type RawClient = Client & { connect(): Promise<void> };
type Rule = () => unknown[] | Promise<unknown[]>;
const ROLE =
  "SELECT pg_is_in_recovery() AS in_recovery, current_setting('transaction_read_only') AS read_only";
const CONNECTION = 'postgres://local:local@127.0.0.1:1/not-connected';
const native = vi.hoisted(() => ({ pending: [] as RawClient[], created: [] as unknown[] }));

vi.mock('pg', () => ({
  Client: class {
    private readonly transport: RawClient;
    constructor(options: unknown) {
      native.created.push(options);
      const next = native.pending.shift();
      if (!next) throw new Error('fixture_native_client_missing');
      this.transport = next;
    }
    connect() {
      return this.transport.connect();
    }
    query<T>(sql: string, params?: unknown[]) {
      return this.transport.query<T>(sql, params);
    }
    end() {
      return this.transport.end();
    }
  },
}));

function recording(rules: Record<string, Rule> = {}) {
  const events: string[] = [];
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  let ends = 0;
  const client: RawClient = {
    async connect() {
      events.push('CONNECT');
      await rules.CONNECT?.();
    },
    async query<T>(sql: string, params?: unknown[]) {
      events.push(sql);
      calls.push({ sql, params });
      const rows = rules[sql]
        ? await rules[sql]()
        : sql === ROLE
          ? [{ in_recovery: false, read_only: 'on' }]
          : sql.startsWith('SELECT')
            ? [{ n: 7 }]
            : [];
      // SQL row typing is the caller's contract, exactly as in the real adapter seam.
      return { rows: rows as T[], rowCount: rows.length };
    },
    async end() {
      ends++;
      events.push('END');
      await rules.END?.();
    },
  };
  return { client, events, calls, ends: () => ends };
}

function gate() {
  let open: () => void = () => {
    throw new Error('fixture_gate_uninitialized');
  };
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

beforeEach(() => {
  native.pending.length = 0;
  native.created.length = 0;
});

describe('ordinary PostgreSQL adapter compatibility (fake transport)', () => {
  it('keeps cached query/transaction/batch/close behavior without using the consent factory', async () => {
    const first = recording({ 'SELECT empty': () => [] });
    const second = recording();
    let ordinary = 0;
    let owned = 0;
    const adapter = new PostgresAdapter({
      connectionString: CONNECTION,
      clientFactory: () => (++ordinary === 1 ? first.client : second.client),
      statementConsentClientFactory: () => {
        owned++;
        throw new Error('unused_owned_factory');
      },
    });
    expect(native.created).toEqual([]);
    expect(await adapter.queryOne('SELECT ? AS n', [7])).toEqual({ n: 7 });
    expect(await adapter.queryOne('SELECT empty', [])).toBeNull();
    const sql = `SELECT '?' AS literal, "?" AS label, ? AS n -- ?\n/* ? */`;
    await adapter.query(sql, [7]);
    expect(first.calls.at(-1)).toEqual({
      sql: `SELECT '?' AS literal, "?" AS label, $1 AS n -- ?\n/* ? */`,
      params: [7],
    });
    expect(
      await adapter.transaction(async (tx) => {
        await tx.execute('UPDATE example SET value=?', [7]);
        return tx.queryOne('SELECT ? AS n', [7]);
      })
    ).toEqual({ n: 7 });
    await adapter.batch([{ sql: 'DELETE FROM example WHERE value=?', params: [7] }]);
    expect(first.events.filter((event) => event === 'BEGIN')).toHaveLength(2);
    expect(first.events.filter((event) => event === 'COMMIT')).toHaveLength(2);
    expect(first.events).not.toContain('ROLLBACK');
    expect(ordinary).toBe(1);
    expect(owned).toBe(0);
    expect(first.ends()).toBe(0);
    await adapter.close();
    expect(first.ends()).toBe(1);
    await adapter.queryOne('SELECT ? AS n', [7]);
    expect(ordinary).toBe(2);
    await adapter.close();
    expect(second.ends()).toBe(1);
    expect(owned).toBe(0);
  });

  it('keeps ordinary transaction failure rollback on the cached client', async () => {
    const failure = new Error('ordinary_query_failed');
    const normal = recording({
      'SELECT broken': () => {
        throw failure;
      },
    });
    const adapter = new PostgresAdapter({
      connectionString: CONNECTION,
      clientFactory: () => normal.client,
    });
    await expect(adapter.transaction((tx) => tx.query('SELECT broken'))).rejects.toBe(failure);
    expect(normal.events).toEqual(['BEGIN', 'SELECT broken', 'ROLLBACK']);
    expect(normal.ends()).toBe(0);
    await adapter.close();
    expect(normal.ends()).toBe(1);
  });
});

describe('owned consent PostgreSQL lifetime (fake transport, no SQL semantics claim)', () => {
  it('opens and closes a fresh authoritative read-only reader and writer per operation', async () => {
    const normal = recording();
    const clients = [recording(), recording(), recording()];
    let next = 0;
    const adapter = new PostgresAdapter({
      connectionString: CONNECTION,
      clientFactory: () => normal.client,
      statementConsentClientFactory: () => clients[next++].client,
    });
    const capability = adapter.statementConsentAtomicCapability();
    expect(next).toBe(0);
    expect(native.created).toEqual([]);
    await adapter.queryOne('SELECT normal');
    expect(await capability.readOperation('SELECT ? AS n', [7])).toEqual({ n: 7 });
    expect(await capability.readOperation('SELECT ? AS n', [7])).toEqual({ n: 7 });
    await capability.executeStatementConsentBatch([{ sql: 'UPDATE example SET n=?', params: [7] }]);
    for (const reader of clients.slice(0, 2)) {
      expect(reader.events).toEqual([
        'BEGIN TRANSACTION READ ONLY',
        ROLE,
        'SELECT $1 AS n',
        'COMMIT',
        'END',
      ]);
      expect(reader.ends()).toBe(1);
    }
    expect(clients[2].events).toEqual(['BEGIN', 'UPDATE example SET n=$1', 'COMMIT', 'END']);
    expect(next).toBe(3);
    expect(normal.events).toEqual(['SELECT normal']);
    await adapter.close();
    expect(normal.ends()).toBe(1);
    for (const client of clients) expect(client.ends()).toBe(1);
  });

  it.each([0, 17])(
    'rejects a plan of %i statements before opening any owned connection',
    async (count) => {
      let opened = 0;
      const adapter = new PostgresAdapter({
        connectionString: CONNECTION,
        statementConsentClientFactory: () => {
          opened++;
          return recording().client;
        },
      });
      await expect(
        adapter
          .statementConsentAtomicCapability()
          .executeStatementConsentBatch(
            Array.from({ length: count }, () => ({ sql: 'SELECT effect' }))
          )
      ).rejects.toThrow('atomic_plan_invalid');
      expect(opened).toBe(0);
    }
  );

  it.each([{ in_recovery: true, read_only: 'on' }, { in_recovery: false, read_only: 'off' }, {}])(
    'rejects an unproven primary/read-only role before the receipt query: %j',
    async (role) => {
      const reader = recording({ [ROLE]: () => [role] });
      const adapter = new PostgresAdapter({
        connectionString: CONNECTION,
        statementConsentClientFactory: () => reader.client,
      });
      await expect(
        adapter.statementConsentAtomicCapability().readOperation('SELECT receipt', [])
      ).rejects.toThrow('authoritative_reader_unavailable');
      expect(reader.events).toEqual(['BEGIN TRANSACTION READ ONLY', ROLE, 'ROLLBACK', 'END']);
      expect(reader.ends()).toBe(1);
    }
  );

  it.each(['reader', 'writer'] as const)(
    'refuses a borrowed cached %s lease without closing it',
    async (kind) => {
      const shared = recording();
      const adapter = new PostgresAdapter({
        connectionString: CONNECTION,
        clientFactory: () => shared.client,
        statementConsentClientFactory: () => shared.client,
      });
      await adapter.queryOne('SELECT normal');
      const capability = adapter.statementConsentAtomicCapability();
      await expect(
        kind === 'reader'
          ? capability.readOperation('SELECT receipt', [])
          : capability.executeStatementConsentBatch([{ sql: 'SELECT effect' }])
      ).rejects.toThrow('connection_not_dedicated');
      expect(shared.events).toEqual(['SELECT normal']);
      expect(shared.ends()).toBe(0);
      await adapter.queryOne('SELECT still_normal');
      await adapter.close();
      expect(shared.ends()).toBe(1);
    }
  );

  it.each(['reader', 'writer'] as const)(
    'refuses an already closed %s object before another BEGIN',
    async (kind) => {
      const owned = recording();
      const adapter = new PostgresAdapter({
        connectionString: CONNECTION,
        statementConsentClientFactory: () => owned.client,
      });
      const capability = adapter.statementConsentAtomicCapability();
      const run = () =>
        kind === 'reader'
          ? capability.readOperation('SELECT receipt', [])
          : capability.executeStatementConsentBatch([{ sql: 'SELECT effect' }]);
      await run();
      const before = [...owned.events];
      await expect(run()).rejects.toThrow('connection_not_dedicated');
      expect(owned.events).toEqual(before);
      expect(owned.ends()).toBe(1);
    }
  );

  it('rejects an active reused lease and keeps normal queries on their own cached connection', async () => {
    const entered = gate();
    const release = gate();
    const normal = recording();
    const owned = recording({
      'SELECT pause': async () => {
        entered.open();
        await release.promise;
        return [];
      },
    });
    const adapter = new PostgresAdapter({
      connectionString: CONNECTION,
      clientFactory: () => normal.client,
      statementConsentClientFactory: () => owned.client,
    });
    const capability = adapter.statementConsentAtomicCapability();
    const pending = capability.executeStatementConsentBatch([{ sql: 'SELECT pause' }]);
    await entered.promise;
    try {
      await expect(capability.readOperation('SELECT receipt', [])).rejects.toThrow(
        'connection_not_dedicated'
      );
      expect(owned.ends()).toBe(0);
      await adapter.queryOne('SELECT ordinary');
      expect(normal.events).toEqual(['SELECT ordinary']);
    } finally {
      release.open();
      await pending;
      await adapter.close();
    }
    expect(owned.events).toEqual(['BEGIN', 'SELECT pause', 'COMMIT', 'END']);
    expect(owned.ends()).toBe(1);
    expect(normal.ends()).toBe(1);
  });

  it.each(['active', 'ended'] as const)(
    'does not lend an %s owned object back to the ordinary factory',
    async (lifetime) => {
      const entered = gate();
      const release = gate();
      const owned = recording({
        'SELECT pause': async () => {
          entered.open();
          await release.promise;
          return [];
        },
      });
      const normal = recording();
      let ordinaryCalls = 0;
      const adapter = new PostgresAdapter({
        connectionString: CONNECTION,
        clientFactory: () => (++ordinaryCalls === 1 ? owned.client : normal.client),
        statementConsentClientFactory: () => owned.client,
      });
      const pending = adapter
        .statementConsentAtomicCapability()
        .executeStatementConsentBatch([{ sql: 'SELECT pause' }]);
      await entered.promise;
      if (lifetime === 'ended') {
        release.open();
        await pending;
      }
      const before = [...owned.events];
      try {
        await expect(adapter.queryOne('SELECT borrowed')).rejects.toThrow(
          'connection_not_dedicated'
        );
        expect(owned.events).toEqual(before);
        expect(owned.ends()).toBe(lifetime === 'active' ? 0 : 1);
        expect(await adapter.queryOne('SELECT ordinary')).toEqual({ n: 7 });
      } finally {
        release.open();
        await pending;
        await adapter.close();
      }
      expect(owned.events).toEqual(['BEGIN', 'SELECT pause', 'COMMIT', 'END']);
      expect(owned.ends()).toBe(1);
      expect(normal.events).toEqual(['SELECT ordinary', 'END']);
      expect(normal.ends()).toBe(1);
    }
  );

  it.each([
    { first: 'ordinary', kind: 'reader' },
    { first: 'owned', kind: 'reader' },
    { first: 'ordinary', kind: 'writer' },
    { first: 'owned', kind: 'writer' },
  ] as const)(
    'admits only the $first owner when one factory promise resolves to the same $kind object',
    async ({ first, kind }) => {
      const factoryReady = gate();
      const entered = gate();
      const release = gate();
      const pause = async () => {
        entered.open();
        await release.promise;
        return [{ n: 7 }];
      };
      const shared = recording({ 'SELECT ordinary': pause, 'SELECT owned': pause });
      const samePromise = factoryReady.promise.then(() => shared.client);
      const adapter = new PostgresAdapter({
        connectionString: CONNECTION,
        clientFactory: () => samePromise,
        statementConsentClientFactory: () => samePromise,
      });
      const capability = adapter.statementConsentAtomicCapability();
      const ordinary = () => adapter.queryOne('SELECT ordinary');
      const owned = () =>
        kind === 'reader'
          ? capability.readOperation('SELECT owned', [])
          : capability.executeStatementConsentBatch([{ sql: 'SELECT owned' }]);
      const winner = first === 'ordinary' ? ordinary() : owned();
      const loser = first === 'ordinary' ? owned() : ordinary();
      // Attach the rejection observer before resolving either factory continuation.
      const refused = expect(loser).rejects.toThrow('connection_not_dedicated');
      factoryReady.open();
      await entered.promise;
      try {
        await refused;
        expect(shared.ends()).toBe(0);
        expect(shared.events).toEqual(
          first === 'ordinary'
            ? ['SELECT ordinary']
            : kind === 'reader'
              ? ['BEGIN TRANSACTION READ ONLY', ROLE, 'SELECT owned']
              : ['BEGIN', 'SELECT owned']
        );
      } finally {
        release.open();
        await winner;
        await adapter.close();
      }
      expect(shared.ends()).toBe(1);
      expect(shared.events).not.toContain(
        first === 'ordinary' ? 'SELECT owned' : 'SELECT ordinary'
      );
    }
  );

  it.each(['begin', 'role', 'read', 'commit', 'rollback-and-close', 'close'] as const)(
    'keeps reader %s failure unknown, rolls back when needed, and closes once',
    async (phase) => {
      const primary = new Error(`reader_${phase}_failure`);
      const secondary = new Error('secondary_failure');
      const at =
        phase === 'begin'
          ? 'BEGIN TRANSACTION READ ONLY'
          : phase === 'role'
            ? ROLE
            : phase === 'commit'
              ? 'COMMIT'
              : phase === 'close'
                ? 'END'
                : 'SELECT receipt';
      const rules: Record<string, Rule> = {
        [at]: () => {
          throw primary;
        },
      };
      if (phase === 'rollback-and-close') {
        rules.ROLLBACK = () => {
          throw secondary;
        };
        rules.END = () => {
          throw secondary;
        };
      }
      const reader = recording(rules);
      const adapter = new PostgresAdapter({
        connectionString: CONNECTION,
        statementConsentClientFactory: () => reader.client,
      });
      await expect(
        adapter.statementConsentAtomicCapability().readOperation('SELECT receipt', [])
      ).rejects.toBe(primary);
      expect(reader.events[0]).toBe('BEGIN TRANSACTION READ ONLY');
      expect(reader.events.at(-1)).toBe('END');
      expect(reader.ends()).toBe(1);
      if (phase === 'close') expect(reader.events).not.toContain('ROLLBACK');
      else expect(reader.events).toContain('ROLLBACK');
    }
  );

  it.each(['begin', 'write', 'commit', 'rollback-and-close', 'close'] as const)(
    'keeps writer %s failure unknown and never leaks the owned lease',
    async (phase) => {
      const primary = new Error(`writer_${phase}_failure`);
      const secondary = new Error('secondary_failure');
      const at =
        phase === 'begin'
          ? 'BEGIN'
          : phase === 'commit'
            ? 'COMMIT'
            : phase === 'close'
              ? 'END'
              : 'SELECT effect';
      const rules: Record<string, Rule> = {
        [at]: () => {
          throw primary;
        },
      };
      if (phase === 'rollback-and-close') {
        rules.ROLLBACK = () => {
          throw secondary;
        };
        rules.END = () => {
          throw secondary;
        };
      }
      const writer = recording(rules);
      const adapter = new PostgresAdapter({
        connectionString: CONNECTION,
        statementConsentClientFactory: () => writer.client,
      });
      await expect(
        adapter
          .statementConsentAtomicCapability()
          .executeStatementConsentBatch([{ sql: 'SELECT effect' }])
      ).rejects.toBe(primary);
      expect(writer.events[0]).toBe('BEGIN');
      expect(writer.events.at(-1)).toBe('END');
      expect(writer.ends()).toBe(1);
      if (phase === 'close') expect(writer.events).not.toContain('ROLLBACK');
      else expect(writer.events).toContain('ROLLBACK');
    }
  );

  it.each(['reader', 'writer'] as const)(
    'does not turn an owned %s factory rejection into an absent row or success',
    async (kind) => {
      const failure = new Error('owned_factory_failed');
      let opens = 0;
      const normal = recording();
      const adapter = new PostgresAdapter({
        connectionString: CONNECTION,
        clientFactory: () => normal.client,
        statementConsentClientFactory: () => {
          opens++;
          throw failure;
        },
      });
      const capability = adapter.statementConsentAtomicCapability();
      await expect(
        kind === 'reader'
          ? capability.readOperation('SELECT receipt', [])
          : capability.executeStatementConsentBatch([{ sql: 'SELECT effect' }])
      ).rejects.toBe(failure);
      expect(opens).toBe(1);
      await adapter.queryOne('SELECT ordinary');
      await adapter.close();
      expect(normal.events).toEqual(['SELECT ordinary', 'END']);
    }
  );

  it.each(['reader', 'writer'] as const)(
    'closes a failed native %s connect without replacing its error',
    async (kind) => {
      const failure = new Error('owned_connect_failed');
      const raw = recording({
        CONNECT: () => {
          throw failure;
        },
        END: () => {
          throw new Error('close_failed');
        },
      });
      native.pending.push(raw.client);
      const adapter = new PostgresAdapter({ connectionString: CONNECTION });
      const capability = adapter.statementConsentAtomicCapability();
      await expect(
        kind === 'reader'
          ? capability.readOperation('SELECT receipt', [])
          : capability.executeStatementConsentBatch([{ sql: 'SELECT effect' }])
      ).rejects.toBe(failure);
      expect(raw.events).toEqual(['CONNECT', 'END']);
      expect(raw.ends()).toBe(1);
      expect(native.pending).toEqual([]);
      expect(native.created).toHaveLength(1);
      const recovered = recording();
      native.pending.push(recovered.client);
      if (kind === 'reader')
        expect(await capability.readOperation('SELECT receipt', [])).toEqual({ n: 7 });
      else await capability.executeStatementConsentBatch([{ sql: 'SELECT effect' }]);
      expect(native.created).toHaveLength(2);
      expect(recovered.ends()).toBe(1);
      await adapter.close();
      expect(raw.ends()).toBe(1);
      expect(recovered.ends()).toBe(1);
    }
  );
});
