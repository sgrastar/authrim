import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prepareMock = vi.hoisted(() => vi.fn());
vi.mock('../../log-iceberg-core-publication', () => ({
  prepareCoreLogPublication: prepareMock,
}));

import { DynamicGroupStore } from '../store';
import { compileGroups } from '../engine';
import { BUILTIN_GROUP_FIELDS, type GroupPlan, type ServiceGroup } from '../model';
import {
  NOW,
  PRIMARY,
  TENANT,
  USER,
  group,
  groups,
  auditArgOf,
  makeAudit,
  makeDb,
  plan,
  publication,
} from './store.fixtures';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  prepareMock.mockReset();
  let n = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `uuid-${++n}`);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('constructor', () => {
  it('rejects empty and whitespace-only tenant ids', () => {
    const { db } = makeDb();
    expect(() => new DynamicGroupStore(db, '')).toThrow('group_tenant_required');
    expect(() => new DynamicGroupStore(db, '   ')).toThrow('group_tenant_required');
    expect(new DynamicGroupStore(db, 'x').tenantId).toBe('x');
  });
});

describe('prepareAudit', () => {
  const input = {
    id: 'audit-1',
    userId: USER,
    ruleVersion: 5,
    generation: 6,
    eventType: 'manual',
    detail: { a: 1 },
    createdAt: 42,
  };

  it('requires a publication context bound to the same tenant', async () => {
    const { db } = makeDb();
    await expect(new DynamicGroupStore(db, TENANT).prepareAudit(input)).rejects.toThrow(
      'group_audit_publication_context_required'
    );
    const other = { ...publication, source: { tenantId: 'other' } as never };
    await expect(new DynamicGroupStore(db, TENANT, other).prepareAudit(input)).rejects.toThrow(
      'group_audit_publication_context_required'
    );
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it('builds the exact core publication request from explicit inputs', async () => {
    const { db } = makeDb();
    prepareMock.mockResolvedValue('prepared');
    const result = await new DynamicGroupStore(db, TENANT, publication).prepareAudit(input);
    expect(result).toBe('prepared');
    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(prepareMock).toHaveBeenCalledWith(publication.env, db, {
      source: publication.source,
      tenantId: TENANT,
      sourceDataset: 'core.service_group_audit',
      logType: 'audit',
      eventAt: 42,
      expiresAt: null,
      overview: { action: 'manual', subject_id: USER },
      row: {
        id: 'audit-1',
        tenant_id: TENANT,
        user_id: USER,
        rule_version: 5,
        generation: 6,
        event_type: 'manual',
        detail_json: '{"a":1}',
        created_at: 42,
      },
    });
  });

  it('defaults id and timestamp and maps an empty user id to a null subject', async () => {
    const { db } = makeDb();
    prepareMock.mockResolvedValue({});
    await new DynamicGroupStore(db, TENANT, publication).prepareAudit({
      userId: '',
      ruleVersion: 1,
      generation: 0,
      eventType: 'evaluation',
      detail: {},
    });
    const arg = auditArgOf(prepareMock);
    expect(arg.eventAt).toBe(NOW);
    expect(arg.overview).toEqual({ action: 'evaluation', subject_id: null });
    expect(arg.row.id).toBe('uuid-1');
    expect(arg.row.created_at).toBe(NOW);
    expect(arg.row.user_id).toBe('');
    expect(arg.row.detail_json).toBe('{}');
  });
});

describe('finishAudit', () => {
  const prepared = (dispatch = vi.fn(async () => undefined)) =>
    ({ publicationId: 'pub-9', dispatch }) as never;

  it('dispatches once the publication is committed or published', async () => {
    for (const s of ['committed', 'published']) {
      const { db, raw, state } = makeDb({ publicationState: s });
      const dispatch = vi.fn(async () => undefined);
      await new DynamicGroupStore(db, TENANT).finishAudit(prepared(dispatch));
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(raw.queryOne).toHaveBeenCalledWith(
        'SELECT state FROM log_iceberg_core_publications WHERE id=? AND tenant_id=?',
        ['pub-9', TENANT],
        PRIMARY
      );
      expect(state.calls).toHaveLength(1);
    }
  });

  it('throws the default or supplied conflict code without dispatching otherwise', async () => {
    for (const s of [null, 'aborted', 'prepared', 'COMMITTED']) {
      const { db } = makeDb({ publicationState: s });
      const dispatch = vi.fn(async () => undefined);
      const store = new DynamicGroupStore(db, TENANT);
      await expect(store.finishAudit(prepared(dispatch))).rejects.toThrow('group_version_conflict');
      await expect(store.finishAudit(prepared(dispatch), 'custom_code')).rejects.toThrow(
        'custom_code'
      );
      expect(dispatch).not.toHaveBeenCalled();
    }
  });
});

describe('catalog', () => {
  it('returns null when absent and queries with the tenant under primary consistency', async () => {
    const { db, raw } = makeDb({ catalogRow: null });
    expect(await new DynamicGroupStore(db, TENANT).catalog()).toBeNull();
    expect(raw.queryOne).toHaveBeenCalledWith(
      'SELECT revision, plan_json FROM service_group_catalog WHERE tenant_id = ?',
      [TENANT],
      PRIMARY
    );
  });

  it('parses the plan and coerces the revision to a number', async () => {
    const { db } = makeDb({ catalogRow: { revision: '7', plan_json: JSON.stringify(plan) } });
    const catalog = await new DynamicGroupStore(db, TENANT).catalog();
    expect(catalog).toEqual({ revision: 7, plan });
  });

  it('rejects a plan stored for a different tenant', async () => {
    const other: GroupPlan = { ...plan, tenantId: 'other' };
    const { db } = makeDb({ catalogRow: { revision: 1, plan_json: JSON.stringify(other) } });
    await expect(new DynamicGroupStore(db, TENANT).catalog()).rejects.toThrow(
      'group_tenant_mismatch'
    );
  });
});

function sizedGroups(count: number, lastDescription: number): ServiceGroup[] {
  return Array.from({ length: count }, (_, i) =>
    group(`G${i}`, null, {
      displayName: 'n'.repeat(200),
      description: 'd'.repeat(i === count - 1 ? lastDescription : 2000),
    })
  );
}
const jsonBytes = (gs: ServiceGroup[]) =>
  new TextEncoder().encode(JSON.stringify(compileGroups(TENANT, gs, BUILTIN_GROUP_FIELDS))).length;

/** Finds a group set whose compiled plan serializes to exactly `target` bytes. */
function groupsWithPlanBytes(target: number): ServiceGroup[] {
  for (let count = 100; count <= 256; count++) {
    const empty = jsonBytes(sizedGroups(count, 0));
    if (empty + 2000 >= target) {
      const gs = sizedGroups(count, target - empty);
      expect(jsonBytes(gs)).toBe(target);
      return gs;
    }
  }
  throw new Error('cannot size groups');
}

describe('save', () => {
  it('rejects non-integer, negative and unsafe expected revisions before touching storage', async () => {
    const { db, state } = makeDb();
    const store = new DynamicGroupStore(db, TENANT);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      await expect(store.save(groups, BUILTIN_GROUP_FIELDS, bad, 'actor')).rejects.toThrow(
        'group_version_invalid'
      );
    }
    // Invalid input is reported before the (also invalid) groups are compiled.
    await expect(
      store.save([group('bad id', null)], BUILTIN_GROUP_FIELDS, -1, 'actor')
    ).rejects.toThrow('group_version_invalid');
    expect(state.calls).toHaveLength(0);
  });

  it('compiles groups before reading the catalog', async () => {
    const { db, state } = makeDb();
    await expect(
      new DynamicGroupStore(db, TENANT).save(
        [group('bad id', null)],
        BUILTIN_GROUP_FIELDS,
        3,
        'actor'
      )
    ).rejects.toThrow('group_identity_invalid');
    expect(state.calls).toHaveLength(0);
  });

  it('rejects when the stored revision differs from the expected one', async () => {
    for (const [row, expected] of [
      [null, 1],
      [{ revision: 3, plan_json: JSON.stringify(plan) }, 2],
      [{ revision: 3, plan_json: JSON.stringify(plan) }, 4],
      [{ revision: 3, plan_json: JSON.stringify(plan) }, 0],
    ] as const) {
      const { db, raw } = makeDb({ catalogRow: row });
      await expect(
        new DynamicGroupStore(db, TENANT).save(groups, BUILTIN_GROUP_FIELDS, expected, 'actor')
      ).rejects.toThrow('group_version_conflict');
      expect(raw.batch).not.toHaveBeenCalled();
    }
  });

  it('creates the first revision from an empty catalog with the exact batch', async () => {
    const { db, raw } = makeDb({ catalogRow: null });
    const result = await new DynamicGroupStore(db, TENANT).save(
      groups,
      BUILTIN_GROUP_FIELDS,
      0,
      'actor-1'
    );
    expect(result).toEqual({ revision: 1, plan });
    expect(raw.batch).toHaveBeenCalledTimes(1);
    const json = JSON.stringify(plan);
    expect(raw.batch.mock.calls[0][0]).toEqual([
      {
        sql: `INSERT INTO service_group_catalog(tenant_id, revision, plan_json, updated_at, write_token) VALUES (?, 0, '{}', ?, '') ON CONFLICT(tenant_id) DO NOTHING`,
        params: [TENANT, NOW],
      },
      {
        sql: 'UPDATE service_group_catalog SET revision = ?, plan_json = ?, updated_at = ?, write_token = ? WHERE tenant_id = ? AND revision = ?',
        params: [1, json, NOW, 'uuid-1', TENANT, 0],
      },
      {
        sql: `INSERT INTO service_group_revisions(tenant_id, revision, plan_json, actor_id, created_at) SELECT tenant_id, revision, plan_json, ?, ? FROM service_group_catalog WHERE tenant_id = ? AND write_token = ?`,
        params: ['actor-1', NOW, TENANT, 'uuid-1'],
      },
    ]);
    expect(raw.queryOne).toHaveBeenLastCalledWith(
      'SELECT write_token FROM service_group_catalog WHERE tenant_id = ?',
      [TENANT],
      PRIMARY
    );
  });

  it('increments from the existing revision', async () => {
    const { db, raw } = makeDb();
    const result = await new DynamicGroupStore(db, TENANT).save(
      groups,
      BUILTIN_GROUP_FIELDS,
      3,
      'a'
    );
    expect(result.revision).toBe(4);
    expect(raw.batch.mock.calls[0][0][1].params.slice(0, 1)).toEqual([4]);
    expect(raw.batch.mock.calls[0][0][1].params.slice(4)).toEqual([TENANT, 3]);
  });

  it('detects a lost write when the stored write token is not ours or missing', async () => {
    for (const token of ['someone-else', null] as const) {
      const { db } = makeDb({ writeToken: token });
      await expect(
        new DynamicGroupStore(db, TENANT).save(groups, BUILTIN_GROUP_FIELDS, 3, 'a')
      ).rejects.toThrow('group_version_conflict');
    }
  });

  it('enforces the 512 KiB catalog limit exactly', async () => {
    const limit = 512 * 1024;
    const atLimit = makeDb({ catalogRow: null });
    const ok = await new DynamicGroupStore(atLimit.db, TENANT).save(
      groupsWithPlanBytes(limit),
      BUILTIN_GROUP_FIELDS,
      0,
      'a'
    );
    expect(ok.revision).toBe(1);

    const over = makeDb({ catalogRow: null });
    await expect(
      new DynamicGroupStore(over.db, TENANT).save(
        groupsWithPlanBytes(limit + 1),
        BUILTIN_GROUP_FIELDS,
        0,
        'a'
      )
    ).rejects.toThrow('group_catalog_limit');
    expect(over.raw.batch).not.toHaveBeenCalled();
  });
});

describe('setManual', () => {
  const guard = 'EXISTS(SELECT 1 FROM service_group_catalog WHERE tenant_id=? AND revision=?)';

  it('rejects unknown, disabled and missing-catalog groups before auditing', async () => {
    const disabled = compileGroups(
      TENANT,
      [group('A', null, { enabled: false })],
      BUILTIN_GROUP_FIELDS
    );
    const cases = [
      makeDb({ catalogRow: null }),
      makeDb({ catalogRow: { revision: 3, plan_json: JSON.stringify(disabled) } }),
    ];
    for (const { db } of cases) {
      await expect(
        new DynamicGroupStore(db, TENANT, publication).setManual(USER, 'A', true, 'x')
      ).rejects.toThrow('group_not_found');
    }
    const { db } = makeDb();
    await expect(
      new DynamicGroupStore(db, TENANT, publication).setManual(USER, 'ZZ', true, 'x')
    ).rejects.toThrow('group_not_found');
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it('adds a membership with a catalog-revision guard and audits it', async () => {
    const { db, raw } = makeDb();
    const audit = makeAudit();
    prepareMock.mockResolvedValue(audit);
    await new DynamicGroupStore(db, TENANT, publication).setManual(USER, 'A', true, 'actor-9');

    expect(prepareMock.mock.calls[0].slice(0, 2)).toEqual([publication.env, db]);
    const arg = auditArgOf(prepareMock);
    expect(arg.eventAt).toBe(NOW);
    expect(arg.overview).toEqual({ action: 'manual', subject_id: USER });
    expect(arg.row).toMatchObject({
      user_id: USER,
      rule_version: 3,
      generation: 0,
      event_type: 'manual',
      detail_json: JSON.stringify({ actorId: 'actor-9', groupId: 'A', present: true }),
    });
    expect(audit.wrapBusinessBatch).toHaveBeenCalledWith(
      [
        {
          sql: `INSERT INTO service_group_manual(tenant_id,user_id,group_id) SELECT ?,?,? WHERE ${guard} ON CONFLICT(tenant_id,user_id,group_id) DO NOTHING`,
          params: [TENANT, USER, 'A', TENANT, 3],
        },
      ],
      {
        where: `${guard} AND EXISTS(SELECT 1 FROM service_group_manual WHERE tenant_id=? AND user_id=? AND group_id=?)`,
        params: [TENANT, 3, TENANT, USER, 'A'],
      }
    );
    expect(raw.batch).toHaveBeenCalledTimes(1);
    expect(audit.dispatch).toHaveBeenCalledTimes(1);
    expect(raw.queryOne).toHaveBeenLastCalledWith(
      'SELECT state FROM log_iceberg_core_publications WHERE id=? AND tenant_id=?',
      ['pub-1', TENANT],
      PRIMARY
    );
  });

  it('removes a membership with a NOT EXISTS verification guard', async () => {
    const { db } = makeDb();
    const audit = makeAudit();
    prepareMock.mockResolvedValue(audit);
    await new DynamicGroupStore(db, TENANT, publication).setManual(USER, 'A', false, 'actor-9');
    expect(audit.wrapBusinessBatch).toHaveBeenCalledWith(
      [
        {
          sql: `DELETE FROM service_group_manual WHERE tenant_id=? AND user_id=? AND group_id=? AND ${guard}`,
          params: [TENANT, USER, 'A', TENANT, 3],
        },
      ],
      {
        where: `${guard} AND NOT EXISTS(SELECT 1 FROM service_group_manual WHERE tenant_id=? AND user_id=? AND group_id=?)`,
        params: [TENANT, 3, TENANT, USER, 'A'],
      }
    );
    expect(JSON.parse(auditArgOf(prepareMock).row.detail_json)).toEqual({
      actorId: 'actor-9',
      groupId: 'A',
      present: false,
    });
  });

  it('only dispatches (no business batch) when the audit is already committed or published', async () => {
    for (const s of ['committed', 'published']) {
      const { db, raw } = makeDb();
      const audit = makeAudit(s);
      prepareMock.mockResolvedValue(audit);
      await new DynamicGroupStore(db, TENANT, publication).setManual(USER, 'A', true, 'x');
      expect(audit.dispatch).toHaveBeenCalledTimes(1);
      expect(raw.batch).not.toHaveBeenCalled();
      expect(audit.wrapBusinessBatch).not.toHaveBeenCalled();
    }
  });

  it('fails with a version conflict when the publication did not commit', async () => {
    const { db } = makeDb({ publicationState: 'aborted' });
    const audit = makeAudit();
    prepareMock.mockResolvedValue(audit);
    await expect(
      new DynamicGroupStore(db, TENANT, publication).setManual(USER, 'A', true, 'x')
    ).rejects.toThrow('group_version_conflict');
    expect(audit.dispatch).not.toHaveBeenCalled();
  });
});
