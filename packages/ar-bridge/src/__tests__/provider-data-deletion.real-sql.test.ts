/**
 * Provider-initiated data deletion against real Core and PII schemas: the linked identity the
 * provider's subject names is unlinked through the account provisioning saga (a double that runs
 * the saga's own statements), a legal hold keeps everything, and the status record follows the
 * unlink to completion without holding personal data.
 *
 * Doubles: the lookup directory (account resolution), the sign-in-method removal lease and the
 * account provisioning RPC (its SQL is the saga's).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import { adapterOver, migrate, type RealSqlAdapter } from './helpers/real-sql';

const TENANT = 'tenant-a';
const USER = 'user-a';
const ACCOUNT = `account:${USER}`;
const FACEBOOK = 'provider-facebook';
const GOOGLE = 'provider-google';
const FACEBOOK_USER = '10200000000000001';
/** When the provider issued the request: after the seeded links were made. */
const ISSUED = Math.floor(Date.now() / 1000);

const world = vi.hoisted(() => {
  const state: {
    core: unknown;
    pii: unknown;
    route: 'found' | 'missing';
    /** The account's lifecycle state, as the resolver reads it at the destination. */
    lifecycle: string;
    lockBusy: boolean;
  } = { core: undefined, pii: undefined, route: 'found', lifecycle: 'active', lockBusy: false };
  return state;
});

vi.mock('@authrim/ar-lib-core', async (original) => {
  const actual = await original<typeof import('@authrim/ar-lib-core')>();
  // As the resolver: active accounts, plus suspended/locked with `restricted`.
  const context = (input?: { acceptLifecycle?: 'restricted' }) => {
    if (world.route === 'missing') throw new Error('account_data_route_not_found');
    const accepted =
      world.lifecycle === 'active' ||
      (input?.acceptLifecycle === 'restricted' &&
        ['suspended', 'locked'].includes(world.lifecycle));
    if (!accepted) {
      throw new Error('lookup_destination_revalidation_failed', { cause: 'account_inactive' });
    }
    return {
      tenantId: TENANT,
      accountId: ACCOUNT,
      legacyUserId: USER,
      lifecycleState: world.lifecycle,
      membership: { routeProjection: { schemaVersion: 1 } },
      coreDb: world.core,
      piiDb: world.pii,
    };
  };
  return {
    ...actual,
    resolveAccountDataContextByIdentifier: vi.fn(
      async (_env: unknown, input: { acceptLifecycle?: 'restricted' }) => context(input)
    ),
    resolveAccountDataContext: vi.fn(
      async (_env: unknown, input: { acceptLifecycle?: 'restricted' }) => context(input)
    ),
    // The read-only probe, over the same real databases (whatever the account's state).
    probeAccountForProviderDataDeletion: vi.fn(
      async (
        _env: unknown,
        input: { remains: { issuer: string; subject: string } | { unlinkOperationId: string } }
      ) => {
        if (world.route === 'missing') throw new Error('account_data_route_not_found');
        const core = world.core as RealSqlAdapter;
        const pii = world.pii as RealSqlAdapter;
        const hold = await core.queryOne(
          "SELECT id FROM legal_holds WHERE subject_id = ? AND state = 'active'",
          [ACCOUNT]
        );
        const remains =
          'unlinkOperationId' in input.remains
            ? await pii.queryOne(
                `SELECT operation_id FROM external_identifier_unlink_operations
                  WHERE operation_id = ? AND raw_values_erased_at IS NULL`,
                [input.remains.unlinkOperationId]
              )
            : ((await pii.queryOne(
                'SELECT id FROM linked_identities WHERE provider_id = ? AND provider_user_id = ?',
                [input.remains.issuer, input.remains.subject]
              )) ??
              (await pii.queryOne(
                `SELECT operation_id FROM external_identifier_unlink_operations
                  WHERE raw_values_erased_at IS NULL`,
                []
              )));
        return {
          accountId: ACCOUNT,
          legacyUserId: USER,
          lifecycleState: world.lifecycle,
          legalHoldActive: Boolean(hold),
          providerDataRemains: Boolean(remains),
        };
      }
    ),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => world.core),
    resolveEffectiveSettings: vi.fn(async () => ({})),
    withLoginMethodRemovalLock: vi.fn(
      async (
        _env: unknown,
        _tenantId: string,
        _userId: string,
        removal: (lease: { owner: string; assertHeld: () => Promise<void> }) => Promise<unknown>
      ) => {
        if (world.lockBusy) throw new actual.LoginMethodRemovalInProgressError();
        return removal({ owner: 'lease-owner', assertHeld: async () => undefined });
      }
    ),
  };
});

import {
  createDataDeletionRequest,
  readDataDeletionRequestState,
  unlinkProviderSubject,
} from '../services/provider-data-deletion';

let core: RealSqlAdapter;
let pii: RealSqlAdapter;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The account provisioning RPC, running the statements removeExternalIdpRoute runs. */
function provisioner() {
  return {
    removeExternalIdpRoute: vi.fn(
      async (input: {
        operationId: string;
        tenantId: string;
        accountId: string;
        userId: string;
        linkedIdentityId: string;
        providerId: string;
        providerUserId: string;
      }) => {
        const now = Math.floor(Date.now() / 1000);
        const results = await pii.batch([
          {
            sql: `INSERT INTO external_identifier_unlink_operations (
                    operation_id, tenant_id, account_id, user_id, issuer_json, subject_json,
                    issuer_sha256, subject_sha256, route_projection_json, state,
                    attempt_count, created_at, updated_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
            params: [
              input.operationId,
              input.tenantId,
              input.accountId,
              input.userId,
              JSON.stringify(input.providerId),
              JSON.stringify(input.providerUserId),
              await sha256Hex(input.providerId),
              await sha256Hex(input.providerUserId),
              JSON.stringify({ schemaVersion: 1 }),
              now,
              now,
            ],
          },
          {
            sql: `DELETE FROM linked_identities
                   WHERE id = ? AND tenant_id = ? AND user_id = ?
                     AND provider_id = ? AND provider_user_id = ?
                     AND provisioning_state = 'active'`,
            params: [
              input.linkedIdentityId,
              input.tenantId,
              input.userId,
              input.providerId,
              input.providerUserId,
            ],
          },
        ]);
        if (results[0]?.rowsAffected !== 1 || results[1]?.rowsAffected !== 1) {
          throw new Error('external_idp_route_removal_write_conflict');
        }
        return { status: 202, operationId: input.operationId, accountId: input.accountId };
      }
    ),
    getExternalIdpRouteRemovalStatus: vi.fn(async (input: { operationId: string }) => {
      const row = await pii.queryOne<{ state: string }>(
        'SELECT state FROM external_identifier_unlink_operations WHERE operation_id = ?',
        [input.operationId]
      );
      if (!row) throw new Error('external_idp_route_removal_status_not_found');
      return {
        status: row.state === 'completed' ? 201 : 202,
        operationId: input.operationId,
        accountId: ACCOUNT,
      };
    }),
  };
}

let rpc: ReturnType<typeof provisioner>;
const env = () => ({ EXTERNAL_IDP_ACCOUNT_PROVISIONER: rpc }) as unknown as Env;

function seedLink(id: string, providerId: string, providerUserId: string): void {
  pii.raw
    .prepare(
      `INSERT INTO linked_identities (
         id, tenant_id, user_id, provider_id, provider_user_id, provider_email, provider_name,
         raw_attributes, raw_claims, profile_data, access_token_encrypted, refresh_token_encrypted,
         token_expires_at, linked_at, provisioning_state
       ) VALUES (?, ?, ?, ?, ?, 'person@example.com', 'Person', '{"id":"x"}', '{"sub":"x"}',
                 '{"name":"Person"}', 'enc-access', 'enc-refresh', 1900000000, 1700000000, 'active')`
    )
    .run(id, TENANT, USER, providerId, providerUserId);
}

function links(): Array<{ id: string; provider_id: string }> {
  return pii.raw
    .prepare('SELECT id, provider_id FROM linked_identities WHERE tenant_id = ? ORDER BY id')
    .all(TENANT) as Array<{ id: string; provider_id: string }>;
}

function statusRows(): Array<Record<string, unknown>> {
  return core.raw.prepare('SELECT * FROM external_idp_data_deletion_requests').all() as Array<
    Record<string, unknown>
  >;
}

describe('provider data deletion (real Core and PII schemas)', () => {
  beforeEach(() => {
    const coreDb = migrate('core');
    coreDb.exec(
      renderPortableMigrationSql(
        readFileSync(
          path.resolve(
            __dirname,
            '../../../../migrations/core/d1/006_external_idp_data_deletion_requests.sql'
          ),
          'utf8'
        ),
        'sqlite'
      )
    );
    // A hold names an account of the tenant (the schema's trigger checks it).
    coreDb.exec(
      `INSERT INTO identity_accounts (
         id, tenant_id, account_type, lifecycle_state, legacy_user_id, created_at, updated_at
       ) VALUES ('${ACCOUNT}', '${TENANT}', 'person', 'active', '${USER}', 1, 1)`
    );
    core = adapterOver(coreDb);
    pii = adapterOver(migrate('pii'));
    world.core = core;
    world.pii = pii;
    world.route = 'found';
    world.lifecycle = 'active';
    world.lockBusy = false;
    rpc = provisioner();
    seedLink('link-facebook', FACEBOOK, FACEBOOK_USER);
    seedLink('link-google', GOOGLE, 'google-sub');
  });

  it('unlinks only the Facebook identity, and the status follows the unlink to completion', async () => {
    const result = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
    });

    expect(result).toMatchObject({
      outcome: 'unlink_pending',
      userId: USER,
      accountId: ACCOUNT,
      linkedIdentityId: 'link-facebook',
    });
    expect(rpc.removeExternalIdpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedIdentityId: 'link-facebook',
        providerId: FACEBOOK,
        providerUserId: FACEBOOK_USER,
        removalLeaseOwner: 'lease-owner',
      })
    );
    // The Facebook link (with its email, name, raw data and tokens) is gone; Google's stays.
    expect(links()).toEqual([{ id: 'link-google', provider_id: GOOGLE }]);

    const { confirmationCode, state } = await createDataDeletionRequest(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      result,
    });
    expect(state).toBe('pending');
    expect(confirmationCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const read = () =>
      readDataDeletionRequestState(env(), {
        tenantId: TENANT,
        providerId: FACEBOOK,
        confirmationCode,
      });
    expect(await read()).toBe('pending');

    // The saga's directory cleanup finishes (and erases the raw subject).
    pii.raw
      .prepare(
        `UPDATE external_identifier_unlink_operations
            SET state = 'completed', issuer_json = NULL, subject_json = NULL,
                raw_values_erased_at = 1, completed_at = 1`
      )
      .run();
    expect(await read()).toBe('completed');
    const [row] = statusRows();
    expect(row).toMatchObject({
      tenant_id: TENANT,
      provider_id: FACEBOOK,
      state: 'completed',
      account_id: null,
      unlink_operation_id: null,
    });
    expect(JSON.stringify(row)).not.toContain(FACEBOOK_USER);

    // Another provider's code, or none, finds nothing.
    expect(
      await readDataDeletionRequestState(env(), {
        tenantId: TENANT,
        providerId: GOOGLE,
        confirmationCode,
      })
    ).toBeNull();
    expect(
      await readDataDeletionRequestState(env(), {
        tenantId: TENANT,
        providerId: FACEBOOK,
        confirmationCode: 'A'.repeat(22),
      })
    ).toBeNull();
  });

  it('answers a repeated request while the cleanup runs with the same pending unlink', async () => {
    const first = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
    });
    const second = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
    });
    expect(second).toMatchObject({
      outcome: 'unlink_pending',
      unlinkOperationId: first.unlinkOperationId,
    });
    expect(rpc.removeExternalIdpRoute).toHaveBeenCalledTimes(1);
  });

  it('completes a request for a subject no account links, without telling it apart', async () => {
    world.route = 'missing';
    const result = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: '999',
      requestIssuedAt: ISSUED,
    });
    expect(result).toEqual({ outcome: 'no_link' });
    const { confirmationCode, state } = await createDataDeletionRequest(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      result,
    });
    expect(state).toBe('completed');
    expect(
      await readDataDeletionRequestState(env(), {
        tenantId: TENANT,
        providerId: FACEBOOK,
        confirmationCode,
      })
    ).toBe('completed');
    expect(rpc.removeExternalIdpRoute).not.toHaveBeenCalled();
    expect(links()).toHaveLength(2);
  });

  it('keeps everything under a legal hold, and records the request as retained', async () => {
    core.raw
      .prepare(
        `INSERT INTO legal_holds (id, tenant_id, subject_type, subject_id, state, reason_code,
                                  created_by, created_at, updated_at)
         VALUES ('hold-1', ?, 'account', ?, 'active', 'litigation', 'admin-1', 1, 1)`
      )
      .run(TENANT, ACCOUNT);

    const result = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
    });

    expect(result).toMatchObject({ outcome: 'retained', userId: USER });
    expect(rpc.removeExternalIdpRoute).not.toHaveBeenCalled();
    expect(links()).toHaveLength(2);
    const facebook = pii.raw
      .prepare('SELECT provider_email, raw_claims FROM linked_identities WHERE id = ?')
      .get('link-facebook');
    expect(facebook).toEqual({ provider_email: 'person@example.com', raw_claims: '{"sub":"x"}' });

    const { confirmationCode, state } = await createDataDeletionRequest(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      result,
    });
    expect(state).toBe('retained');
    expect(statusRows()[0]).toMatchObject({ state: 'retained', account_id: null });
    expect(
      await readDataDeletionRequestState(env(), {
        tenantId: TENANT,
        providerId: FACEBOOK,
        confirmationCode,
      })
    ).toBe('retained');
  });

  it('unlinks once a hold is released', async () => {
    core.raw
      .prepare(
        `INSERT INTO legal_holds (id, tenant_id, subject_type, subject_id, state, reason_code,
                                  created_by, created_at, released_by, released_at,
                                  release_reason, updated_at)
         VALUES ('hold-1', ?, 'account', ?, 'released', 'litigation', 'admin-1', 1, 'admin-1', 2,
                 'closed', 2)`
      )
      .run(TENANT, ACCOUNT);
    const result = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
    });
    expect(result.outcome).toBe('unlink_pending');
    expect(links()).toEqual([{ id: 'link-google', provider_id: GOOGLE }]);
  });

  it.each(['suspended', 'locked'])(
    'unlinks a %s account as an active one, and the status follows it',
    async (lifecycle) => {
      world.lifecycle = lifecycle;
      core.raw
        .prepare('UPDATE identity_accounts SET lifecycle_state = ? WHERE id = ?')
        .run(lifecycle, ACCOUNT);
      const result = await unlinkProviderSubject(env(), {
        tenantId: TENANT,
        providerId: FACEBOOK,
        providerUserId: FACEBOOK_USER,
        requestIssuedAt: ISSUED,
      });
      expect(result).toMatchObject({
        outcome: 'unlink_pending',
        linkedIdentityId: 'link-facebook',
      });
      expect(rpc.removeExternalIdpRoute).toHaveBeenCalledWith(
        expect.objectContaining({ restrictedAccountAllowed: true })
      );
      expect(links()).toEqual([{ id: 'link-google', provider_id: GOOGLE }]);
      // The account's own state is not this request's to change.
      expect(core.raw.prepare('SELECT lifecycle_state FROM identity_accounts').get()).toEqual({
        lifecycle_state: lifecycle,
      });
      // Resolved from the directory's primary, never from a cached route.
      const { resolveAccountDataContextByIdentifier } = await import('@authrim/ar-lib-core');
      expect(vi.mocked(resolveAccountDataContextByIdentifier)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ acceptLifecycle: 'restricted', freshRoute: true })
      );

      const { confirmationCode } = await createDataDeletionRequest(env(), {
        tenantId: TENANT,
        providerId: FACEBOOK,
        result,
      });
      pii.raw
        .prepare(
          `UPDATE external_identifier_unlink_operations
              SET state = 'completed', issuer_json = NULL, subject_json = NULL,
                  raw_values_erased_at = 1, completed_at = 1`
        )
        .run();
      expect(
        await readDataDeletionRequestState(env(), {
          tenantId: TENANT,
          providerId: FACEBOOK,
          confirmationCode,
        })
      ).toBe('completed');
      expect(rpc.getExternalIdpRouteRemovalStatus).toHaveBeenCalledWith(
        expect.objectContaining({ restrictedAccountAllowed: true })
      );
    }
  );

  it('retains the request for an account whose deletion a legal hold stopped', async () => {
    world.lifecycle = 'deleting';
    core.raw
      .prepare(
        `INSERT INTO legal_holds (id, tenant_id, subject_type, subject_id, state, reason_code,
                                  created_by, created_at, updated_at)
         VALUES ('hold-1', ?, 'account', ?, 'active', 'litigation', 'admin-1', 1, 1)`
      )
      .run(TENANT, ACCOUNT);
    const result = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
    });
    expect(result).toMatchObject({ outcome: 'retained', userId: USER });
    expect(rpc.removeExternalIdpRoute).not.toHaveBeenCalled();
    const { state } = await createDataDeletionRequest(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      result,
    });
    expect(state).toBe('retained');
  });

  it('does not complete a request for a deleted account that still holds the link', async () => {
    // The deletion is not done with the subject yet (the link row is still there).
    world.lifecycle = 'deleted';
    const result = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
    });
    expect(result).toMatchObject({ outcome: 'account_inactive' });
    await expect(
      createDataDeletionRequest(env(), { tenantId: TENANT, providerId: FACEBOOK, result })
    ).rejects.toThrow('data_deletion_request_not_recordable');
  });

  it('completes a request for a deleted account (its deletion erased the link)', async () => {
    pii.raw.prepare("DELETE FROM linked_identities WHERE id = 'link-facebook'").run();
    world.lifecycle = 'deleted';
    const result = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
    });
    expect(result).toMatchObject({ outcome: 'account_deleted' });
    expect(rpc.removeExternalIdpRoute).not.toHaveBeenCalled();
    const { state } = await createDataDeletionRequest(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      result,
    });
    expect(state).toBe('completed');
  });

  it.each(['deleting', 'deprovisioned'])(
    'does nothing for a %s account (no hold), and never records it as done',
    async (lifecycle) => {
      world.lifecycle = lifecycle;
      const result = await unlinkProviderSubject(env(), {
        tenantId: TENANT,
        providerId: FACEBOOK,
        providerUserId: FACEBOOK_USER,
        requestIssuedAt: ISSUED,
      });
      expect(result).toMatchObject({ outcome: 'account_inactive' });
      expect(rpc.removeExternalIdpRoute).not.toHaveBeenCalled();
      expect(links()).toHaveLength(2);
      await expect(
        createDataDeletionRequest(env(), { tenantId: TENANT, providerId: FACEBOOK, result })
      ).rejects.toThrow('data_deletion_request_not_recordable');
      expect(statusRows()).toHaveLength(0);
    }
  );

  it('keeps a stopped (blocked) unlink pending, for a repeated request too', async () => {
    const first = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
    });
    const { confirmationCode } = await createDataDeletionRequest(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      result: first,
    });
    pii.raw.prepare("UPDATE external_identifier_unlink_operations SET state = 'blocked'").run();

    const again = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
    });
    expect(again).toMatchObject({
      outcome: 'unlink_pending',
      unlinkOperationId: first.unlinkOperationId,
      attention: 'unlink_blocked',
    });
    rpc.getExternalIdpRouteRemovalStatus.mockRejectedValueOnce(
      new Error('external_idp_route_removal_status_blocked')
    );
    expect(
      await readDataDeletionRequestState(env(), {
        tenantId: TENANT,
        providerId: FACEBOOK,
        confirmationCode,
      })
    ).toBe('pending');
  });

  it('reports a hold placed while the link was being removed', async () => {
    const remove = rpc.removeExternalIdpRoute.getMockImplementation()!;
    rpc.removeExternalIdpRoute.mockImplementationOnce(async (input) => {
      const removed = await remove(input);
      core.raw
        .prepare(
          `INSERT INTO legal_holds (id, tenant_id, subject_type, subject_id, state, reason_code,
                                    created_by, created_at, updated_at)
           VALUES ('hold-late', ?, 'account', ?, 'active', 'litigation', 'admin-1', 1, 1)`
        )
        .run(TENANT, ACCOUNT);
      return removed;
    });
    const result = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
    });
    expect(result).toMatchObject({
      outcome: 'unlink_pending',
      attention: 'hold_placed_during_unlink',
    });
  });

  it('keeps a pending request pending while the account is being deleted, done once deleted', async () => {
    const result = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
    });
    const { confirmationCode } = await createDataDeletionRequest(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      result,
    });
    const read = () =>
      readDataDeletionRequestState(env(), {
        tenantId: TENANT,
        providerId: FACEBOOK,
        confirmationCode,
      });
    // Suspended since: looked up as before (still pending until the cleanup finishes).
    world.lifecycle = 'suspended';
    expect(await read()).toBe('pending');
    // Being deleted since: pending (a hold may stop that deletion).
    world.lifecycle = 'deleting';
    expect(await read()).toBe('pending');
    // Deleted, but the unlink operation still holds the raw subject: not done yet.
    world.lifecycle = 'deleted';
    expect(await read()).toBe('pending');
    // The deletion erased it (as account-directory-removal-producer does): done.
    pii.raw
      .prepare(
        `UPDATE external_identifier_unlink_operations
            SET state = 'blocked', issuer_json = NULL, subject_json = NULL,
                raw_values_erased_at = 1, error_code = 'account_deleted'`
      )
      .run();
    expect(await read()).toBe('completed');
    expect(statusRows()[0]).toMatchObject({ state: 'completed', account_id: null });
  });

  it.each([1, 30, 60, 3600])(
    'leaves a link made %i s after the request was issued (linked again since)',
    async (later) => {
      pii.raw
        .prepare('UPDATE linked_identities SET linked_at = ? WHERE id = ?')
        .run((ISSUED + later) * 1000, 'link-facebook');
      const result = await unlinkProviderSubject(env(), {
        tenantId: TENANT,
        providerId: FACEBOOK,
        providerUserId: FACEBOOK_USER,
        requestIssuedAt: ISSUED,
      });
      expect(result).toEqual({ outcome: 'no_link' });
      expect(rpc.removeExternalIdpRoute).not.toHaveBeenCalled();
      expect(links()).toHaveLength(2);
    }
  );

  it("removes a link made in the request's own second", async () => {
    pii.raw
      .prepare('UPDATE linked_identities SET linked_at = ? WHERE id = ?')
      .run(ISSUED * 1000 + 999, 'link-facebook');
    const result = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
    });
    expect(result.outcome).toBe('unlink_pending');
  });

  it('reads the link again under the lease, and leaves one replaced meanwhile', async () => {
    const { withLoginMethodRemovalLock } = await import('@authrim/ar-lib-core');
    const lock = vi.mocked(withLoginMethodRemovalLock);
    const original = lock.getMockImplementation()!;
    lock.mockImplementationOnce(async (lockEnv, tenantId, userId, removal) => {
      // The person unlinked and linked Facebook again while this request waited.
      pii.raw.prepare("DELETE FROM linked_identities WHERE id = 'link-facebook'").run();
      pii.raw
        .prepare(
          `INSERT INTO linked_identities (id, tenant_id, user_id, provider_id, provider_user_id,
                                          linked_at, provisioning_state)
           VALUES ('link-facebook-new', ?, ?, ?, ?, ?, 'active')`
        )
        .run(TENANT, USER, FACEBOOK, FACEBOOK_USER, (ISSUED + 1) * 1000);
      return original(lockEnv, tenantId, userId, removal);
    });
    const result = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
    });
    expect(result).toEqual({ outcome: 'no_link' });
    expect(rpc.removeExternalIdpRoute).not.toHaveBeenCalled();
    expect(links().map((link) => link.id)).toEqual(['link-facebook-new', 'link-google']);
  });

  it('leaves any link once the same signed payload already removed one', async () => {
    const result = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
      mayRemoveLink: false,
    });
    expect(result).toEqual({ outcome: 'no_link' });
    expect(rpc.removeExternalIdpRoute).not.toHaveBeenCalled();
    expect(links()).toHaveLength(2);
  });

  it('asks the payload guard again under the lease, and records the removal there', async () => {
    // Another copy of the same payload removed the link and the person linked again, all
    // while this copy waited: the guard (asked under the lease) now says removed.
    const removed = { value: false };
    const guard = {
      alreadyRemoved: vi.fn(async () => removed.value),
      markRemoved: vi.fn(async () => {
        removed.value = true;
      }),
    };
    const { withLoginMethodRemovalLock } = await import('@authrim/ar-lib-core');
    const lock = vi.mocked(withLoginMethodRemovalLock);
    const original = lock.getMockImplementation()!;
    lock.mockImplementationOnce(async (lockEnv, tenantId, userId, removal) => {
      removed.value = true;
      return original(lockEnv, tenantId, userId, removal);
    });
    const late = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
      mayRemoveLink: true,
      payloadGuard: guard,
    });
    expect(late).toEqual({ outcome: 'no_link' });
    expect(rpc.removeExternalIdpRoute).not.toHaveBeenCalled();
    expect(links()).toHaveLength(2);

    removed.value = false;
    const first = await unlinkProviderSubject(env(), {
      tenantId: TENANT,
      providerId: FACEBOOK,
      providerUserId: FACEBOOK_USER,
      requestIssuedAt: ISSUED,
      payloadGuard: guard,
    });
    expect(first.outcome).toBe('unlink_pending');
    expect(guard.markRemoved).toHaveBeenCalledTimes(1);
  });

  it('refuses while another change to how the account signs in runs', async () => {
    world.lockBusy = true;
    await expect(
      unlinkProviderSubject(env(), {
        tenantId: TENANT,
        providerId: FACEBOOK,
        providerUserId: FACEBOOK_USER,
        requestIssuedAt: ISSUED,
      })
    ).rejects.toThrow();
    expect(links()).toHaveLength(2);
  });
});
