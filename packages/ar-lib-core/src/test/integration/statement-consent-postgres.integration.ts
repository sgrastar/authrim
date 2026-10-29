import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client as PgClient } from 'pg';
import { PostgresAdapter } from '../../db/adapters/postgres-adapter';
import {
  applyStatementConsentTransition,
  prepareStatementConsentTransition,
  type StatementConsentOperationResult,
} from '../../services/statement-consent-transitions';
import {
  stepASchema,
  transitionInput,
} from '../../services/__tests__/statement-consent-transition-fixture';

/** Explicit integration only: a disposable loopback PG URL is required; never silently skip. */
function localDatabase(): string {
  const value = process.env.AUTHRIM_STATEMENT_CONSENT_TEST_PG_URL;
  if (!value) throw new Error('local_pg_backend_unproven');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('local_pg_invalid_url');
  }
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hash
  )
    throw new Error('local_pg_only');
  // node-postgres accepts query overrides (including host); never let them escape loopback.
  for (const [key, setting] of url.searchParams) {
    if (key !== 'sslmode' || setting !== 'disable') throw new Error('local_pg_options_invalid');
  }
  return value;
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup() {
  const connectionString = localDatabase();
  const { Client } = await import('pg');
  const schema = `consent_step_a_${crypto.randomUUID().replaceAll('-', '')}`;
  const control: PgClient = new Client({ connectionString });
  await control.connect();
  await control.query(`CREATE SCHEMA ${schema}`);
  cleanup.push(async () => {
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
  });
  const baseline = readFileSync(
    new URL(
      '../../../../../migrations/core/postgresql/001_0_4_0_core_baseline.sql',
      import.meta.url
    ),
    'utf8'
  );
  const tables = [
    'consent_statements',
    'consent_statement_versions',
    'user_consent_records',
    'consent_item_history',
  ];
  for (const table of tables) {
    const ddl = baseline.match(
      new RegExp(`CREATE TABLE public\\.${table} \\([\\s\\S]*?\\n\\);`)
    )?.[0];
    if (!ddl) throw new Error('actual_pg_schema_missing');
    await control.query(ddl.replaceAll('public.', `${schema}.`));
  }
  for (const table of tables) {
    for (const ddl of baseline.matchAll(
      new RegExp(`ALTER TABLE ONLY public\\.${table}\\n[\\s\\S]*?;`, 'g')
    ))
      await control.query(ddl[0].replaceAll('public.', `${schema}.`));
    for (const ddl of baseline.matchAll(
      new RegExp(`CREATE (?:UNIQUE )?INDEX [^;]+ ON public\\.${table} [^;]+;`, 'g')
    ))
      await control.query(ddl[0].replaceAll('public.', `${schema}.`));
  }
  await control.query(`SET search_path=${schema},public`);
  await control.query(
    'ALTER TABLE user_consent_records ADD COLUMN content_hash TEXT; ALTER TABLE consent_item_history ADD COLUMN content_hash_after TEXT;'
  );
  await control.query(stepASchema('postgresql'));
  const backendIds = new Set<number>();
  async function owned() {
    const raw: PgClient = new Client({
      connectionString,
      options: `-c search_path=${schema},public`,
    });
    await raw.connect();
    const pid = await raw.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    backendIds.add(pid.rows[0].pid);
    return {
      query: async <T = unknown>(sql: string, params?: unknown[]) => {
        const result = await raw.query(sql, params);
        return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
      },
      end: () => raw.end(),
    };
  }
  const adapter = new PostgresAdapter({
    connectionString,
    clientFactory: owned,
    statementConsentClientFactory: owned,
  });
  cleanup.push(() => adapter.close());
  await adapter.execute(
    `INSERT INTO consent_statements(id,tenant_id,slug,created_at,updated_at) VALUES(?,?,?,?,?)`,
    ['statement-tenant-a', 'tenant-a', 'statement-tenant-a', 1, 1]
  );
  await adapter.execute(
    `INSERT INTO consent_statement_versions(id,tenant_id,statement_id,version,effective_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
    ['version-tenant-a', 'tenant-a', 'statement-tenant-a', '20261025', 1, 'active', 1, 1]
  );
  for (const [kind, key] of [
    ['tenant', ''],
    ['statement', 'statement-tenant-a'],
  ])
    await adapter.execute(
      `INSERT INTO statement_consent_guards(tenant_id,scope_kind,scope_key,mode,account_id,physical_id,restore_epoch,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        'tenant-a',
        kind,
        key,
        'enforced',
        'account-tenant-a',
        'physical-source',
        'epoch-source',
        1,
        1,
      ]
    );
  await adapter.execute(
    `INSERT INTO statement_consent_key_states(tenant_id,user_id,statement_id,account_id,physical_id,restore_epoch,revision,withdrawal_generation,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    [
      'tenant-a',
      'user-tenant-a',
      'statement-tenant-a',
      'account-tenant-a',
      'physical-source',
      'epoch-source',
      0,
      0,
      1,
    ]
  );
  return {
    adapter,
    cap: adapter.statementConsentAtomicCapability(),
    control,
    owned,
    backendIds,
    schema,
  };
}

describe('dedicated PostgreSQL consent transaction, actual local backend', () => {
  it.each(['tenant', 'statement'])(
    'keeps the %s guard account binding immutable',
    async (scope) => {
      const f = await setup();
      await expect(
        f.adapter.execute('UPDATE statement_consent_guards SET account_id=? WHERE scope_kind=?', [
          'other-account',
          scope,
        ])
      ).rejects.toThrow('statement_consent_guard_monotonic');
    }
  );
  it('reopens only a statement in a newer generation while preserving the tenant closure', async () => {
    const f = await setup();
    await f.adapter.execute(
      "UPDATE statement_consent_guards SET mode='closed',definition_generation=1,closed_generation=1 WHERE scope_kind='statement'"
    );
    await expect(
      f.adapter.execute(
        "UPDATE statement_consent_guards SET mode='enforced' WHERE scope_kind='statement'"
      )
    ).rejects.toThrow('statement_consent_guard_monotonic');
    await f.adapter.execute(
      "UPDATE statement_consent_guards SET mode='enforced',definition_generation=2 WHERE scope_kind='statement'"
    );
    const guard = await f.adapter.queryOne<{
      mode: string;
      definition_generation: string;
      closed_generation: string;
    }>(
      "SELECT mode,definition_generation,closed_generation FROM statement_consent_guards WHERE scope_kind='statement'"
    );
    expect(guard?.mode).toBe('enforced');
    expect(Number(guard?.definition_generation)).toBe(2);
    expect(Number(guard?.closed_generation)).toBe(1);
    await expect(
      f.adapter.execute(
        "UPDATE statement_consent_guards SET closed_generation=0 WHERE scope_kind='statement'"
      )
    ).rejects.toThrow('statement_consent_guard_monotonic');
    await f.adapter.execute(
      "UPDATE statement_consent_guards SET mode='closed' WHERE scope_kind='tenant'"
    );
    await expect(
      f.adapter.execute(
        "UPDATE statement_consent_guards SET mode='enforced',definition_generation=2 WHERE scope_kind='tenant'"
      )
    ).rejects.toThrow('statement_consent_guard_monotonic');
  });
  it('admits the trusted metadata snapshot with no account-side definitions', async () => {
    const f = await setup();
    await f.adapter.execute('DELETE FROM consent_statement_versions');
    await f.adapter.execute('DELETE FROM consent_statements');
    expect(await applyStatementConsentTransition(f.cap, transitionInput())).toMatchObject({
      outcome: 'applied',
    });
  });

  it('normalizes actual default int8 strings for grant, noop, withdraw and historical replay', async () => {
    const f = await setup();
    const first = transitionInput();
    const numeric = (
      result: StatementConsentOperationResult,
      outcome: 'applied' | 'noop',
      revision: number,
      generation: number
    ) => {
      expect(result).toEqual({ outcome, revision, withdrawalGeneration: generation });
      if (result.outcome === 'rejected') throw new Error('fixture-outcome');
      expect(typeof result.revision).toBe('number');
      expect(typeof result.withdrawalGeneration).toBe('number');
    };
    const rawInt8 = async (operationId: string) => {
      const raw = await f.cap.readOperation(
        `SELECT expected_revision,expected_withdrawal_generation FROM statement_consent_operations WHERE tenant_id=? AND operation_id=?`,
        ['tenant-a', operationId]
      );
      if (
        raw === null ||
        typeof raw !== 'object' ||
        !('expected_revision' in raw) ||
        !('expected_withdrawal_generation' in raw)
      )
        throw new Error('fixture-row');
      // These are actual node-postgres results under its default parser, not simulated strings.
      expect(typeof raw.expected_revision).toBe('string');
      expect(typeof raw.expected_withdrawal_generation).toBe('string');
    };
    numeric(await applyStatementConsentTransition(f.cap, first), 'applied', 1, 0);
    await rawInt8(first.operationId);
    const noop = transitionInput('tenant-a', 'b'.repeat(64));
    noop.expected.revision = 1;
    noop.before = structuredClone(first.after);
    noop.after = structuredClone(first.after);
    noop.noop = true;
    noop.history = null;
    numeric(await applyStatementConsentTransition(f.cap, noop), 'noop', 1, 0);
    await rawInt8(noop.operationId);
    numeric(await applyStatementConsentTransition(f.cap, noop), 'noop', 1, 0);
    const withdrawal = transitionInput('tenant-a', 'c'.repeat(64));
    withdrawal.action = 'withdraw';
    withdrawal.before = structuredClone(first.after);
    withdrawal.expected.revision = 1;
    withdrawal.after = {
      ...first.after,
      status: 'withdrawn',
      withdrawn_at: withdrawal.effectAt,
      updated_at: Math.max(withdrawal.effectAt, first.after.updated_at),
    };
    if (!withdrawal.history) throw new Error('fixture-history');
    Object.assign(withdrawal.history, {
      action: 'withdrawn',
      status_before: 'granted',
      status_after: 'withdrawn',
      version_before: first.after.version,
      version_id_before: first.after.version_id,
      withdrawn_at: withdrawal.after.withdrawn_at,
      granted_at: withdrawal.after.granted_at,
      expires_at: withdrawal.after.expires_at,
      retain_until: withdrawal.after.retain_until,
      consent_settings_snapshot_at: withdrawal.after.consent_settings_snapshot_at,
      record_retention_days_snapshot: withdrawal.after.record_retention_days_snapshot,
      reconsent_interval_days_snapshot: withdrawal.after.reconsent_interval_days_snapshot,
    });
    numeric(await applyStatementConsentTransition(f.cap, withdrawal), 'applied', 2, 1);
    await rawInt8(withdrawal.operationId);
    numeric(await applyStatementConsentTransition(f.cap, withdrawal), 'applied', 2, 1);
    numeric(await applyStatementConsentTransition(f.cap, first), 'applied', 1, 0);
    expect(
      await f.adapter.queryOne(`SELECT status FROM user_consent_records WHERE tenant_id=?`, [
        'tenant-a',
      ])
    ).toEqual({ status: 'withdrawn' });
    expect(
      await f.adapter.queryOne(`SELECT COUNT(*)::integer AS n FROM consent_item_history`)
    ).toEqual({ n: 2 });
  });
  it('rejects missing finalization/single execute/middle failure and replays a successful result once', async () => {
    const f = await setup();
    const input = transitionInput();
    const plan = await prepareStatementConsentTransition(f.cap, input);
    const insert = plan.statements.find((statement) => statement.sql.startsWith('WITH p AS'));
    if (!insert) throw new Error('fixture');
    await expect(f.adapter.execute(insert.sql, insert.params)).rejects.toThrow();
    await expect(
      f.cap.executeStatementConsentBatch(plan.statements.slice(0, -1))
    ).rejects.toThrow();
    await expect(
      f.cap.executeStatementConsentBatch([
        ...plan.statements.slice(0, -1),
        { sql: 'SELECT * FROM nonexistent_step_a_fault' },
        plan.statements[plan.statements.length - 1],
      ])
    ).rejects.toThrow();
    expect(
      await f.adapter.queryOne(`SELECT COUNT(*)::integer AS n FROM statement_consent_operations`)
    ).toEqual({ n: 0 });
    expect(
      await f.adapter.queryOne(`SELECT COUNT(*)::integer AS n FROM user_consent_records`)
    ).toEqual({ n: 0 });
    expect(await applyStatementConsentTransition(f.cap, input)).toMatchObject({
      outcome: 'applied',
      revision: 1,
    });
    expect(await applyStatementConsentTransition(f.cap, input)).toMatchObject({
      outcome: 'applied',
      revision: 1,
    });
    expect(
      await f.adapter.queryOne(`SELECT COUNT(*)::integer AS n FROM consent_item_history`)
    ).toEqual({ n: 1 });
    expect(f.backendIds.size).toBeGreaterThan(1);
  });
  it('does not run a normal cached query inside the owned transaction', async () => {
    const f = await setup();
    let release: () => void = () => {
      throw new Error('pause-not-installed');
    };
    let entered: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = new PostgresAdapter({
      connectionString: localDatabase(),
      clientFactory: f.owned,
      statementConsentClientFactory: async () => {
        const client = await f.owned();
        return {
          end: () => client.end(),
          query: async <T = unknown>(sql: string, params?: unknown[]) => {
            const result = await client.query<T>(sql, params);
            if (sql === 'SELECT 123 AS consent_pause') {
              entered();
              await gate;
            }
            return result;
          },
        };
      },
    });
    cleanup.push(() => adapter.close());
    const pending = adapter.statementConsentAtomicCapability().executeStatementConsentBatch([
      {
        sql: `INSERT INTO statement_consent_admissions(tenant_id,operation_id,payload_sha256,statement_id,definition_generation,physical_id,restore_epoch,issued_at,expires_at) VALUES('tenant-a','${'d'.repeat(64)}','${'e'.repeat(64)}','statement-tenant-a',0,'physical-source','epoch-source',1,2)`,
      },
      { sql: 'SELECT 123 AS consent_pause' },
    ]);
    await paused;
    try {
      expect(
        await adapter.queryOne(`SELECT COUNT(*)::integer AS n FROM statement_consent_admissions`)
      ).toEqual({ n: 0 });
    } finally {
      release();
    }
    await pending;
    expect(
      await adapter.queryOne(`SELECT COUNT(*)::integer AS n FROM statement_consent_admissions`)
    ).toEqual({ n: 1 });
  });
  it('refuses a factory lending the normal cached connection before read/write BEGIN', async () => {
    const f = await setup();
    const shared = await f.owned();
    const adapter = new PostgresAdapter({
      connectionString: localDatabase(),
      clientFactory: () => shared,
      statementConsentClientFactory: () => shared,
    });
    cleanup.push(() => adapter.close());
    await adapter.queryOne('SELECT 1 AS n');
    await expect(
      adapter.statementConsentAtomicCapability().readOperation('SELECT 1', [])
    ).rejects.toThrow('statement_consent_pg_connection_not_dedicated');
    await expect(
      adapter.statementConsentAtomicCapability().executeStatementConsentBatch([{ sql: 'SELECT 1' }])
    ).rejects.toThrow('statement_consent_pg_connection_not_dedicated');
    expect(await adapter.queryOne('SELECT 1 AS n')).toEqual({ n: 1 });
  });
  it('does not read uncommitted data inside a normal cached transaction', async () => {
    const f = await setup();
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.adapter.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO statement_consent_admissions(tenant_id,operation_id,payload_sha256,statement_id,definition_generation,physical_id,restore_epoch,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`,
        [
          'tenant-a',
          'a'.repeat(64),
          'b'.repeat(64),
          'statement-tenant-a',
          0,
          'physical-source',
          'epoch-source',
          1,
          2,
        ]
      );
      entered();
      await gate;
    });
    await paused;
    try {
      // v1 delegated to queryOne() and could observe this uncommitted cached-connection write.
      expect(
        await f.cap.readOperation(
          'SELECT COUNT(*)::integer AS n FROM statement_consent_admissions',
          []
        )
      ).toEqual({ n: 0 });
    } finally {
      release();
    }
    await pending;
    expect(
      await f.cap.readOperation(
        'SELECT COUNT(*)::integer AS n FROM statement_consent_admissions',
        []
      )
    ).toEqual({ n: 1 });
  });
  it('enforces database read-only semantics, rolls back a rejected write, and closes only its owned client', async () => {
    const f = await setup();
    const events: string[] = [];
    let closed = 0;
    const adapter = new PostgresAdapter({
      connectionString: localDatabase(),
      clientFactory: f.owned,
      statementConsentClientFactory: async () => {
        const client = await f.owned();
        return {
          query: async <T = unknown>(sql: string, params?: unknown[]) => {
            events.push(sql);
            return client.query<T>(sql, params);
          },
          end: async () => {
            closed++;
            events.push('END_OWNED');
            await client.end();
          },
        };
      },
    });
    cleanup.push(() => adapter.close());
    await adapter.queryOne('SELECT 1 AS n');
    await expect(
      adapter
        .statementConsentAtomicCapability()
        .readOperation(
          `INSERT INTO statement_consent_admissions(tenant_id,operation_id,payload_sha256,statement_id,definition_generation,physical_id,restore_epoch,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?) RETURNING operation_id`,
          [
            'tenant-a',
            'c'.repeat(64),
            'd'.repeat(64),
            'statement-tenant-a',
            0,
            'physical-source',
            'epoch-source',
            1,
            2,
          ]
        )
    ).rejects.toThrow(/read-only/i);
    expect(events[0]).toBe('BEGIN TRANSACTION READ ONLY');
    expect(events).toContain('ROLLBACK');
    expect(events).not.toContain('COMMIT');
    expect(events.at(-1)).toBe('END_OWNED');
    expect(closed).toBe(1);
    expect(
      await adapter.queryOne('SELECT COUNT(*)::integer AS n FROM statement_consent_admissions')
    ).toEqual({ n: 0 });
    expect(await adapter.queryOne('SELECT 1 AS n')).toEqual({ n: 1 });
  });
  it.each(['query', 'begin-response', 'commit-response', 'rollback-and-close', 'close'] as const)(
    'closes its read lease on %s failure without replacing the original error',
    async (failure) => {
      const f = await setup();
      const events: string[] = [];
      let closed = 0;
      const adapter = new PostgresAdapter({
        connectionString: localDatabase(),
        clientFactory: f.owned,
        statementConsentClientFactory: async () => {
          const client = await f.owned();
          return {
            query: async <T = unknown>(sql: string, params?: unknown[]) => {
              events.push(sql);
              const result = await client.query<T>(sql, params);
              if (failure === 'begin-response' && sql === 'BEGIN TRANSACTION READ ONLY')
                throw new Error('consent_begin_response_lost');
              if (failure === 'commit-response' && sql === 'COMMIT')
                throw new Error('consent_commit_response_lost');
              if (failure === 'rollback-and-close' && sql === 'ROLLBACK')
                throw new Error('secondary_rollback_failure');
              return result;
            },
            end: async () => {
              closed++;
              events.push('END_OWNED');
              await client.end();
              if (failure === 'rollback-and-close' || failure === 'close')
                throw new Error('secondary_close_failure');
            },
          };
        },
      });
      cleanup.push(() => adapter.close());
      const sql =
        failure === 'query' || failure === 'rollback-and-close'
          ? 'SELECT * FROM nonexistent_statement_consent_reader_fault'
          : 'SELECT 1 AS n';
      const expected =
        failure === 'begin-response'
          ? 'consent_begin_response_lost'
          : failure === 'commit-response'
            ? 'consent_commit_response_lost'
            : failure === 'close'
              ? 'secondary_close_failure'
              : 'nonexistent_statement_consent_reader_fault';
      await expect(
        adapter.statementConsentAtomicCapability().readOperation(sql, [])
      ).rejects.toThrow(expected);
      expect(events[0]).toBe('BEGIN TRANSACTION READ ONLY');
      if (failure === 'close') {
        expect(events).toContain('COMMIT');
        expect(events).not.toContain('ROLLBACK');
      } else expect(events).toContain('ROLLBACK');
      expect(events.at(-1)).toBe('END_OWNED');
      expect(closed).toBe(1);
    }
  );
  it('commits and closes a fresh reader, and rejects reusing that ended object', async () => {
    const f = await setup();
    const events: string[] = [];
    const client = await f.owned();
    let closed = 0;
    const reader = {
      query: async <T = unknown>(sql: string, params?: unknown[]) => {
        events.push(sql);
        return client.query<T>(sql, params);
      },
      end: async () => {
        closed++;
        events.push('END_OWNED');
        await client.end();
      },
    };
    const adapter = new PostgresAdapter({
      connectionString: localDatabase(),
      clientFactory: f.owned,
      statementConsentClientFactory: () => reader,
    });
    cleanup.push(() => adapter.close());
    expect(
      await adapter.statementConsentAtomicCapability().readOperation('SELECT ?::integer AS n', [7])
    ).toEqual({ n: 7 });
    expect(events[0]).toBe('BEGIN TRANSACTION READ ONLY');
    expect(events).toContain('COMMIT');
    expect(events).not.toContain('ROLLBACK');
    expect(events.at(-1)).toBe('END_OWNED');
    expect(closed).toBe(1);
    await expect(
      adapter.statementConsentAtomicCapability().readOperation('SELECT 1', [])
    ).rejects.toThrow('statement_consent_pg_connection_not_dedicated');
    expect(closed).toBe(1);
    expect(await adapter.queryOne('SELECT 1 AS n')).toEqual({ n: 1 });
  });
  it('recovers a writer COMMIT response loss from a fresh primary receipt without repeating effects', async () => {
    const cleanupStart = cleanup.length;
    const f = await setup();
    const sessions: Array<{
      pid: number;
      mode: 'pending' | 'reader' | 'writer';
      events: string[];
      queries: Array<{ sql: string; params: unknown[] | undefined }>;
      ends: number;
      role: unknown[] | null;
    }> = [];
    const ordinaryEvents: string[] = [];
    let ordinaryOpens = 0;
    let ordinaryEnds = 0;
    let responseLosses = 0;
    const adapter = new PostgresAdapter({
      connectionString: localDatabase(),
      clientFactory: async () => {
        ordinaryOpens++;
        const client = await f.owned();
        return {
          query: async <T = unknown>(sql: string, params?: unknown[]) => {
            ordinaryEvents.push(sql);
            return client.query<T>(sql, params);
          },
          end: async () => {
            ordinaryEnds++;
            await client.end();
          },
        };
      },
      statementConsentClientFactory: async () => {
        const client = await f.owned();
        const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const session: (typeof sessions)[number] = {
          pid: backend.rows[0].pid,
          mode: 'pending',
          events: [],
          queries: [],
          ends: 0,
          role: null,
        };
        sessions.push(session);
        return {
          query: async <T = unknown>(sql: string, params?: unknown[]) => {
            session.events.push(sql);
            session.queries.push({ sql, params });
            if (sql === 'BEGIN') session.mode = 'writer';
            if (sql === 'BEGIN TRANSACTION READ ONLY') session.mode = 'reader';
            // The actual backend executes every statement, including COMMIT, before the seam throws.
            const result = await client.query<T>(sql, params);
            if (sql.includes('pg_is_in_recovery()')) session.role = result.rows;
            if (sql === 'COMMIT' && session.mode === 'writer' && responseLosses === 0) {
              responseLosses++;
              session.events.push('COMMIT_RESPONSE_LOST');
              throw new Error('consent_writer_commit_response_lost');
            }
            return result;
          },
          end: async () => {
            session.ends++;
            session.events.push('END_OWNED');
            await client.end();
          },
        };
      },
    });
    cleanup.push(() => adapter.close());
    try {
      const ordinaryBackend = await adapter.queryOne<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid'
      );
      if (!ordinaryBackend) throw new Error('fixture_ordinary_backend_missing');
      const input = transitionInput('tenant-a', 'f'.repeat(64));
      const capability = adapter.statementConsentAtomicCapability();
      const result = await applyStatementConsentTransition(capability, input);
      expect(result).toEqual({ outcome: 'applied', revision: 1, withdrawalGeneration: 0 });
      expect(responseLosses).toBe(1);
      expect(sessions.map((session) => session.mode)).toEqual(['reader', 'writer', 'reader']);
      const writer = sessions[1];
      const recovery = sessions[2];
      expect(writer.events[0]).toBe('BEGIN');
      expect(writer.events.slice(-4)).toEqual([
        'COMMIT',
        'COMMIT_RESPONSE_LOST',
        'ROLLBACK',
        'END_OWNED',
      ]);
      expect(writer.ends).toBe(1);
      expect(recovery.events[0]).toBe('BEGIN TRANSACTION READ ONLY');
      expect(recovery.role).toEqual([{ in_recovery: false, read_only: 'on' }]);
      const receiptQuery = recovery.queries.find((query) =>
        query.sql.includes('FROM statement_consent_operations WHERE tenant_id=$1')
      );
      expect(receiptQuery).toBeDefined();
      expect(receiptQuery?.params).toEqual(['tenant-a', input.operationId]);
      expect(recovery.events.slice(-2)).toEqual(['COMMIT', 'END_OWNED']);
      expect(new Set(sessions.map((session) => session.pid)).size).toBe(3);
      for (const session of sessions) {
        expect(session.pid).not.toBe(ordinaryBackend.pid);
        expect(session.ends).toBe(1);
      }
      const durableSnapshot = async () => ({
        records: await adapter.query('SELECT * FROM user_consent_records ORDER BY id'),
        history: await adapter.query('SELECT * FROM consent_item_history ORDER BY id'),
        operations: await adapter.query(
          'SELECT * FROM statement_consent_operations ORDER BY operation_id'
        ),
        keys: await adapter.query(
          'SELECT * FROM statement_consent_key_states ORDER BY tenant_id,user_id,statement_id'
        ),
      });
      const first = await durableSnapshot();
      expect(first.records).toHaveLength(1);
      expect(first.records[0]).toMatchObject({
        id: input.after.id,
        tenant_id: 'tenant-a',
        status: 'granted',
      });
      expect(first.history).toHaveLength(1);
      expect(first.history[0]).toMatchObject({
        id: input.history?.id,
        tenant_id: 'tenant-a',
        action: 'granted',
      });
      expect(first.operations).toHaveLength(1);
      expect(first.keys).toHaveLength(1);
      expect(first.operations[0]).toMatchObject({
        operation_id: input.operationId,
        status: 'applied',
      });
      expect(first.keys[0]).toMatchObject({ revision: '1', withdrawal_generation: '0' });
      expect(await applyStatementConsentTransition(capability, input)).toEqual(result);
      expect(await durableSnapshot()).toEqual(first);
      expect(sessions.map((session) => session.mode)).toEqual([
        'reader',
        'writer',
        'reader',
        'reader',
      ]);
      expect(sessions.filter((session) => session.mode === 'writer')).toHaveLength(1);
      expect(sessions[3].role).toEqual([{ in_recovery: false, read_only: 'on' }]);
      expect(sessions[3].ends).toBe(1);
      expect(responseLosses).toBe(1);
      expect(await adapter.queryOne('SELECT pg_backend_pid() AS pid')).toEqual(ordinaryBackend);
      expect(ordinaryOpens).toBe(1);
      expect(ordinaryEnds).toBe(0);
      expect(ordinaryEvents.every((sql) => sql.startsWith('SELECT'))).toBe(true);
      await adapter.close();
      expect(ordinaryEnds).toBe(1);
    } finally {
      // This case explicitly verifies its owned schema cleanup instead of only trusting afterEach.
      for (const dispose of cleanup.splice(cleanupStart).reverse()) await dispose();
    }
    expect(ordinaryEnds).toBe(1);
    for (const session of sessions) expect(session.ends).toBe(1);
    const verifier = await f.owned();
    try {
      expect(
        (
          await verifier.query<{ n: number }>(
            'SELECT COUNT(*)::integer AS n FROM pg_catalog.pg_namespace WHERE nspname=$1',
            [f.schema]
          )
        ).rows
      ).toEqual([{ n: 0 }]);
    } finally {
      await verifier.end();
    }
  });
});
