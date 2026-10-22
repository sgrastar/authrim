import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import {
  INVITATION_RESERVATION_TTL_SECONDS,
  bindInvitationReservation,
  claimInvitationReservation,
  findInvitationById,
  invitationHasUsesLeft,
  invitationHolderForEmail,
  releaseExpiredInvitationReservations,
  releaseInvitationReservation,
  reserveInvitationUse,
} from '../invitation-auth-core';

const NOW = 1_800_000_000;

describe('invitation use reservations in the real schema', () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;

  function createInvitation(id: string, maxUses: number, expiresAt = NOW + 86_400) {
    db.prepare(
      `INSERT INTO tenant_invitations
       (id, token, tenant_id, invited_email, invited_by, role_id, org_id, max_uses, use_count,
        expires_at, created_at, updated_at)
       VALUES (?, ?, 'tenant-a', NULL, 'admin-1', NULL, NULL, ?, 0, ?, ?, ?)`
    ).run(id, `token-${id}`, maxUses, expiresAt, NOW, NOW);
  }

  function useCount(id: string): number {
    return Number(
      (
        db.prepare('SELECT use_count FROM tenant_invitations WHERE id = ?').get(id) as {
          use_count: number;
        }
      ).use_count
    );
  }

  function reservations(id: string) {
    return db
      .prepare(
        `SELECT holder, status, user_id FROM tenant_invitation_redemptions
         WHERE invitation_id = ? ORDER BY holder`
      )
      .all(id);
  }

  beforeEach(() => {
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
    for (const tenant of ['tenant-a', 'tenant-b']) {
      db.prepare(
        `INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(tenant, `${tenant}-code`, `${tenant}-key`, tenant, NOW, NOW);
    }
  });

  it('counts a use when a sign-up starts and refuses one past the limit', async () => {
    createInvitation('inv-1', 2);

    const first = await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'user:a',
      now: NOW,
    });
    const second = await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'user:b',
      now: NOW,
    });
    const third = await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'user:c',
      now: NOW,
    });

    expect(first.status).toBe('reserved');
    expect(second.status).toBe('reserved');
    expect(third).toEqual({ status: 'unavailable' });
    expect(useCount('inv-1')).toBe(2);
    expect(reservations('inv-1')).toEqual([
      { holder: 'user:a', status: 'reserved', user_id: null },
      { holder: 'user:b', status: 'reserved', user_id: null },
    ]);
  });

  it('keeps one use for a holder that restarts, even when the invitation is used up', async () => {
    createInvitation('inv-1', 1);

    const first = await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'email:x',
      now: NOW,
    });
    const restart = await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'email:x',
      now: NOW + 600,
    });

    expect(first.status).toBe('reserved');
    expect(restart).toEqual({
      status: 'held',
      reservationId: (first as { reservationId: string }).reservationId,
    });
    expect(useCount('inv-1')).toBe(1);
    const expiresAt = db
      .prepare('SELECT expires_at FROM tenant_invitation_redemptions WHERE holder = ?')
      .get('email:x') as { expires_at: number };
    expect(expiresAt.expires_at).toBe(NOW + 600 + INVITATION_RESERVATION_TTL_SECONDS);
  });

  it('takes no second use for a holder that restarts while uses are left', async () => {
    createInvitation('inv-1', 5);

    const first = await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'email:x',
      now: NOW,
    });
    const restart = await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'email:x',
      now: NOW + 1,
    });

    expect(restart).toEqual({
      status: 'held',
      reservationId: (first as { reservationId: string }).reservationId,
    });
    expect(useCount('inv-1')).toBe(1);
  });

  it.each([
    ['an expired invitation', 'inv-expired', NOW - 1, 'tenant-a'],
    ['an unknown invitation', 'inv-missing', 0, 'tenant-a'],
    ["another tenant's invitation", 'inv-1', NOW + 86_400, 'tenant-b'],
  ])('reserves nothing from %s', async (_label, id, expiresAt, tenantId) => {
    createInvitation('inv-1', 5);
    if (id === 'inv-expired') createInvitation(id, 5, expiresAt);

    const result = await reserveInvitationUse(adapter, {
      invitationId: id,
      tenantId,
      holder: 'user:a',
      now: NOW,
    });

    expect(result).toEqual({ status: 'unavailable' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tenant_invitation_redemptions').get()).toEqual({
      n: 0,
    });
    expect(useCount('inv-1')).toBe(0);
  });

  it('counts unlimited invitations without a limit', async () => {
    createInvitation('inv-1', -1);
    for (const holder of ['user:a', 'user:b', 'user:c']) {
      expect(
        (
          await reserveInvitationUse(adapter, {
            invitationId: 'inv-1',
            tenantId: 'tenant-a',
            holder,
            now: NOW,
          })
        ).status
      ).toBe('reserved');
    }
    expect(useCount('inv-1')).toBe(3);
  });

  it('gives an abandoned use back once it expires, so the invitation can be used again', async () => {
    createInvitation('inv-1', 1);
    await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'user:abandoned',
      now: NOW,
    });

    const beforeExpiry = await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'user:next',
      now: NOW + INVITATION_RESERVATION_TTL_SECONDS - 1,
    });
    const afterExpiry = await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'user:next',
      now: NOW + INVITATION_RESERVATION_TTL_SECONDS,
    });

    expect(beforeExpiry).toEqual({ status: 'unavailable' });
    expect(afterExpiry.status).toBe('reserved');
    expect(useCount('inv-1')).toBe(1);
    expect(reservations('inv-1')).toEqual([
      { holder: 'user:next', status: 'reserved', user_id: null },
    ]);
  });

  it('never gives back an applied use', async () => {
    createInvitation('inv-1', 1);
    const reserved = (await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'user:a',
      now: NOW,
    })) as { reservationId: string };
    expect(
      await claimInvitationReservation(adapter, {
        reservationId: reserved.reservationId,
        invitationId: 'inv-1',
        tenantId: 'tenant-a',
        userId: 'user-a',
        now: NOW + 10,
      })
    ).toBe(true);

    await releaseExpiredInvitationReservations(adapter, 'inv-1', 'tenant-a', NOW + 86_400);
    await releaseInvitationReservation(adapter, {
      reservationId: reserved.reservationId,
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
    });

    expect(useCount('inv-1')).toBe(1);
    expect(reservations('inv-1')).toEqual([
      { holder: 'user:a', status: 'applied', user_id: 'user-a' },
    ]);
  });

  it('applies a reservation to one account only, idempotently', async () => {
    createInvitation('inv-1', 3);
    const reserved = (await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'user:a',
      now: NOW,
    })) as { reservationId: string };
    const claim = (userId: string, invitationId = 'inv-1', tenantId = 'tenant-a') =>
      claimInvitationReservation(adapter, {
        reservationId: reserved.reservationId,
        invitationId,
        tenantId,
        userId,
      });

    expect(await claim('user-a', 'inv-1', 'tenant-b')).toBe(false);
    expect(await claim('user-a', 'inv-other')).toBe(false);
    expect(await claim('user-a')).toBe(true);
    expect(await claim('user-a')).toBe(true);
    expect(await claim('user-b')).toBe(false);
    expect(reservations('inv-1')).toEqual([
      { holder: 'user:a', status: 'applied', user_id: 'user-a' },
    ]);
  });

  it('cannot apply a reservation that was released', async () => {
    createInvitation('inv-1', 1);
    const reserved = (await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'external:state-1',
      now: NOW,
    })) as { reservationId: string };

    await releaseInvitationReservation(adapter, {
      reservationId: reserved.reservationId,
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      now: NOW + 5,
    });

    expect(useCount('inv-1')).toBe(0);
    expect(
      await claimInvitationReservation(adapter, {
        reservationId: reserved.reservationId,
        invitationId: 'inv-1',
        tenantId: 'tenant-a',
        userId: 'user-a',
      })
    ).toBe(false);
    // Releasing twice gives back one use only.
    await releaseInvitationReservation(adapter, {
      reservationId: reserved.reservationId,
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
    });
    expect(useCount('inv-1')).toBe(0);
  });

  it('names a holder by the hashed, case-folded email', async () => {
    const holder = await invitationHolderForEmail(' New@Example.com ');

    expect(holder).toBe(await invitationHolderForEmail('new@example.com'));
    expect(holder).toMatch(/^email:[0-9a-f]{64}$/);
    expect(holder).not.toContain('example');
  });

  it('finds an invitation by id within its tenant whether or not it expired', async () => {
    createInvitation('inv-1', 1, NOW - 10);

    expect((await findInvitationById(adapter, 'inv-1', 'tenant-a'))?.id).toBe('inv-1');
    expect(await findInvitationById(adapter, 'inv-1', 'tenant-b')).toBeNull();
  });

  it('counts nothing again when the adapter replays a reservation batch that committed', async () => {
    createInvitation('inv-1', 5);
    const replaying = {
      ...adapter,
      batch: async (statements: Parameters<DatabaseAdapter['batch']>[0]) => {
        await adapter.batch(statements);
        // The response was lost after the commit, so the adapter sends the same batch again.
        return adapter.batch(statements);
      },
    } as DatabaseAdapter;

    const result = await reserveInvitationUse(replaying, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'email:x',
      now: NOW,
    });

    expect(useCount('inv-1')).toBe(1);
    expect(result.status).toBe('held');
    expect(reservations('inv-1')).toEqual([
      { holder: 'email:x', status: 'reserved', user_id: null },
    ]);
  });

  it('applies a use bound to the account its sign-up created to that account only', async () => {
    createInvitation('inv-1', 5);
    const { reservationId } = (await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'email:x',
      now: NOW,
    })) as { reservationId: string };
    const input = { reservationId, invitationId: 'inv-1', tenantId: 'tenant-a' };

    expect(await bindInvitationReservation(adapter, { ...input, userId: 'user-a' })).toBe(true);
    expect(await bindInvitationReservation(adapter, { ...input, userId: 'user-a' })).toBe(true);
    expect(await bindInvitationReservation(adapter, { ...input, userId: 'user-b' })).toBe(false);
    expect(await claimInvitationReservation(adapter, { ...input, userId: 'user-b' })).toBe(false);
    expect(await claimInvitationReservation(adapter, { ...input, userId: 'user-a' })).toBe(true);
    expect(reservations('inv-1')).toEqual([
      { holder: 'email:x', status: 'applied', user_id: 'user-a' },
    ]);
  });

  it('reads an invitation as usable again once its last use expired unapplied', async () => {
    createInvitation('inv-1', 1);
    await reserveInvitationUse(adapter, {
      invitationId: 'inv-1',
      tenantId: 'tenant-a',
      holder: 'user:abandoned',
      now: NOW,
    });
    const invitation = (await findInvitationById(adapter, 'inv-1', 'tenant-a'))!;

    expect(await invitationHasUsesLeft(adapter, invitation, NOW + 10)).toBe(false);
    expect(
      await invitationHasUsesLeft(adapter, invitation, NOW + INVITATION_RESERVATION_TTL_SECONDS)
    ).toBe(true);
    // Read only: the use itself comes back with the next reservation.
    expect(useCount('inv-1')).toBe(1);
  });
});
