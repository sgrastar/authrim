import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prepareMock = vi.hoisted(() => vi.fn());
vi.mock('../../log-iceberg-core-publication', () => ({
  prepareCoreLogPublication: prepareMock,
}));

import { DynamicGroupStore, type InputVersion } from '../store';
import { evaluateGroups } from '../engine';
import {
  NOW,
  TENANT,
  USER,
  V,
  auditArgOf,
  makeAudit,
  makeDb,
  makeReader,
  plan,
  publication,
} from './store.fixtures';

const INSERT_SQL = `INSERT INTO service_group_results(tenant_id, user_id) VALUES (?, ?) ON CONFLICT(tenant_id, user_id) DO NOTHING`;
const CLAIM_SQL = `UPDATE service_group_results SET lease_token = ?, lease_until = ?, attempts = attempts + 1 WHERE tenant_id = ? AND user_id = ? AND lease_until <= ?`;
const ERROR_SQL =
  'UPDATE service_group_results SET lease_until = 0, error_code = ? WHERE tenant_id = ? AND user_id = ? AND lease_token = ?';
const input = { attributes: { email_domain: 'example.com' }, sources: {} };
const expectedEvaluation = evaluateGroups(plan, input);

const stored = (over: Record<string, unknown> = {}) => ({
  route_version: '',
  rule_version: 3,
  core_version: 1,
  pii_version: 2,
  metadata_version: 3,
  epoch: 4,
  generation: 5,
  evaluated_at: 111,
  result_json: null,
  error_code: null,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  prepareMock.mockReset();
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('uuid-1');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const errorUpdates = (calls: ReturnType<typeof makeDb>['state']['calls']) =>
  calls.filter((c) => c.kind === 'execute' && c.sql === ERROR_SQL);

describe('evaluate', () => {
  it('rejects mismatched readers before writing anything', async () => {
    const { db, state } = makeDb();
    const store = new DynamicGroupStore(db, TENANT, publication);
    const { reader } = makeReader([V]);
    await expect(store.evaluate(USER, { ...reader, tenantId: 'x' })).rejects.toThrow(
      'group_tenant_or_subject_mismatch'
    );
    await expect(store.evaluate(USER, { ...reader, userId: 'x' })).rejects.toThrow(
      'group_tenant_or_subject_mismatch'
    );
    await expect(store.evaluate('x', reader)).rejects.toThrow('group_tenant_or_subject_mismatch');
    expect(state.calls).toHaveLength(0);
  });

  it('claims a 60s lease and refuses to run when the claim is not exactly one row', async () => {
    for (const claimRows of [0, 2]) {
      const { db, state } = makeDb({ claimRows });
      const { reader } = makeReader([V]);
      await expect(
        new DynamicGroupStore(db, TENANT, publication).evaluate(USER, reader)
      ).rejects.toThrow('group_evaluation_busy');
      expect(state.calls).toEqual([
        { kind: 'execute', sql: INSERT_SQL, params: [TENANT, USER] },
        { kind: 'execute', sql: CLAIM_SQL, params: ['uuid-1', NOW + 60_000, TENANT, USER, NOW] },
      ]);
    }
  });

  it('records group_catalog_missing on the lease when no catalog exists', async () => {
    const { db, state } = makeDb({ catalogRow: null });
    const { reader } = makeReader([V]);
    await expect(
      new DynamicGroupStore(db, TENANT, publication).evaluate(USER, reader)
    ).rejects.toThrow('group_catalog_missing');
    expect(errorUpdates(state.calls)).toEqual([
      {
        kind: 'execute',
        sql: ERROR_SQL,
        params: ['group_catalog_missing', TENANT, USER, 'uuid-1'],
      },
    ]);
    expect(reader.load).not.toHaveBeenCalled();
  });

  it.each([
    ['before/after the load', (i: number): InputVersion => (i === 0 ? V : { ...V, core: 2 })],
    ['after evaluation', (i: number): InputVersion => (i < 2 ? V : { ...V, pii: 3 })],
    ['after audit preparation', (i: number): InputVersion => (i < 3 ? V : { ...V, epoch: 5 })],
  ])('aborts with group_input_changed when versions move %s', async (_name, versions) => {
    const { db, state, raw } = makeDb();
    const { reader } = makeReader(versions);
    prepareMock.mockResolvedValue(makeAudit());
    await expect(
      new DynamicGroupStore(db, TENANT, publication).evaluate(USER, reader)
    ).rejects.toThrow('group_input_changed');
    expect(errorUpdates(state.calls)).toHaveLength(1);
    expect(errorUpdates(state.calls)[0].params).toEqual([
      'group_input_changed',
      TENANT,
      USER,
      'uuid-1',
    ]);
    expect(raw.batch).not.toHaveBeenCalled();
  });

  it('does not prepare an audit when the second version check already failed', async () => {
    const { db } = makeDb();
    const { reader } = makeReader((i) => (i < 2 ? V : { ...V, metadata: 99 }));
    await expect(
      new DynamicGroupStore(db, TENANT, publication).evaluate(USER, reader)
    ).rejects.toThrow('group_input_changed');
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it.each([[-1], [1.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 2]])(
    'rejects invalid stored generation %s',
    async (generation) => {
      const { db, state } = makeDb({ resultRow: stored({ generation }) });
      const { reader } = makeReader([V]);
      await expect(
        new DynamicGroupStore(db, TENANT, publication).evaluate(USER, reader)
      ).rejects.toThrow('group_generation_invalid');
      expect(prepareMock).not.toHaveBeenCalled();
      expect(errorUpdates(state.calls)[0].params?.[0]).toBe('group_generation_invalid');
    }
  );

  it('accepts generation 0 and increments it', async () => {
    const { db } = makeDb({ resultRow: stored({ generation: 0 }) });
    const { reader } = makeReader([V]);
    prepareMock.mockResolvedValue(makeAudit());
    await new DynamicGroupStore(db, TENANT, publication).evaluate(USER, reader);
    expect(auditArgOf(prepareMock).row.generation).toBe(1);
  });

  it('maps unexpected failures to group_input_unavailable and keeps group_* codes', async () => {
    const cases: Array<[unknown, string]> = [
      [new Error('boom'), 'group_input_unavailable'],
      ['group_weird', 'group_input_unavailable'],
      [new Error('group_Weird'), 'group_input_unavailable'],
      [new Error('group_load_failed'), 'group_load_failed'],
    ];
    for (const [thrown, code] of cases) {
      const { db, state } = makeDb();
      const { reader } = makeReader([V], {
        load: vi.fn(async () => {
          throw thrown;
        }),
      });
      await expect(
        new DynamicGroupStore(db, TENANT, publication).evaluate(USER, reader)
      ).rejects.toThrow(new RegExp(`^${code}$`));
      expect(errorUpdates(state.calls)).toEqual([
        { kind: 'execute', sql: ERROR_SQL, params: [code, TENANT, USER, 'uuid-1'] },
      ]);
    }
  });

  it('commits through a guarded batch and audits before/after state', async () => {
    const previous = evaluateGroups(plan, {
      attributes: { email_domain: 'other.com' },
      sources: {},
    });
    const { db, raw, state } = makeDb({
      resultRow: stored({ result_json: JSON.stringify(previous) }),
    });
    const route = { ...V, route: 'rt' };
    const { reader } = makeReader([route]);
    const audit = makeAudit();
    prepareMock.mockResolvedValue(audit);

    const snap = await new DynamicGroupStore(db, TENANT, publication).evaluate(USER, reader);

    expect(prepareMock).toHaveBeenCalledTimes(1);
    const auditArg = auditArgOf(prepareMock);
    expect(auditArg.eventAt).toBe(NOW);
    expect(auditArg.overview).toEqual({ action: 'evaluation', subject_id: USER });
    expect(auditArg.row).toMatchObject({
      user_id: USER,
      rule_version: 3,
      generation: 6,
      event_type: 'evaluation',
      created_at: NOW,
    });
    expect(JSON.parse(auditArg.row.detail_json)).toEqual({
      before: previous.groups,
      after: expectedEvaluation.groups,
      inputVersion: route,
    });

    const [statements, guard] = audit.wrapBusinessBatch.mock.calls[0];
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain(
      'UPDATE service_group_results SET generation = generation + 1'
    );
    expect(statements[0].sql).toContain('AND generation = ?');
    expect(statements[0].params).toEqual([
      3,
      1,
      2,
      3,
      4,
      JSON.stringify(expectedEvaluation),
      NOW,
      'rt',
      TENANT,
      USER,
      'uuid-1',
      NOW,
      'rt',
      1,
      2,
      3,
      4,
      TENANT,
      3,
      5,
    ]);
    expect(guard.where).toBe(
      `EXISTS(SELECT 1 FROM service_group_results WHERE tenant_id=? AND user_id=? AND lease_token=? AND lease_until=0 AND error_code IS NULL AND generation=? AND rule_version=? AND route_version=? AND core_version=? AND pii_version=? AND metadata_version=? AND epoch=? AND evaluated_at=?)`
    );
    expect(guard.params).toEqual([TENANT, USER, 'uuid-1', 6, 3, 'rt', 1, 2, 3, 4, NOW]);
    expect(raw.batch).toHaveBeenCalledTimes(1);
    expect(audit.dispatch).toHaveBeenCalledTimes(1);
    expect(errorUpdates(state.calls)).toHaveLength(0);
    expect(snap.tenantId).toBe(TENANT);
    expect(snap.userId).toBe(USER);
    expect(snap.generation).toBe(5);
  });

  it('writes an empty route when the input version has none', async () => {
    const { db } = makeDb();
    const { reader } = makeReader([V]);
    const audit = makeAudit();
    prepareMock.mockResolvedValue(audit);
    await new DynamicGroupStore(db, TENANT, publication).evaluate(USER, reader);
    const [statements, guard] = audit.wrapBusinessBatch.mock.calls[0];
    expect(statements[0].params[7]).toBe('');
    expect(statements[0].params[12]).toBe('');
    expect(guard.params[5]).toBe('');
    const auditArg = auditArgOf(prepareMock);
    expect(JSON.parse(auditArg.row.detail_json)).toMatchObject({ before: null });
    expect(auditArg.row.generation).toBe(1);
  });

  it('skips the business batch when the audit is already committed or published', async () => {
    for (const s of ['committed', 'published']) {
      const { db, raw } = makeDb({
        resultRow: stored({ result_json: '{"nodes":{},"groups":{},"evaluatedNodes":0}' }),
      });
      const { reader } = makeReader([V]);
      const audit = makeAudit(s);
      prepareMock.mockResolvedValue(audit);
      const snap = await new DynamicGroupStore(db, TENANT, publication).evaluate(USER, reader);
      expect(audit.dispatch).toHaveBeenCalledTimes(1);
      expect(raw.batch).not.toHaveBeenCalled();
      expect(snap.tenantId).toBe(TENANT);
    }
  });

  it('reports group_evaluation_superseded and records it when the guarded update lost', async () => {
    for (const batchRows of [0, 2]) {
      const { db, state } = makeDb({ batchRows });
      const { reader } = makeReader([V]);
      const audit = makeAudit();
      prepareMock.mockResolvedValue(audit);
      await expect(
        new DynamicGroupStore(db, TENANT, publication).evaluate(USER, reader)
      ).rejects.toThrow('group_evaluation_superseded');
      expect(audit.dispatch).not.toHaveBeenCalled();
      expect(errorUpdates(state.calls)).toEqual([
        {
          kind: 'execute',
          sql: ERROR_SQL,
          params: ['group_evaluation_superseded', TENANT, USER, 'uuid-1'],
        },
      ]);
    }
  });

  it('surfaces a post-commit audit failure with the superseded code and does not touch the lease', async () => {
    const { db, state } = makeDb({ publicationState: 'aborted' });
    const { reader } = makeReader([V]);
    prepareMock.mockResolvedValue(makeAudit());
    await expect(
      new DynamicGroupStore(db, TENANT, publication).evaluate(USER, reader)
    ).rejects.toThrow('group_evaluation_superseded');
    expect(errorUpdates(state.calls)).toHaveLength(0);
  });

  it('rethrows post-commit dispatch errors unchanged without recording an error', async () => {
    const { db, state } = makeDb();
    const { reader } = makeReader([V]);
    const audit = makeAudit();
    audit.dispatch.mockRejectedValue(new Error('dispatch boom'));
    prepareMock.mockResolvedValue(audit);
    await expect(
      new DynamicGroupStore(db, TENANT, publication).evaluate(USER, reader)
    ).rejects.toThrow(/^dispatch boom$/);
    expect(errorUpdates(state.calls)).toHaveLength(0);
  });

  it('requires a publication context for the audit and records the failure', async () => {
    const { db, state } = makeDb();
    const { reader } = makeReader([V]);
    await expect(new DynamicGroupStore(db, TENANT).evaluate(USER, reader)).rejects.toThrow(
      'group_audit_publication_context_required'
    );
    expect(errorUpdates(state.calls)[0].params?.[0]).toBe(
      'group_audit_publication_context_required'
    );
  });
});
