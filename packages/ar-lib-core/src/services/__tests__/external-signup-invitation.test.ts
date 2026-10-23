import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import {
  applyExternalSignupInvitation,
  externalSignupInvitationEmailCheck,
  externalSignupInvitationRequirement,
  isUsableInvitationToken,
  releaseExternalSignupInvitation,
  reserveExternalSignupInvitation,
} from '../external-signup-invitation';

const NOW = Math.floor(Date.now() / 1000);

describe('invitations carried by a federated sign-in, in the real schema', () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;
  const log = { warn: vi.fn() };

  function createInvitation(invitedEmail: string | null = null, maxUses = 1) {
    db.prepare(
      `INSERT INTO tenant_invitations
       (id, token, tenant_id, invited_email, invited_by, role_id, org_id, max_uses, use_count,
        expires_at, created_at, updated_at)
       VALUES ('inv-1', 'token-1', 'tenant-a', ?, 'admin-1', 'role-1', NULL, ?, 0, ?, ?, ?)`
    ).run(invitedEmail, maxUses, NOW + 86_400, NOW, NOW);
  }

  const useCount = () =>
    Number(
      (
        db.prepare("SELECT use_count FROM tenant_invitations WHERE id = 'inv-1'").get() as {
          use_count: number;
        }
      ).use_count
    );

  function settingsEnv(policy?: string) {
    return {
      SETTINGS: {
        get: vi.fn(async (key: string) =>
          key === 'settings:tenant:tenant-a:authentication-methods' && policy
            ? JSON.stringify({ 'authentication-methods.invitation.email_verification': policy })
            : null
        ),
      },
    } as never;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    const opened = sqliteAdapter();
    db = opened.db;
    adapter = {
      ...opened.adapter,
      transaction: async () => {
        throw new Error('not used');
      },
      isHealthy: async () => ({ healthy: true, latencyMs: 0 }),
      getType: () => 'sqlite',
      close: async () => undefined,
    } as DatabaseAdapter;
    db.prepare(
      `INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
       VALUES ('tenant-a', 'code-a', 'key-a', 'Tenant A', ?, ?)`
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO identity_accounts (id, tenant_id, account_type, legacy_user_id, created_at, updated_at) VALUES ('account:user-new', 'tenant-a', 'user', 'user-new', ?, ?)`
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO roles (id, tenant_id, name, permissions_json, created_at, role_type, is_system)
       VALUES ('role-1', 'tenant-a', 'member', '[]', ?, 'custom', 0)`
    ).run(NOW);
  });

  it('reserves a use for the sign-in for as long as it is told, and only in its tenant', async () => {
    createInvitation();

    const reserved = await reserveExternalSignupInvitation(adapter, {
      token: 'token-1',
      tenantId: 'tenant-a',
      holder: 'saml:request-1',
      ttlSeconds: 900,
    });
    const otherTenant = await reserveExternalSignupInvitation(adapter, {
      token: 'token-1',
      tenantId: 'tenant-b',
      holder: 'saml:request-2',
      ttlSeconds: 900,
    });

    expect(reserved).toEqual({ inviteId: 'inv-1', inviteReservationId: expect.any(String) });
    expect(otherTenant).toBeNull();
    expect(useCount()).toBe(1);
    const row = db
      .prepare('SELECT holder, expires_at FROM tenant_invitation_redemptions')
      .get() as { holder: string; expires_at: number };
    expect(row.holder).toBe('saml:request-1');
    expect(row.expires_at - NOW).toBeGreaterThanOrEqual(899);
    expect(row.expires_at - NOW).toBeLessThanOrEqual(901);
  });

  it('reserves nothing once the invitation has no use left', async () => {
    createInvitation();
    await reserveExternalSignupInvitation(adapter, {
      token: 'token-1',
      tenantId: 'tenant-a',
      holder: 'external:flow-1',
      ttlSeconds: 900,
    });

    expect(
      await reserveExternalSignupInvitation(adapter, {
        token: 'token-1',
        tenantId: 'tenant-a',
        holder: 'external:flow-2',
        ttlSeconds: 900,
      })
    ).toBeNull();
  });

  it.each([
    [null, undefined, { invitedEmail: null, requireVerifiedEmail: false }],
    [
      'invited@example.com',
      undefined,
      { invitedEmail: 'invited@example.com', requireVerifiedEmail: false },
    ],
    [
      'invited@example.com',
      'required',
      { invitedEmail: 'invited@example.com', requireVerifiedEmail: true },
    ],
  ])(
    'reads what an invitation for %s asks under policy %s',
    async (invitedEmail, policy, expected) => {
      createInvitation(invitedEmail);

      expect(
        await externalSignupInvitationRequirement(settingsEnv(policy), adapter, {
          tenantId: 'tenant-a',
          inviteId: 'inv-1',
        })
      ).toEqual(expected);
    }
  );

  it.each([
    [null, { email: 'any@example.com', emailVerified: false }, 'ok'],
    [
      { invitedEmail: 'Invited@Example.com', requireVerifiedEmail: false },
      { email: 'invited@example.com ' },
      'ok',
    ],
    [
      { invitedEmail: 'invited@example.com', requireVerifiedEmail: false },
      { email: 'other@example.com' },
      'email_mismatch',
    ],
    [
      { invitedEmail: 'invited@example.com', requireVerifiedEmail: false },
      { email: null },
      'email_mismatch',
    ],
    [
      { invitedEmail: 'invited@example.com', requireVerifiedEmail: true },
      { email: 'invited@example.com', emailVerified: false },
      'email_not_verified',
    ],
    [
      { invitedEmail: 'invited@example.com', requireVerifiedEmail: true },
      { email: 'invited@example.com' },
      'email_not_verified',
    ],
    [
      { invitedEmail: 'invited@example.com', requireVerifiedEmail: true },
      { email: 'invited@example.com', emailVerified: true },
      'ok',
    ],
    [{ invitedEmail: null, requireVerifiedEmail: true }, { email: null }, 'ok'],
  ] as const)(
    'decides whether an account may be created: %j %j → %s',
    (requirement, identity, expected) => {
      expect(externalSignupInvitationEmailCheck(requirement, identity)).toBe(expected);
    }
  );

  it('applies the reserved use to the new account and gives its role there', async () => {
    createInvitation();
    const reserved = (await reserveExternalSignupInvitation(adapter, {
      token: 'token-1',
      tenantId: 'tenant-a',
      holder: 'external:flow-1',
      ttlSeconds: 900,
    }))!;

    const applied = await applyExternalSignupInvitation(() => adapter, adapter, log, {
      ...reserved,
      tenantId: 'tenant-a',
      userId: 'user-new',
    });

    expect(applied).toBe(true);
    expect(db.prepare('SELECT status, user_id FROM tenant_invitation_redemptions').get()).toEqual({
      status: 'applied',
      user_id: 'user-new',
    });
    expect(db.prepare('SELECT subject_id, role_id FROM role_assignments').all()).toEqual([
      { subject_id: 'user-new', role_id: 'role-1' },
    ]);
  });

  it('gives a released use back and then applies nothing', async () => {
    createInvitation();
    const reserved = (await reserveExternalSignupInvitation(adapter, {
      token: 'token-1',
      tenantId: 'tenant-a',
      holder: 'external:flow-1',
      ttlSeconds: 900,
    }))!;

    await releaseExternalSignupInvitation(() => adapter, log, {
      ...reserved,
      tenantId: 'tenant-a',
    });
    const applied = await applyExternalSignupInvitation(() => adapter, adapter, log, {
      ...reserved,
      tenantId: 'tenant-a',
      userId: 'user-new',
    });

    expect(useCount()).toBe(0);
    expect(applied).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: 'reservation_lost' })
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM role_assignments').get()).toEqual({ n: 0 });
  });

  it('logs, and does not throw, when the database cannot be reached', async () => {
    const unreachable = () => {
      throw new Error('down');
    };

    await expect(
      releaseExternalSignupInvitation(unreachable, log, {
        inviteId: 'inv-1',
        inviteReservationId: 'r',
        tenantId: 'tenant-a',
      })
    ).resolves.toBeUndefined();
    await expect(
      applyExternalSignupInvitation(unreachable, adapter, log, {
        inviteId: 'inv-1',
        inviteReservationId: 'r',
        tenantId: 'tenant-a',
        userId: 'user-new',
      })
    ).resolves.toBe(false);
  });

  it.each([
    ['invite-token', true],
    ['', false],
    ['x'.repeat(513), false],
    [42, false],
    [undefined, false],
  ])('takes %j as an invitation token: %s', (token, usable) => {
    expect(isUsableInvitationToken(token)).toBe(usable);
  });
});
