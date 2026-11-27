import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import type { TenantRBACDatabases } from '../../services/tenant-rbac';
import {
  extractIDTokenClaimsFromCache,
  getAccessTokenRBACClaims,
  getCompositeRBACCache,
  getIDTokenRBACClaims,
  getIDTokenRBACClaimsConfigurable,
  getUserRBACClaims,
  resolveEffectiveRoles,
  resolvePermissions,
  resolveScopedRoles,
  resolveSubjectGroupClaims,
} from '../rbac-claims';
import { evaluatePermissionEmbeddingForScope } from '../policy-embedding';
import { evaluateIdLevelPermissions, hasIdLevelPermission } from '../resource-permissions';

const NOW = 1_800_000_000;

function openDatabase(): { db: DatabaseSync; adapter: DatabaseAdapter } {
  const opened = sqliteAdapter();
  for (const tenant of ['tenant-a', 'tenant-b']) {
    opened.db
      .prepare(
        `INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(tenant, `code-${tenant}`, `key-${tenant}`, tenant, NOW, NOW);
  }
  const adapter = {
    ...opened.adapter,
    transaction: async () => {
      throw new Error('not used');
    },
    isHealthy: async () => ({ healthy: true, latencyMs: 0 }),
    getType: () => 'sqlite',
    close: async () => undefined,
  } as DatabaseAdapter;
  return { db: opened.db, adapter };
}

/**
 * Token RBAC claims under routed account storage: roles and groups are defined in the
 * tenant metadata database and assigned in the account's database. Two separate SQLite databases
 * stand in for the two D1 databases, so a claim built from the wrong one comes out empty.
 */
describe('RBAC claims across the metadata and account databases', () => {
  let metadata: { db: DatabaseSync; adapter: DatabaseAdapter };
  let account: { db: DatabaseSync; adapter: DatabaseAdapter };
  let dbs: TenantRBACDatabases;

  function role(id: string, tenantId: string, name: string, permissions: string[]) {
    metadata.db
      .prepare(
        `INSERT INTO roles (id, tenant_id, name, permissions_json, created_at, role_type, is_system)
         VALUES (?, ?, ?, ?, ?, 'custom', 0)`
      )
      .run(id, tenantId, name, JSON.stringify(permissions), NOW);
  }

  function group(id: string, key: string, name: string, state = 'active') {
    metadata.db
      .prepare(
        `INSERT INTO "groups" (id, tenant_id, group_key, display_name, lifecycle_state,
           created_at, updated_at)
         VALUES (?, 'tenant-a', ?, ?, ?, ?, ?)`
      )
      .run(id, key, name, state, NOW, NOW);
  }

  function assign(
    database: DatabaseSync,
    id: string,
    roleId: string,
    scope: { type: string; target: string } = { type: 'global', target: '' },
    expiresAt: number | null = null
  ) {
    database
      .prepare(
        `INSERT INTO role_assignments (id, tenant_id, subject_id, role_id, scope_type,
           scope_target, expires_at, created_at, updated_at)
         VALUES (?, 'tenant-a', 'user-1', ?, ?, ?, ?, ?, ?)`
      )
      .run(id, roleId, scope.type, scope.target, expiresAt, NOW, NOW);
  }

  function join(id: string, groupId: string) {
    account.db
      .prepare(
        `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source,
           source_ref, created_at, updated_at)
         VALUES (?, 'tenant-a', ?, 'user-1', 'manual', '', ?, ?)`
      )
      .run(id, groupId, NOW, NOW);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
    metadata = openDatabase();
    account = openDatabase();
    dbs = { metadata: metadata.adapter, account: account.adapter };
    for (const database of [metadata.db, account.db]) {
      database
        .prepare(
          `INSERT INTO identity_accounts (id, tenant_id, account_type, legacy_user_id, created_at, updated_at)
           VALUES ('account:user-1', 'tenant-a', 'user', 'user-1', ?, ?)`
        )
        .run(NOW, NOW);
    }

    role('role-admin', 'tenant-a', 'admin', ['users:write', 'users:read']);
    role('role-viewer', 'tenant-a', 'viewer', ['users:read', 'documents:read']);
    role('role-editor', 'tenant-a', 'editor', ['documents:write']);
    role('role-other-tenant', 'tenant-b', 'intruder', ['*:*']);
    group('grp-1', 'acme', 'Acme');
    group('grp-2', 'beta', 'Beta');
    group('grp-3', 'closed', 'Closed', 'suspended');

    assign(account.db, 'ra-1', 'role-viewer');
    assign(account.db, 'ra-2', 'role-admin');
    assign(account.db, 'ra-3', 'role-editor', { type: 'group', target: 'group:grp-1' });
    // Expired, of another tenant's role, and of a role the tenant has deleted: none grants.
    assign(account.db, 'ra-4', 'role-editor', { type: 'global', target: '' }, NOW - 1);
    assign(account.db, 'ra-5', 'role-other-tenant');
    assign(account.db, 'ra-6', 'role-deleted');
    // An assignment found in the metadata database is not the account's.
    assign(metadata.db, 'ra-7', 'role-editor');

    join('m-1', 'grp-2');
    join('m-2', 'grp-1');
    join('m-3', 'grp-3');
    join('m-4', 'grp-deleted');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the roles of the account database by the metadata database', async () => {
    await expect(resolveEffectiveRoles(dbs, 'user-1', 'tenant-a')).resolves.toEqual([
      'admin',
      'editor',
      'viewer',
    ]);
    await expect(resolveScopedRoles(dbs, 'user-1', 'tenant-a')).resolves.toEqual([
      { name: 'admin', scope: 'global' },
      { name: 'editor', scope: 'group', scopeTarget: 'group:grp-1' },
      { name: 'viewer', scope: 'global' },
    ]);
    // Tenant-wide permissions only: editor is assigned for grp-1 alone (its global one expired).
    await expect(resolvePermissions(dbs, 'user-1', 'tenant-a')).resolves.toEqual([
      'documents:read',
      'users:read',
      'users:write',
    ]);
  });

  it('leaves out of the scoped role claim an assignment of the removed organisation scope', async () => {
    assign(account.db, 'ra-org', 'role-admin', { type: 'org', target: 'org:o1' });
    assign(account.db, 'ra-bare', 'role-viewer', { type: 'group', target: 'grp-2' });
    await expect(resolveScopedRoles(dbs, 'user-1', 'tenant-a')).resolves.toEqual([
      { name: 'admin', scope: 'global' },
      { name: 'editor', scope: 'group', scopeTarget: 'group:grp-1' },
      { name: 'viewer', scope: 'global' },
    ]);
  });

  it('gives the active groups of the account database, by key', async () => {
    await expect(resolveSubjectGroupClaims(dbs, 'tenant-a', 'user-1')).resolves.toEqual([
      { id: 'grp-1', key: 'acme', name: 'Acme', kind: 'static' },
      { id: 'grp-2', key: 'beta', name: 'Beta', kind: 'static' },
    ]);
  });

  it('builds the token claims from both databases', async () => {
    await expect(getUserRBACClaims(dbs, 'user-1', 'tenant-a')).resolves.toEqual({
      authrim_roles: ['admin', 'viewer'],
      authrim_groups: [
        { id: 'grp-1', key: 'acme', name: 'Acme', kind: 'static' },
        { id: 'grp-2', key: 'beta', name: 'Beta', kind: 'static' },
      ],
      authrim_user_type: 'end_user',
    });
    // An organisation claim name is no longer one: it gives nothing.
    await expect(
      getIDTokenRBACClaimsConfigurable(dbs, 'user-1', 'roles,org_name,orgs', 'tenant-a')
    ).resolves.toEqual({ authrim_roles: ['admin', 'viewer'] });
    await expect(
      getAccessTokenRBACClaims(dbs, 'user-1', {
        tenantId: 'tenant-a',
        claimsConfig: 'roles,org_id,permissions',
      })
    ).resolves.toEqual({
      authrim_roles: ['admin', 'viewer'],
      authrim_permissions: ['documents:read', 'users:read', 'users:write'],
    });
    const composite = await getCompositeRBACCache(dbs, 'user-1', { tenantId: 'tenant-a' });
    expect(composite).toEqual(expect.objectContaining({ roles: ['admin', 'viewer'] }));
    expect(Object.keys(composite).filter((key) => key.startsWith('org') || key === 'plan')).toEqual(
      []
    );
  });

  it('gives the default ID token claims, the composite cache default, when no config is set', async () => {
    const claims = await getIDTokenRBACClaims(dbs, 'user-1', { tenantId: 'tenant-a' });
    expect(claims).toEqual(
      extractIDTokenClaimsFromCache(
        await getCompositeRBACCache(dbs, 'user-1', { tenantId: 'tenant-a' })
      )
    );
    expect(claims.authrim_permissions).toEqual(['documents:read', 'users:read', 'users:write']);
    expect(claims).not.toHaveProperty('authrim_org_id');
  });

  it('gives nothing from the metadata database alone (as one database for both)', async () => {
    const metadataOnly = { metadata: metadata.adapter, account: metadata.adapter };
    await expect(resolveEffectiveRoles(metadataOnly, 'user-1', 'tenant-a')).resolves.toEqual([
      'editor',
    ]);
    await expect(resolveSubjectGroupClaims(metadataOnly, 'tenant-a', 'user-1')).resolves.toEqual(
      []
    );
  });

  it('embeds the permissions of the account roles for the requested scope', async () => {
    const embedding = await evaluatePermissionEmbeddingForScope(
      dbs,
      'user-1',
      'openid users:write documents:write billing:read',
      { tenantId: 'tenant-a' }
    );
    expect(embedding.permissions).toEqual(['users:write']);
    expect(embedding.scopedPermissions).toEqual([
      expect.objectContaining({ permission: 'documents:write' }),
    ]);
  });

  it('embeds nothing from an assignment with an unknown scope or without its target', async () => {
    role('role-billing', 'tenant-a', 'billing', ['billing:read']);
    assign(account.db, 'ra-blank', 'role-billing', { type: '', target: '' });
    assign(account.db, 'ra-region', 'role-billing', { type: 'region', target: '' });
    assign(account.db, 'ra-group-blank', 'role-billing', { type: 'group', target: '' });
    // The organisation scope is gone: an assignment that still names it grants nothing.
    assign(account.db, 'ra-org', 'role-billing', { type: 'org', target: 'org:org-1' });

    const embedding = await evaluatePermissionEmbeddingForScope(dbs, 'user-1', 'billing:read', {
      tenantId: 'tenant-a',
    });

    expect(embedding).toEqual({ permissions: [], scopedPermissions: [] });
  });

  it('embeds a global assignment with an empty target as tenant-wide', async () => {
    // ra-1 and ra-2 are global with an empty target, as the Admin API and invitations write them.
    const embedding = await evaluatePermissionEmbeddingForScope(dbs, 'user-1', 'users:read', {
      tenantId: 'tenant-a',
    });

    expect(embedding.permissions).toEqual(['users:read']);
  });

  it('grants resource permissions of the metadata database to the account roles', async () => {
    const grant = (id: string, subjectType: string, subjectId: string, resourceId: string) =>
      metadata.db
        .prepare(
          `INSERT INTO resource_permissions (id, tenant_id, subject_type, subject_id,
             resource_type, resource_id, actions_json, is_active, created_at, updated_at)
           VALUES (?, 'tenant-a', ?, ?, 'documents', ?, '["read"]', 1, ?, ?)`
        )
        .run(id, subjectType, subjectId, resourceId, NOW, NOW);
    grant('rp-1', 'role', 'role-viewer', 'doc-1');
    grant('rp-2', 'user', 'user-1', 'doc-2');
    grant('rp-3', 'role', 'role-other-tenant', 'doc-3');
    // A grant to one of the subject's groups counts; one to a suspended group or another group
    // does not.
    grant('rp-4', 'group', 'grp-2', 'doc-4');
    grant('rp-5', 'group', 'grp-3', 'doc-5');
    grant('rp-6', 'group', 'grp-other', 'doc-6');

    await expect(evaluateIdLevelPermissions(dbs, 'user-1', 'tenant-a')).resolves.toEqual([
      'documents:doc-1:read',
      'documents:doc-2:read',
      'documents:doc-4:read',
    ]);
    await expect(
      hasIdLevelPermission(dbs, 'user-1', 'documents', 'doc-1', 'read', 'tenant-a')
    ).resolves.toBe(true);
    await expect(
      hasIdLevelPermission(dbs, 'user-1', 'documents', 'doc-3', 'read', 'tenant-a')
    ).resolves.toBe(false);
  });

  it('grants resource permissions of a scoped role only where the role is assigned', async () => {
    // role-editor is assigned for grp-1 only (ra-3); its global assignment expired (ra-4).
    metadata.db
      .prepare(
        `INSERT INTO resource_permissions (id, tenant_id, subject_type, subject_id,
           resource_type, resource_id, actions_json, is_active, created_at, updated_at)
         VALUES ('rp-9', 'tenant-a', 'role', 'role-editor', 'documents', 'doc-9', '["write"]', 1,
           ?, ?)`
      )
      .run(NOW, NOW);
    const writes = (groupId?: string) =>
      hasIdLevelPermission(dbs, 'user-1', 'documents', 'doc-9', 'write', 'tenant-a', {
        groupIds: groupId ? [groupId] : [],
      });

    await expect(writes('grp-1')).resolves.toBe(true);
    await expect(writes('grp-2')).resolves.toBe(false);
    // Where the resource's groups are not known (token embedding), a group-scoped role grants
    // nothing.
    await expect(writes()).resolves.toBe(false);
    await expect(evaluateIdLevelPermissions(dbs, 'user-1', 'tenant-a')).resolves.not.toContain(
      'documents:doc-9:write'
    );
  });
});
