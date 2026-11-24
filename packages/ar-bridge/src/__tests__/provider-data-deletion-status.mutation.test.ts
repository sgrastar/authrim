import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { callArg } from './helpers/mock-args';

const m = vi.hoisted(() => ({
  settings: vi.fn(),
  persistence: vi.fn(),
  resolveAccount: vi.fn(),
  probe: vi.fn(),
  execute: vi.fn(),
  queryOne: vi.fn(),
  status: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (original) => {
  const actual = await original<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveEffectiveSettings: m.settings,
    resolveAuthCorePersistenceAdapterFromEnv: m.persistence,
    resolveAccountDataContext: m.resolveAccount,
    probeAccountForProviderDataDeletion: m.probe,
  };
});
vi.mock('../services/linked-identity-store', () => ({ findLinkedIdentity: vi.fn() }));

import {
  EXTERNAL_IDP_SETTINGS_META,
  DEFAULT_SIGNED_REQUEST_MAX_AGE_SECONDS,
} from '@authrim/ar-lib-core';
import {
  CONFIRMATION_CODE_PATTERN,
  ProviderDataDeletionError,
  createDataDeletionRequest,
  dataDeletionStateFor,
  readDataDeletionRequestState,
  resolveSignedRequestMaxAgeSeconds,
  type ProviderDataDeletionOutcome,
} from '../services/provider-data-deletion';

const META = EXTERNAL_IDP_SETTINGS_META['external_idp.signed_request_max_age_seconds'];
const KEY = 'external_idp.signed_request_max_age_seconds';
const ENV = {
  EXTERNAL_IDP_ACCOUNT_PROVISIONER: { getExternalIdpRouteRemovalStatus: m.status },
} as unknown as Env;
const CODE = 'AbCdEfGhIjKlMnOpQrStUv';
const NOW_S = 1_700_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_S * 1000);
  vi.clearAllMocks();
  m.settings.mockReset().mockResolvedValue({});
  m.execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  m.queryOne.mockReset().mockResolvedValue(null);
  m.persistence.mockReset().mockResolvedValue({ execute: m.execute, queryOne: m.queryOne });
  m.resolveAccount.mockReset().mockResolvedValue({ legacyUserId: 'user-a' });
  m.probe.mockReset();
  m.status.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveSignedRequestMaxAgeSeconds', () => {
  it('reads the external-idp settings of the tenant', async () => {
    await resolveSignedRequestMaxAgeSeconds(ENV, 'tenant-a');
    expect(m.settings).toHaveBeenCalledWith(ENV, 'external-idp', { tenantId: 'tenant-a' });
  });

  it('uses a configured integer within the allowed range, boundaries included', async () => {
    const min = META.min ?? 0;
    const max = META.max ?? Number.MAX_SAFE_INTEGER;
    for (const value of [min, min + 1, max - 1, max]) {
      m.settings.mockResolvedValue({ [KEY]: value });
      await expect(resolveSignedRequestMaxAgeSeconds(ENV, 't')).resolves.toBe(value);
    }
  });

  it('falls back to the default for anything else', async () => {
    const min = META.min ?? 0;
    const max = META.max ?? Number.MAX_SAFE_INTEGER;
    for (const value of [min - 1, max + 1, 120.5, '300', null, undefined, Number.NaN]) {
      m.settings.mockResolvedValue({ [KEY]: value });
      await expect(resolveSignedRequestMaxAgeSeconds(ENV, 't')).resolves.toBe(
        DEFAULT_SIGNED_REQUEST_MAX_AGE_SECONDS
      );
    }
  });

  it('uses the shortest allowed age when the settings cannot be read', async () => {
    m.settings.mockRejectedValue(new Error('kv down'));
    await expect(resolveSignedRequestMaxAgeSeconds(ENV, 't')).resolves.toBe(META.min);
  });
});

describe('dataDeletionStateFor', () => {
  it.each([
    ['account_inactive', null],
    ['unlink_pending', 'pending'],
    ['retained', 'retained'],
    ['unlinked', 'completed'],
    ['no_link', 'completed'],
    ['account_deleted', 'completed'],
  ])('maps %s to %s', (outcome, state) => {
    expect(dataDeletionStateFor(outcome as ProviderDataDeletionOutcome)).toBe(state);
  });

  it('refuses to map an unknown outcome as done', () => {
    expect(() => dataDeletionStateFor('brand_new' as ProviderDataDeletionOutcome)).toThrow(
      'data_deletion_outcome_unmapped:brand_new'
    );
  });
});

describe('createDataDeletionRequest', () => {
  const create = (result: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    createDataDeletionRequest(ENV, {
      tenantId: 'tenant-a',
      providerId: 'provider-fb',
      result: result as never,
      ...extra,
    });

  it('refuses to record an inactive account', async () => {
    const err = await create({ outcome: 'account_inactive' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderDataDeletionError);
    expect((err as Error).message).toBe('data_deletion_request_not_recordable');
    expect(m.persistence).not.toHaveBeenCalled();
  });

  it('refuses a pending request that names no account or operation', async () => {
    for (const result of [
      { outcome: 'unlink_pending' },
      { outcome: 'unlink_pending', accountId: 'a' },
      { outcome: 'unlink_pending', unlinkOperationId: 'o' },
    ]) {
      await expect(create(result)).rejects.toThrow(
        'data_deletion_request_pending_reference_missing'
      );
    }
    expect(m.execute).not.toHaveBeenCalled();
  });

  it('records a pending request with its account and operation', async () => {
    const out = await create({
      outcome: 'unlink_pending',
      accountId: 'account:a',
      unlinkOperationId: 'op-1',
    });
    expect(out.state).toBe('pending');
    expect(out.confirmationCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(m.persistence).toHaveBeenCalledWith(ENV, 'bridge-data-deletion:create', {
      tenantId: 'tenant-a',
    });
    expect(String(callArg(m.execute, 0, 0))).toContain(
      'INSERT INTO external_idp_data_deletion_requests'
    );
    expect(callArg(m.execute, 0, 1)).toEqual([
      'tenant-a',
      out.confirmationCode,
      'provider-fb',
      'pending',
      'account:a',
      'op-1',
      NOW_S,
      NOW_S,
      null,
    ]);
  });

  it('records a completed request with its completion time and no references', async () => {
    const out = await create(
      { outcome: 'unlinked', accountId: 'account:a', unlinkOperationId: 'op-1' },
      { nowSeconds: 42 }
    );
    expect(out.state).toBe('completed');
    expect(callArg(m.execute, 0, 1)).toEqual([
      'tenant-a',
      out.confirmationCode,
      'provider-fb',
      'completed',
      null,
      null,
      42,
      42,
      42,
    ]);
  });

  it('records a retained request with no references and no completion time', async () => {
    const out = await create({ outcome: 'retained', accountId: 'account:a' });
    expect(out.state).toBe('retained');
    expect((callArg(m.execute, 0, 1) as unknown[]).slice(3)).toEqual([
      'retained',
      null,
      null,
      NOW_S,
      NOW_S,
      null,
    ]);
  });

  it('issues a different unguessable code each time', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) codes.add((await create({ outcome: 'no_link' })).confirmationCode);
    expect(codes.size).toBe(20);
    for (const code of codes) expect(CONFIRMATION_CODE_PATTERN.test(code)).toBe(true);
  });
});

describe('readDataDeletionRequestState', () => {
  const row = (extra: Record<string, unknown> = {}) => ({
    provider_id: 'provider-fb',
    state: 'pending',
    account_id: 'account:a',
    unlink_operation_id: 'op-1',
    ...extra,
  });
  const read = (extra: Record<string, unknown> = {}) =>
    readDataDeletionRequestState(ENV, {
      tenantId: 'tenant-a',
      providerId: 'provider-fb',
      confirmationCode: CODE,
      ...extra,
    });

  it.each(['short', `${CODE}x`, 'AbCdEfGhIjKlMnOpQrSt!!', '', `${CODE}\n`])(
    'does not look up the malformed code %j',
    async (code) => {
      await expect(read({ confirmationCode: code })).resolves.toBeNull();
      expect(m.persistence).not.toHaveBeenCalled();
    }
  );

  it('reads the row of the tenant and code', async () => {
    await read();
    expect(m.persistence).toHaveBeenCalledWith(ENV, 'bridge-data-deletion:read', {
      tenantId: 'tenant-a',
    });
    expect(String(callArg(m.queryOne, 0, 0))).toContain('FROM external_idp_data_deletion_requests');
    expect(callArg(m.queryOne, 0, 1)).toEqual(['tenant-a', CODE]);
  });

  it('finds nothing for an unknown code or another provider', async () => {
    await expect(read()).resolves.toBeNull();
    m.queryOne.mockResolvedValue(row({ provider_id: 'other' }));
    await expect(read()).resolves.toBeNull();
  });

  it.each(['completed', 'retained'])('returns a %s state as recorded', async (state) => {
    m.queryOne.mockResolvedValue(row({ state }));
    await expect(read()).resolves.toBe(state);
    expect(m.resolveAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['no account', { account_id: null }],
    ['no operation', { unlink_operation_id: null }],
    ['empty references', { account_id: '', unlink_operation_id: '' }],
  ])('keeps a pending request with %s pending, without looking further', async (_n, extra) => {
    m.queryOne.mockResolvedValue(row(extra));
    await expect(read()).resolves.toBe('pending');
    expect(m.resolveAccount).not.toHaveBeenCalled();
  });

  describe('a pending request', () => {
    beforeEach(() => {
      m.queryOne.mockResolvedValue(row());
    });

    it('asks for the account fresh, accepting restricted ones', async () => {
      m.status.mockResolvedValue({ operationId: 'op-1', status: 202 });
      await read();
      expect(m.resolveAccount).toHaveBeenCalledWith(ENV, {
        tenantId: 'tenant-a',
        accountId: 'account:a',
        acceptLifecycle: 'restricted',
        freshRoute: true,
      });
    });

    it('stays pending while the unlink is still running', async () => {
      m.status.mockResolvedValue({ operationId: 'op-1', status: 202 });
      await expect(read()).resolves.toBe('pending');
      expect(m.status).toHaveBeenCalledWith({
        restrictedAccountAllowed: true,
        schemaVersion: 1,
        tenantId: 'tenant-a',
        accountId: 'account:a',
        userId: 'user-a',
        operationId: 'op-1',
      });
      expect(m.execute).not.toHaveBeenCalled();
    });

    it('stays pending when the status names another operation', async () => {
      m.status.mockResolvedValue({ operationId: 'other', status: 201 });
      await expect(read()).resolves.toBe('pending');
    });

    it('completes the request once the unlink finished, clearing its references', async () => {
      m.status.mockResolvedValue({ operationId: 'op-1', status: 201 });
      await expect(read()).resolves.toBe('completed');
      const sql = String(callArg(m.execute, 0, 0));
      expect(sql).toContain(
        "SET state = 'completed', account_id = NULL, unlink_operation_id = NULL"
      );
      expect(sql).toContain("state = 'pending'");
      expect(callArg(m.execute, 0, 1)).toEqual([NOW_S, NOW_S, 'tenant-a', CODE]);
    });

    it('uses the given time for the completion', async () => {
      m.status.mockResolvedValue({ operationId: 'op-1', status: 201 });
      await read({ nowSeconds: 7 });
      expect(callArg(m.execute, 0, 1)).toEqual([7, 7, 'tenant-a', CODE]);
    });

    it.each([
      'external_idp_route_removal_status_blocked',
      'external_idp_route_removal_status_not_found',
    ])('stays pending on %s', async (message) => {
      m.status.mockRejectedValue(new Error(message));
      await expect(read()).resolves.toBe('pending');
    });

    it.each([
      new Error('external_idp_route_removal_status_other'),
      new Error('x external_idp_route_removal_status_blocked'),
      new Error('external_idp_route_removal_status_blocked_later'),
      new Error('external_idp_route_removal_status_not_found\n'),
      'external_idp_route_removal_status_blocked',
    ])('does not swallow the failure %s', async (error) => {
      m.status.mockRejectedValue(error);
      await expect(read()).rejects.toBe(error);
    });

    it('refuses to look up without the account provisioner', async () => {
      await expect(
        readDataDeletionRequestState({} as Env, {
          tenantId: 'tenant-a',
          providerId: 'provider-fb',
          confirmationCode: CODE,
        })
      ).rejects.toThrow('external_idp_account_provisioner_unavailable');
    });

    it('treats an account whose route is gone as finished', async () => {
      m.resolveAccount.mockRejectedValue(new Error('account_data_route_not_found'));
      await expect(read()).resolves.toBe('completed');
      expect(m.status).not.toHaveBeenCalled();
    });

    it('rethrows other account lookup failures', async () => {
      m.resolveAccount.mockRejectedValue(new Error('lookup down'));
      await expect(read()).rejects.toThrow('lookup down');
    });

    describe('when the account became inactive', () => {
      beforeEach(() => {
        m.resolveAccount.mockRejectedValue(
          new Error('lookup_destination_revalidation_failed', { cause: 'account_inactive' })
        );
      });

      it('probes the account for what the unlink operation still holds', async () => {
        m.probe.mockResolvedValue({ lifecycleState: 'deleted', providerDataRemains: false });
        await expect(read()).resolves.toBe('completed');
        expect(m.probe).toHaveBeenCalledWith(ENV, {
          tenantId: 'tenant-a',
          account: { accountId: 'account:a' },
          remains: { unlinkOperationId: 'op-1' },
        });
      });

      it.each([
        ['deleted but data remains', { lifecycleState: 'deleted', providerDataRemains: true }],
        ['being deleted', { lifecycleState: 'deleting', providerDataRemains: false }],
      ])('stays pending when %s', async (_n, probe) => {
        m.probe.mockResolvedValue(probe);
        await expect(read()).resolves.toBe('pending');
      });

      it('completes when the route is gone by the probe', async () => {
        m.probe.mockRejectedValue(new Error('account_data_route_not_found'));
        await expect(read()).resolves.toBe('completed');
      });

      it('stays pending when it is inactive again', async () => {
        m.probe.mockRejectedValue(
          new Error('lookup_destination_revalidation_failed', { cause: 'account_inactive' })
        );
        await expect(read()).resolves.toBe('pending');
      });

      it('rethrows other probe failures', async () => {
        m.probe.mockRejectedValue(new Error('probe down'));
        await expect(read()).rejects.toThrow('probe down');
      });

      it('rethrows a different inactive-style error', async () => {
        const error = new Error('lookup_destination_revalidation_failed', { cause: 'other' });
        m.resolveAccount.mockRejectedValue(error);
        await expect(read()).rejects.toBe(error);
        expect(m.probe).not.toHaveBeenCalled();
      });
    });
  });
});
