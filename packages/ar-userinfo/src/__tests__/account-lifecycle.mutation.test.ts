import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { CanonicalRuntimeUserProjection, DatabaseAdapter, Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  readiness: vi.fn(),
  settings: vi.fn(),
  contract: vi.fn(),
  sources: vi.fn(),
  missing: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  GUEST_LIFECYCLE_SCOPE: 'account:lifecycle:read',
  GuestLifecycleRepository: class {
    get = mocks.get;
  },
  resolveGuestSettings: mocks.settings,
  loadClientContractCached: mocks.contract,
  resolveCustomClaimRuntimeSourcesFromEnv: mocks.sources,
  getMissingRequiredCustomClaims: mocks.missing,
}));

import { readAccountLifecycleClaim } from '../account-lifecycle';

function input(
  overrides: Partial<CanonicalRuntimeUserProjection> = {},
  env: Record<string, unknown> = {
    AUTHRIM_CONFIG: {},
    GUEST_UPGRADE_READINESS: { read: mocks.readiness },
  }
) {
  return {
    c: { env } as unknown as Context<{ Bindings: Env }>,
    adapter: {} as DatabaseAdapter,
    tenantId: 'tenant-a',
    clientId: 'client-a',
    scopes: ['openid', 'account:lifecycle:read'],
    user: {
      id: 'user-a',
      tenant_id: 'tenant-a',
      account_type: 'user',
      registration_state: 'guest',
      status: 'active',
      created_at: '2026-09-01T00:00:00Z',
      ...overrides,
    } as CanonicalRuntimeUserProjection,
  };
}

describe('UserInfo account lifecycle (exact behaviour)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readiness.mockResolvedValue({ tenantId: 'tenant-a', email: true });
    mocks.get.mockResolvedValue({
      phase: 'active',
      client_id: 'client-a',
      created_at: 100,
      deletion_due_at: 200,
    });
    mocks.settings.mockResolvedValue({
      policy: { upgradeEnabled: true },
      upgradeMethods: ['email', 'passkey'],
    });
    mocks.contract.mockResolvedValue({ guestAuth: { allowedUpgradeMethods: ['email'] } });
    mocks.sources.mockResolvedValue({ nonPiiDb: {}, piiDb: {}, schemaDb: {} });
    mocks.missing.mockResolvedValue([]);
  });

  it('drops a stale deletion date once the account is registered', async () => {
    mocks.get.mockResolvedValue({ phase: 'registered', created_at: 100, deletion_due_at: 200 });
    expect((await readAccountLifecycleClaim(input()))?.deletion_due_at).toBeNull();
  });

  it('reports a guest without a stored deadline as having none', async () => {
    mocks.get.mockResolvedValue({ phase: 'active', client_id: 'client-a', created_at: 100 });
    expect((await readAccountLifecycleClaim(input()))?.deletion_due_at).toBeNull();
  });

  it('does not evaluate an upgrade for an account that is registered without a lifecycle row', async () => {
    mocks.get.mockResolvedValue(null);
    const claim = await readAccountLifecycleClaim(input({ registration_state: 'registered' }));
    expect(claim).toMatchObject({ registration_state: 'registered', upgrade_eligible: false });
    expect(mocks.settings).not.toHaveBeenCalled();
  });

  describe('email readiness', () => {
    it('is unavailable when the readiness binding is missing', async () => {
      await expect(readAccountLifecycleClaim(input({}, { AUTHRIM_CONFIG: {} }))).rejects.toThrow(
        'guest_upgrade_readiness_unavailable'
      );
    });

    it('asks for the tenant being served', async () => {
      await readAccountLifecycleClaim(input());
      expect(mocks.readiness).toHaveBeenCalledWith('tenant-a');
    });

    it.each([['true'], [1], [undefined], [null]])(
      'rejects an email readiness that is not a boolean (%j)',
      async (email) => {
        mocks.readiness.mockResolvedValue({ tenantId: 'tenant-a', email });
        await expect(readAccountLifecycleClaim(input())).rejects.toThrow(
          'guest_upgrade_readiness_invalid'
        );
      }
    );
  });

  describe('account data sources', () => {
    it('resolves the sources of the account being read', async () => {
      await readAccountLifecycleClaim(input());
      expect(mocks.sources).toHaveBeenCalledWith(expect.anything(), 'tenant-a', {
        accountId: 'user-a',
      });
      expect(mocks.missing).toHaveBeenCalledWith({
        db: {},
        dbPii: {},
        schemaDb: {},
        tenantId: 'tenant-a',
        userId: 'user-a',
      });
    });

    it('fails when the account route has no non-PII database', async () => {
      mocks.sources.mockResolvedValue({ nonPiiDb: null, piiDb: {}, schemaDb: {} });
      await expect(readAccountLifecycleClaim(input())).rejects.toThrow(
        'account_data_route_incomplete'
      );
      expect(mocks.missing).not.toHaveBeenCalled();
    });
  });

  describe('creation time', () => {
    it('falls back to the projection creation time in whole seconds', async () => {
      mocks.get.mockResolvedValue({ phase: 'registered' });
      const claim = await readAccountLifecycleClaim(
        input({ created_at: '2026-09-01T00:00:00.999Z' })
      );
      expect(claim?.created_at).toBe(Date.parse('2026-09-01T00:00:00Z') / 1000);
    });

    it('accepts the epoch itself', async () => {
      mocks.get.mockResolvedValue({ phase: 'registered' });
      const claim = await readAccountLifecycleClaim(input({ created_at: '1970-01-01T00:00:00Z' }));
      expect(claim?.created_at).toBe(0);
    });

    it.each([['not a date'], ['1960-01-01T00:00:00Z']])(
      'rejects a creation time that cannot be reported (%s)',
      async (createdAt) => {
        mocks.get.mockResolvedValue({ phase: 'registered' });
        await expect(readAccountLifecycleClaim(input({ created_at: createdAt }))).rejects.toThrow(
          'account_lifecycle_creation_invalid'
        );
      }
    );

    it('rejects a stored creation time that is negative', async () => {
      mocks.get.mockResolvedValue({ phase: 'registered', created_at: -1 });
      await expect(readAccountLifecycleClaim(input())).rejects.toThrow(
        'account_lifecycle_creation_invalid'
      );
    });
  });
});
