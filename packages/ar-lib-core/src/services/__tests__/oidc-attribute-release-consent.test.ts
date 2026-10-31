import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOIDCClaimSetHash,
  enforceOIDCAttributeReleaseConsent,
  OIDCAttributeReleaseConsentRequiredError,
  normalizeAttributeReleaseConsentPolicy,
} from '../oidc-attribute-release-consent';
import { resolveAuthCorePersistenceAdapterFromEnv } from '../auth-core-persistence-context';
import { resolveAccountDataContext } from '../runtime-data-context';
import { MockDatabaseAdapter } from '../../repositories/__tests__/mock-adapter';

vi.mock('../auth-core-persistence-context', () => ({
  resolveAuthCorePersistenceAdapterFromEnv: vi.fn(),
}));
vi.mock('../runtime-data-context', () => ({
  resolveAccountDataContext: vi.fn(),
}));

describe('OIDC attribute release consent', () => {
  // Attribute release consents are tenant metadata; OAuth client consents are stored with the
  // user in its account database.
  let adapter: MockDatabaseAdapter;
  let accountAdapter: MockDatabaseAdapter;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
    adapter.initTable('attribute_release_consents', 'id');
    adapter.initTable('oauth_client_consents', 'id');
    accountAdapter = new MockDatabaseAdapter();
    accountAdapter.initTable('oauth_client_consents', 'id');
    // Complete the adapter surface so the account route source is used as-is.
    Object.assign(accountAdapter, { getType: () => 'd1', close: async () => undefined });
    vi.mocked(resolveAuthCorePersistenceAdapterFromEnv).mockResolvedValue(adapter);
    vi.mocked(resolveAccountDataContext).mockReset();
    vi.mocked(resolveAccountDataContext).mockResolvedValue({
      coreDb: accountAdapter,
    } as never);
  });

  it('normalizes protocol-neutral claim release consent policy config', () => {
    expect(
      normalizeAttributeReleaseConsentPolicy({
        enabled: true,
        mode: 'until_attributes_change',
      })
    ).toEqual({
      enabled: true,
      mode: 'until_attributes_change',
    });

    expect(normalizeAttributeReleaseConsentPolicy({ enabled: true, mode: 'invalid' })).toBeNull();
  });

  it('builds a stable claim set hash without storing raw claim values', async () => {
    const left = await buildOIDCClaimSetHash({
      email: 'user@example.edu',
      name: 'Example User',
      address: {
        country: 'JP',
        locality: 'Tokyo',
      },
    });
    const right = await buildOIDCClaimSetHash({
      address: {
        locality: 'Tokyo',
        country: 'JP',
      },
      name: 'Example User',
      email: 'user@example.edu',
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(left).not.toContain('user@example.edu');
  });

  it('uses a recent OAuth consent as OIDC every-time claim release transaction confirmation', async () => {
    accountAdapter.seed('oauth_client_consents', [
      {
        id: 'oauth-consent-recent',
        tenant_id: 'tenant-a',
        user_id: 'user-1',
        client_id: 'client-1',
        scope: 'openid email',
        granted_at: Date.now(),
        expires_at: null,
      },
    ]);

    await expect(
      enforceOIDCAttributeReleaseConsent({
        env: {} as never,
        tenantId: 'tenant-a',
        subjectId: 'user-1',
        clientMetadata: {
          client_id: 'client-1',
          attribute_release_consent: { enabled: true, mode: 'every_time' },
        },
        claims: {
          sub: 'user-1',
          email: 'user@example.edu',
        },
        target: 'id_token',
      })
    ).resolves.toMatchObject({
      action: 'release',
      reasonCodes: ['release.attribute_consent.transaction_confirmed'],
    });

    expect(adapter.getAll('attribute_release_consents')).toHaveLength(1);
    expect(resolveAccountDataContext).toHaveBeenCalledWith(
      {},
      { tenantId: 'tenant-a', accountId: 'user-1' }
    );
  });

  it('does not take an OAuth consent from the tenant metadata database', async () => {
    adapter.seed('oauth_client_consents', [
      {
        id: 'oauth-consent-metadata',
        tenant_id: 'tenant-a',
        user_id: 'user-1',
        client_id: 'client-1',
        scope: 'openid email',
        granted_at: Date.now(),
        expires_at: null,
      },
    ]);

    await expect(
      enforceOIDCAttributeReleaseConsent({
        env: {} as never,
        tenantId: 'tenant-a',
        subjectId: 'user-1',
        clientMetadata: {
          client_id: 'client-1',
          attribute_release_consent: { enabled: true, mode: 'once' },
        },
        claims: { sub: 'user-1', email: 'user@example.edu' },
        target: 'userinfo',
      })
    ).rejects.toBeInstanceOf(OIDCAttributeReleaseConsentRequiredError);
  });

  it('treats a subject without an account route as having no OAuth consent', async () => {
    vi.mocked(resolveAccountDataContext).mockRejectedValue(
      new Error('account_data_route_not_found')
    );

    await expect(
      enforceOIDCAttributeReleaseConsent({
        env: {} as never,
        tenantId: 'tenant-a',
        subjectId: 'user-unrouted',
        clientMetadata: {
          client_id: 'client-1',
          attribute_release_consent: { enabled: true, mode: 'once' },
        },
        claims: { sub: 'user-unrouted', email: 'user@example.edu' },
        target: 'id_token',
      })
    ).rejects.toBeInstanceOf(OIDCAttributeReleaseConsentRequiredError);
  });

  it('rejects OIDC every-time claim release when OAuth consent is not recent', async () => {
    accountAdapter.seed('oauth_client_consents', [
      {
        id: 'oauth-consent-old',
        tenant_id: 'tenant-a',
        user_id: 'user-1',
        client_id: 'client-1',
        scope: 'openid email',
        granted_at: Date.now() - 10 * 60 * 1000,
        expires_at: null,
      },
    ]);

    await expect(
      enforceOIDCAttributeReleaseConsent({
        env: {} as never,
        tenantId: 'tenant-a',
        subjectId: 'user-1',
        clientMetadata: {
          client_id: 'client-1',
          attribute_release_consent: { enabled: true, mode: 'every_time' },
        },
        claims: {
          sub: 'user-1',
          email: 'user@example.edu',
        },
        target: 'userinfo',
      })
    ).rejects.toBeInstanceOf(OIDCAttributeReleaseConsentRequiredError);

    expect(adapter.getAll('attribute_release_consents')).toHaveLength(0);
  });
});
