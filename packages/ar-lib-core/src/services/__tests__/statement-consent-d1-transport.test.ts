import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createD1Adapter } from '../../db/adapters/d1-adapter';
import { createStatementConsentD1Capability } from '../../db/statement-consent-atomic';
import {
  applyStatementConsentTransition,
  prepareStatementConsentTransition,
} from '../statement-consent-transitions';
import {
  stepAD1Statements,
  transitionFixture,
  transitionInput,
} from './statement-consent-transition-fixture';

type LocalD1 = Awaited<ReturnType<import('miniflare').Miniflare['getD1Database']>>;
type LocalStatement = ReturnType<LocalD1['prepare']>;
type LocalSession = ReturnType<LocalD1['withSession']>;
// Local workerd can hide deferred-FK commit errors. SQL dispatch, full rollback, recovery, and
// a self-FK-removal fault control establish causality; an opaque reference alone proves nothing.
const TRANSACTION_END_REJECTION =
  /^(?:internal error; reference = [a-z0-9]{1,128}|(?:D1_ERROR: )?FOREIGN KEY constraint failed(?:: SQLITE_CONSTRAINT(?:_FOREIGNKEY)?)?)$/;

async function durableState(db: LocalD1) {
  const tables = [
    ['statement_consent_operations', 'tenant_id,operation_id'],
    ['statement_consent_key_states', 'tenant_id,user_id,statement_id'],
    ['user_consent_records', 'tenant_id,id'],
    ['consent_item_history', 'tenant_id,id'],
    ['statement_consent_guards', 'tenant_id,scope_kind,scope_key'],
    ['statement_consent_admissions', 'tenant_id,operation_id'],
  ] as const;
  return Promise.all(
    tables.map(async ([table, order]) => ({
      table,
      rows: (
        await db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all<Record<string, unknown>>()
      ).results,
    }))
  );
}

function expectOneCommittedTransition(
  state: Awaited<ReturnType<typeof durableState>>,
  before: Awaited<ReturnType<typeof durableState>>,
  input: ReturnType<typeof transitionInput>
) {
  const rows = (table: string) => state.find((entry) => entry.table === table)?.rows;
  expect(rows('statement_consent_operations')).toHaveLength(1);
  expect(rows('statement_consent_operations')?.[0]).toMatchObject({
    tenant_id: input.owner.tenantId,
    operation_id: input.operationId,
    status: 'applied',
    is_terminal: 1,
  });
  expect(rows('statement_consent_key_states')).toHaveLength(1);
  expect(rows('statement_consent_key_states')?.[0]).toMatchObject({
    revision: 1,
    withdrawal_generation: 0,
  });
  expect(rows('user_consent_records')).toHaveLength(1);
  expect(rows('user_consent_records')?.[0]).toMatchObject({
    id: input.after.id,
    status: 'granted',
  });
  expect(rows('consent_item_history')).toHaveLength(1);
  expect(rows('consent_item_history')?.[0]).toMatchObject({
    id: input.history?.id,
    action: 'granted',
  });
  for (const table of ['statement_consent_guards', 'statement_consent_admissions']) {
    expect(rows(table)).toEqual(before.find((entry) => entry.table === table)?.rows);
  }
}

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

async function binding() {
  // Reuse installed Wrangler's Miniflare. No new dependency or download is permitted.
  const require = createRequire(import.meta.url);
  const entry = require.resolve('miniflare', { paths: [require.resolve('wrangler')] });
  const { Miniflare, convertV4MiniflareOptions } = (await import(
    pathToFileURL(entry).href
  )) as typeof import('miniflare');
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'consent-local',
      modules: true,
      script: 'export default {fetch(){return new Response("local-test")}}',
      compatibilityDate: '2026-07-08',
      host: '127.0.0.1',
      cf: false,
      d1Databases: ['CONSENT'],
    })
  );
  disposals.push(() => mf.dispose());
  const db: LocalD1 = await mf.getD1Database('CONSENT', 'consent-local');
  // Reuse exact installed consent table definitions/indexes, not a permissive hand-built schema.
  const host = transitionFixture();
  try {
    const schema = await host.adapter.query<{ sql: string }>(
      `SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'statement_consent_%' AND tbl_name IN ('consent_statements','consent_statement_versions','user_consent_records','consent_item_history') ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`
    );
    for (const row of schema) await db.prepare(row.sql).run();
    // Private schema statements are generated alongside the draft; triggers remain single statements.
    for (const sql of stepAD1Statements()) await db.prepare(sql).run();
  } finally {
    host.close();
  }
  const sessionConstraints: (string | undefined)[] = [];
  const transport = {
    prepared: [] as string[],
    runs: [] as string[],
    batches: [] as string[][],
    failures: [] as Array<{ method: 'run' | 'batch'; message: string }>,
  };
  const statements = new WeakMap<LocalStatement, { raw: LocalStatement; sql: string }>();
  const failure = (method: 'run' | 'batch', error: unknown) => {
    transport.failures.push({
      method,
      message: error instanceof Error ? error.message : String(error),
    });
  };
  function observeStatement(raw: LocalStatement, sql: string): LocalStatement {
    const observed: LocalStatement = {
      bind: (...values) => observeStatement(raw.bind(...values), sql),
      first: raw.first.bind(raw),
      all: raw.all.bind(raw),
      raw: raw.raw.bind(raw),
      async run<T = Record<string, unknown>>() {
        transport.runs.push(sql);
        try {
          return await raw.run<T>();
        } catch (error) {
          failure('run', error);
          throw error;
        }
      },
    };
    statements.set(observed, { raw, sql });
    return observed;
  }
  async function observeBatch<T>(owner: Pick<LocalD1, 'batch'>, wrapped: LocalStatement[]) {
    const originals = wrapped.map((statement) => {
      const original = statements.get(statement);
      if (!original) throw new Error('local_d1_observer_statement_missing');
      return original;
    });
    transport.batches.push(originals.map((statement) => statement.sql));
    try {
      // Pass the real binding's native statements, never object wrappers, into its batch transport.
      return await owner.batch<T>(originals.map((statement) => statement.raw));
    } catch (error) {
      failure('batch', error);
      throw error;
    }
  }
  function observeSession(session: LocalSession): LocalSession {
    return {
      prepare(sql) {
        transport.prepared.push(sql);
        return observeStatement(session.prepare(sql), sql);
      },
      batch: <T = unknown>(wrapped: LocalStatement[]) => observeBatch<T>(session, wrapped),
      getBookmark: () => session.getBookmark(),
    };
  }
  // Keep the full installed Cloudflare binding surface, including sessions and deprecated dump.
  const observed: LocalD1 = {
    prepare(sql) {
      transport.prepared.push(sql);
      return observeStatement(db.prepare(sql), sql);
    },
    batch: <T = unknown>(wrapped: LocalStatement[]) => observeBatch<T>(db, wrapped),
    exec: (sql) => db.exec(sql),
    dump: () => db.dump(),
    withSession(constraint) {
      sessionConstraints.push(constraint);
      if (typeof db.withSession !== 'function')
        throw new Error('local_d1_sessions_backend_unproven');
      return observeSession(db.withSession(constraint));
    },
  };
  const adapter = createD1Adapter(observed, 'consent-test', { retryConfig: { maxRetries: 0 } });
  const cap = createStatementConsentD1Capability(adapter);
  const fixture = transitionFixture();
  try {
    await fixture.seed();
    for (const table of [
      'consent_statements',
      'consent_statement_versions',
      'statement_consent_guards',
      'statement_consent_key_states',
    ]) {
      const rows = await fixture.adapter.query<Record<string, unknown>>(`SELECT * FROM ${table}`);
      for (const row of rows) {
        const keys = Object.keys(row);
        await db
          .prepare(
            `INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`
          )
          .bind(...keys.map((key) => row[key]))
          .run();
      }
    }
  } finally {
    fixture.close();
  }
  return { db, adapter, cap, sessionConstraints, transport };
}

describe('local Miniflare real D1 prepared/bind/batch transport (no remote)', () => {
  it('uses first-primary for both committed receipt reads and for read-only replay', async () => {
    const { cap, sessionConstraints } = await binding();
    const input = transitionInput();
    expect(await applyStatementConsentTransition(cap, input)).toMatchObject({
      outcome: 'applied',
      revision: 1,
    });
    expect(sessionConstraints).toEqual(['first-primary', 'first-primary']);
    sessionConstraints.length = 0;
    expect(await applyStatementConsentTransition(cap, input)).toMatchObject({
      outcome: 'applied',
      revision: 1,
    });
    expect(sessionConstraints).toEqual(['first-primary']);
  });
  it('rejects a missing terminal statement at the D1 transaction boundary', async () => {
    const { db, cap, transport } = await binding();
    const input = transitionInput();
    const plan = await prepareStatementConsentTransition(cap, input);
    const before = await durableState(db);
    await expect(cap.executeStatementConsentBatch(plan.statements.slice(0, -1))).rejects.toThrow();
    expect(transport.batches).toEqual([
      plan.statements.slice(0, -1).map((statement) => statement.sql),
    ]);
    expect(transport.failures).toHaveLength(1);
    expect(transport.failures[0].method).toBe('batch');
    expect(transport.failures[0].message).toMatch(TRANSACTION_END_REJECTION);
    expect(await durableState(db)).toEqual(before);
    expect((await db.prepare('SELECT * FROM statement_consent_operations').all()).results).toEqual(
      []
    );
    expect((await db.prepare('SELECT * FROM user_consent_records').all()).results).toEqual([]);
    expect(await applyStatementConsentTransition(cap, input)).toEqual({
      outcome: 'applied',
      revision: 1,
      withdrawalGeneration: 0,
    });
    const committed = await durableState(db);
    expectOneCommittedTransition(committed, before, input);
    expect(transport.batches).toHaveLength(2);
    expect(await applyStatementConsentTransition(cap, input)).toEqual({
      outcome: 'applied',
      revision: 1,
      withdrawalGeneration: 0,
    });
    expect(await durableState(db)).toEqual(committed);
    expect(transport.batches).toHaveLength(2);
  });
  it('rejects single executing execute and middle SQL failure, then applies and replays once', async () => {
    const { db, adapter, cap, transport } = await binding();
    const input = transitionInput();
    const plan = await prepareStatementConsentTransition(cap, input);
    const before = await durableState(db);
    await expect(
      adapter.execute(plan.statements[0].sql, plan.statements[0].params)
    ).rejects.toThrow();
    expect(transport.runs).toEqual([plan.statements[0].sql]);
    expect(transport.failures).toHaveLength(1);
    expect(transport.failures[0].method).toBe('run');
    expect(transport.failures[0].message).toMatch(TRANSACTION_END_REJECTION);
    expect(await durableState(db)).toEqual(before);
    await expect(
      cap.executeStatementConsentBatch([
        ...plan.statements.slice(0, 2),
        { sql: 'SELECT * FROM nonexistent_statement_consent_fault' },
        ...plan.statements.slice(2),
      ])
    ).rejects.toThrow();
    expect(transport.batches).toHaveLength(1);
    expect(transport.batches[0]).toEqual([
      ...plan.statements.slice(0, 2).map((statement) => statement.sql),
      'SELECT * FROM nonexistent_statement_consent_fault',
      ...plan.statements.slice(2).map((statement) => statement.sql),
    ]);
    expect(transport.failures).toHaveLength(2);
    expect(transport.failures[1].method).toBe('batch');
    expect(transport.failures[1].message).toMatch(
      /no such table: nonexistent_statement_consent_fault/i
    );
    expect(await durableState(db)).toEqual(before);
    expect(await applyStatementConsentTransition(cap, input)).toMatchObject({
      outcome: 'applied',
      revision: 1,
    });
    const committed = await durableState(db);
    expectOneCommittedTransition(committed, before, input);
    expect(transport.batches).toHaveLength(2);
    expect(await applyStatementConsentTransition(cap, input)).toMatchObject({
      outcome: 'applied',
      revision: 1,
    });
    expect(await durableState(db)).toEqual(committed);
    expect(transport.batches).toHaveLength(2);
    expect(await adapter.queryOne('SELECT COUNT(*) AS n FROM consent_item_history')).toEqual({
      n: 1,
    });
  });
});
