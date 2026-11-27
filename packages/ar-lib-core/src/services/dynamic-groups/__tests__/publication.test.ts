import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';
import { sqliteAdapter } from '../../../repositories/__tests__/sqlite-core-schema';
import { resolveSubjectGroups } from '../../group-membership';
import { compileGroups } from '../engine';
import { BUILTIN_GROUP_FIELDS, type Evaluation, type ServiceGroup } from '../model';
import { DynamicGroupStore, type GroupInputReader, type InputVersion } from '../store';
import { SavedGroupInputReader } from '../inputs';
import {
  DYNAMIC_MEMBERSHIP_FRESHNESS_SECONDS,
  dynamicFreshnessWindow,
  dynamicMembershipSourceRef,
  evaluateAndPublishDynamicMemberships,
  expireDynamicMembershipsAfterFailure,
  markDynamicMembershipsStale,
  parseDynamicMembershipSourceRef,
  publishDynamicMemberships,
  resolveDynamicFreshnessSeconds,
  retryPendingDynamicInvalidations,
  expireDynamicGroupMemberships,
} from '../publication';

const DYNAMIC_MEMBERSHIP_RENEW_BEFORE_SECONDS = DYNAMIC_MEMBERSHIP_FRESHNESS_SECONDS / 2;
import { dynamicGroupKey, removeDynamicGroup, syncDynamicGroupCatalog } from '../canonical';

const TENANT = 't1';
const USER = 'u1';
const NOW = 1_800_000_000;
const VERSION: InputVersion = { core: 1, pii: 1, metadata: 1, epoch: 0 };

const group = (id: string, extra: Partial<ServiceGroup> = {}): ServiceGroup => ({
  id,
  tenantId: TENANT,
  key: id.toLowerCase(),
  displayName: id,
  description: '',
  enabled: true,
  condition: null,
  ...extra,
});

function kv() {
  const values = new Map<string, string>();
  const put = vi.fn(async (key: string, value: string) => void values.set(key, value));
  return {
    cache: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put,
    } as unknown as KVNamespace,
    put,
  };
}

describe('dynamic membership publication', () => {
  let meta: ReturnType<typeof sqliteAdapter>;
  let account: ReturnType<typeof sqliteAdapter>;
  let store: DynamicGroupStore;
  let version: InputVersion;
  const reader: GroupInputReader = {
    tenantId: TENANT,
    userId: USER,
    version: async () => version,
    load: async () => ({ attributes: {}, sources: {} }),
  };
  const groups = [group('A'), group('B'), group('C')];

  async function saveCatalog(list = groups, expected = 0) {
    return store.save(list, BUILTIN_GROUP_FIELDS, expected, 'actor');
  }
  /** Commits a result row as a finished evaluation would. */
  function commit(
    generation: number,
    results: Record<string, { member: boolean; dynamic: boolean }>,
    ruleVersion = 1,
    committed: InputVersion = VERSION,
    inputValidUntil?: number
  ) {
    const evaluation: Evaluation = {
      ...(inputValidUntil === undefined ? {} : { inputValidUntil }),
      nodes: {},
      evaluatedNodes: 0,
      groups: Object.fromEntries(
        Object.entries(results).map(([id, r]) => [
          id,
          { member: r.member, dynamic: r.dynamic, sources: r.dynamic ? ['dynamic'] : [] },
        ])
      ),
    };
    meta.db
      .prepare(
        `INSERT INTO service_group_results(tenant_id, user_id, generation, rule_version, core_version,
          pii_version, metadata_version, epoch, result_json, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, user_id) DO UPDATE SET generation = excluded.generation,
          rule_version = excluded.rule_version, result_json = excluded.result_json,
          core_version = excluded.core_version, pii_version = excluded.pii_version,
          metadata_version = excluded.metadata_version, epoch = excluded.epoch`
      )
      .run(
        TENANT,
        USER,
        generation,
        ruleVersion,
        committed.core,
        committed.pii,
        committed.metadata,
        committed.epoch,
        JSON.stringify(evaluation),
        NOW
      );
  }
  const rows = () =>
    account.db
      .prepare(
        `SELECT group_id, source_ref, lifecycle_state, stale_after FROM group_memberships
          WHERE tenant_id = ? AND subject_id = ? AND assignment_source = 'dynamic' ORDER BY group_id`
      )
      .all(TENANT, USER) as Array<{
      group_id: string;
      source_ref: string;
      lifecycle_state: string;
      stale_after: number;
    }>;
  const publication = () =>
    account.db
      .prepare(
        `SELECT generation, invalidation_pending FROM dynamic_membership_publications
          WHERE tenant_id = ? AND subject_id = ?`
      )
      .get(TENANT, USER) as { generation: string; invalidation_pending: number } | undefined;
  const inputRevision = () =>
    (
      account.db
        .prepare('SELECT revision FROM service_group_inputs WHERE tenant_id = ? AND user_id = ?')
        .get(TENANT, USER) as { revision: number } | undefined
    )?.revision ?? 0;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    meta = sqliteAdapter();
    account = sqliteAdapter();
    store = new DynamicGroupStore(meta.adapter, TENANT);
    version = { ...VERSION };
    // The subject's account: publication is fenced by it being active.
    account.db
      .prepare(
        `INSERT INTO identity_accounts(id, tenant_id, legacy_user_id, account_type, lifecycle_state,
          registration_state, directory_publication_state, created_at, updated_at)
         VALUES ('acc', ?, ?, 'user', 'active', 'registered', 'active', 1, 1)`
      )
      .run(TENANT, USER);
    await saveCatalog();
  });
  afterEach(() => {
    meta.db.close();
    account.db.close();
    vi.useRealTimers();
  });

  it('encodes generation first so string order is generation order', () => {
    expect(dynamicMembershipSourceRef(7, 3)).toBe('0000000000000007:3');
    expect(dynamicMembershipSourceRef(10, 1) > dynamicMembershipSourceRef(9, 99)).toBe(true);
    expect(parseDynamicMembershipSourceRef('0000000000000010:1')).toEqual({
      generation: 10,
      ruleVersion: 1,
    });
    expect(parseDynamicMembershipSourceRef('10:1')).toBeNull();
  });

  it('publishes only dynamic === true groups, with stale_after and a cache invalidation', async () => {
    const { cache, put } = kv();
    commit(1, {
      A: { member: true, dynamic: true },
      B: { member: true, dynamic: false }, // SCIM: not a dynamic row
      C: { member: false, dynamic: false },
    });
    const result = await publishDynamicMemberships(store, reader, account.adapter, { cache });
    expect(result).toEqual({ status: 'published', generation: 1, groupIds: ['A'] });
    expect(rows()).toEqual([
      {
        group_id: 'A',
        source_ref: dynamicMembershipSourceRef(1, 1),
        lifecycle_state: 'active',
        stale_after: NOW + DYNAMIC_MEMBERSHIP_FRESHNESS_SECONDS,
      },
    ]);
    expect(put).toHaveBeenCalledWith(
      `rbac:v2:subject-version:${TENANT}:${USER}`,
      expect.any(String)
    );
    const effective = await resolveSubjectGroups(
      { metadata: meta.adapter, account: account.adapter },
      TENANT,
      USER,
      NOW
    );
    expect([...effective.directGroupIds]).toEqual(['A']);
  });

  it('lets a row derived from an expiring manual membership expire with it', async () => {
    // D derives from a manual membership that ends at NOW + 100.
    commit(1, { A: { member: true, dynamic: true } }, 1, VERSION, NOW + 100);
    expect((await store.snapshot(USER, reader)).freshness).toBe('fresh');
    await publishDynamicMemberships(store, reader, account.adapter);
    expect(rows()).toEqual([
      expect.objectContaining({ group_id: 'A', lifecycle_state: 'active', stale_after: NOW + 100 }),
    ]);
    // Published again before then: still capped, and current (not rewritten each time).
    vi.setSystemTime((NOW + 90) * 1000);
    expect((await publishDynamicMemberships(store, reader, account.adapter)).status).toBe(
      'current'
    );
    // Past it, the result is not fresh: the scheduler evaluates again, the rows stop granting.
    vi.setSystemTime((NOW + 101) * 1000);
    expect((await store.snapshot(USER, reader)).freshness).toBe('stale');
    expect((await publishDynamicMemberships(store, reader, account.adapter)).status).toBe(
      'not_fresh'
    );
    expect(rows()[0].stale_after).toBeLessThanOrEqual(NOW + 101);
  });

  it('evaluates again once a manual membership that starts later starts', async () => {
    // Not yet a member; the manual membership starts at NOW + 100.
    commit(1, { A: { member: false, dynamic: false } }, 1, VERSION, NOW + 100);
    expect((await store.snapshot(USER, reader)).freshness).toBe('fresh');
    vi.setSystemTime((NOW + 100) * 1000);
    expect((await store.snapshot(USER, reader)).freshness).toBe('stale');
  });

  it('replaces the previous generation and keeps rows of other sources', async () => {
    account.db
      .prepare(
        `INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source,
          source_ref, created_at, updated_at) VALUES ('m1', ?, 'A', ?, 'manual', '', 1, 1)`
      )
      .run(TENANT, USER);
    commit(1, { A: { member: true, dynamic: true }, B: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter);
    commit(2, { A: { member: true, dynamic: false }, B: { member: true, dynamic: true } });
    const result = await publishDynamicMemberships(store, reader, account.adapter);
    expect(result.status).toBe('published');
    expect(rows().map((r) => [r.group_id, r.source_ref])).toEqual([
      ['B', dynamicMembershipSourceRef(2, 1)],
    ]);
    expect(
      account.db
        .prepare(`SELECT COUNT(*) AS n FROM group_memberships WHERE assignment_source = 'manual'`)
        .get()
    ).toEqual({ n: 1 });
  });

  it('refuses to publish a generation older than the one already published', async () => {
    commit(5, { A: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter);
    commit(4, { B: { member: true, dynamic: true } });
    const result = await publishDynamicMemberships(store, reader, account.adapter);
    expect(result.status).toBe('superseded');
    expect(rows().map((r) => [r.group_id, r.source_ref])).toEqual([
      ['A', dynamicMembershipSourceRef(5, 1)],
    ]);
  });

  it('expires the rows at once, without republishing, when the result is not fresh', async () => {
    const { cache, put } = kv();
    commit(1, { A: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter);
    vi.setSystemTime((NOW + 100) * 1000);
    version = { ...VERSION, pii: 2 }; // an input changed: re-evaluation pending
    const result = await publishDynamicMemberships(store, reader, account.adapter, { cache });
    expect(result.status).toBe('not_fresh');
    expect(rows()).toEqual([
      expect.objectContaining({
        group_id: 'A',
        source_ref: dynamicMembershipSourceRef(1, 1),
        stale_after: NOW + 100,
      }),
    ]);
    expect(put).toHaveBeenCalledWith(
      `rbac:v2:subject-version:${TENANT}:${USER}`,
      expect.any(String)
    );
    const effective = await resolveSubjectGroups(
      { metadata: meta.adapter, account: account.adapter },
      TENANT,
      USER,
      NOW + 100
    );
    expect(effective.directGroupIds.size).toBe(0);
  });

  it('expires only generations up to the last known one after a failed evaluation', async () => {
    commit(1, { A: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter);
    // A newer generation's row (published by a newer evaluation) is left alone.
    account.db
      .prepare(
        `INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source,
          source_ref, stale_after, created_at, updated_at) VALUES ('n', ?, 'B', ?, 'dynamic', ?, ?, 1, 1)`
      )
      .run(TENANT, USER, dynamicMembershipSourceRef(2, 1), NOW + 999);
    await expireDynamicMembershipsAfterFailure(store, account.adapter, USER);
    expect(rows().map((r) => [r.group_id, r.stale_after])).toEqual([
      ['A', NOW],
      ['B', NOW + 999],
    ]);
  });

  it('expires the rows when the evaluation throws, and passes the error on', async () => {
    commit(1, { A: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter);
    const failing = {
      ...reader,
      core: account.adapter,
    } as unknown as SavedGroupInputReader;
    vi.spyOn(store, 'evaluate').mockRejectedValueOnce(new Error('group_input_unavailable'));
    await expect(evaluateAndPublishDynamicMemberships(store, failing)).rejects.toThrow(
      'group_input_unavailable'
    );
    expect(rows()[0].stale_after).toBe(NOW);
  });

  it('keeps the newest generation on record across an empty publication', async () => {
    commit(1, { A: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter);
    commit(2, { A: { member: true, dynamic: false } });
    expect((await publishDynamicMemberships(store, reader, account.adapter)).status).toBe(
      'published'
    );
    // No membership row at all (never a row without a group), the generation on record.
    expect(rows()).toEqual([]);
    // No claims cache binding in this call: the invalidation stays pending.
    expect(publication()).toEqual({
      generation: dynamicMembershipSourceRef(2, 1),
      invalidation_pending: 1,
    });
    expect((await publishDynamicMemberships(store, reader, account.adapter)).status).toBe(
      'current'
    );
    // A late publication of generation 1 is refused: generation 2 is on record.
    commit(1, { A: { member: true, dynamic: true } });
    expect((await publishDynamicMemberships(store, reader, account.adapter)).status).toBe(
      'superseded'
    );
    expect(rows()).toEqual([]);
    expect(
      account.db.prepare(`SELECT COUNT(*) AS n FROM group_memberships WHERE group_id = ''`).get()
    ).toEqual({ n: 0 });
  });

  it('expires a changed rule group rows at once and invalidates their subjects', async () => {
    commit(1, { A: { member: true, dynamic: true }, B: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter);
    const { cache, put } = kv();
    expect(await expireDynamicGroupMemberships(account.adapter, TENANT, 'A', { cache })).toEqual([
      USER,
    ]);
    expect(rows().map((r) => [r.group_id, r.stale_after])).toEqual([
      ['A', NOW],
      ['B', NOW + DYNAMIC_MEMBERSHIP_FRESHNESS_SECONDS],
    ]);
    expect(put).toHaveBeenCalledWith(
      `rbac:v2:subject-version:${TENANT}:${USER}`,
      expect.any(String)
    );
    expect(await expireDynamicGroupMemberships(account.adapter, TENANT, 'A', { cache })).toEqual(
      []
    );
    expect(publication()?.invalidation_pending).toBe(0);
  });

  it('records the pending invalidation with the group expiry itself (KV down)', async () => {
    commit(1, { A: { member: true, dynamic: true } });
    const { cache } = kv();
    await publishDynamicMemberships(store, reader, account.adapter, { cache });
    expect(publication()?.invalidation_pending).toBe(0);
    const failing = {
      put: vi.fn(async () => {
        throw new Error('kv down');
      }),
    } as unknown as KVNamespace;
    await expireDynamicGroupMemberships(account.adapter, TENANT, 'A', { cache: failing });
    expect(publication()?.invalidation_pending).toBe(1);
    expect(rows()[0].stale_after).toBe(NOW);
  });

  it('clears a pending mark only for the generation it invalidated', async () => {
    commit(1, { A: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter);
    // A newer generation recorded meanwhile (by another worker) stays pending.
    const put = vi.fn(async () => {
      account.db.exec(
        `UPDATE dynamic_membership_publications SET generation = '${dynamicMembershipSourceRef(2, 1)}'`
      );
    });
    const cache = { put } as unknown as KVNamespace;
    await retryPendingDynamicInvalidations(account.adapter, TENANT, { cache });
    expect(put).toHaveBeenCalled();
    expect(publication()?.invalidation_pending).toBe(1);
  });

  it('expires rows found without a generation on record, then publishes the first one', async () => {
    // Rows restored without their record (the record is rebuilt, not restored).
    account.db
      .prepare(
        `INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source,
          source_ref, stale_after, created_at, updated_at) VALUES ('r', ?, 'B', ?, 'dynamic', ?, ?, 1, 1)`
      )
      .run(TENANT, USER, dynamicMembershipSourceRef(9, 1), NOW + 999);
    commit(1, { A: { member: true, dynamic: true } });
    const markStaleWrites: string[] = [];
    const batch = account.adapter.batch.bind(account.adapter);
    vi.spyOn(account.adapter, 'batch').mockImplementation(async (statements) => {
      if (statements.some((s) => s.sql.includes('UPDATE group_memberships SET stale_after')))
        markStaleWrites.push('stale');
      return batch(statements);
    });
    expect((await publishDynamicMemberships(store, reader, account.adapter)).status).toBe(
      'published'
    );
    expect(markStaleWrites).toEqual(['stale']);
    expect(rows().map((r) => [r.group_id, r.source_ref])).toEqual([
      ['A', dynamicMembershipSourceRef(1, 1)],
    ]);
    expect(publication()?.generation).toBe(dynamicMembershipSourceRef(1, 1));
  });

  it('writes the rows again at once when the freshness window was shortened', async () => {
    commit(1, { A: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter);
    expect(rows()[0].stale_after).toBe(NOW + DYNAMIC_MEMBERSHIP_FRESHNESS_SECONDS);
    const result = await publishDynamicMemberships(store, reader, account.adapter, {
      freshnessSeconds: 3600,
    });
    expect(result.status).toBe('published');
    expect(rows()[0]).toMatchObject({
      source_ref: dynamicMembershipSourceRef(1, 1),
      stale_after: NOW + 3600,
    });
    expect(
      (await publishDynamicMemberships(store, reader, account.adapter, { freshnessSeconds: 3600 }))
        .status
    ).toBe('current');
  });

  it('refuses an older generation also after the rows were deleted', async () => {
    commit(3, { A: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter);
    account.db.exec(`DELETE FROM group_memberships`); // a group removed, say
    commit(2, { B: { member: true, dynamic: true } });
    expect((await publishDynamicMemberships(store, reader, account.adapter)).status).toBe(
      'superseded'
    );
    expect(rows()).toEqual([]);
  });

  it('publishes nothing for an account that is not active', async () => {
    account.db.exec(`UPDATE identity_accounts SET lifecycle_state = 'deleting'`);
    commit(1, { A: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter);
    expect(rows()).toEqual([]);
  });

  it('leaves out groups decided by a self-writable field while they carry roles', async () => {
    // The field is on the registration form today; the plan was saved without the mark (an
    // older plan): the mark is read fresh at publication.
    meta.db.exec(`INSERT INTO custom_claim_schemas(id, tenant_id, field_key, display_label,
      field_type, is_active, operation_status, schema_version, show_on_registration, created_at,
      updated_at) VALUES ('${TENANT}:team', '${TENANT}', 'team', 'Team', 'string', 1, 'active', 1,
      1, 1, 1)`);
    const fields = {
      ...BUILTIN_GROUP_FIELDS,
      'custom.team': { type: 'string' as const, schemaId: `${TENANT}:team`, schemaVersion: 1 },
    };
    const teamGroup = group('T', {
      condition: { op: 'attribute', field: 'custom.team', compare: 'eq', value: 'x' },
    });
    const referencing = group('R', { condition: { op: 'member', groupId: 'T' } });
    await store.save([...groups, teamGroup, referencing], fields, 1, 'actor');
    commit(
      1,
      {
        A: { member: true, dynamic: true },
        T: { member: true, dynamic: true },
        R: { member: true, dynamic: true },
      },
      2
    );
    // No roles yet: published.
    expect((await publishDynamicMemberships(store, reader, account.adapter)).groupIds).toEqual([
      'A',
      'R',
      'T',
    ]);
    // A role on R: R (which depends on the self-writable field through T) is left out.
    meta.db
      .exec(`INSERT INTO group_role_assignments(id, tenant_id, group_id, role_id, created_at, updated_at)
      VALUES ('g', '${TENANT}', 'R', 'reader', 1, 1)`);
    commit(
      2,
      {
        A: { member: true, dynamic: true },
        T: { member: true, dynamic: true },
        R: { member: true, dynamic: true },
      },
      2
    );
    const result = await publishDynamicMemberships(store, reader, account.adapter);
    expect(result.groupIds).toEqual(['A', 'T']);
    expect(
      rows()
        .filter((r) => r.lifecycle_state === 'active')
        .map((r) => r.group_id)
    ).toEqual(['A', 'T']);
  });

  it('makes the rows stale when the re-read after writing fails', async () => {
    commit(1, { A: { member: true, dynamic: true } });
    const snapshot = store.snapshot.bind(store);
    vi.spyOn(store, 'snapshot')
      .mockImplementationOnce(snapshot)
      .mockRejectedValueOnce(new Error('read failed'));
    const result = await publishDynamicMemberships(store, reader, account.adapter);
    expect(result.status).toBe('not_fresh');
    expect(rows()[0].stale_after).toBe(NOW);
  });

  it('keeps a failed cache invalidation pending until one succeeds', async () => {
    commit(1, { A: { member: true, dynamic: true } });
    const warn = vi.fn();
    const failing = {
      put: vi.fn(async () => {
        throw new Error('kv down');
      }),
    } as unknown as KVNamespace;
    const result = await publishDynamicMemberships(store, reader, account.adapter, {
      cache: failing,
      log: { warn },
    });
    expect(result.status).toBe('published');
    expect(warn).toHaveBeenCalled();
    expect(publication()?.invalidation_pending).toBe(1);
    // The rows stand; the reconcile's pending pass invalidates, whatever the rows.
    expect(rows()[0].stale_after).toBe(NOW + DYNAMIC_MEMBERSHIP_FRESHNESS_SECONDS);
    expect(
      await retryPendingDynamicInvalidations(account.adapter, TENANT, { cache: failing })
    ).toEqual([]);
    const { cache, put } = kv();
    expect(await retryPendingDynamicInvalidations(account.adapter, TENANT, { cache })).toEqual([
      USER,
    ]);
    expect(put).toHaveBeenCalledWith(
      `rbac:v2:subject-version:${TENANT}:${USER}`,
      expect.any(String)
    );
    expect(publication()?.invalidation_pending).toBe(0);
    expect(
      (await publishDynamicMemberships(store, reader, account.adapter, { cache })).status
    ).toBe('current');
  });

  it('retries a pending invalidation at the start of the next publication', async () => {
    commit(1, { A: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter); // no cache: nothing to do
    account.db.exec(`UPDATE dynamic_membership_publications SET invalidation_pending = 1`);
    const { cache, put } = kv();
    expect(
      (await publishDynamicMemberships(store, reader, account.adapter, { cache })).status
    ).toBe('current');
    expect(put).toHaveBeenCalled();
    expect(publication()?.invalidation_pending).toBe(0);
  });

  it('makes the last rows stale when a newer generation keeps arriving (round limit)', async () => {
    commit(1, { A: { member: true, dynamic: true } });
    let generation = 1;
    const snapshot = store.snapshot.bind(store);
    vi.spyOn(store, 'snapshot').mockImplementation(async (...args) => {
      const result = await snapshot(...args);
      return { ...result, generation: generation++ };
    });
    const result = await publishDynamicMemberships(store, reader, account.adapter);
    expect(result.status).toBe('not_fresh');
    expect(rows().every((r) => Number(r.stale_after) === NOW)).toBe(true);
  });

  it('reads the tenant freshness window, clamped to its bounds', async () => {
    const settings = (value: unknown) => ({
      SETTINGS: {
        get: vi.fn(async () => JSON.stringify({ 'groups.dynamic_freshness_seconds': value })),
      } as unknown as KVNamespace,
    });
    expect(await resolveDynamicFreshnessSeconds(undefined, TENANT)).toBe(86_400);
    expect(await resolveDynamicFreshnessSeconds({}, TENANT)).toBe(86_400);
    expect(await resolveDynamicFreshnessSeconds(settings(7200), TENANT)).toBe(7200);
    expect(await resolveDynamicFreshnessSeconds(settings(60), TENANT)).toBe(3600);
    expect(dynamicFreshnessWindow('x')).toBe(86_400);
    // An unreadable settings document: the minimum window, logged.
    const warn = vi.fn();
    const unreadable = {
      SETTINGS: {
        get: vi.fn(async () => {
          throw new Error('kv down');
        }),
      } as unknown as KVNamespace,
    };
    expect(await resolveDynamicFreshnessSeconds(unreadable, TENANT, { warn })).toBe(3600);
    expect(warn).toHaveBeenCalled();
    commit(1, { A: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter, { freshnessSeconds: 7200 });
    expect(rows()[0].stale_after).toBe(NOW + 7200);
  });

  it('is idempotent for the same generation and renews rows near their staleness', async () => {
    const { cache, put } = kv();
    commit(1, { A: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter, { cache });
    put.mockClear();
    expect(
      (await publishDynamicMemberships(store, reader, account.adapter, { cache })).status
    ).toBe('current');
    expect(put).not.toHaveBeenCalled();
    const later =
      NOW + DYNAMIC_MEMBERSHIP_FRESHNESS_SECONDS - DYNAMIC_MEMBERSHIP_RENEW_BEFORE_SECONDS;
    vi.setSystemTime(later * 1000);
    expect((await publishDynamicMemberships(store, reader, account.adapter)).status).toBe(
      'published'
    );
    expect(rows()[0].stale_after).toBe(later + DYNAMIC_MEMBERSHIP_FRESHNESS_SECONDS);
  });

  it('restores missing rows of a fresh result (a failed publication retried)', async () => {
    commit(1, { A: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter);
    account.db.exec(`DELETE FROM group_memberships`);
    expect((await publishDynamicMemberships(store, reader, account.adapter)).status).toBe(
      'published'
    );
    expect(rows().map((r) => r.group_id)).toEqual(['A']);
  });

  it('makes the rows just written stale when the inputs change while publishing', async () => {
    commit(1, { A: { member: true, dynamic: true } });
    let calls = 0;
    const racing: GroupInputReader = {
      ...reader,
      version: async () => (++calls > 1 ? { ...VERSION, core: 9 } : VERSION),
    };
    const result = await publishDynamicMemberships(store, racing, account.adapter);
    expect(result.status).toBe('not_fresh');
    expect(rows()[0].stale_after).toBe(NOW);
  });

  it('does not bump its own input revision; SCIM rows do', async () => {
    commit(1, { A: { member: true, dynamic: true } });
    const before = inputRevision();
    await publishDynamicMemberships(store, reader, account.adapter);
    await markDynamicMembershipsStale(account.adapter, TENANT, USER);
    expect(inputRevision()).toBe(before);
    account.db
      .prepare(
        `INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source,
          source_ref, created_at, updated_at) VALUES ('s1', ?, 'S', ?, 'scim', 'scim', 1, 1)`
      )
      .run(TENANT, USER);
    expect(inputRevision()).toBe(before + 1);
    account.db.exec(`UPDATE group_memberships SET lifecycle_state = 'revoked' WHERE id = 's1'`);
    account.db.exec(`DELETE FROM group_memberships WHERE id = 's1'`);
    expect(inputRevision()).toBe(before + 3);
  });

  it('marks every dynamic row stale at once (PII-only erasure)', async () => {
    const { cache, put } = kv();
    commit(1, { A: { member: true, dynamic: true } });
    await publishDynamicMemberships(store, reader, account.adapter);
    await markDynamicMembershipsStale(account.adapter, TENANT, USER, cache);
    expect(rows()[0].stale_after).toBe(NOW);
    expect(put).toHaveBeenCalled();
    const effective = await resolveSubjectGroups(
      { metadata: meta.adapter, account: account.adapter },
      TENANT,
      USER,
      NOW
    );
    expect(effective.directGroupIds.size).toBe(0);
  });
});

describe('service groups as canonical groups', () => {
  let meta: ReturnType<typeof sqliteAdapter>;
  let shardA: ReturnType<typeof sqliteAdapter>;
  let shardB: ReturnType<typeof sqliteAdapter>;
  let store: DynamicGroupStore;
  const canonical = () =>
    meta.db
      .prepare(
        `SELECT id, group_key, display_name, lifecycle_state, kind, rule_revision FROM "groups"
          WHERE tenant_id = ? ORDER BY id`
      )
      .all(TENANT);
  const membership = (db: ReturnType<typeof sqliteAdapter>, id: string, subject: string) =>
    db.db
      .prepare(
        `INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source,
          source_ref, created_at, updated_at) VALUES (?, ?, 'A', ?, 'dynamic', 'r', 1, 1)`
      )
      .run(id, TENANT, subject);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    meta = sqliteAdapter();
    shardA = sqliteAdapter();
    shardB = sqliteAdapter();
    store = new DynamicGroupStore(meta.adapter, TENANT);
  });
  afterEach(() => {
    meta.db.close();
    shardA.db.close();
    shardB.db.close();
    vi.useRealTimers();
  });

  it('creates, renames, disables and deactivates the canonical rows with the catalog', async () => {
    await store.save([group('A'), group('B')], BUILTIN_GROUP_FIELDS, 0, 'actor');
    expect(canonical()).toEqual([
      {
        id: 'A',
        group_key: dynamicGroupKey('A'),
        display_name: 'A',
        lifecycle_state: 'active',
        kind: 'dynamic',
        rule_revision: 1,
      },
      expect.objectContaining({ id: 'B', kind: 'dynamic', rule_revision: 1 }),
    ]);
    await store.save(
      [group('A', { displayName: 'Renamed' }), group('B', { enabled: false })],
      BUILTIN_GROUP_FIELDS,
      1,
      'actor'
    );
    expect(canonical()).toEqual([
      expect.objectContaining({ id: 'A', display_name: 'Renamed', rule_revision: 2 }),
      expect.objectContaining({ id: 'B', lifecycle_state: 'inactive', rule_revision: 2 }),
    ]);
    await store.save([group('A', { displayName: 'Renamed' })], BUILTIN_GROUP_FIELDS, 2, 'actor');
    expect(canonical()).toEqual([
      expect.objectContaining({ id: 'A', lifecycle_state: 'active' }),
      expect.objectContaining({ id: 'B', lifecycle_state: 'inactive' }),
    ]);
  });

  it("runs the caller's checks right before the write, which a refusal stops", async () => {
    const check = vi.fn(async () => {
      throw new Error('role_delegation_denied');
    });
    await expect(store.save([group('A')], BUILTIN_GROUP_FIELDS, 0, 'actor', check)).rejects.toThrow(
      'role_delegation_denied'
    );
    expect(check).toHaveBeenCalledWith(meta.adapter);
    expect(await store.catalog()).toBeNull();
    expect(canonical()).toEqual([]);
  });

  it('writes no canonical row when the catalog save conflicts', async () => {
    await store.save([group('A')], BUILTIN_GROUP_FIELDS, 0, 'actor');
    await expect(
      store.save([group('A'), group('B')], BUILTIN_GROUP_FIELDS, 0, 'actor')
    ).rejects.toThrow('group_version_conflict');
    expect(canonical().map((row) => (row as { id: string }).id)).toEqual(['A']);
  });

  it('removes a deleted group from every shard, with its grants, and bumps the tenant cache', async () => {
    const { cache, put } = kv();
    await store.save([group('A'), group('B')], BUILTIN_GROUP_FIELDS, 0, 'actor');
    membership(shardA, 'm1', 'u1');
    membership(shardB, 'm2', 'u2');
    meta.db
      .exec(`INSERT INTO group_role_assignments(id, tenant_id, group_id, role_id, created_at, updated_at)
      VALUES ('g1', '${TENANT}', 'A', 'reader', 1, 1);
      INSERT INTO resource_permissions(id, tenant_id, subject_type, subject_id, resource_type,
        resource_id, actions_json, created_at, updated_at)
      VALUES ('rp-a', '${TENANT}', 'group', 'A', 'documents', 'd1', '["read"]', 1, 1),
             ('rp-user', '${TENANT}', 'user', 'A', 'documents', 'd1', '["read"]', 1, 1)`);
    await store.save([group('B')], BUILTIN_GROUP_FIELDS, 1, 'actor');
    await expect(
      removeDynamicGroup(meta.adapter, [shardA.adapter], TENANT, 'B', cache)
    ).rejects.toThrow('group_still_in_catalog');
    await removeDynamicGroup(meta.adapter, [shardA.adapter, shardB.adapter], TENANT, 'A', cache);
    for (const shard of [shardA, shardB])
      expect(shard.db.prepare('SELECT COUNT(*) AS n FROM group_memberships').get()).toEqual({
        n: 0,
      });
    expect(meta.db.prepare('SELECT COUNT(*) AS n FROM group_role_assignments').get()).toEqual({
      n: 0,
    });
    // The group's resource permissions go with it; a user's of the same id stays.
    expect(meta.db.prepare('SELECT id FROM resource_permissions ORDER BY id').all()).toEqual([
      { id: 'rp-user' },
    ]);
    expect(canonical().map((row) => (row as { id: string }).id)).toEqual(['B']);
    expect(put).toHaveBeenCalledWith(`rbac:v2:tenant-version:${TENANT}`, expect.any(String));
    expect(put).toHaveBeenCalledWith(`rbac:v2:subject-version:${TENANT}:u1`, expect.any(String));
    expect(put).toHaveBeenCalledWith(`rbac:v2:subject-version:${TENANT}:u2`, expect.any(String));
    // A caller that has just bumped the tenant version itself asks for no second bump.
    await store.save([], BUILTIN_GROUP_FIELDS, 2, 'actor');
    put.mockClear();
    await removeDynamicGroup(meta.adapter, [shardA.adapter], TENANT, 'B', cache, {
      bumpTenant: false,
    });
    expect(put).not.toHaveBeenCalledWith(`rbac:v2:tenant-version:${TENANT}`, expect.any(String));
  });

  it('refuses a removal while another group has it as parent, in the save itself', async () => {
    await store.save([group('A')], BUILTIN_GROUP_FIELDS, 0, 'actor');
    meta.db.exec(`INSERT INTO "groups"(id, tenant_id, group_key, display_name, parent_group_id,
      created_at, updated_at) VALUES ('child', '${TENANT}', 'child', 'Child', 'A', 1, 1)`);
    await expect(store.save([], BUILTIN_GROUP_FIELDS, 1, 'actor')).rejects.toThrow(
      'group_version_conflict'
    );
    expect((await store.catalog())?.revision).toBe(1);
  });

  it('leaves the groups of a tenant without a catalog awaiting it (a restore in progress)', async () => {
    meta.db
      .exec(`INSERT INTO "groups"(id, tenant_id, group_key, display_name, kind, created_at, updated_at)
      VALUES ('A', '${TENANT}', 'dynamic:A', 'A', 'dynamic', 1, 1)`);
    membership(shardA, 'm1', 'u1');
    const result = await syncDynamicGroupCatalog(meta.adapter, TENANT, null);
    expect(result).toEqual({ changed: 0, orphanIds: [], awaitingCatalog: ['A'] });
    expect(canonical()).toEqual([expect.objectContaining({ id: 'A', lifecycle_state: 'active' })]);
    await expect(removeDynamicGroup(meta.adapter, [shardA.adapter], TENANT, 'A')).rejects.toThrow(
      'group_catalog_missing'
    );
    expect(shardA.db.prepare('SELECT COUNT(*) AS n FROM group_memberships').get()).toEqual({
      n: 1,
    });
  });

  it('repairs missing rows and reports orphans, leaving admin-created dynamic groups alone', async () => {
    await store.save([group('A'), group('B')], BUILTIN_GROUP_FIELDS, 0, 'actor');
    meta.db.exec(`DELETE FROM "groups" WHERE id = 'A'`);
    meta.db
      .exec(`INSERT INTO "groups"(id, tenant_id, group_key, display_name, kind, created_at, updated_at)
      VALUES ('X', '${TENANT}', 'dynamic:X', 'Gone', 'dynamic', 1, 1),
             ('admin', '${TENANT}', 'hand-made', 'Admin', 'dynamic', 1, 1)`);
    const catalog = await store.catalog();
    const result = await syncDynamicGroupCatalog(meta.adapter, TENANT, catalog);
    expect(result.orphanIds).toEqual(['X']);
    expect(canonical()).toEqual([
      expect.objectContaining({ id: 'A', lifecycle_state: 'active', rule_revision: 1 }),
      expect.objectContaining({ id: 'B' }),
      expect.objectContaining({ id: 'X', lifecycle_state: 'inactive' }),
      expect.objectContaining({ id: 'admin', lifecycle_state: 'active' }),
    ]);
    expect((await syncDynamicGroupCatalog(meta.adapter, TENANT, catalog)).changed).toBe(0);
  });
});

describe('SCIM link input from SCIM memberships', () => {
  let meta: ReturnType<typeof sqliteAdapter>;
  let core: ReturnType<typeof sqliteAdapter>;
  let pii: ReturnType<typeof sqliteAdapter>;
  let instance: SavedGroupInputReader;
  const plan = compileGroups(
    TENANT,
    [group('linked', { scimRoleId: 'scim-1' }), group('broken', { scimRoleId: 'missing' })],
    BUILTIN_GROUP_FIELDS
  );

  beforeEach(() => {
    meta = sqliteAdapter();
    core = sqliteAdapter();
    pii = sqliteAdapter('pii');
    instance = new SavedGroupInputReader(meta.adapter, core.adapter, pii.adapter, TENANT, USER);
    core.db
      .prepare(
        `INSERT INTO identity_accounts(id, tenant_id, legacy_user_id, account_type, lifecycle_state,
          registration_state, directory_publication_state, created_at, updated_at)
         VALUES ('acc', ?, ?, 'user', 'active', 'registered', 'active', 1, 1)`
      )
      .run(TENANT, USER);
  });
  afterEach(() => {
    meta.db.close();
    core.db.close();
    pii.db.close();
  });

  it('reads SCIM-kind groups and the subject SCIM rows, and versions both', async () => {
    const epochBefore = (await instance.version()).epoch;
    meta.db
      .exec(`INSERT INTO "groups"(id, tenant_id, group_key, display_name, kind, created_at, updated_at)
      VALUES ('scim-1', '${TENANT}', 'scim:scim-1', 'Engineers', 'scim', 1, 1),
             ('missing', '${TENANT}', 'static-x', 'Static', 'static', 1, 1)`);
    expect((await instance.version()).epoch).toBe(epochBefore + 1); // only the SCIM group
    expect((await instance.load(plan)).sources).toEqual({
      linked: { manual: false, scim: false },
      broken: { manual: false, scim: 'unknown' },
    });
    const coreBefore = (await instance.version()).core;
    core.db
      .prepare(
        `INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source,
          source_ref, created_at, updated_at) VALUES ('s1', ?, 'scim-1', ?, 'scim', 'scim', 1, 1)`
      )
      .run(TENANT, USER);
    expect((await instance.version()).core).toBe(coreBefore + 1);
    expect((await instance.load(plan)).sources.linked).toEqual({ manual: false, scim: true });
    // Rows of other sources are not the SCIM link and do not change the input.
    const afterScim = await instance.version();
    core.db
      .prepare(
        `INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source,
          source_ref, created_at, updated_at) VALUES ('d1', ?, 'scim-1', ?, 'dynamic', 'x', 1, 1)`
      )
      .run(TENANT, USER);
    expect(await instance.version()).toEqual(afterScim);
    // A change that does not make the membership more or less effective does not either.
    core.db.exec(`UPDATE group_memberships SET updated_at = 99 WHERE id = 's1'`);
    expect(await instance.version()).toEqual(afterScim);
    // An inactive SCIM group links nobody, and switching it bumps the epoch.
    meta.db.exec(`UPDATE "groups" SET lifecycle_state = 'inactive' WHERE id = 'scim-1'`);
    expect((await instance.version()).epoch).toBe(afterScim.epoch + 1);
    expect((await instance.load(plan)).sources.linked).toEqual({ manual: false, scim: false });
    meta.db.exec(`UPDATE "groups" SET lifecycle_state = 'active' WHERE id = 'scim-1'`);
    core.db.exec(`UPDATE group_memberships SET lifecycle_state = 'revoked' WHERE id = 's1'`);
    expect((await instance.load(plan)).sources.linked).toEqual({ manual: false, scim: false });
  });

  it('reads effective manual memberships as the manual input, and versions them', async () => {
    const before = await instance.version();
    const now = Math.floor(Date.now() / 1000);
    const insert = core.db.prepare(
      `INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source,
        source_ref, starts_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'manual', '', ?, ?, 1, 1)`
    );
    // Not yet started and already expired: not members.
    insert.run('m-later', TENANT, 'linked', USER, now + 3600, null);
    insert.run('m-ended', TENANT, 'broken', USER, null, now - 60);
    expect((await instance.version()).core).toBe(before.core + 2);
    const manual = async () =>
      Object.fromEntries(
        Object.entries((await instance.load(plan)).sources).map(([id, source]) => [
          id,
          source.manual,
        ])
      );
    expect(await manual()).toEqual({ linked: false, broken: false });
    core.db.exec(`UPDATE group_memberships SET starts_at = NULL WHERE id = 'm-later'`);
    expect((await instance.version()).core).toBe(before.core + 3);
    expect(await manual()).toEqual({ linked: true, broken: false });
    // Removing it is a change of the input too.
    core.db.exec(`UPDATE group_memberships SET lifecycle_state = 'revoked' WHERE id = 'm-later'`);
    expect((await instance.version()).core).toBe(before.core + 4);
    expect(await manual()).toEqual({ linked: false, broken: false });
  });

  it('reports when the manual input changes by itself (the next start or end)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const insert = core.db.prepare(
      `INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source,
        source_ref, starts_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'manual', '', ?, ?, 1, 1)`
    );
    expect((await instance.load(plan)).validUntil).toBeUndefined();
    // A start already past changes nothing any more; the end still does.
    insert.run('m-1', TENANT, 'linked', USER, now - 10, now + 500);
    insert.run('m-2', TENANT, 'broken', USER, now + 200, null);
    // Another subject's membership is not this subject's input.
    insert.run('m-3', TENANT, 'broken', USER + '-other', null, now + 50);
    expect((await instance.load(plan)).validUntil).toBe(now + 200);
  });

  it('keeps evaluating a plan saved without the self-writable mark', async () => {
    meta.db.exec(`INSERT INTO custom_claim_schemas(id, tenant_id, field_key, display_label,
      field_type, is_active, operation_status, schema_version, show_on_registration, created_at,
      updated_at) VALUES ('${TENANT}:team', '${TENANT}', 'team', 'Team', 'string', 1, 'active', 1,
      1, 1, 1)`);
    const older = compileGroups(
      TENANT,
      [
        group('T', {
          condition: { op: 'attribute', field: 'custom.team', compare: 'eq', value: 'x' },
        }),
      ],
      {
        ...BUILTIN_GROUP_FIELDS,
        'custom.team': { type: 'string', schemaId: `${TENANT}:team`, schemaVersion: 1, pii: false },
      }
    );
    await expect(instance.load(older)).resolves.toBeDefined();
    // Any other change of the field's contract still stops it.
    meta.db.exec(`UPDATE custom_claim_schemas SET schema_version = 2 WHERE id = '${TENANT}:team'`);
    await expect(instance.load(older)).rejects.toThrow('group_attribute_schema_changed');
  });

  it('bumps both subjects when a SCIM row moves to another subject', () => {
    const revision = (user: string) =>
      (
        core.db
          .prepare('SELECT revision FROM service_group_inputs WHERE tenant_id = ? AND user_id = ?')
          .get(TENANT, user) as { revision: number } | undefined
      )?.revision ?? 0;
    core.db
      .prepare(
        `INSERT INTO group_memberships(id, tenant_id, group_id, subject_id, assignment_source,
          source_ref, created_at, updated_at) VALUES ('s1', ?, 'scim-1', 'a', 'scim', 'scim', 1, 1)`
      )
      .run(TENANT);
    const [a, b] = [revision('a'), revision('b')];
    core.db.exec(`UPDATE group_memberships SET subject_id = 'b' WHERE id = 's1'`);
    expect([revision('a'), revision('b')]).toEqual([a + 1, b + 1]);
  });

  it('migration 017 makes results of every tenant with a catalog stale once', async () => {
    const { readMigrationSource } =
      await import('../../../../../../test/helpers/migration-source.mjs');
    const sql = readMigrationSource(
      new URL('../../../../../../migrations/core/d1/', import.meta.url),
      '017_service_group_scim_membership_inputs.sql'
    );
    const bump = sql.slice(sql.lastIndexOf('END;') + 'END;'.length);
    meta.db
      .exec(`INSERT INTO service_group_catalog(tenant_id, revision, plan_json, updated_at, write_token)
      VALUES ('with-catalog', 1, '{}', 1, ''), ('fresh-catalog', 1, '{}', 1, '');
      INSERT INTO service_group_epoch(tenant_id, revision) VALUES ('with-catalog', 4), ('no-catalog', 7)`);
    meta.db.exec(bump);
    const epoch = (tenant: string) =>
      (
        meta.db
          .prepare('SELECT revision FROM service_group_epoch WHERE tenant_id = ?')
          .get(tenant) as { revision: number } | undefined
      )?.revision;
    expect([epoch('with-catalog'), epoch('fresh-catalog'), epoch('no-catalog')]).toEqual([5, 1, 7]);
  });
});
