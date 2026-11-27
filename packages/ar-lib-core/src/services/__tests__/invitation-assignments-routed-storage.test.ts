import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { KVNamespace } from '@cloudflare/workers-types';
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
 * Routed account storage keeps tenant settings (roles, groups, invitations) in the tenant
 * metadata database (`tenant_core/default`) and the account's rows (identity_accounts, role_assignments,
 * group_memberships) in its account database (`tenant_core/users`). Two separate SQLite
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
        `INSERT INTO tenant_invitations
         (id, token, tenant_id, invited_email, invited_by, role_id, max_uses, use_count,
          expires_at, created_at, updated_at)
         VALUES ('inv-1', 'token-1', 'tenant-a', NULL, 'admin-1', 'role-1', 1, 0, ?, ?, ?)`
      )
      .run(NOW + 86_400, NOW, NOW);
    account.db
      .prepare(
        `INSERT INTO identity_accounts (id, tenant_id, account_type, legacy_user_id, created_at, updated_at)
         VALUES ('account:user-new', 'tenant-a', 'user', 'user-new', ?, ?)`
      )
      .run(NOW, NOW);
  });

  it("gives the invited role to the new account, in the account's database", async () => {
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
  });

  it("joins the invited group on the account's database and drops the account's cached claims", async () => {
    metadata.db
      .prepare(
        `INSERT INTO "groups" (id, tenant_id, group_key, display_name, lifecycle_state, created_at, updated_at)
         VALUES ('group-1', 'tenant-a', 'staff', 'Staff', 'active', ?, ?)`
      )
      .run(NOW, NOW);
    metadata.db.exec(`UPDATE tenant_invitations SET group_id = 'group-1' WHERE id = 'inv-1'`);
    const puts: string[] = [];
    const cache = {
      put: vi.fn(async (key: string) => {
        puts.push(key);
      }),
    } as unknown as KVNamespace;
    const reserved = await reserveExternalSignupInvitation(metadata.adapter, {
      token: 'token-1',
      tenantId: 'tenant-a',
      holder: 'external:flow-2',
      ttlSeconds: 900,
    });

    await expect(
      applyExternalSignupInvitation(() => metadata.adapter, account.adapter, log, {
        ...reserved!,
        tenantId: 'tenant-a',
        userId: 'user-new',
        cache,
      })
    ).resolves.toBe(true);

    expect(log.warn).not.toHaveBeenCalled();
    expect(
      account.db
        .prepare(
          `SELECT group_id, subject_id, assignment_source, source_ref, lifecycle_state
             FROM group_memberships WHERE tenant_id = 'tenant-a'`
        )
        .all()
    ).toEqual([
      {
        group_id: 'group-1',
        subject_id: 'user-new',
        assignment_source: 'invitation',
        source_ref: 'inv-1',
        lifecycle_state: 'active',
      },
    ]);
    expect(metadata.db.prepare('SELECT count(*) AS n FROM group_memberships').get()).toEqual({
      n: 0,
    });
    expect(puts).toEqual(['rbac:v2:subject-version:tenant-a:user-new']);
  });
});
