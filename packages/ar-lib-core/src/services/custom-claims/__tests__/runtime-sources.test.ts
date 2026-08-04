import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types/env';

const mocks = vi.hoisted(() => ({
  resolveTenant: vi.fn(),
  resolveAccount: vi.fn(),
  getTenant: vi.fn(),
  getAccount: vi.fn(),
}));

vi.mock('../../runtime-data-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../runtime-data-context')>()),
  resolveTenantMetadataContext: mocks.resolveTenant,
  resolveAccountDataContext: mocks.resolveAccount,
  getTenantMetadataContextFromHono: mocks.getTenant,
  getAccountDataContextFromHono: mocks.getAccount,
}));

import {
  resolveCustomClaimRuntimeSourcesFromEnv,
  resolveCustomClaimRuntimeSourcesFromHono,
} from '../runtime-sources';

describe('custom claim Control Plane runtime sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves tenant metadata without exposing account stores', async () => {
    const schemaDb = { query: vi.fn() };
    mocks.resolveTenant.mockResolvedValue({ tenantId: 'tenant-a', coreDb: schemaDb });

    await expect(resolveCustomClaimRuntimeSourcesFromEnv({} as Env, 'tenant-a')).resolves.toEqual({
      schemaDb,
      nonPiiDb: null,
      piiDb: null,
    });
    expect(mocks.resolveAccount).not.toHaveBeenCalled();
  });

  it('resolves account values through the account route', async () => {
    const schemaDb = { query: vi.fn() };
    const coreDb = { query: vi.fn() };
    const piiDb = { query: vi.fn() };
    mocks.resolveTenant.mockResolvedValue({ tenantId: 'tenant-a', coreDb: schemaDb });
    mocks.resolveAccount.mockResolvedValue({ tenantId: 'tenant-a', coreDb, piiDb });

    await expect(
      resolveCustomClaimRuntimeSourcesFromEnv({} as Env, 'tenant-a', {
        accountId: 'account:user-a',
      })
    ).resolves.toEqual({ schemaDb, nonPiiDb: coreDb, piiDb });
    expect(mocks.resolveAccount).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      accountId: 'account:user-a',
    });
  });

  it('uses pre-resolved Hono tenant and account contexts', async () => {
    const schemaDb = { query: vi.fn() };
    const coreDb = { query: vi.fn() };
    const piiDb = { query: vi.fn() };
    mocks.getTenant.mockReturnValue({ tenantId: 'tenant-a', coreDb: schemaDb });
    mocks.getAccount.mockReturnValue({ tenantId: 'tenant-a', coreDb, piiDb });

    await expect(
      resolveCustomClaimRuntimeSourcesFromHono({} as never, 'tenant-a')
    ).resolves.toEqual({ schemaDb, nonPiiDb: coreDb, piiDb });
  });

  it('fails closed when Hono routing context is missing', async () => {
    mocks.getTenant.mockReturnValue(null);
    mocks.getAccount.mockReturnValue(null);

    await expect(resolveCustomClaimRuntimeSourcesFromHono({} as never, 'tenant-a')).rejects.toThrow(
      'tenant_metadata_context_required'
    );
  });

  it('rejects cross-tenant metadata and account contexts', async () => {
    mocks.getTenant.mockReturnValue({ tenantId: 'tenant-b', coreDb: {} });
    await expect(resolveCustomClaimRuntimeSourcesFromHono({} as never, 'tenant-a')).rejects.toThrow(
      'tenant_metadata_context_conflict'
    );

    mocks.getTenant.mockReturnValue({ tenantId: 'tenant-a', coreDb: {} });
    mocks.getAccount.mockReturnValue({ tenantId: 'tenant-b', coreDb: {}, piiDb: {} });
    await expect(resolveCustomClaimRuntimeSourcesFromHono({} as never, 'tenant-a')).rejects.toThrow(
      'account_data_context_conflict'
    );
  });
});
