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

function input(overrides: Partial<CanonicalRuntimeUserProjection> = {}) {
  return {
    c: {
      env: { AUTHRIM_CONFIG: {}, GUEST_UPGRADE_READINESS: { read: mocks.readiness } },
    } as unknown as Context<{
      Bindings: Env;
    }>,
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

describe('UserInfo account lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readiness.mockResolvedValue({ tenantId: 'tenant-a', email: true });
    mocks.get.mockResolvedValue({
      phase: 'active',
      client_id: 'client-a',
      status: 'active',
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

  it('does not read or expose lifecycle without the granted scope', async () => {
    expect(await readAccountLifecycleClaim({ ...input(), scopes: ['openid'] })).toBeUndefined();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.sources).not.toHaveBeenCalled();
  });
  it.each(['active', 'upgrading'])(
    'does not report a %s lifecycle as registered from a staged user projection',
    async (phase) => {
      mocks.get.mockResolvedValue({
        phase,
        client_id: 'client-a',
        created_at: 100,
        deletion_due_at: 200,
      });
      const claim = await readAccountLifecycleClaim(input({ account_type: 'user' }));
      expect(claim).toMatchObject({
        registration_state: 'guest',
        deletion_due_at: 200,
        upgrade_eligible: phase === 'active',
      });
    }
  );
  it('reports committed registration even when the user projection still says anonymous', async () => {
    mocks.get.mockResolvedValue({ phase: 'registered', created_at: 100, deletion_due_at: null });
    expect(await readAccountLifecycleClaim(input())).toMatchObject({
      registration_state: 'registered',
      deletion_due_at: null,
      upgrade_eligible: false,
    });
    expect(mocks.readiness).not.toHaveBeenCalled();
  });
  it('does not offer an upgrade through another client', async () => {
    expect(await readAccountLifecycleClaim({ ...input(), clientId: 'client-b' })).toMatchObject({
      upgrade_eligible: false,
    });
    expect(mocks.contract).not.toHaveBeenCalled();
    expect(mocks.readiness).not.toHaveBeenCalled();
  });
  it('preserves regular accounts without a guest lifecycle row', async () => {
    mocks.get.mockResolvedValue(null);
    expect(
      await readAccountLifecycleClaim(
        input({ account_type: 'user', registration_state: 'registered' })
      )
    ).toMatchObject({
      registration_state: 'registered',
      upgrade_eligible: false,
    });
  });
  it('reports unavailable email delivery as ineligible', async () => {
    mocks.readiness.mockResolvedValue({ tenantId: 'tenant-a', email: false });
    expect((await readAccountLifecycleClaim(input()))?.upgrade_eligible).toBe(false);
  });
  it('rejects readiness from another tenant', async () => {
    mocks.readiness.mockResolvedValue({ tenantId: 'tenant-b', email: true });
    await expect(readAccountLifecycleClaim(input())).rejects.toThrow(
      'guest_upgrade_readiness_invalid'
    );
  });
  it('reports stored deadlines even when overdue and distinguishes incomplete profile', async () => {
    mocks.missing.mockResolvedValue([{ fieldKey: 'required-name' }]);
    expect(await readAccountLifecycleClaim(input())).toEqual({
      registration_state: 'guest',
      status: 'active',
      created_at: 100,
      deletion_due_at: 200,
      upgrade_eligible: true,
      profile_complete: false,
    });
  });
  it.each(['deleting', 'deleted'])('rejects a %s account', async (phase) => {
    mocks.get.mockResolvedValue({ phase });
    await expect(readAccountLifecycleClaim(input())).rejects.toThrow('account_lifecycle_deleted');
    expect(mocks.sources).not.toHaveBeenCalled();
  });
  it.each(['device', 'agent', 'service'])('does not apply human lifecycle to %s', async (kind) => {
    expect(await readAccountLifecycleClaim(input({ account_type: kind }))).toBeUndefined();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('rejects cross-tenant projection before reading data', async () => {
    await expect(readAccountLifecycleClaim(input({ tenant_id: 'tenant-b' }))).rejects.toThrow(
      'account_lifecycle_tenant_mismatch'
    );
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('returns no deletion date or upgrade eligibility after promotion', async () => {
    mocks.get.mockResolvedValue({ phase: 'registered', created_at: 100, deletion_due_at: null });
    expect(await readAccountLifecycleClaim(input({ account_type: 'user' }))).toEqual({
      registration_state: 'registered',
      status: 'active',
      created_at: 100,
      deletion_due_at: null,
      upgrade_eligible: false,
      profile_complete: true,
    });
    expect(mocks.settings).not.toHaveBeenCalled();
  });
  it.each([
    { enabled: false, methods: ['email'], allowed: ['email'], eligible: false },
    { enabled: true, methods: [], allowed: ['email'], eligible: false },
    { enabled: true, methods: ['email'], allowed: [], eligible: false },
    { enabled: true, methods: ['passkey'], allowed: ['email'], eligible: false },
    { enabled: true, methods: ['passkey'], allowed: ['passkey'], eligible: true },
  ])(
    'requires current method and global permissions: %j',
    async ({ enabled, methods, allowed, eligible }) => {
      mocks.settings.mockResolvedValue({
        policy: { upgradeEnabled: enabled },
        upgradeMethods: methods,
      });
      mocks.contract.mockResolvedValue({ guestAuth: { allowedUpgradeMethods: allowed } });
      expect((await readAccountLifecycleClaim(input()))?.upgrade_eligible).toBe(eligible);
    }
  );
  it('propagates unavailable settings rather than granting default eligibility', async () => {
    mocks.settings.mockRejectedValue(new Error('settings_read_failed'));
    await expect(readAccountLifecycleClaim(input())).rejects.toThrow('settings_read_failed');
  });
});

describe('registration and operational status are independent', () => {
  it.each(['active', 'suspended', 'locked', 'inactive'])(
    'preserves %s status without changing guest registration',
    async (status) => {
      mocks.get.mockResolvedValue({ phase: 'upgrading', created_at: 100, deletion_due_at: null });
      mocks.sources.mockResolvedValue({ nonPiiDb: {} });
      mocks.missing.mockResolvedValue([]);
      const claim = await readAccountLifecycleClaim(input({ status: status }));
      expect(claim).toMatchObject({ status, registration_state: 'guest', upgrade_eligible: false });
      expect(claim).not.toHaveProperty('account_kind');
    }
  );
});
