import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import type { TenantRBACDatabases } from '../../services/tenant-rbac';
import {
  getAccessTokenRBACClaims,
  getCompositeRBACCache,
  getIDTokenRBACClaimsConfigurable,
  getUserRBACClaims,
  resolveAllOrganizations,
  resolveEffectiveRoles,
  resolveOrganizationInfo,
  resolveOrganizationName,
  resolvePermissions,
  resolveScopedRoles,
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
 * Token RBAC claims under routed account storage: roles and organisations are defined in the
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

  function organization(id: string, name: string, active = 1) {
    metadata.db
      .prepare(
        `INSERT INTO organizations (id, tenant_id, name, org_type, plan, is_active, created_at,
           updated_at)
         VALUES (?, 'tenant-a', ?, 'enterprise', 'professional', ?, ?, ?)`
      )
      .run(id, name, active, NOW, NOW);
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

  function join(id: string, orgId: string, primary: number) {
    account.db
      .prepare(
        `INSERT INTO subject_org_membership (id, tenant_id, subject_id, org_id, membership_type,
           is_primary, created_at, updated_at)
         VALUES (?, 'tenant-a', 'user-1', ?, 'member', ?, ?, ?)`
      )
      .run(id, orgId, primary, NOW, NOW);
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
          `INSERT INTO users_core (id, tenant_id, created_at, updated_at)
           VALUES ('user-1', 'tenant-a', ?, ?)`
        )
        .run(NOW, NOW);
    }

    role('role-admin', 'tenant-a', 'admin', ['users:write', 'users:read']);
    role('role-viewer', 'tenant-a', 'viewer', ['users:read', 'documents:read']);
    role('role-editor', 'tenant-a', 'editor', ['documents:write']);
    role('role-other-tenant', 'tenant-b', 'intruder', ['*:*']);
    organization('org-1', 'Acme');
    organization('org-2', 'Beta');
    organization('org-3', 'Closed', 0);

    assign(account.db, 'ra-1', 'role-viewer');
    assign(account.db, 'ra-2', 'role-admin');
    assign(account.db, 'ra-3', 'role-editor', { type: 'org', target: 'org:org-1' });
    // Expired, of another tenant's role, and of a role the tenant has deleted: none grants.
    assign(account.db, 'ra-4', 'role-editor', { type: 'global', target: '' }, NOW - 1);
    assign(account.db, 'ra-5', 'role-other-tenant');
    assign(account.db, 'ra-6', 'role-deleted');
    // An assignment found in the metadata database is not the account's.
    assign(metadata.db, 'ra-7', 'role-editor');

    join('m-1', 'org-2', 0);
    join('m-2', 'org-1', 1);
    join('m-3', 'org-3', 0);
    join('m-4', 'org-deleted', 0);
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
      { name: 'editor', scope: 'org', scopeTarget: 'org:org-1' },
      { name: 'viewer', scope: 'global' },
    ]);
    // Tenant-wide permissions only: editor is assigned in org-1 alone (its global one expired).
    await expect(resolvePermissions(dbs, 'user-1', 'tenant-a')).resolves.toEqual([
      'documents:read',
      'users:read',
      'users:write',
    ]);
  });

  it('gives the active organisations of the account database, primary first', async () => {
    await expect(resolveOrganizationInfo(dbs, 'user-1', 'tenant-a')).resolves.toEqual({
      org_id: 'org-1',
      plan: 'professional',
      org_type: 'enterprise',
    });
    await expect(resolveOrganizationName(dbs, 'user-1', 'tenant-a')).resolves.toBe('Acme');
    await expect(resolveAllOrganizations(dbs, 'user-1', 'tenant-a')).resolves.toEqual([
      { id: 'org-1', name: 'Acme', type: 'enterprise', is_primary: true },
      { id: 'org-2', name: 'Beta', type: 'enterprise', is_primary: false },
    ]);
  });

  it('builds the token claims from both databases', async () => {
    await expect(getUserRBACClaims(dbs, 'user-1', 'tenant-a')).resolves.toEqual({
      authrim_roles: ['admin', 'editor', 'viewer'],
      authrim_user_type: 'end_user',
      authrim_org_id: 'org-1',
      authrim_plan: 'professional',
      authrim_org_type: 'enterprise',
    });
    await expect(
      getIDTokenRBACClaimsConfigurable(dbs, 'user-1', 'roles,org_name,orgs', 'tenant-a')
    ).resolves.toEqual({
      authrim_roles: ['admin', 'editor', 'viewer'],
      authrim_org_name: 'Acme',
      authrim_orgs: [
        { id: 'org-1', name: 'Acme', type: 'enterprise', is_primary: true },
        { id: 'org-2', name: 'Beta', type: 'enterprise', is_primary: false },
      ],
    });
    await expect(
      getAccessTokenRBACClaims(dbs, 'user-1', {
        tenantId: 'tenant-a',
        claimsConfig: 'roles,org_id,permissions',
      })
    ).resolves.toEqual({
      authrim_roles: ['admin', 'editor', 'viewer'],
      authrim_org_id: 'org-1',
      authrim_permissions: ['documents:read', 'users:read', 'users:write'],
    });
    await expect(getCompositeRBACCache(dbs, 'user-1', { tenantId: 'tenant-a' })).resolves.toEqual(
      expect.objectContaining({
        roles: ['admin', 'editor', 'viewer'],
        org_id: 'org-1',
        org_name: 'Acme',
      })
    );
  });

  it('gives nothing from the metadata database alone (as one database for both)', async () => {
    const metadataOnly = { metadata: metadata.adapter, account: metadata.adapter };
    await expect(resolveEffectiveRoles(metadataOnly, 'user-1', 'tenant-a')).resolves.toEqual([
      'editor',
    ]);
    await expect(resolveAllOrganizations(metadataOnly, 'user-1', 'tenant-a')).resolves.toEqual([]);
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
    assign(account.db, 'ra-org-blank', 'role-billing', { type: 'org', target: '' });

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

    await expect(evaluateIdLevelPermissions(dbs, 'user-1', 'tenant-a')).resolves.toEqual([
      'documents:doc-1:read',
      'documents:doc-2:read',
    ]);
    await expect(
      hasIdLevelPermission(dbs, 'user-1', 'documents', 'doc-1', 'read', 'tenant-a')
    ).resolves.toBe(true);
    await expect(
      hasIdLevelPermission(dbs, 'user-1', 'documents', 'doc-3', 'read', 'tenant-a')
    ).resolves.toBe(false);
  });

  it('grants resource permissions of a scoped role only where the role is assigned', async () => {
    // role-editor is assigned in org-1 only (ra-3); its global assignment expired (ra-4).
    metadata.db
      .prepare(
        `INSERT INTO resource_permissions (id, tenant_id, subject_type, subject_id,
           resource_type, resource_id, actions_json, is_active, created_at, updated_at)
         VALUES ('rp-9', 'tenant-a', 'role', 'role-editor', 'documents', 'doc-9', '["write"]', 1,
           ?, ?)`
      )
      .run(NOW, NOW);
    const writes = (orgId?: string) =>
      hasIdLevelPermission(dbs, 'user-1', 'documents', 'doc-9', 'write', 'tenant-a', { orgId });

    await expect(writes('org-1')).resolves.toBe(true);
    await expect(writes('org-2')).resolves.toBe(false);
    // Where the resource's organisation is not known (token embedding), an organisation-scoped
    // role grants nothing.
    await expect(writes()).resolves.toBe(false);
    await expect(evaluateIdLevelPermissions(dbs, 'user-1', 'tenant-a')).resolves.not.toContain(
      'documents:doc-9:write'
    );
  });
});
