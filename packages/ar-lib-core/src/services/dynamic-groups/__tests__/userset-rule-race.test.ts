/**
 * A ReBAC group userset write and a service-group rule save whose checks run concurrently (D1:
 * no lock): both fence on the tenant authorization version (policy_rules_version) and raise it
 * in their batch, so whichever commits second changes nothing and answers
 * group_version_conflict, in either order (real SQL on the D1 schema).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sqliteAdapter } from '../../../repositories/__tests__/sqlite-core-schema';
import { BUILTIN_GROUP_FIELDS, type ServiceGroup } from '../model';
import { DynamicGroupStore } from '../store';
import { guardGroupUsersetWrite } from '../role-guard';
import { createGroup } from '../../group-catalog';

const TENANT = 'tenant-a';

const group = (id: string): ServiceGroup => ({
  id,
  tenantId: TENANT,
  key: id.toLowerCase(),
  displayName: id,
  description: '',
  enabled: true,
  condition: null,
});

describe('ReBAC userset writes and service-group rule saves', () => {
  let fixture: ReturnType<typeof sqliteAdapter>;
  let store: DynamicGroupStore;
  let groupId: string;

  /** The guarded userset insert, with `between` run after its check and before its batch. */
  const writeUserset = (between: () => Promise<void> = async () => {}) =>
    guardGroupUsersetWrite(fixture.adapter, TENANT, groupId, async (_reader, fence) => {
      await between();
      return {
        statements: [
          {
            sql: `INSERT INTO relationships (id, tenant_id, relationship_type, from_type, from_id,
                from_relation, to_type, to_id, permission_level, expires_at, is_bidirectional,
                created_at, updated_at)
              SELECT 'u1', ?, 'viewer', 'group', ?, 'member', 'document', 'doc-1', 'full', NULL,
                0, 0, 0 WHERE ${fence.sql}`,
            params: [TENANT, groupId, ...fence.params],
          },
        ],
        result: 'u1',
      };
    });
  const usersets = () =>
    fixture.db.prepare("SELECT id FROM relationships WHERE from_type = 'group'").all();
  const version = () =>
    fixture.db.prepare('SELECT version FROM policy_rules_version WHERE tenant_id = ?').get(TENANT);

  beforeEach(async () => {
    fixture = sqliteAdapter('core');
    store = new DynamicGroupStore(fixture.adapter, TENANT);
    groupId = await createGroup(fixture.adapter, TENANT, { groupKey: 'team', displayName: 'Team' });
  });
  afterEach(() => fixture.db.close());

  it('lets a rule save that commits first make the userset write conflict', async () => {
    const outcome = await writeUserset(async () => {
      await store.save([group('A')], BUILTIN_GROUP_FIELDS, 0, 'actor');
    });
    expect(outcome).toEqual({ kind: 'group_version_conflict' });
    expect(usersets()).toEqual([]);
  });

  it('lets a userset write that commits first make the rule save conflict', async () => {
    await expect(
      store.save([group('A')], BUILTIN_GROUP_FIELDS, 0, 'actor', async () => {
        // The save's check has read the version; the userset is written meanwhile.
        expect(await writeUserset()).toEqual({ kind: 'written', result: 'u1' });
      })
    ).rejects.toThrow('group_version_conflict');
    expect(usersets()).toEqual([{ id: 'u1' }]);
    // The first save of the catalog lost: it leaves no empty row behind, and a retry succeeds.
    expect(fixture.db.prepare('SELECT revision FROM service_group_catalog').all()).toEqual([]);
    expect(await store.catalog()).toBeNull();
    await expect(store.save([group('A')], BUILTIN_GROUP_FIELDS, 0, 'actor')).resolves.toMatchObject(
      { revision: 1 }
    );
    expect((await store.catalog())?.revision).toBe(1);
  });

  it('treats an empty first row left by an earlier lost save as no catalog yet', async () => {
    fixture.db
      .prepare(
        `INSERT INTO service_group_catalog(tenant_id, revision, plan_json, updated_at, write_token)
         VALUES (?, 0, '{}', 0, '')`
      )
      .run(TENANT);
    expect(await store.catalog()).toBeNull();
    await expect(store.save([group('A')], BUILTIN_GROUP_FIELDS, 0, 'actor')).resolves.toMatchObject(
      { revision: 1 }
    );
  });

  it('raises the version on each committed write, and lets them run one after the other', async () => {
    expect(version()).toBeUndefined();
    expect(await writeUserset()).toEqual({ kind: 'written', result: 'u1' });
    expect(version()).toEqual({ version: 1 });
    await store.save([group('A')], BUILTIN_GROUP_FIELDS, 0, 'actor');
    expect(version()).toEqual({ version: 2 });
  });
});
