/**
 * UserInfo: authrim_roles and authrim_groups follow the tenant's ID token claim settings, are
 * computed after the identity mapping (a mapping cannot supply them) and are not released
 * information (the release approval passes them).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  introspect: vi.fn(),
  getClientCached: vi.fn(),
  findByLegacyUserId: vi.fn(),
  applyMapping: vi.fn(),
  getRBACClaims: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    introspectTokenFromContext: mocks.introspect,
    getClientCached: mocks.getClientCached,
    isUserInfoEncryptionRequired: () => false,
    CanonicalRuntimeUserProjectionRepository: class {
      findByLegacyUserId = mocks.findByLegacyUserId;
    },
    resolveEffectiveSettings: async () => ({}),
    applyOIDCIdentityMapping: mocks.applyMapping,
    resolveAccountDataContextFromHono: async () => undefined,
    findOAuthClientConsentRevocation: async () => ({ generation: 0, revokedAt: null }),
    createAccountAuthContextFromHono: () => ({ coreAdapter: { account: true } }),
    createAuthContextFromHono: () => ({ coreAdapter: { metadata: true } }),
    createPIIContextFromHono: () => ({ coreAdapter: {}, defaultPiiAdapter: {} }),
    loadSubjectServerClaims: mocks.getRBACClaims,
    // The profile discloses what the test hands in.
    resolveDisclosedServerClaims: async (input: { claims: Record<string, unknown> }) =>
      structuredClone(input.claims),
  };
});

vi.mock('../account-lifecycle', () => ({
  ACCOUNT_LIFECYCLE_CLAIM: 'authrim_account_lifecycle',
  readAccountLifecycleClaim: async () => undefined,
}));

import { userinfoHandler } from '../userinfo';
import { lastJson, recordingContext } from './helpers/userinfo-context';

const GROUPS = [{ id: 'g-1', key: 'staff', name: 'Staff', kind: 'static' }];

function projection() {
  return {
    id: 'user-1',
    tenant_id: 'default',
    subject_id: 'subject:user-1',
    account_id: 'account:user-1',
    email: 'user@example.com',
    email_verified: 1,
    name: 'Test User',
    given_name: 'Test',
    family_name: 'User',
    phone_number: null,
    phone_number_verified: 0,
    address_json: null,
    active: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.introspect.mockResolvedValue({
    valid: true,
    claims: {
      sub: 'user-1',
      scope: 'openid profile',
      client_id: 'client-1',
      authrim_release: ['*'],
    },
  });
  mocks.getClientCached.mockResolvedValue({ client_id: 'client-1' });
  mocks.findByLegacyUserId.mockResolvedValue(projection());
  mocks.applyMapping.mockImplementation(async (input: { claims: Record<string, unknown> }) => ({
    // A mapping that tries to supply the authorization claims itself.
    claims: { ...input.claims, authrim_roles: ['forged'], authrim_groups: [] },
  }));
  mocks.getRBACClaims.mockResolvedValue({ authrim_roles: ['member'], authrim_groups: GROUPS });
});

describe('userinfo authorization claims', () => {
  it('answers the computed roles and groups for the subject', async () => {
    const ctx = recordingContext();
    await userinfoHandler(ctx.c);
    const body = lastJson(ctx).body;
    expect(body.authrim_roles).toEqual(['member']);
    expect(body.authrim_groups).toEqual(GROUPS);
    expect(mocks.getRBACClaims).toHaveBeenCalledWith(
      expect.anything(),
      { metadata: { metadata: true }, account: { account: true } },
      'default',
      'user-1'
    );
  });

  it('answers neither when the settings leave them out (and drops a mapped value)', async () => {
    mocks.getRBACClaims.mockResolvedValue({});
    const ctx = recordingContext();
    await userinfoHandler(ctx.c);
    const body = lastJson(ctx).body;
    expect(body).not.toHaveProperty('authrim_roles');
    expect(body).not.toHaveProperty('authrim_groups');
  });

  it('answers without them when they cannot be computed', async () => {
    mocks.getRBACClaims.mockRejectedValue(new Error('db down'));
    const ctx = recordingContext();
    await userinfoHandler(ctx.c);
    const { body } = lastJson(ctx);
    expect(body).not.toHaveProperty('authrim_roles');
    expect(body).toMatchObject({ sub: 'user-1' });
  });
});
