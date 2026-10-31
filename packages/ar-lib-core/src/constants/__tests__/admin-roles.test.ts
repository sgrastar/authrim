import { readMigrationSource } from '../../../../../test/helpers/migration-source.mjs';

import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROLE_DEFINITIONS,
  ADMIN_ROLE_GROUPS,
  ADMIN_ROLES,
  isReservedAdminRoleName,
  isStandardAdminRole,
} from '../admin-roles';
import { ADMIN_PERMISSIONS, hasAdminPermission } from '../../types/admin-user';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

function sql(path: string): string {
  return renderPortableMigrationSql(
    readMigrationSource(dirname(resolve(REPO_ROOT, path)), basename(path))
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', '1')
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '1000'),
    'sqlite'
  );
}

const byName = (name: string) => ADMIN_ROLE_DEFINITIONS.find((role) => role.name === name)!;
const allPermissions = Object.values(ADMIN_PERMISSIONS) as string[];
const namespaces = new Set(allPermissions.map((permission) => permission.split(':')[1]));

describe('standard Admin roles', () => {
  it('names four roles, all under the reserved prefix', () => {
    expect(Object.values(ADMIN_ROLES)).toEqual([
      'ar_super_admin',
      'ar_tenant_admin',
      'ar_support',
      'ar_viewer',
    ]);
    for (const name of Object.values(ADMIN_ROLES)) {
      expect(isReservedAdminRoleName(name)).toBe(true);
      expect(isStandardAdminRole(name)).toBe(true);
    }
    expect(isReservedAdminRoleName('AR_anything')).toBe(true);
    expect(isReservedAdminRoleName('operator')).toBe(false);
    expect(isStandardAdminRole('admin')).toBe(false);
    expect(ADMIN_ROLE_DEFINITIONS.map(({ id }) => id)).toEqual([
      'role_ar_super_admin',
      'role_ar_tenant_admin',
      'role_ar_support',
      'role_ar_viewer',
    ]);
  });

  it('orders the hierarchy super > tenant admin > support > viewer', () => {
    const levels = ADMIN_ROLE_DEFINITIONS.map((role) => role.hierarchyLevel);
    expect(levels).toEqual([...levels].sort((a, b) => b - a));
    expect(new Set(levels).size).toBe(levels.length);
  });

  it('lets only the super admin skip role checks and hold the wildcard', () => {
    expect(byName(ADMIN_ROLES.SUPER_ADMIN).permissions).toEqual(['*']);
    expect(ADMIN_ROLE_GROUPS.platform).toEqual([ADMIN_ROLES.SUPER_ADMIN]);
    for (const role of ADMIN_ROLE_DEFINITIONS.slice(1)) {
      expect(role.permissions).not.toContain('*');
      expect(role.permissions).not.toContain('admin:*');
    }
  });

  it('lists only permissions that exist, or a namespace wildcard of one that does', () => {
    for (const role of ADMIN_ROLE_DEFINITIONS.slice(1)) {
      for (const permission of role.permissions) {
        if (permission.endsWith(':*')) {
          expect(namespaces.has(permission.split(':')[1]), `${role.name}: ${permission}`).toBe(
            true
          );
        } else {
          expect(allPermissions, `${role.name}: ${permission}`).toContain(permission);
        }
      }
    }
  });

  it('keeps every platform-only permission away from the tenant admin', () => {
    const tenantAdmin = [...byName(ADMIN_ROLES.TENANT_ADMIN).permissions];
    const platformOnly = [
      'admin:control_plane:read',
      'admin:control_plane:provision',
      'admin:database_connections:read',
      'admin:database_routing:switch',
      'admin:tenants:lifecycle:standard',
      'admin:tenants:lifecycle:break_glass',
      'admin:tenant_domains:write',
      'admin:storage_destinations:read',
      'admin:backups:manage',
      'admin:logging:platform_defaults:update',
      'admin:logging:dlq:purge',
      'admin:admin_logging:repair:run',
      'admin:saml_providers:signing:dr_bundle:export',
      'admin:saml_providers:signing:dr_bundle:import',
      'admin:support_ops:break_glass:request',
      'admin:support_ops:break_glass:reveal',
      'admin:dr_backup:destination:select',
      'admin:diagnostic_logging:destination:select',
    ];
    for (const permission of platformOnly) {
      expect(allPermissions, permission).toContain(permission);
      expect(hasAdminPermission(tenantAdmin, permission), permission).toBe(false);
    }
  });

  it('keeps secrets away from the viewer and approval away from support', () => {
    const viewer = [...byName(ADMIN_ROLES.VIEWER).permissions];
    for (const permission of [
      'admin:clients:secret:rotate',
      'admin:webhooks:payload:read',
      'admin:email_deliveries:recipient:full:read',
      'admin:operational_logs:detail:read',
      'admin:support_ops:break_glass:reveal',
      'admin:users:write',
      'admin:settings:write',
    ]) {
      expect(hasAdminPermission(viewer, permission), permission).toBe(false);
    }
    const support = [...byName(ADMIN_ROLES.SUPPORT).permissions];
    expect(hasAdminPermission(support, 'admin:support_ops:actions:request')).toBe(true);
    expect(hasAdminPermission(support, 'admin:support_ops:actions:approve')).toBe(false);
    expect(hasAdminPermission(support, 'admin:support_ops:actions:execute')).toBe(false);
    expect(hasAdminPermission(support, 'admin:users:unlock')).toBe(true);
    expect(hasAdminPermission(support, 'admin:users:write')).toBe(false);
    expect(hasAdminPermission(viewer, 'admin:audit:read')).toBe(true);
  });

  it('gives the tenant admin settings writes, ReBAC, IP allow lists and full recipients', () => {
    const tenantAdmin = [...byName(ADMIN_ROLES.TENANT_ADMIN).permissions];
    for (const permission of [
      'admin:settings:write',
      'admin:policy:rebac:write',
      'admin:roles:write',
      'admin:ip_allowlist:write',
      'admin:security:write',
      'admin:email_deliveries:recipient:full:read',
      'admin:support_ops:actions:approve',
      'admin:admin_users:write',
      'admin:admin_roles:write',
    ]) {
      expect(hasAdminPermission(tenantAdmin, permission), permission).toBe(true);
    }
  });
});

describe('migration 054 (ar_ roles)', () => {
  const baseline = 'migrations/admin/d1/001_0_4_0_admin_baseline.sql';
  const migration = 'migrations/admin/d1/054_admin_roles_ar_prefix.sql';

  function prepared(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(sql(baseline));
    return db;
  }

  function user(db: DatabaseSync, id: string, tenant = 'default') {
    db.prepare(
      `INSERT INTO admin_users (id, tenant_id, email, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`
    ).run(id, tenant, `${id}@example.com`);
  }

  function assign(db: DatabaseSync, id: string, userId: string, roleId: string, scope: string) {
    db.prepare(
      `INSERT INTO admin_role_assignments (id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, created_at)
       VALUES (?, 'default', ?, ?, ?, ?, 1)`
    ).run(id, userId, roleId, scope, scope === 'tenant' ? 'default' : null);
  }

  const rolesOf = (db: DatabaseSync, userId: string) =>
    (
      db
        .prepare(
          `SELECT r.name AS name, a.scope_type AS scope
             FROM admin_role_assignments a JOIN admin_roles r ON r.id = a.admin_role_id
            WHERE a.admin_user_id = ? ORDER BY r.name, a.scope_type`
        )
        .all(userId) as { name: string; scope: string }[]
    ).map(({ name, scope }) => `${name}/${scope}`);

  it('seeds exactly the definitions in the TypeScript module', () => {
    const db = prepared();
    db.exec(sql(migration));
    const rows = db
      .prepare(
        `SELECT id, name, display_name, description, permissions_json, hierarchy_level, role_type, is_system
           FROM admin_roles WHERE name LIKE 'ar\\_%' ESCAPE '\\' ORDER BY hierarchy_level DESC`
      )
      .all() as Record<string, unknown>[];
    expect(rows).toEqual(
      ADMIN_ROLE_DEFINITIONS.map((role) => ({
        id: role.id,
        name: role.name,
        display_name: role.displayName,
        description: role.description,
        permissions_json: JSON.stringify(role.permissions).replace(/","/g, '", "'),
        hierarchy_level: role.hierarchyLevel,
        role_type: 'system',
        is_system: 1,
      }))
    );
  });

  it('removes the old standard roles and keeps the other built-in ones', () => {
    const db = prepared();
    db.exec(sql(migration));
    const names = (
      db.prepare('SELECT name FROM admin_roles ORDER BY name').all() as { name: string }[]
    ).map(({ name }) => name);
    for (const old of ['super_admin', 'security_admin', 'admin', 'support', 'viewer']) {
      expect(names).not.toContain(old);
    }
    expect(names).toContain('storage_destination_admin');
    expect(names).toContain('platform_database_viewer');
  });

  it('moves assignments, merges admin and security_admin, and demotes a tenant-scoped super admin', () => {
    const db = prepared();
    for (const id of ['root', 'ops', 'both', 'help', 'look', 'tenantroot']) user(db, id);
    assign(db, 'a1', 'root', 'role_super_admin', 'global');
    assign(db, 'a2', 'ops', 'role_admin', 'tenant');
    assign(db, 'a3', 'both', 'role_admin', 'tenant');
    assign(db, 'a4', 'both', 'role_security_admin', 'tenant');
    assign(db, 'a5', 'help', 'role_support', 'tenant');
    assign(db, 'a6', 'look', 'role_viewer', 'global');
    assign(db, 'a7', 'tenantroot', 'role_super_admin', 'tenant');

    db.exec(sql(migration));

    expect(rolesOf(db, 'root')).toEqual(['ar_super_admin/global']);
    expect(rolesOf(db, 'ops')).toEqual(['ar_tenant_admin/tenant']);
    expect(rolesOf(db, 'both')).toEqual(['ar_tenant_admin/tenant']);
    expect(rolesOf(db, 'help')).toEqual(['ar_support/tenant']);
    expect(rolesOf(db, 'look')).toEqual(['ar_viewer/global']);
    expect(rolesOf(db, 'tenantroot')).toEqual(['ar_tenant_admin/tenant']);
  });

  it('keeps the longer of two assignments that merge into one, and no expiry above any expiry', () => {
    const db = prepared();
    for (const id of ['a', 'b', 'c']) user(db, id);
    const at = (id: string, userId: string, roleId: string, expiresAt: number | null) => {
      assign(db, id, userId, roleId, 'tenant');
      db.prepare('UPDATE admin_role_assignments SET expires_at = ? WHERE id = ?').run(
        expiresAt,
        id
      );
    };
    // admin expired early, security_admin never expires: the account must stay an administrator.
    at('a1', 'a', 'role_admin', 1000);
    at('a2', 'a', 'role_security_admin', null);
    // Both end: the later end is kept, whichever role carried it.
    at('b1', 'b', 'role_admin', 5000);
    at('b2', 'b', 'role_security_admin', 9000);
    // The one that is read first is the one that never expires.
    at('c1', 'c', 'role_admin', null);
    at('c2', 'c', 'role_security_admin', 3000);

    db.exec(sql(migration));

    const expiry = (userId: string) =>
      db
        .prepare('SELECT expires_at AS e FROM admin_role_assignments WHERE admin_user_id = ?')
        .all(userId) as { e: number | null }[];
    expect(expiry('a')).toEqual([{ e: null }]);
    expect(expiry('b')).toEqual([{ e: 9000 }]);
    expect(expiry('c')).toEqual([{ e: null }]);
  });

  it('renames a custom role that already carries the reserved prefix instead of failing', () => {
    const db = prepared();
    db.prepare(
      `INSERT INTO admin_roles (id, tenant_id, name, permissions_json, hierarchy_level, role_type, is_system, created_at, updated_at)
       VALUES ('c-default', 'default', 'ar_super_admin', '[]', 1, 'custom', 0, 1, 1),
              ('c-other', 'tenant-b', 'AR_Tenant_Admin', '[]', 1, 'custom', 0, 1, 1)`
    ).run();

    db.exec(sql(migration));

    const names = db
      .prepare(
        `SELECT id, name, is_system FROM admin_roles WHERE id IN ('c-default', 'c-other') ORDER BY id`
      )
      .all();
    expect(names).toEqual([
      { id: 'c-default', name: 'custom_c-default', is_system: 0 },
      { id: 'c-other', name: 'custom_c-other', is_system: 0 },
    ]);
    expect(
      db.prepare(`SELECT is_system FROM admin_roles WHERE name = 'ar_super_admin'`).get()
    ).toEqual({ is_system: 1 });
  });

  it('does not stop when the renamed custom role would take a name that is already used', () => {
    const db = prepared();
    db.prepare(
      `INSERT INTO admin_roles (id, tenant_id, name, permissions_json, hierarchy_level, role_type, is_system, created_at, updated_at)
       VALUES ('c1', 'tenant-b', 'ar_support', '[]', 1, 'custom', 0, 1, 1),
              ('c2', 'tenant-b', 'custom_ar_support', '[]', 1, 'custom', 0, 1, 1),
              ('c3', 'tenant-b', 'custom_ar_support_c1', '[]', 1, 'custom', 0, 1, 1)`
    ).run();

    expect(() => db.exec(sql(migration))).not.toThrow();

    const names = (
      db.prepare(`SELECT name FROM admin_roles WHERE tenant_id = 'tenant-b' ORDER BY id`).all() as {
        name: string;
      }[]
    ).map(({ name }) => name);
    expect(new Set(names).size).toBe(3);
    expect(names).not.toContain('ar_support');
    expect(names).toContain('custom_ar_support');
    expect(names).toContain('custom_ar_support_c1');
    // The name it had stays visible.
    expect(db.prepare("SELECT display_name AS d FROM admin_roles WHERE id = 'c1'").get()).toEqual({
      d: 'ar_support',
    });
  });

  it('gives a role a random suffix when custom_<id> is taken, and keeps its invitation in step', () => {
    const db = prepared();
    user(db, 'invitee-c');
    db.prepare(
      `INSERT INTO admin_roles (id, tenant_id, name, permissions_json, hierarchy_level, role_type, is_system, created_at, updated_at)
       VALUES ('x1', 'tenant-b', 'ar_super_admin', '[]', 1, 'custom', 0, 1, 1),
              ('x2', 'tenant-b', 'custom_x1', '[]', 1, 'custom', 0, 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO admin_invitations (
         id, tenant_id, admin_user_id, email, pending_email_key, code_hash, status, admin_role_id,
         admin_role_name, scope_type, scope_id, expires_at, last_sent_at, created_by, created_at, updated_at)
       VALUES ('i-custom', 'tenant-b', 'invitee-c', 'c@example.com', 'c@example.com', 'h', 'pending',
         'x1', 'ar_super_admin', 'tenant', 'tenant-b', 9, 1, 'root', 1, 1)`
    ).run();

    expect(() => db.exec(sql(migration))).not.toThrow();

    const renamed = db.prepare("SELECT name FROM admin_roles WHERE id = 'x1'").get() as {
      name: string;
    };
    expect(renamed.name).toMatch(/^custom_x1_[0-9a-f]{16}$/);
    expect(db.prepare("SELECT name FROM admin_roles WHERE id = 'x2'").get()).toEqual({
      name: 'custom_x1',
    });
    // The invitation no longer reads as an invitation to the platform role.
    expect(
      db.prepare("SELECT admin_role_name AS n FROM admin_invitations WHERE id = 'i-custom'").get()
    ).toEqual({ n: renamed.name });
  });

  it('never leaves a duplicate tenant-scoped super admin as ar_super_admin', () => {
    const db = prepared();
    user(db, 'dup');
    // The tenant's own copy of the old system role, next to the default one.
    db.prepare(
      `INSERT INTO admin_roles (id, tenant_id, name, permissions_json, hierarchy_level, role_type, is_system, created_at, updated_at)
       VALUES ('copy-super', 'tenant-a', 'super_admin', '["*"]', 100, 'system', 1, 1, 1)`
    ).run();
    assign(db, 'd1', 'dup', 'role_super_admin', 'tenant');
    assign(db, 'd2', 'dup', 'copy-super', 'tenant');

    db.exec(sql(migration));

    expect(rolesOf(db, 'dup')).toEqual(['ar_tenant_admin/tenant']);
  });

  it('moves a tenant-scoped super admin invitation to ar_tenant_admin, like the assignment', () => {
    const db = prepared();
    for (const id of ['inv-g', 'inv-t']) user(db, id);
    const invite = (id: string, userId: string, scope: string, scopeId: string | null) =>
      db
        .prepare(
          `INSERT INTO admin_invitations (
             id, tenant_id, admin_user_id, email, pending_email_key, code_hash, status, admin_role_id,
             admin_role_name, scope_type, scope_id, expires_at, last_sent_at, created_by, created_at, updated_at)
           VALUES (?, 'default', ?, ?, ?, 'h', 'pending', 'role_super_admin', 'super_admin', ?, ?, 9, 1, 'root', 1, 1)`
        )
        .run(id, userId, `${id}@example.com`, `${id}@example.com`, scope, scopeId);
    invite('i-global', 'inv-g', 'global', null);
    invite('i-tenant', 'inv-t', 'tenant', 'default');

    db.exec(sql(migration));

    expect(
      db
        .prepare(
          'SELECT id, admin_role_id AS r, admin_role_name AS n FROM admin_invitations ORDER BY id'
        )
        .all()
    ).toEqual([
      { id: 'i-global', r: 'role_ar_super_admin', n: 'ar_super_admin' },
      { id: 'i-tenant', r: 'role_ar_tenant_admin', n: 'ar_tenant_admin' },
    ]);
  });

  it('renames the role of an invitation and repoints a role that inherited an old one', () => {
    const db = prepared();
    user(db, 'invitee');
    db.prepare(
      `INSERT INTO admin_invitations (
         id, tenant_id, admin_user_id, email, pending_email_key, code_hash, status, admin_role_id,
         admin_role_name, scope_type, scope_id, expires_at, last_sent_at, created_by, created_at, updated_at)
       VALUES ('i1', 'default', 'invitee', 'invitee@example.com', 'invitee@example.com', 'h', 'pending',
         'role_admin', 'admin', 'tenant', 'default', 9, 1, 'root', 1, 1)`
    ).run();
    db.prepare(
      `INSERT INTO admin_roles (id, tenant_id, name, permissions_json, hierarchy_level, role_type, is_system,
         created_at, updated_at, inherits_from)
       VALUES ('custom1', 'default', 'billing', '[]', 10, 'custom', 0, 1, 1, 'role_viewer')`
    ).run();

    db.exec(sql(migration));

    expect(
      db.prepare(`SELECT admin_role_id AS id, admin_role_name AS name FROM admin_invitations`).get()
    ).toEqual({ id: 'role_ar_tenant_admin', name: 'ar_tenant_admin' });
    expect(
      db.prepare(`SELECT inherits_from AS id FROM admin_roles WHERE id = 'custom1'`).get()
    ).toEqual({
      id: 'role_ar_viewer',
    });
  });
});
