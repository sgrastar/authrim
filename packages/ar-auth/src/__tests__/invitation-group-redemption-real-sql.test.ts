import { describe, expect, it, vi } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';
import { reserveInvitationUse } from '@authrim/ar-lib-core';
import { completeSignupInvitation } from '../invitation-redemption';
import { adapterOver, migrate } from './helpers/real-sql';

const NOW = Math.floor(Date.now() / 1000);

/**
 * A sign-up that redeems an invitation naming a group joins the group on the new account's own
 * database (the invitation and the group are in the tenant metadata database).
 */
function setup(groupState = 'active') {
  const metadata = adapterOver(migrate('core'));
  const account = adapterOver(migrate('core'));
  for (const db of [metadata.raw, account.raw])
    db.prepare(
      `INSERT INTO tenants (id, tenant_code, tenant_key, name, created_at, updated_at)
       VALUES ('tenant-a', 'code-a', 'key-a', 'Tenant A', ?, ?)`
    ).run(NOW, NOW);
  metadata.raw
    .prepare(
      `INSERT INTO "groups" (id, tenant_id, group_key, display_name, lifecycle_state, created_at, updated_at)
       VALUES ('group-1', 'tenant-a', 'staff', 'Staff', ?, ?, ?)`
    )
    .run(groupState, NOW, NOW);
  metadata.raw
    .prepare(
      `INSERT INTO tenant_invitations
       (id, token, tenant_id, invited_email, invited_by, role_id, org_id, group_id, max_uses,
        use_count, expires_at, created_at, updated_at)
       VALUES ('inv-1', 'token-1', 'tenant-a', NULL, 'admin-1', NULL, NULL, 'group-1', 1, 0, ?, ?, ?)`
    )
    .run(NOW + 86_400, NOW, NOW);
  const puts: string[] = [];
  const cache = {
    put: vi.fn(async (key: string) => {
      puts.push(key);
    }),
  } as unknown as KVNamespace;
  return { metadata, account, cache, puts };
}

async function redeem(f: ReturnType<typeof setup>, log = { warn: vi.fn() }) {
  const reserved = await reserveInvitationUse(f.metadata, {
    invitationId: 'inv-1',
    tenantId: 'tenant-a',
    holder: 'challenge-1',
  });
  if (reserved.status !== 'reserved') throw new Error('not reserved');
  const applied = await completeSignupInvitation(
    { invitations: () => f.metadata, assignments: f.account, cache: f.cache },
    log,
    {
      reservation: { invite_id: 'inv-1', invite_reservation_id: reserved.reservationId },
      tenantId: 'tenant-a',
      userId: 'user-new',
    }
  );
  return { applied, log };
}

describe('sign-up invitation that names a group', () => {
  it("writes the membership on the account's database and drops its cached claims", async () => {
    const f = setup();
    const { applied, log } = await redeem(f);
    expect(applied).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
    expect(
      f.account.raw
        .prepare(
          'SELECT group_id, subject_id, assignment_source, source_ref, lifecycle_state FROM group_memberships'
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
    expect(f.metadata.raw.prepare('SELECT count(*) n FROM group_memberships').get()).toEqual({
      n: 0,
    });
    expect(f.puts).toEqual(['rbac:v2:subject-version:tenant-a:user-new']);
  });

  it('does not join a group stopped since the invitation was made', async () => {
    const f = setup('suspended');
    const { applied, log } = await redeem(f);
    expect(applied).toBe(true);
    expect(f.account.raw.prepare('SELECT count(*) n FROM group_memberships').get()).toEqual({
      n: 0,
    });
    expect(log.warn).toHaveBeenCalledWith(
      'Failed to join the group from invitation',
      expect.objectContaining({ invite_id: 'inv-1', error: 'Group not active' })
    );
  });
});
