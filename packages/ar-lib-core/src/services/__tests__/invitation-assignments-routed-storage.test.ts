import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import {
  applyExternalSignupInvitation,
  reserveExternalSignupInvitation,
} from '../external-signup-invitation';

const NOW = Math.floor(Date.now() / 1000);

function openDatabase(): { db: DatabaseSync; adapter: DatabaseAdapter } {
  const opened = sqliteAdapter();
  const adapter = {
    ...opened.adapter,
    transaction: async () => {
      throw new Error('not used');
    },
    isHealthy: async () => ({ healthy: true, latencyMs: 0 }),
    getType: () => 'sqlite',
    close: async () => undefined,
  } as DatabaseAdapter;
  opened.db
    .prepare(
      `INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
       VALUES ('tenant-a', 'code-a', 'key-a', 'Tenant A', ?, ?)`
    )
    .run(NOW, NOW);
  return { db: opened.db, adapter };
}

/**
 * Routed account storage keeps tenant settings (roles, organisations, invitations) in the tenant
 * metadata database (`tenant_core/default`) and the account's rows (users_core, role_assignments,
 * subject_org_membership) in its account database (`tenant_core/users`). Two separate SQLite
 * databases stand in for the two D1 databases, so nothing can be found by reading the wrong one.
 */
describe('invitation assignments under routed account storage', () => {
  let metadata: { db: DatabaseSync; adapter: DatabaseAdapter };
  let account: { db: DatabaseSync; adapter: DatabaseAdapter };
  const log = { warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    metadata = openDatabase();
    account = openDatabase();
    metadata.db
      .prepare(
        `INSERT INTO roles (id, tenant_id, name, permissions_json, created_at, role_type, is_system)
         VALUES ('role-1', 'tenant-a', 'member', '[]', ?, 'custom', 0)`
      )
      .run(NOW);
    metadata.db
      .prepare(
        `INSERT INTO organizations (id, tenant_id, name, created_at, updated_at)
         VALUES ('org-1', 'tenant-a', 'Org One', ?, ?)`
      )
      .run(NOW, NOW);
    metadata.db
      .prepare(
        `INSERT INTO tenant_invitations
         (id, token, tenant_id, invited_email, invited_by, role_id, org_id, max_uses, use_count,
          expires_at, created_at, updated_at)
         VALUES ('inv-1', 'token-1', 'tenant-a', NULL, 'admin-1', 'role-1', 'org-1', 1, 0, ?, ?, ?)`
      )
      .run(NOW + 86_400, NOW, NOW);
    account.db
      .prepare(
        `INSERT INTO users_core (id, tenant_id, created_at, updated_at)
         VALUES ('user-new', 'tenant-a', ?, ?)`
      )
      .run(NOW, NOW);
  });

  it("gives the invited role and organisation to the new account, in the account's database", async () => {
    const reserved = await reserveExternalSignupInvitation(metadata.adapter, {
      token: 'token-1',
      tenantId: 'tenant-a',
      holder: 'external:flow-1',
      ttlSeconds: 900,
    });
    expect(reserved).not.toBeNull();

    const applied = await applyExternalSignupInvitation(
      () => metadata.adapter,
      account.adapter,
      log,
      { ...reserved!, tenantId: 'tenant-a', userId: 'user-new' }
    );

    expect(applied).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    expect(
      account.db
        .prepare(
          `SELECT subject_id, role_id, scope_type, scope_target FROM role_assignments
           WHERE tenant_id = 'tenant-a'`
        )
        .all()
    ).toEqual([
      { subject_id: 'user-new', role_id: 'role-1', scope_type: 'global', scope_target: '' },
    ]);
    expect(
      account.db
        .prepare(
          `SELECT subject_id, org_id, membership_type FROM subject_org_membership
           WHERE tenant_id = 'tenant-a'`
        )
        .all()
    ).toEqual([{ subject_id: 'user-new', org_id: 'org-1', membership_type: 'member' }]);
  });
});
