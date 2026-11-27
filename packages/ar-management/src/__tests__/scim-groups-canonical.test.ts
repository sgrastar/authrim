/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- SCIM JSON bodies and the shared SCIM test harness fakes are untyped in these route tests */
/**
 * SCIM Groups on the canonical group tables: SCIM reads and writes only the membership rows of
 * the tenant's SCIM provisioning domain (`assignment_source = 'scim'`, `source_ref = 'scim'`), so
 * manual and rule rows and membership through descendant groups survive a GET followed by a PUT;
 * `User.groups` tells direct from inherited groups.
 */
import { describe, expect, it, vi } from 'vitest';
import { describeScimTestHarness } from './scim-test-harness';

const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const BULK_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:BulkRequest';
const TOKEN_A = 'valid-scim-token';
const TOKEN_B = 'other-scim-token';

describeScimTestHarness('SCIM Groups on canonical groups', (harness) => {
  const send = (method: string, path: string, body?: unknown, token = TOKEN_A) =>
    harness.app.fetch(
      harness.createRequest(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { Authorization: `Bearer ${token}` },
      }),
      harness.env
    );
  const rows = (groupId: string) =>
    harness.canonicalGroups
      .memberships()
      .filter((row) => row.group_id === groupId)
      .map((row) => [row.subject_id, row.assignment_source, row.source_ref, row.lifecycle_state]);
  const memberValues = (body: any) => (body.members ?? []).map((member: any) => member.value);
  const patchOps = (operations: unknown[]) => ({ schemas: [PATCH_SCHEMA], Operations: operations });
  const bulk = (operations: unknown[]) =>
    send('POST', '/scim/v2/Bulk', { schemas: [BULK_SCHEMA], Operations: operations });

  function seedTree() {
    harness.canonicalGroups.seedGroup({
      id: 'group-child',
      displayName: 'Child',
      parentGroupId: 'group-001',
    });
    // A manual member of the group, a member of its child (membership through a descendant), a
    // provisioning rule's member, and one SCIM member.
    harness.canonicalGroups.seedMembership({
      groupId: 'group-001',
      subjectId: 'user-001',
      source: 'manual',
      sourceRef: '',
    });
    harness.canonicalGroups.seedMembership({
      groupId: 'group-001',
      subjectId: 'user-001',
      source: 'rule',
      sourceRef: 'rule-1',
    });
    harness.canonicalGroups.seedMembership({ groupId: 'group-child', subjectId: 'user-001' });
    harness.canonicalGroups.seedMembership({ groupId: 'group-001', subjectId: 'user-002' });
  }

  describe('a GET followed by a PUT of what it returned', () => {
    it('leaves manual and rule rows and membership through child groups as they are', async () => {
      seedTree();
      const before = harness.canonicalGroups.memberships();
      const got = await send('GET', '/scim/v2/Groups/group-001');
      expect(got.status).toBe(200);
      const resource = await got.json<any>();
      // Only SCIM rows are members here.
      expect(memberValues(resource)).toEqual(['user-002']);

      const put = await send('PUT', '/scim/v2/Groups/group-001', resource);
      expect(put.status).toBe(200);
      expect(harness.canonicalGroups.memberships()).toEqual(before);
    });

    it('does the same through Bulk', async () => {
      seedTree();
      const before = harness.canonicalGroups.memberships();
      const resource = await (await send('GET', '/scim/v2/Groups/group-001')).json<any>();
      const res = await bulk([{ method: 'PUT', path: '/Groups/group-001', data: resource }]);
      expect(res.status).toBe(200);
      expect((await res.json<any>()).Operations[0].status).toBe('200');
      expect(harness.canonicalGroups.memberships()).toEqual(before);
    });

    it('lets a PUT without members remove only the SCIM rows', async () => {
      seedTree();
      const put = await send('PUT', '/scim/v2/Groups/group-001', {
        schemas: [GROUP_SCHEMA],
        displayName: 'Administrators',
      });
      expect(put.status).toBe(200);
      expect(rows('group-001')).toEqual([
        ['user-001', 'manual', '', 'active'],
        ['user-001', 'rule', 'rule-1', 'active'],
        ['user-002', 'scim', 'scim', 'revoked'],
      ]);
      expect(rows('group-child')).toEqual([['user-001', 'scim', 'scim', 'active']]);
    });
  });

  describe('two SCIM tokens of the tenant', () => {
    it('share the provisioning domain and never touch manual or rule rows', async () => {
      seedTree();
      const a = await send(
        'PATCH',
        '/scim/v2/Groups/group-001',
        patchOps([{ op: 'add', path: 'members', value: [{ value: 'user-001' }] }])
      );
      expect(a.status).toBe(200);
      // The other token sees the members the first one added (a rotated token keeps the rows).
      const seenByB = await (
        await send('GET', '/scim/v2/Groups/group-001', undefined, TOKEN_B)
      ).json<any>();
      expect(memberValues(seenByB)).toEqual(['user-001', 'user-002']);

      const cleared = await send(
        'PATCH',
        '/scim/v2/Groups/group-001',
        patchOps([{ op: 'remove', path: 'members' }]),
        TOKEN_B
      );
      expect(cleared.status).toBe(200);
      expect(rows('group-001')).toEqual([
        ['user-001', 'manual', '', 'active'],
        ['user-001', 'rule', 'rule-1', 'active'],
        ['user-001', 'scim', 'scim', 'revoked'],
        ['user-002', 'scim', 'scim', 'revoked'],
      ]);
    });
  });

  describe('PATCH of members', () => {
    const seedA = () =>
      harness.canonicalGroups.seedMembership({ groupId: 'group-001', subjectId: 'user-001' });
    const scimMembers = () =>
      rows('group-001')
        .filter((row) => row[3] === 'active')
        .map((row) => row[0]);

    it('adds to the current members (union), with or without a path', async () => {
      seedA();
      const withPath = await send(
        'PATCH',
        '/scim/v2/Groups/group-001',
        patchOps([{ op: 'add', path: 'members', value: [{ value: 'user-002' }] }])
      );
      expect(withPath.status).toBe(200);
      expect(memberValues(await withPath.json<any>())).toEqual(['user-001', 'user-002']);
      expect(scimMembers()).toEqual(['user-001', 'user-002']);

      harness.users.set('user-003', { ...harness.users.get('user-002'), id: 'user-003' });
      const noPath = await send(
        'PATCH',
        '/scim/v2/Groups/group-001',
        patchOps([{ op: 'add', value: { members: [{ value: 'user-003' }] } }])
      );
      expect(noPath.status).toBe(200);
      expect(scimMembers()).toEqual(['user-001', 'user-002', 'user-003']);
    });

    it('replaces the members with replace, and removes the given ones with remove', async () => {
      seedA();
      await send(
        'PATCH',
        '/scim/v2/Groups/group-001',
        patchOps([{ op: 'replace', path: 'members', value: [{ value: 'user-002' }] }])
      );
      expect(scimMembers()).toEqual(['user-002']);
      await send(
        'PATCH',
        '/scim/v2/Groups/group-001',
        patchOps([
          { op: 'add', path: 'members', value: [{ value: 'user-001' }] },
          { op: 'remove', path: 'members', value: [{ value: 'user-002' }] },
        ])
      );
      expect(scimMembers()).toEqual(['user-001']);
      await send(
        'PATCH',
        '/scim/v2/Groups/group-001',
        patchOps([{ op: 'replace', value: { displayName: 'Admins', members: [] } }])
      );
      expect(scimMembers()).toEqual([]);
      expect(harness.groups.get('group-001').name).toBe('Admins');
    });

    it('adds to the current members through Bulk too', async () => {
      seedA();
      const res = await bulk([
        {
          method: 'PATCH',
          path: '/Groups/group-001',
          data: patchOps([{ op: 'add', path: 'members', value: [{ value: 'user-002' }] }]),
        },
      ]);
      expect((await res.json<any>()).Operations[0].status).toBe('200');
      expect(scimMembers()).toEqual(['user-001', 'user-002']);
    });

    it('keeps a member whose account no longer routes when the patch leaves it', async () => {
      // A suspended or locked member: its rows are read, its route is refused.
      harness.canonicalGroups.seedMembership({ groupId: 'group-001', subjectId: 'user-suspended' });
      const renamed = await send(
        'PATCH',
        '/scim/v2/Groups/group-001',
        patchOps([{ op: 'replace', path: 'displayName', value: 'Renamed' }])
      );
      expect(renamed.status).toBe(200);
      const added = await send(
        'PATCH',
        '/scim/v2/Groups/group-001',
        patchOps([{ op: 'add', path: 'members', value: [{ value: 'user-001' }] }])
      );
      expect(added.status).toBe(200);
      expect(scimMembers()).toEqual(['user-001', 'user-suspended']);
      const bulkRename = await bulk([
        {
          method: 'PATCH',
          path: '/Groups/group-001',
          data: patchOps([{ op: 'replace', path: 'displayName', value: 'Again' }]),
        },
      ]);
      expect((await bulkRename.json<any>()).Operations[0].status).toBe('200');
    });
  });

  describe('PATCH member paths', () => {
    const URN = 'urn:ietf:params:scim:schemas:core:2.0:Group';
    const seedA = () =>
      harness.canonicalGroups.seedMembership({ groupId: 'group-001', subjectId: 'user-001' });
    const active = () =>
      rows('group-001')
        .filter((row) => row[3] === 'active')
        .map((row) => row[0]);
    const patchGroup = (operations: unknown[]) =>
      send('PATCH', '/scim/v2/Groups/group-001', patchOps(operations));
    const bulkPatch = async (operations: unknown[]) =>
      (
        await (
          await bulk([{ method: 'PATCH', path: '/Groups/group-001', data: patchOps(operations) }])
        ).json<any>()
      ).Operations[0];

    it('removes a member named by a single- or double-quoted filter', async () => {
      seedA();
      expect(
        (await patchGroup([{ op: 'remove', path: "members[value eq 'user-001']" }])).status
      ).toBe(200);
      expect(active()).toEqual([]);
      await patchGroup([{ op: 'add', path: 'members', value: [{ value: 'user-001' }] }]);
      expect(
        (await bulkPatch([{ op: 'remove', path: 'members[value eq "user-001"]' }])).status
      ).toBe('200');
      expect(active()).toEqual([]);
    });

    it('accepts the Group schema URN before members and before a filter', async () => {
      seedA();
      expect(
        (
          await patchGroup([
            { op: 'add', path: `${URN}:members`, value: [{ value: 'user-002', display: 'Jane' }] },
          ])
        ).status
      ).toBe(200);
      expect(active()).toEqual(['user-001', 'user-002']);
      expect(
        (await bulkPatch([{ op: 'remove', path: `${URN}:members[value eq 'user-001']` }])).status
      ).toBe('200');
      expect(active()).toEqual(['user-002']);
    });

    it("replaces a filtered member's value, as an object or through .value", async () => {
      seedA();
      expect(
        (
          await patchGroup([
            { op: 'replace', path: 'members[value eq "user-001"]', value: { value: 'user-002' } },
          ])
        ).status
      ).toBe(200);
      expect(active()).toEqual(['user-002']);
      expect(
        (
          await bulkPatch([
            { op: 'replace', path: "members[value eq 'user-002'].value", value: 'user-001' },
          ])
        ).status
      ).toBe('200');
      expect(active()).toEqual(['user-001']);
    });

    it('refuses a members path or operator it cannot apply, before any write', async () => {
      seedA();
      const before = harness.canonicalGroups.memberships();
      const cases: Array<[unknown[], string]> = [
        [
          [{ op: 'add', path: 'members[value eq "user-002"]', value: { value: 'user-002' } }],
          'invalidPath',
        ],
        [[{ op: 'replace', path: 'members.display', value: 'x' }], 'invalidPath'],
        [
          [{ op: 'replace', path: 'members[display eq "x"]', value: { value: 'user-002' } }],
          'invalidPath',
        ],
        [
          [{ op: 'replace', path: 'members[value eq "user-001"].display', value: 'x' }],
          'invalidPath',
        ],
        [[{ op: 'remove', value: { members: [{ value: 'user-001' }] } }], 'invalidPath'],
        [
          [{ op: 'replace', path: 'members[value eq "nobody"]', value: { value: 'user-002' } }],
          'noTarget',
        ],
        // A later operation that fails also stops the earlier ones.
        [
          [
            { op: 'replace', path: 'displayName', value: 'Never' },
            { op: 'add', path: 'members', value: [{ value: 'user-002' }] },
            { op: 'replace', path: 'members.type', value: 'User' },
          ],
          'invalidPath',
        ],
      ];
      for (const [operations, scimType] of cases) {
        const res = await patchGroup(operations);
        expect(res.status).toBe(400);
        expect((await res.json<any>()).scimType).toBe(scimType);
        const operation = await bulkPatch(operations);
        expect(operation.status).toBe('400');
        expect(operation.response.scimType).toBe(scimType);
      }
      expect(harness.canonicalGroups.memberships()).toEqual(before);
      expect(harness.groups.get('group-001').name).toBe('Administrators');
    });

    it('refuses an invalid member element; only an empty array empties the members', async () => {
      seedA();
      const before = harness.canonicalGroups.memberships();
      for (const value of [
        [{}],
        [{ value: '' }],
        [{ value: 7 }],
        [{ value: 'user-002', display: 3 }],
        [{ value: 'user-002', extra: 'x' }],
        [{ value: 'user-002' }, 'user-003'],
      ]) {
        const res = await patchGroup([{ op: 'replace', path: 'members', value }]);
        expect(res.status).toBe(400);
        expect((await res.json<any>()).scimType).toBe('invalidValue');
        expect((await bulkPatch([{ op: 'replace', path: 'members', value }])).status).toBe('400');
      }
      expect(harness.canonicalGroups.memberships()).toEqual(before);
      expect((await patchGroup([{ op: 'replace', path: 'members', value: [] }])).status).toBe(200);
      expect(active()).toEqual([]);
    });

    it('refuses to remove a value that is not a User id (an alias), as add does', async () => {
      seedA();
      const alias = await patchGroup([
        { op: 'remove', path: 'members', value: [{ value: 'account:user-001' }] },
      ]);
      expect(alias.status).toBe(400);
      expect(
        (await bulkPatch([{ op: 'remove', path: "members[value eq 'account:user-001']" }])).status
      ).toBe('400');
      expect(active()).toEqual(['user-001']);
      // Removing a User that is not a member changes nothing and succeeds.
      expect(
        (await patchGroup([{ op: 'remove', path: 'members', value: [{ value: 'user-002' }] }]))
          .status
      ).toBe(200);
      expect(active()).toEqual(['user-001']);
    });
  });

  describe('member values', () => {
    it('store the canonical User id and refuse an alias that routes elsewhere', async () => {
      // `account:user-001` routes to user-001, but it is not that User's SCIM id.
      const alias = await send('POST', '/scim/v2/Groups', {
        schemas: [GROUP_SCHEMA],
        displayName: 'Aliased',
        members: [{ value: 'account:user-001' }],
      });
      expect(alias.status).toBe(400);
      expect(harness.groups.size).toBe(1);

      const created = await send('POST', '/scim/v2/Groups', {
        schemas: [GROUP_SCHEMA],
        displayName: 'Canonical',
        members: [{ value: 'user-001' }],
      });
      const body = await created.json<any>();
      expect(memberValues(body)).toEqual(['user-001']);
      expect(rows(String(body.id))).toEqual([['user-001', 'scim', 'scim', 'active']]);
    });
  });

  describe('displayName', () => {
    it('stays unique among SCIM groups on PUT and PATCH renames', async () => {
      harness.canonicalGroups.seedGroup({ id: 'group-002', displayName: 'Operators' });
      // A group of another kind does not take the name.
      harness.canonicalGroups.seedGroup({ id: 'team', displayName: 'Team', kind: 'static' });
      const put = await send('PUT', '/scim/v2/Groups/group-001', {
        schemas: [GROUP_SCHEMA],
        displayName: 'Operators',
      });
      expect(put.status).toBe(409);
      expect((await put.json<any>()).scimType).toBe('uniqueness');
      const patch = await send(
        'PATCH',
        '/scim/v2/Groups/group-001',
        patchOps([{ op: 'replace', path: 'displayName', value: 'Operators' }])
      );
      expect(patch.status).toBe(409);
      const res = await bulk([
        {
          method: 'PUT',
          path: '/Groups/group-001',
          data: { schemas: [GROUP_SCHEMA], displayName: 'Operators' },
        },
        {
          method: 'PATCH',
          path: '/Groups/group-001',
          data: patchOps([{ op: 'replace', path: 'displayName', value: 'Operators' }]),
        },
      ]);
      expect((await res.json<any>()).Operations.map((op: any) => op.status)).toEqual([
        '409',
        '409',
      ]);
      expect(harness.groups.get('group-001').name).toBe('Administrators');
      // Keeping its own name, or taking another kind's name, is fine.
      expect(
        (
          await send('PUT', '/scim/v2/Groups/group-001', {
            schemas: [GROUP_SCHEMA],
            displayName: 'Administrators',
          })
        ).status
      ).toBe(200);
      expect(
        (
          await send('PUT', '/scim/v2/Groups/group-001', {
            schemas: [GROUP_SCHEMA],
            displayName: 'Team',
          })
        ).status
      ).toBe(200);
    });
  });

  describe('the group list', () => {
    it('reads no member when members are left out, and reads them per page otherwise', async () => {
      harness.canonicalGroups.seedGroup({ id: 'group-002', displayName: 'Operators' });
      harness.canonicalGroups.seedMembership({ groupId: 'group-001', subjectId: 'user-001' });
      harness.canonicalGroups.seedMembership({ groupId: 'group-002', subjectId: 'user-002' });
      const db = harness.env.DB as any;
      const original = db.prepare;
      const statements: string[] = [];
      db.prepare = (sql: string) => {
        statements.push(sql);
        return original.call(db, sql);
      };
      const memberReads = () => statements.filter((sql) => sql.includes('group_memberships'));

      for (const query of ['excludedAttributes=members', 'attributes=displayName']) {
        statements.length = 0;
        const res = await send('GET', `/scim/v2/Groups?${query}`);
        expect(res.status).toBe(200);
        const body = await res.json<any>();
        expect(body.Resources).toHaveLength(2);
        expect(body.Resources.every((group: any) => group.members === undefined)).toBe(true);
        expect(memberReads()).toEqual([]);
      }

      statements.length = 0;
      const full = await (await send('GET', '/scim/v2/Groups?sortBy=displayName')).json<any>();
      expect(full.Resources.map((group: any) => memberValues(group))).toEqual([
        ['user-001'],
        ['user-002'],
      ]);
      expect(memberReads()).toHaveLength(1);
      expect(memberReads()[0]).toContain('group_id IN (?, ?)');
    });
  });

  describe('User.groups', () => {
    it('is direct for every membership in force and indirect for the ancestors', async () => {
      harness.canonicalGroups.seedGroup({
        id: 'group-child',
        displayName: 'Child',
        parentGroupId: 'group-001',
      });
      harness.canonicalGroups.seedGroup({ id: 'team', displayName: 'Team', kind: 'static' });
      harness.canonicalGroups.seedMembership({ groupId: 'group-child', subjectId: 'user-001' });
      harness.canonicalGroups.seedMembership({
        groupId: 'team',
        subjectId: 'user-001',
        source: 'manual',
        sourceRef: '',
      });
      harness.canonicalGroups.seedGroup({ id: 'ruled', displayName: 'Ruled', kind: 'provisioned' });
      harness.canonicalGroups.seedMembership({
        groupId: 'ruled',
        subjectId: 'user-001',
        source: 'rule',
        sourceRef: 'rule-1',
      });
      // A revoked row is not shown.
      harness.canonicalGroups.seedGroup({ id: 'gone', displayName: 'Gone' });
      harness.canonicalGroups.seedMembership({
        groupId: 'gone',
        subjectId: 'user-001',
        state: 'revoked',
      });

      const res = await send('GET', '/scim/v2/Users/user-001');
      expect(res.status).toBe(200);
      const body = await res.json<any>();
      expect(body.groups).toEqual([
        {
          value: 'group-001',
          $ref: 'http://localhost/scim/v2/Groups/group-001',
          display: 'Administrators',
          type: 'indirect',
        },
        {
          value: 'group-child',
          $ref: 'http://localhost/scim/v2/Groups/group-child',
          display: 'Child',
          type: 'direct',
        },
        // Not SCIM groups: no SCIM resource to refer to.
        { value: 'ruled', display: 'Ruled', type: 'direct' },
        { value: 'team', display: 'Team', type: 'direct' },
      ]);
    });
  });

  describe('groups that are not SCIM groups', () => {
    it('are neither listed nor addressable', async () => {
      harness.canonicalGroups.seedGroup({ id: 'team', displayName: 'Team', kind: 'static' });
      const list = await (await send('GET', '/scim/v2/Groups')).json<any>();
      expect(list.Resources.map((group: any) => group.id)).toEqual(['group-001']);
      expect((await send('GET', '/scim/v2/Groups/team')).status).toBe(404);
      expect(
        (
          await send('PUT', '/scim/v2/Groups/team', {
            schemas: [GROUP_SCHEMA],
            displayName: 'Taken over',
          })
        ).status
      ).toBe(404);
      expect((await send('DELETE', '/scim/v2/Groups/team')).status).toBe(404);
      expect(harness.groups.get('team').name).toBe('Team');
    });
  });

  describe('deleting a group with child groups', () => {
    it('is refused with 409 through Bulk too', async () => {
      seedTree();
      const res = await bulk([{ method: 'DELETE', path: '/Groups/group-001' }]);
      const operation = (await res.json<any>()).Operations[0];
      expect(operation.status).toBe('409');
      expect(harness.groups.has('group-001')).toBe(true);
      expect(rows('group-001')).toHaveLength(3);
    });
  });

  describe('the RBAC claims cache', () => {
    function bindCache() {
      const put = vi.fn(async () => undefined);
      (harness.env as any).REBAC_CACHE = { put, get: vi.fn(async () => null) };
      return () => put.mock.calls.map((call) => String((call as unknown[])[0]));
    }

    it('is invalidated for each subject whose membership changes, and only theirs', async () => {
      harness.canonicalGroups.seedMembership({ groupId: 'group-001', subjectId: 'user-001' });
      const keys = bindCache();
      const res = await send('PUT', '/scim/v2/Groups/group-001', {
        schemas: [GROUP_SCHEMA],
        displayName: 'Administrators',
        members: [{ value: 'user-002' }],
      });
      expect(res.status).toBe(200);
      expect(keys().sort()).toEqual([
        'rbac:v2:subject-version:default:user-001',
        'rbac:v2:subject-version:default:user-002',
      ]);
    });

    it('deletes the resource permissions granted to the group with it', async () => {
      harness.canonicalGroups.db
        .prepare(
          `INSERT INTO resource_permissions (id, tenant_id, subject_type, subject_id, resource_type,
             resource_id, actions_json, created_at, updated_at)
           VALUES ('rp-group', 'default', 'group', 'group-001', 'documents', 'd1', '["read"]', 1, 1),
                  ('rp-user', 'default', 'user', 'group-001', 'documents', 'd1', '["read"]', 1, 1)`
        )
        .run();
      expect((await send('DELETE', '/scim/v2/Groups/group-001')).status).toBe(204);
      expect(
        harness.canonicalGroups.db.prepare('SELECT id FROM resource_permissions').all()
      ).toEqual([{ id: 'rp-user' }]);
    });

    it('moves the tenant version on a rename, and on a delete before the memberships go', async () => {
      harness.canonicalGroups.seedMembership({ groupId: 'group-001', subjectId: 'user-001' });
      const keys = bindCache();
      const renamed = await send(
        'PATCH',
        '/scim/v2/Groups/group-001',
        patchOps([{ op: 'replace', path: 'displayName', value: 'Admins' }])
      );
      expect(renamed.status).toBe(200);
      expect(keys()).toEqual(['rbac:v2:tenant-version:default']);

      const deleted = await send('DELETE', '/scim/v2/Groups/group-001');
      expect(deleted.status).toBe(204);
      expect(keys()).toEqual([
        'rbac:v2:tenant-version:default',
        'rbac:v2:tenant-version:default',
        'rbac:v2:subject-version:default:user-001',
      ]);
    });

    it('is invalidated by a Bulk create for each member', async () => {
      const keys = bindCache();
      const res = await bulk([
        {
          method: 'POST',
          path: '/Groups',
          bulkId: 'g1',
          data: {
            schemas: [GROUP_SCHEMA],
            displayName: 'Bulk group',
            members: [{ value: 'user-001' }],
          },
        },
      ]);
      expect((await res.json<any>()).Operations[0].status).toBe('201');
      expect(keys()).toEqual(['rbac:v2:subject-version:default:user-001']);
    });
  });
});
