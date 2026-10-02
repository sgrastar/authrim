import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ transition: vi.fn(), read: vi.fn(), initialize: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  transitionAccountAuthenticationState: mocks.transition,
  readAccountAuthenticationState: mocks.read,
  initializeAccountAuthenticationFromAccount: mocks.initialize,
}));

import {
  getCanonicalAccountStatus,
  transitionAccountLifecycle,
  updateCanonicalAccountStatus,
} from '../account-status';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

type SqlValue = string | number | null;
const values = (params: unknown[] = []) =>
  params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));

function store() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(resolve(REPO_ROOT, 'migrations/core/d1/001_0_4_0_core_baseline.sql'), 'utf8')
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
  );
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`INSERT INTO identity_subjects (id, tenant_id, subject_type, lifecycle_state, created_at, updated_at)
           VALUES ('subject:user-1', 'tenant-a', 'person', 'active', 0, 0)`);
  db.exec(`INSERT INTO identity_accounts (id, tenant_id, account_type, lifecycle_state, legacy_user_id,
             primary_subject_id, created_at, updated_at)
           VALUES ('account:user-1', 'tenant-a', 'user', 'active', 'user-1', 'subject:user-1', 0, 0)`);
  return {
    db,
    async queryOne(sql: string, params?: unknown[]) {
      return db.prepare(sql).get(...values(params)) ?? null;
    },
    async batch(statements: Array<{ sql: string; params?: unknown[] }>) {
      db.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params }) => ({
          success: true,
          rowsAffected: Number(db.prepare(sql).run(...values(params)).changes),
        }));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

describe('account status', () => {
  let core: ReturnType<typeof store>;
  beforeEach(() => {
    core = store();
  });

  const subject = () =>
    core.db
      .prepare("SELECT lifecycle_state FROM identity_subjects WHERE id = 'subject:user-1'")
      .get().lifecycle_state;

  it('sets the account and its subject together, recording the transition', async () => {
    expect(
      await updateCanonicalAccountStatus(
        core as never,
        'tenant-a',
        'user-1',
        'suspended',
        { suspended_at: 100, suspended_until: null },
        2000,
        'op-suspend'
      )
    ).toBe(true);
    expect(await getCanonicalAccountStatus(core as never, 'tenant-a', 'user-1')).toMatchObject({
      lifecycle_state: 'suspended',
      status: 'suspended',
      lifecycle_version_ms: 2000,
      lifecycle_operation_id: 'op-suspend',
    });
    expect(subject()).toBe('suspended');
  });

  it('never lets an older transition overwrite a newer one, account or subject', async () => {
    await updateCanonicalAccountStatus(
      core as never,
      'tenant-a',
      'user-1',
      'active',
      {},
      3000,
      'op-activate'
    );
    // A suspension of an earlier version finishing late changes nothing.
    expect(
      await updateCanonicalAccountStatus(
        core as never,
        'tenant-a',
        'user-1',
        'suspended',
        { suspended_at: 1 },
        2000,
        'op-suspend'
      )
    ).toBe(false);
    expect(await getCanonicalAccountStatus(core as never, 'tenant-a', 'user-1')).toMatchObject({
      lifecycle_state: 'active',
      lifecycle_operation_id: 'op-activate',
    });
    expect(subject()).toBe('active');
  });

  it('refuses another transition of the same version, as the authentication state does', async () => {
    expect(
      await updateCanonicalAccountStatus(
        core as never,
        'tenant-a',
        'user-1',
        'suspended',
        {},
        2000,
        'op-a'
      )
    ).toBe(true);
    expect(
      await updateCanonicalAccountStatus(
        core as never,
        'tenant-a',
        'user-1',
        'active',
        {},
        2000,
        'op-b'
      )
    ).toBe(false);
    expect(subject()).toBe('suspended');
  });

  it('takes the same transition again (a retry)', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        await updateCanonicalAccountStatus(
          core as never,
          'tenant-a',
          'user-1',
          'suspended',
          {},
          2000,
          'op'
        )
      ).toBe(true);
    }
    expect(subject()).toBe('suspended');
  });

  it('never sets an account being deleted, or deleted, back to another status', async () => {
    for (const state of ['deleting', 'deleted']) {
      core.db.exec(`UPDATE identity_accounts SET lifecycle_state = '${state}'`);
      core.db.exec(`UPDATE identity_subjects SET lifecycle_state = '${state}'`);
      expect(
        await updateCanonicalAccountStatus(
          core as never,
          'tenant-a',
          'user-1',
          'active',
          {},
          9000,
          'op-activate'
        )
      ).toBe(false);
      expect(subject()).toBe(state);
    }
    // The deletion itself still goes on.
    expect(
      await updateCanonicalAccountStatus(
        core as never,
        'tenant-a',
        'user-1',
        'deleted',
        {},
        9500,
        'op-delete'
      )
    ).toBe(true);
  });

  it('never sets a subject being deleted, or deleted, back either', async () => {
    core.db.exec("UPDATE identity_subjects SET lifecycle_state = 'deleted'");
    await updateCanonicalAccountStatus(
      core as never,
      'tenant-a',
      'user-1',
      'active',
      {},
      9000,
      'op-activate'
    );
    expect(subject()).toBe('deleted');
  });

  it('refuses a metadata key that is not a plain name', async () => {
    await expect(
      updateCanonicalAccountStatus(
        core as never,
        'tenant-a',
        'user-1',
        'suspended',
        { "x', '$.status": 'active' },
        1,
        'op'
      )
    ).rejects.toThrow('account_status_metadata_key_invalid');
  });

  describe('one transition, the same way on every path', () => {
    const input = {
      tenantId: 'tenant-a',
      userId: 'user-1',
      lifecycle: 'suspended' as const,
      status: 'suspended',
      metadataPatch: { suspended_at: 2 },
      versionMs: 2000,
      operationId: 'op-suspend',
      revokeSessions: true,
    };

    beforeEach(() => {
      mocks.transition.mockReset();
      mocks.transition.mockResolvedValue({});
      mocks.read.mockReset();
      mocks.read.mockResolvedValue({ lifecycle: 'active', lifecycleOperationId: 'other' });
    });

    it('takes the authentication state first, then the account and its subject', async () => {
      mocks.transition.mockImplementation(async () => {
        // The account is unchanged until the authentication state took the transition.
        expect(subject()).toBe('active');
        return {};
      });
      expect(await transitionAccountLifecycle({} as never, core as never, input)).toBe('taken');
      expect(mocks.transition).toHaveBeenCalledWith(expect.anything(), {
        tenantId: 'tenant-a',
        userId: 'user-1',
        lifecycle: 'suspended',
        sourceVersionMs: 2000,
        operationId: 'op-suspend',
        revokeSessions: true,
      });
      expect(subject()).toBe('suspended');
    });

    it('changes nothing when the authentication state has a newer (or same-version) one', async () => {
      for (const message of [
        'account_authentication_lifecycle_stale',
        'account_authentication_lifecycle_conflict',
      ]) {
        mocks.transition.mockRejectedValueOnce(new Error(message));
        expect(await transitionAccountLifecycle({} as never, core as never, input)).toBe(
          'superseded'
        );
      }
      expect(subject()).toBe('active');
      // Anything else is an error to retry.
      mocks.transition.mockRejectedValueOnce(new Error('do_unavailable'));
      await expect(transitionAccountLifecycle({} as never, core as never, input)).rejects.toThrow(
        'do_unavailable'
      );
    });

    it('is superseded when the account took a newer one after the state took this one', async () => {
      await updateCanonicalAccountStatus(
        core as never,
        'tenant-a',
        'user-1',
        'active',
        {},
        3000,
        'op-newer'
      );
      expect(await transitionAccountLifecycle({} as never, core as never, input)).toBe(
        'superseded'
      );
      expect(subject()).toBe('active');
    });

    it('activates the account first, then the authentication state', async () => {
      await updateCanonicalAccountStatus(
        core as never,
        'tenant-a',
        'user-1',
        'suspended',
        {},
        1000,
        'op-suspend'
      );
      mocks.transition.mockImplementation(async () => {
        // Sign-in is allowed only once both are active: the account is already.
        expect(subject()).toBe('active');
        return {};
      });
      expect(
        await transitionAccountLifecycle({} as never, core as never, {
          ...input,
          lifecycle: 'active',
          status: 'active',
          operationId: 'op-activate',
          revokeSessions: false,
        })
      ).toBe('taken');
      // Crossed by another transition in the authentication state: sign-in stays refused.
      mocks.transition.mockReset();
      mocks.transition.mockRejectedValueOnce(
        new Error('account_authentication_lifecycle_conflict')
      );
      expect(
        await transitionAccountLifecycle({} as never, core as never, {
          ...input,
          lifecycle: 'active',
          status: 'active',
          versionMs: 4000,
          operationId: 'op-activate-2',
          revokeSessions: false,
        })
      ).toBe('superseded');
    });

    it('finishes its own operation taken before under another version', async () => {
      // An earlier attempt took it in the authentication state at version 1500.
      mocks.transition.mockRejectedValueOnce(new Error('account_authentication_lifecycle_stale'));
      mocks.read.mockResolvedValueOnce({
        lifecycle: 'suspended',
        lifecycleOperationId: 'op-suspend',
        lifecycleVersionMs: 1500,
      });
      expect(await transitionAccountLifecycle({} as never, core as never, input)).toBe('taken');
      expect(await getCanonicalAccountStatus(core as never, 'tenant-a', 'user-1')).toMatchObject({
        lifecycle_state: 'suspended',
        lifecycle_version_ms: 1500,
        lifecycle_operation_id: 'op-suspend',
      });
    });

    it('starts an authentication state not initialized yet from the account before activating', async () => {
      await updateCanonicalAccountStatus(
        core as never,
        'tenant-a',
        'user-1',
        'suspended',
        {},
        1000,
        'op-suspend'
      );
      mocks.read.mockResolvedValueOnce({ lifecycle: null });
      mocks.initialize.mockImplementation(async () => {
        // Initialized while the account still says suspended.
        expect(subject()).toBe('suspended');
        return {};
      });
      // The authentication step fails: sign-in stays refused, as the state starts suspended.
      mocks.transition.mockRejectedValueOnce(new Error('do_unavailable'));
      await expect(
        transitionAccountLifecycle({} as never, core as never, {
          ...input,
          lifecycle: 'active',
          status: 'active',
          operationId: 'op-activate',
          revokeSessions: false,
        })
      ).rejects.toThrow('do_unavailable');
      expect(mocks.initialize).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-a',
        'user-1',
        expect.objectContaining({ lifecycle: 'suspended' })
      );
    });
  });
});
