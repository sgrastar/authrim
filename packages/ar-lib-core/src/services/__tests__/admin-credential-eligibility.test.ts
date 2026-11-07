import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { evaluateAdminCredentialEligibility } from '../admin-credential-eligibility';

const NOW = 1_800_000_000_000;

describe('evaluateAdminCredentialEligibility', () => {
  let sqlite: DatabaseSync;
  let adapter: DatabaseAdapter;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE admin_users (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL, name TEXT,
        is_active INTEGER, status TEXT NOT NULL, locked_until INTEGER);
      CREATE TABLE admin_roles (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, is_system INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE admin_role_assignments (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, admin_user_id TEXT NOT NULL,
        admin_role_id TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT, expires_at INTEGER);
      -- The admin's own assignments; group ones come through the same view in the real schema.
      CREATE VIEW admin_effective_role_assignments AS SELECT * FROM admin_role_assignments;
      INSERT INTO admin_roles VALUES ('role-system', 'default', 1);
      INSERT INTO admin_roles VALUES ('role-acme', 'acme', 0);
      INSERT INTO admin_roles VALUES ('role-other', 'other', 0);
      INSERT INTO admin_users VALUES ('admin-1', 'acme', 'a@example.com', 'Ada', 1, 'active', NULL);
    `);
    const params = (values: unknown[] = []): SQLInputValue[] =>
      values.map((value) => {
        if (value === null || typeof value === 'string' || typeof value === 'number') return value;
        throw new Error('unsupported_test_sql_value');
      });
    adapter = {
      async queryOne<T>(sql: string, values?: unknown[]) {
        return (sqlite.prepare(sql).get(...params(values)) ?? null) as T | null;
      },
    } as unknown as DatabaseAdapter;
  });

  const assign = (
    id: string,
    role: string,
    scope: string,
    scopeId: string | null,
    exp: number | null
  ) =>
    sqlite
      .prepare('INSERT INTO admin_role_assignments VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'acme', 'admin-1', role, scope, scopeId, exp);

  const evaluate = (overrides: Partial<{ tenantId: string; adminUserId: string }> = {}) =>
    evaluateAdminCredentialEligibility(adapter, {
      tenantId: 'acme',
      adminUserId: 'admin-1',
      now: NOW,
      ...overrides,
    });

  it('accepts an active admin with a role effective in the home tenant', async () => {
    assign('ra-1', 'role-acme', 'tenant', 'acme', null);
    await expect(evaluate()).resolves.toEqual({
      eligible: true,
      email: 'a@example.com',
      name: 'Ada',
    });
  });

  it.each([
    ['a global system role', 'role-system', 'global', null, null],
    ['a legacy tenant assignment without scope id', 'role-acme', 'tenant', null, null],
    ['an assignment expiring later (milliseconds)', 'role-acme', 'tenant', 'acme', NOW + 1],
  ])('counts %s', async (_label, role, scope, scopeId, exp) => {
    assign('ra-1', role, scope, scopeId, exp);
    await expect(evaluate()).resolves.toMatchObject({ eligible: true });
  });

  it.each([
    ['no assignment', null],
    ['an expired assignment', () => assign('ra-1', 'role-acme', 'tenant', 'acme', NOW)],
    [
      'an assignment scoped to another tenant',
      () => assign('ra-1', 'role-acme', 'tenant', 'other', null),
    ],
    ["another tenant's custom role", () => assign('ra-1', 'role-other', 'tenant', 'acme', null)],
  ])('refuses %s', async (_label, seed) => {
    if (seed) seed();
    await expect(evaluate()).resolves.toEqual({ eligible: false });
  });

  it.each([
    ['inactive', 'UPDATE admin_users SET is_active = 0'],
    ['suspended', "UPDATE admin_users SET status = 'suspended'"],
    ['locked until later', `UPDATE admin_users SET locked_until = ${NOW + 60_000}`],
  ])('refuses an admin who is %s', async (_label, update) => {
    assign('ra-1', 'role-acme', 'tenant', 'acme', null);
    sqlite.exec(update);
    await expect(evaluate()).resolves.toEqual({ eligible: false });
  });

  it('accepts an admin whose lock has already expired', async () => {
    assign('ra-1', 'role-acme', 'tenant', 'acme', null);
    sqlite.exec(`UPDATE admin_users SET locked_until = ${NOW - 1}`);
    await expect(evaluate()).resolves.toMatchObject({ eligible: true });
  });

  it('never resolves an admin outside the given home tenant', async () => {
    assign('ra-1', 'role-system', 'global', null, null);
    await expect(evaluate({ tenantId: 'other' })).resolves.toEqual({ eligible: false });
    await expect(evaluate({ adminUserId: 'admin-2' })).resolves.toEqual({ eligible: false });
  });
});
