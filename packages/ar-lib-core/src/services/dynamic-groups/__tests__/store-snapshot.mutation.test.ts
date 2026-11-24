import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prepareMock = vi.hoisted(() => vi.fn());
vi.mock('../../log-iceberg-core-publication', () => ({
  prepareCoreLogPublication: prepareMock,
}));

import { DynamicGroupStore } from '../store';
import { compileGroups } from '../engine';
import { BUILTIN_GROUP_FIELDS, type Evaluation } from '../model';
import { PRIMARY, TENANT, USER, V, attr, group, makeDb, makeReader, plan } from './store.fixtures';

const evaluation: Evaluation = {
  nodes: {},
  groups: { A: { member: true, dynamic: true, sources: [] } },
  evaluatedNodes: 1,
};

const row = (over: Record<string, unknown> = {}) => ({
  route_version: '',
  rule_version: 3,
  core_version: 1,
  pii_version: 2,
  metadata_version: 3,
  epoch: 4,
  generation: 5,
  evaluated_at: 111,
  result_json: JSON.stringify(evaluation),
  error_code: null,
  ...over,
});

beforeEach(() => {
  prepareMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('snapshot', () => {
  it('rejects readers for another tenant or subject without any query', async () => {
    const { db, state } = makeDb();
    const store = new DynamicGroupStore(db, TENANT);
    const { reader } = makeReader([V]);
    await expect(store.snapshot(USER, { ...reader, tenantId: 'other' })).rejects.toThrow(
      'group_tenant_or_subject_mismatch'
    );
    await expect(store.snapshot(USER, { ...reader, userId: 'other' })).rejects.toThrow(
      'group_tenant_or_subject_mismatch'
    );
    await expect(store.snapshot('other', reader)).rejects.toThrow(
      'group_tenant_or_subject_mismatch'
    );
    expect(state.calls).toHaveLength(0);
  });

  it('reports a pending snapshot with sentinel versions when nothing was evaluated', async () => {
    const { db, raw } = makeDb({ resultRow: null });
    const { reader, version } = makeReader([V]);
    const snap = await new DynamicGroupStore(db, TENANT).snapshot(USER, reader);
    expect(snap).toStrictEqual({
      tenantId: TENANT,
      userId: USER,
      ruleVersion: 0,
      inputVersion: { core: -1, pii: -1, metadata: -1, epoch: -1 },
      generation: 0,
      evaluatedAt: null,
      freshness: 'pending',
      evaluation: null,
      error: null,
    });
    expect(version).not.toHaveBeenCalled();
    expect(raw.queryOne).toHaveBeenCalledWith(
      'SELECT * FROM service_group_results WHERE tenant_id = ? AND user_id = ?',
      [TENANT, USER],
      PRIMARY
    );
  });

  it('maps every stored column and is fresh only when rule and input versions match', async () => {
    const { db } = makeDb({ resultRow: row({ route_version: 'r1' }) });
    const { reader, version } = makeReader([{ ...V, route: 'r1' }]);
    const snap = await new DynamicGroupStore(db, TENANT).snapshot(USER, reader);
    expect(version).toHaveBeenCalledTimes(1);
    expect(snap.freshness).toBe('fresh');
    expect(snap.ruleVersion).toBe(3);
    expect(snap.inputVersion).toStrictEqual({
      route: 'r1',
      core: 1,
      pii: 2,
      metadata: 3,
      epoch: 4,
    });
    expect(snap.generation).toBe(5);
    expect(snap.evaluatedAt).toBe(111);
    expect(snap.evaluation).toEqual(evaluation);
    expect(snap.error).toBeNull();
  });

  it('coerces numeric strings and keeps a stored evaluated_at of 0', async () => {
    const { db } = makeDb({
      resultRow: row({
        rule_version: '3',
        core_version: '1',
        pii_version: '2',
        metadata_version: '3',
        epoch: '4',
        generation: '9',
        evaluated_at: 0,
      }),
    });
    const { reader } = makeReader([V]);
    const snap = await new DynamicGroupStore(db, TENANT).snapshot(USER, reader);
    expect(snap.freshness).toBe('fresh');
    expect(snap.generation).toBe(9);
    expect(snap.evaluatedAt).toBe(0);
    expect(snap.inputVersion).toStrictEqual(V);
  });

  it('treats an absent route and an empty route as equal', async () => {
    const { db } = makeDb({ resultRow: row() });
    const { reader } = makeReader([{ ...V, route: '' }]);
    expect((await new DynamicGroupStore(db, TENANT).snapshot(USER, reader)).freshness).toBe(
      'fresh'
    );
  });

  it.each([
    ['core', { ...V, core: 9 }],
    ['pii', { ...V, pii: 9 }],
    ['metadata', { ...V, metadata: 9 }],
    ['epoch', { ...V, epoch: 9 }],
    ['route added', { ...V, route: 'r2' }],
  ])('is stale when the current %s differs', async (_name, current) => {
    const { db } = makeDb({ resultRow: row() });
    const { reader } = makeReader([current]);
    const snap = await new DynamicGroupStore(db, TENANT).snapshot(USER, reader);
    expect(snap.freshness).toBe('stale');
    expect(snap.error).toBeNull();
  });

  it('is stale when the stored route differs from the current one', async () => {
    const { db } = makeDb({ resultRow: row({ route_version: 'r1' }) });
    const { reader } = makeReader([V]);
    expect((await new DynamicGroupStore(db, TENANT).snapshot(USER, reader)).freshness).toBe(
      'stale'
    );
  });

  it('is stale without consulting inputs when the catalog is missing or at another revision', async () => {
    for (const catalogRow of [null, { revision: 4, plan_json: JSON.stringify(plan) }]) {
      const { db } = makeDb({ resultRow: row(), catalogRow });
      const { reader, version } = makeReader([V]);
      const snap = await new DynamicGroupStore(db, TENANT).snapshot(USER, reader);
      expect(snap.freshness).toBe('stale');
      expect(snap.explanation).toBeUndefined();
      expect(version).not.toHaveBeenCalled();
    }
  });

  it('is pending (not fresh) without a stored result even when versions match', async () => {
    const { db } = makeDb({ resultRow: row({ result_json: null }) });
    const { reader, version } = makeReader([V]);
    const snap = await new DynamicGroupStore(db, TENANT).snapshot(USER, reader);
    expect(snap.freshness).toBe('pending');
    expect(snap.evaluation).toBeNull();
    expect(version).not.toHaveBeenCalled();
  });

  it('fails on a stored error code without reading input versions', async () => {
    const { db } = makeDb({ resultRow: row({ error_code: 'group_input_changed' }) });
    const { reader, version } = makeReader([V]);
    const snap = await new DynamicGroupStore(db, TENANT).snapshot(USER, reader);
    expect(snap.freshness).toBe('failed');
    expect(snap.error).toBe('group_input_changed');
    expect(version).not.toHaveBeenCalled();
  });

  it('keeps group_* error codes thrown by the reader and hides everything else', async () => {
    const cases: Array<[unknown, string]> = [
      [new Error('group_input_gone'), 'group_input_gone'],
      [new Error('group_'), 'group_input_unavailable'],
      [new Error('xgroup_a'), 'group_input_unavailable'],
      [new Error('group_a1'), 'group_input_unavailable'],
      [new Error('group_A'), 'group_input_unavailable'],
      [new Error('group_a '), 'group_input_unavailable'],
      [new Error('boom'), 'group_input_unavailable'],
      ['group_input_gone', 'group_input_unavailable'],
    ];
    for (const [thrown, code] of cases) {
      const { db } = makeDb({ resultRow: row() });
      const { reader } = makeReader([V], {
        version: vi.fn(async () => {
          throw thrown;
        }),
      });
      const snap = await new DynamicGroupStore(db, TENANT).snapshot(USER, reader);
      expect(snap.freshness).toBe('failed');
      expect(snap.error).toBe(code);
    }
  });

  describe('explanation', () => {
    const groups = [
      group('A', attr('email_domain', 'example.com')),
      group('B', { op: 'member', groupId: 'A' }),
      group('C', {
        op: 'all',
        args: [
          { op: 'member', groupId: 'A' },
          { op: 'attribute', field: 'country', compare: 'in', value: ['JP', 'US'] },
        ],
      }),
    ];
    const plan2 = compileGroups(TENANT, groups, BUILTIN_GROUP_FIELDS);
    const entries = Object.entries(plan2.nodes);
    const nodeOf = (pred: (e: (typeof entries)[number][1]) => boolean) => {
      const found = entries.filter(([, def]) => pred(def));
      expect(found).toHaveLength(1);
      return found[0][0];
    };

    it('describes attribute, member and composite nodes and defaults missing results to unknown', async () => {
      const emailNode = nodeOf(
        (d) =>
          d.expression.op === 'attribute' &&
          'field' in d.expression &&
          d.expression.field === 'email_domain'
      );
      const countryNode = nodeOf(
        (d) =>
          d.expression.op === 'attribute' &&
          'field' in d.expression &&
          d.expression.field === 'country'
      );
      const memberNode = nodeOf((d) => d.expression.op === 'member');
      const allNode = nodeOf((d) => d.expression.op === 'all');
      const stored: Evaluation = {
        nodes: { [emailNode]: true, [memberNode]: false, [allNode]: 'unknown' },
        groups: {},
        evaluatedNodes: 3,
      };
      const { db } = makeDb({
        catalogRow: { revision: 3, plan_json: JSON.stringify(plan2) },
        resultRow: row({ result_json: JSON.stringify(stored) }),
      });
      const { reader } = makeReader([V]);
      const snap = await new DynamicGroupStore(db, TENANT).snapshot(USER, reader);
      expect(snap.explanation).toHaveLength(entries.length);
      const byNode = Object.fromEntries((snap.explanation ?? []).map((e) => [e.node, e]));
      expect(byNode[emailNode]).toStrictEqual({
        node: emailNode,
        operator: 'attribute',
        field: 'email_domain',
        compare: 'eq',
        expected: 'example.com',
        children: plan2.nodes[emailNode].children,
        result: true,
      });
      expect(byNode[countryNode]).toStrictEqual({
        node: countryNode,
        operator: 'attribute',
        field: 'country',
        compare: 'in',
        expected: ['JP', 'US'],
        children: plan2.nodes[countryNode].children,
        result: 'unknown',
      });
      expect(byNode[memberNode]).toStrictEqual({
        node: memberNode,
        operator: 'member',
        children: plan2.nodes[memberNode].children,
        groupId: 'A',
        result: false,
      });
      expect(byNode[allNode]).toStrictEqual({
        node: allNode,
        operator: 'all',
        children: plan2.nodes[allNode].children,
        result: 'unknown',
      });
      expect(plan2.nodes[allNode].children).toHaveLength(2);
    });

    it('omits the explanation without a stored evaluation', async () => {
      const { db } = makeDb({ resultRow: row({ result_json: null }) });
      const { reader } = makeReader([V]);
      const snap = await new DynamicGroupStore(db, TENANT).snapshot(USER, reader);
      expect('explanation' in snap).toBe(false);
    });
  });
});
