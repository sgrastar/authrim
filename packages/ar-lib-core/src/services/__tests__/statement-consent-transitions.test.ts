import { afterEach, describe, expect, it } from 'vitest';
import {
  applyStatementConsentTransition,
  prepareStatementConsentTransition,
  statementConsentHistoryId,
} from '../statement-consent-transitions';
import {
  transitionFixture,
  transitionInput,
  copyStatement,
} from './statement-consent-transition-fixture';

const open: ReturnType<typeof transitionFixture>[] = [];
afterEach(() => {
  for (const fixture of open.splice(0)) fixture.close();
});
async function setup() {
  const fixture = transitionFixture();
  open.push(fixture);
  await fixture.seed();
  return fixture;
}

const DATABASE_NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
async function databaseNow(f: ReturnType<typeof transitionFixture>): Promise<number> {
  const row = await f.adapter.queryOne<{ now_ms: number }>(`SELECT ${DATABASE_NOW} AS now_ms`);
  if (!row || !Number.isSafeInteger(row.now_ms) || row.now_ms < 0)
    throw new Error('fixture_database_clock_invalid');
  return row.now_ms;
}
async function tenantState(f: ReturnType<typeof transitionFixture>, tenant: string) {
  const snapshots: Record<string, Array<Record<string, unknown>>> = {};
  for (const table of [
    'consent_statements',
    'consent_statement_versions',
    'consent_statement_localizations',
    'user_consent_records',
    'consent_item_history',
    'statement_consent_guards',
    'statement_consent_key_states',
    'statement_consent_operations',
    'statement_consent_admissions',
  ]) {
    snapshots[table] = await f.adapter.query<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE tenant_id=? ORDER BY 1,2,3`,
      [tenant]
    );
  }
  return snapshots;
}

describe('statement consent same-database closure and effect evidence (real SQLite/FK ON)', () => {
  it('applies one record/history/revision, recovers transport loss, and does not retain UA/IP in receipt', async () => {
    const f = await setup();
    const input = transitionInput();
    let loseResponse = true;
    const cap = {
      ...f.capability,
      async executeStatementConsentBatch(
        statements: Parameters<typeof f.capability.executeStatementConsentBatch>[0]
      ) {
        await f.capability.executeStatementConsentBatch(statements);
        if (loseResponse) {
          loseResponse = false;
          throw new Error('lost-response');
        }
      },
    };
    expect(await applyStatementConsentTransition(cap, input)).toEqual({
      outcome: 'applied',
      revision: 1,
      withdrawalGeneration: 0,
    });
    expect(await applyStatementConsentTransition(cap, input)).toEqual({
      outcome: 'applied',
      revision: 1,
      withdrawalGeneration: 0,
    });
    expect(await f.rows('user_consent_records')).toHaveLength(1);
    expect(await f.rows('consent_item_history')).toHaveLength(1);
    const receipt = await f.rows('statement_consent_operations');
    expect(receipt).toHaveLength(1);
    expect(receipt[0]).toMatchObject({ status: 'applied', is_terminal: 1, required_terminal: 1 });
    expect(JSON.stringify(receipt)).not.toContain('ua-marker');
    expect(JSON.stringify(receipt)).not.toContain('hashed-ip-marker');
  });

  it.each(['last', 'history', 'key', 'record'] as const)(
    'rolls every effect back if the %s statement is omitted',
    async (omitted) => {
      const f = await setup();
      const { statements } = await prepareStatementConsentTransition(
        f.capability,
        transitionInput()
      );
      const index =
        omitted === 'last'
          ? statements.length - 1
          : omitted === 'history'
            ? statements.findIndex((s) => s.sql.startsWith('INSERT INTO consent_item_history'))
            : omitted === 'key'
              ? statements.findIndex((s) => s.sql.startsWith('UPDATE statement_consent_key_states'))
              : statements.findIndex((s) => s.sql.startsWith('INSERT INTO user_consent_records'));
      expect(index).toBeGreaterThanOrEqual(0);
      await expect(
        f.capability.executeStatementConsentBatch(statements.filter((_s, i) => i !== index))
      ).rejects.toThrow();
      expect(await f.rows('user_consent_records')).toEqual([]);
      expect(await f.rows('consent_item_history')).toEqual([]);
      expect(await f.rows('statement_consent_operations')).toEqual([]);
      expect((await f.rows('statement_consent_key_states'))[0]).toMatchObject({
        revision: 0,
        withdrawal_generation: 0,
      });
    }
  );

  it('rejects a standalone executing INSERT and never leaves a permit for delayed old SQL', async () => {
    const f = await setup();
    const input = transitionInput();
    const { statements } = await prepareStatementConsentTransition(f.capability, input);
    await expect(f.adapter.execute(statements[0].sql, statements[0].params)).rejects.toThrow(
      /FOREIGN KEY/
    );
    await expect(
      f.adapter.execute(
        `INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
        [
          input.after.id,
          input.owner.tenantId,
          input.owner.userId,
          input.owner.statementId,
          input.after.version_id,
          input.after.version,
          'granted',
          1,
          1,
        ]
      )
    ).rejects.toThrow(/guard/);
    expect(await f.rows('statement_consent_operations')).toEqual([]);
    expect(await f.rows('user_consent_records')).toEqual([]);
  });

  it.each([
    'delete',
    'null',
    'zero',
    'terminal-insert',
    'other-row',
    'rowid-replace',
    'early-finalize',
  ] as const)('fails closed on %s rather than relying on the builder tail', async (fault) => {
    const f = await setup();
    const input = transitionInput();
    const { statements } = await prepareStatementConsentTransition(f.capability, input);
    const insert = copyStatement(statements[0]);
    const inject =
      fault === 'delete'
        ? `DELETE FROM statement_consent_operations`
        : fault === 'null'
          ? `UPDATE statement_consent_operations SET required_terminal=NULL`
          : fault === 'zero'
            ? `UPDATE statement_consent_operations SET required_terminal=0`
            : fault === 'other-row'
              ? `INSERT OR REPLACE INTO statement_consent_operations SELECT * FROM statement_consent_operations`
              : fault === 'rowid-replace'
                ? `INSERT OR REPLACE INTO statement_consent_operations(rowid) VALUES(1)`
                : `UPDATE statement_consent_operations SET status='applied',is_terminal=1`;
    if (fault === 'terminal-insert') {
      insert.sql = insert.sql
        .replace('admitted)\n', 'admitted,status,is_terminal)\n')
        .replace('END FROM p', "END,'applied',1 FROM p");
      expect(insert.sql).toContain('admitted,status,is_terminal');
    }
    await expect(
      f.capability.executeStatementConsentBatch(
        fault === 'terminal-insert' ? [insert] : [insert, { sql: inject }, ...statements.slice(1)]
      )
    ).rejects.toThrow();
    expect(await f.rows('statement_consent_operations')).toEqual([]);
    expect(await f.rows('user_consent_records')).toEqual([]);
  });

  it('does not permit terminal re-open or a same-PK REPLACE after a successful result', async () => {
    const f = await setup();
    const input = transitionInput();
    await applyStatementConsentTransition(f.capability, input);
    await expect(
      f.adapter.execute(`UPDATE statement_consent_operations SET status='executing',is_terminal=0`)
    ).rejects.toThrow();
    await expect(
      f.adapter.execute(
        `INSERT OR REPLACE INTO statement_consent_operations SELECT * FROM statement_consent_operations`
      )
    ).rejects.toThrow();
    expect(await f.rows('consent_item_history')).toHaveLength(1);
    expect((await f.rows('statement_consent_operations'))[0]?.status).toBe('applied');
  });

  it('rejects different-op REPLACE against the partial UNIQUE executing-key index', async () => {
    const f = await setup();
    const input = transitionInput();
    const a = await prepareStatementConsentTransition(f.capability, input);
    const bInput = structuredClone(input);
    bInput.operationId = 'b'.repeat(64);
    if (bInput.history)
      bInput.history.id = statementConsentHistoryId(bInput.owner.tenantId, bInput.operationId);
    const b = await prepareStatementConsentTransition(f.capability, bInput);
    const replacement = copyStatement(b.statements[0]);
    replacement.sql = replacement.sql.replace(
      'INSERT INTO statement_consent_operations',
      'INSERT OR REPLACE INTO statement_consent_operations'
    );
    await expect(
      f.capability.executeStatementConsentBatch([
        a.statements[0],
        replacement,
        ...a.statements.slice(1),
      ])
    ).rejects.toThrow();
    expect(await f.rows('statement_consent_operations')).toEqual([]);
    expect(await f.rows('user_consent_records')).toEqual([]);
  });

  it('keeps all four tables WITHOUT ROWID and rejects a fractional DB generation', async () => {
    const f = await setup();
    const tables = await f.adapter.query<{ name: string; wr: number }>('PRAGMA table_list');
    expect(await f.adapter.queryOne('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    expect(await f.adapter.queryOne('PRAGMA recursive_triggers')).toEqual({
      recursive_triggers: 0,
    });
    for (const name of [
      'statement_consent_guards',
      'statement_consent_key_states',
      'statement_consent_operations',
      'statement_consent_admissions',
    ])
      expect(tables.find((row) => row.name === name)?.wr).toBe(1);
    await expect(
      f.adapter.execute(
        `UPDATE statement_consent_guards SET definition_generation=1.5 WHERE scope_kind='statement'`
      )
    ).rejects.toThrow();
    expect(
      (
        await f.adapter.queryOne<{ definition_generation: number }>(
          `SELECT definition_generation FROM statement_consent_guards WHERE scope_kind='statement'`
        )
      )?.definition_generation
    ).toBe(0);
  });

  it('records a no-op without advancing generation or adding history', async () => {
    const f = await setup();
    const first = transitionInput();
    await applyStatementConsentTransition(f.capability, first);
    const next = transitionInput('tenant-a', 'b'.repeat(64));
    next.expected.revision = 1;
    next.before = structuredClone(first.after);
    next.after = structuredClone(first.after);
    next.noop = true;
    next.history = null;
    expect(await applyStatementConsentTransition(f.capability, next)).toEqual({
      outcome: 'noop',
      revision: 1,
      withdrawalGeneration: 0,
    });
    expect(await f.rows('consent_item_history')).toHaveLength(1);
  });

  it('checks fixed expiry again inside the atomic batch, not only at preparation', async () => {
    const f = await setup();
    const input = transitionInput();
    let clock = input.effectAt;
    const clockDb = f.db;
    let clockCalls = 0;
    clockDb.function('julianday', (argument: unknown) => {
      if (argument !== 'now') throw new Error('fixture_unexpected_clock_argument');
      clockCalls++;
      return clock / 86_400_000 + 2_440_587.5;
    });
    const admittedNow = await databaseNow(f);
    expect(clockCalls).toBe(1);
    expect(admittedNow).toBeGreaterThanOrEqual(input.issuedAt);
    expect(admittedNow).toBeLessThanOrEqual(input.expiresAt);
    const keyBefore = await f.rows('statement_consent_key_states');
    clockDb.function('consent_advance_clock', () => {
      clock = input.expiresAt + 2_000;
      return 1;
    });
    const plan = await prepareStatementConsentTransition(f.capability, input);
    await expect(
      f.capability.executeStatementConsentBatch([
        plan.statements[0],
        { sql: 'SELECT consent_advance_clock()' },
        ...plan.statements.slice(1),
      ])
    ).rejects.toThrow();
    // Observe the same SQL clock expression as the actual guards, not just the JS variable.
    expect(await databaseNow(f)).toBeGreaterThan(input.expiresAt);
    expect(clockCalls).toBeGreaterThan(1);
    expect(await f.rows('statement_consent_operations')).toEqual([]);
    expect(await f.rows('user_consent_records')).toEqual([]);
    expect(await f.rows('consent_item_history')).toEqual([]);
    expect(await f.rows('statement_consent_key_states')).toEqual(keyBefore);
  });

  it('requires prior-history retention effects and keeps a future updated_at from moving backward', async () => {
    const f = await setup();
    const first = transitionInput();
    first.after.updated_at += 86_400_000;
    first.after.retain_until = first.effectAt + 1_000;
    if (!first.history) throw new Error('fixture');
    first.history.retain_until = first.after.retain_until;
    await applyStatementConsentTransition(f.capability, first);
    const withdrawal = transitionInput('tenant-a', 'b'.repeat(64));
    withdrawal.action = 'withdraw';
    withdrawal.before = structuredClone(first.after);
    withdrawal.expected.revision = 1;
    withdrawal.after = {
      ...first.after,
      status: 'withdrawn',
      withdrawn_at: withdrawal.effectAt,
      retain_until: withdrawal.effectAt + 2_000,
    };
    if (!withdrawal.history) throw new Error('fixture');
    Object.assign(withdrawal.history, {
      action: 'withdrawn',
      status_before: 'granted',
      status_after: 'withdrawn',
      version_before: first.after.version,
      version_id_before: first.after.version_id,
      withdrawn_at: withdrawal.after.withdrawn_at,
      granted_at: withdrawal.after.granted_at,
      retain_until: withdrawal.after.retain_until,
      consent_settings_snapshot_at: withdrawal.after.consent_settings_snapshot_at,
    });
    const plan = await prepareStatementConsentTransition(f.capability, withdrawal);
    const retention = plan.statements.findIndex((s) =>
      s.sql.startsWith('UPDATE consent_item_history')
    );
    expect(retention).toBeGreaterThan(0);
    await expect(
      f.capability.executeStatementConsentBatch(
        plan.statements.filter((_s, index) => index !== retention)
      )
    ).rejects.toThrow();
    expect((await f.rows('user_consent_records'))[0]).toMatchObject({
      status: 'granted',
      updated_at: first.after.updated_at,
    });
    expect(await applyStatementConsentTransition(f.capability, withdrawal)).toMatchObject({
      outcome: 'applied',
      revision: 2,
      withdrawalGeneration: 1,
    });
    expect((await f.rows('user_consent_records'))[0]?.updated_at).toBe(first.after.updated_at);
    const histories = await f.rows('consent_item_history');
    expect(histories).toHaveLength(2);
    expect(histories.every((row) => row.retain_until === withdrawal.after.retain_until)).toBe(true);
  });

  it.each([
    'revision',
    'withdrawal',
    'definition',
    'closed',
    'tenant',
    'account',
    'physical',
    'epoch',
    'expired',
    'future',
  ] as const)(
    'records rejected, with no grant, for stale or invalid %s evidence',
    async (change) => {
      const f = await setup();
      const observedNow = await databaseNow(f);
      // A coherent token captured long ago is unambiguously expired under the real DB clock.
      const input = transitionInput(
        'tenant-a',
        'a'.repeat(64),
        change === 'expired' ? observedNow - 700_000 : Date.now()
      );
      const before = await tenantState(f, 'tenant-a');
      if (change === 'revision') input.expected.revision = 1;
      if (change === 'withdrawal') input.expected.withdrawalGeneration = 1;
      if (change === 'definition') input.expected.definitionGeneration = 1;
      if (change === 'closed') input.expected.closedGeneration = 1;
      if (change === 'tenant') {
        input.owner.tenantId = 'other';
        input.after.tenant_id = 'other';
        if (input.history) {
          input.history.tenant_id = 'other';
          input.history.id = statementConsentHistoryId('other', input.operationId);
        }
      }
      if (change === 'account') input.owner.accountId = 'other';
      if (change === 'physical') input.owner.physicalId = 'other';
      if (change === 'epoch') input.owner.restoreEpoch = 'other';
      if (change === 'expired') expect(await databaseNow(f)).toBeGreaterThan(input.expiresAt);
      if (change === 'future') {
        input.issuedAt += 700_000;
        input.expiresAt += 1_400_000;
        input.effectAt = input.issuedAt;
      }
      expect((await applyStatementConsentTransition(f.capability, input)).outcome).toBe('rejected');
      expect(await f.rows('user_consent_records')).toEqual([]);
      expect(await f.rows('consent_item_history')).toEqual([]);
      const after = await tenantState(f, 'tenant-a');
      for (const table of Object.keys(before))
        if (table !== 'statement_consent_operations') expect(after[table]).toEqual(before[table]);
      const receipts = await f.rows('statement_consent_operations');
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        tenant_id: input.owner.tenantId,
        operation_id: input.operationId,
        status: 'rejected',
        is_terminal: 1,
        admitted: 0,
      });
      expect((await applyStatementConsentTransition(f.capability, input)).outcome).toBe('rejected');
      expect(await f.rows('statement_consent_operations')).toEqual(receipts);
      expect(await tenantState(f, 'tenant-a')).toEqual(after);
    }
  );

  it('keeps tenant B and refuses same op with a changed payload or a new physical route', async () => {
    const f = await setup();
    await f.seed('tenant-b');
    const a = transitionInput();
    const b = transitionInput('tenant-b');
    // Same op IDs in distinct tenants are valid composite receipt keys in a shared DB.
    expect(a.operationId).toBe(b.operationId);
    expect(await applyStatementConsentTransition(f.capability, a)).toEqual({
      outcome: 'applied',
      revision: 1,
      withdrawalGeneration: 0,
    });
    expect(await applyStatementConsentTransition(f.capability, b)).toEqual({
      outcome: 'applied',
      revision: 1,
      withdrawalGeneration: 0,
    });
    expect(a.history?.id).not.toBe(b.history?.id);
    const beforeB = await tenantState(f, 'tenant-b');
    const beforeA = await tenantState(f, 'tenant-a');
    expect(beforeB.user_consent_records).toHaveLength(1);
    expect(beforeB.consent_item_history).toHaveLength(1);
    expect(beforeB.statement_consent_operations[0]).toMatchObject({
      tenant_id: 'tenant-b',
      status: 'applied',
      is_terminal: 1,
    });
    const replay = structuredClone(a);
    replay.after.client_id = 'different';
    if (replay.history) replay.history.client_id = 'different';
    await expect(applyStatementConsentTransition(f.capability, replay)).rejects.toThrow(/conflict/);
    expect(await tenantState(f, 'tenant-b')).toEqual(beforeB);
    expect(await tenantState(f, 'tenant-a')).toEqual(beforeA);
    const rerouted = structuredClone(a);
    rerouted.owner.physicalId = 'replacement';
    await expect(applyStatementConsentTransition(f.capability, rerouted)).rejects.toThrow(
      /conflict/
    );
    expect(await tenantState(f, 'tenant-b')).toEqual(beforeB);
    expect(await tenantState(f, 'tenant-a')).toEqual(beforeA);
    expect(await applyStatementConsentTransition(f.capability, b)).toEqual({
      outcome: 'applied',
      revision: 1,
      withdrawalGeneration: 0,
    });
    expect(await tenantState(f, 'tenant-b')).toEqual(beforeB);
    expect(await f.rows('user_consent_records')).toHaveLength(2);
    expect(await f.rows('consent_item_history')).toHaveLength(2);
  });

  it('binds global history IDs to tenant+op and rejects a foreign tenant history ID before any write', async () => {
    const f = await setup();
    await f.seed('tenant-b');
    const a = transitionInput();
    const b = transitionInput('tenant-b');
    expect(statementConsentHistoryId('tenant:a', a.operationId)).not.toBe(
      statementConsentHistoryId('tenant:a:b', a.operationId)
    );
    const beforeA = await tenantState(f, 'tenant-a');
    const beforeB = await tenantState(f, 'tenant-b');
    if (!a.history || !b.history) throw new Error('fixture_history_missing');
    b.history.id = a.history.id;
    await expect(applyStatementConsentTransition(f.capability, b)).rejects.toThrow(
      'statement_consent_transition_invalid'
    );
    expect(await tenantState(f, 'tenant-a')).toEqual(beforeA);
    expect(await tenantState(f, 'tenant-b')).toEqual(beforeB);
    const valid = transitionInput('tenant-b');
    const plan = await prepareStatementConsentTransition(f.capability, valid);
    const changed = plan.statements.map(copyStatement);
    const insert = changed.find((statement) =>
      statement.sql.includes('INSERT INTO statement_consent_operations')
    );
    if (!insert?.params) throw new Error('fixture_operation_insert_missing');
    // Bypass only the TS builder input check: the real trigger must independently reject it.
    const expectedId = `"id":${JSON.stringify(statementConsentHistoryId('tenant-b', valid.operationId))}`;
    const historyIndexes = insert.params.flatMap((value, index) =>
      typeof value === 'string' &&
      value.startsWith('{') &&
      value.includes(expectedId) &&
      value.includes('"status_before"')
        ? [index]
        : []
    );
    expect(historyIndexes).toHaveLength(1);
    const historyParam = historyIndexes[0];
    const historyJson = insert.params[historyParam];
    if (typeof historyJson !== 'string') throw new Error('fixture_history_param_missing');
    insert.params[historyParam] = historyJson.replace(
      expectedId,
      `"id":${JSON.stringify(a.history.id)}`
    );
    await expect(f.capability.executeStatementConsentBatch(changed)).rejects.toThrow();
    expect(await tenantState(f, 'tenant-a')).toEqual(beforeA);
    expect(await tenantState(f, 'tenant-b')).toEqual(beforeB);
  });

  it('retains withdrawal generation and refuses an old grant after withdrawal', async () => {
    const f = await setup();
    const first = transitionInput();
    await applyStatementConsentTransition(f.capability, first);
    const withdrawal = transitionInput('tenant-a', 'b'.repeat(64));
    withdrawal.action = 'withdraw';
    withdrawal.before = structuredClone(first.after);
    withdrawal.expected.revision = 1;
    withdrawal.after = {
      ...first.after,
      status: 'withdrawn',
      withdrawn_at: withdrawal.effectAt,
      updated_at: Math.max(withdrawal.effectAt, first.after.updated_at),
    };
    if (!withdrawal.history) throw new Error('fixture');
    Object.assign(withdrawal.history, {
      action: 'withdrawn',
      status_before: 'granted',
      status_after: 'withdrawn',
      version_before: first.after.version,
      version_id_before: first.after.version_id,
      withdrawn_at: withdrawal.effectAt,
      granted_at: withdrawal.after.granted_at,
      consent_settings_snapshot_at: withdrawal.after.consent_settings_snapshot_at,
    });
    expect(await applyStatementConsentTransition(f.capability, withdrawal)).toMatchObject({
      outcome: 'applied',
      revision: 2,
      withdrawalGeneration: 1,
    });
    const stale = transitionInput('tenant-a', 'c'.repeat(64));
    expect((await applyStatementConsentTransition(f.capability, stale)).outcome).toBe('rejected');
    expect((await f.rows('user_consent_records'))[0]?.status).toBe('withdrawn');
    expect(await f.rows('consent_item_history')).toHaveLength(2);
  });

  it('leaves normal auto-rowid legacy writes working when disabled and protects enabled victims from disabled REPLACE', async () => {
    const f = transitionFixture();
    open.push(f);
    await f.seed('tenant-a', 'disabled');
    const input = transitionInput();
    await f.adapter.execute(
      `INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
      [
        input.after.id,
        input.owner.tenantId,
        input.owner.userId,
        input.owner.statementId,
        input.after.version_id,
        input.after.version,
        1,
        1,
      ]
    );
    await f.adapter.execute(`UPDATE user_consent_records SET updated_at=2 WHERE id=?`, [
      input.after.id,
    ]);
    await f.adapter.execute(
      `INSERT INTO consent_item_history(id,tenant_id,user_id,statement_id,action,created_at) VALUES(?,?,?,?,?,?)`,
      ['history-a', 'tenant-a', 'user-tenant-a', 'statement-tenant-a', 'granted', 1]
    );
    await f.adapter.execute(
      `UPDATE statement_consent_guards SET mode='enforced' WHERE tenant_id=?`,
      [input.owner.tenantId]
    );
    await f.seed('tenant-b', 'disabled');
    await f.adapter.execute(
      `INSERT INTO user_consent_records(id,tenant_id,user_id,statement_id,version_id,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
      [
        'record-b',
        'tenant-b',
        'user-tenant-b',
        'statement-tenant-b',
        'version-tenant-b',
        '20261025',
        1,
        1,
      ]
    );
    const rowid = await f.adapter.queryOne<{ rowid: number }>(
      `SELECT rowid FROM user_consent_records WHERE id=?`,
      [input.after.id]
    );
    expect(rowid).not.toBeNull();
    for (const alias of ['rowid', 'oid', '_rowid_']) {
      await expect(
        f.adapter.execute(
          `INSERT OR REPLACE INTO user_consent_records(${alias},id,tenant_id,user_id,statement_id,version_id,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
          [
            rowid?.rowid,
            'other-record',
            'tenant-b',
            'user-tenant-b',
            'statement-tenant-b',
            'version-tenant-b',
            '20261025',
            1,
            1,
          ]
        )
      ).rejects.toThrow();
    }
    await expect(
      f.adapter.execute(`UPDATE user_consent_records SET tenant_id='tenant-b' WHERE id=?`, [
        input.after.id,
      ])
    ).rejects.toThrow();
    await expect(
      f.adapter.execute(`UPDATE OR REPLACE user_consent_records SET id=? WHERE id='record-b'`, [
        input.after.id,
      ])
    ).rejects.toThrow();
    const historyRow = await f.adapter.queryOne<{ rowid: number }>(
      `SELECT rowid FROM consent_item_history WHERE id='history-a'`
    );
    for (const alias of ['rowid', 'oid', '_rowid_'])
      await expect(
        f.adapter.execute(
          `INSERT OR REPLACE INTO consent_item_history(${alias},id,tenant_id,user_id,statement_id,action,created_at) VALUES(?,?,?,?,?,?,?)`,
          [
            historyRow?.rowid,
            'history-b',
            'tenant-b',
            'user-tenant-b',
            'statement-tenant-b',
            'granted',
            1,
          ]
        )
      ).rejects.toThrow();
    expect(
      await f.adapter.queryOne(`SELECT id FROM consent_item_history WHERE id='history-a'`)
    ).toEqual({ id: 'history-a' });
    expect((await f.rows('user_consent_records'))[0]?.id).toBe(input.after.id);
  });
});
