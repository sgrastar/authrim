import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOIDCClaimSetHash,
  enforceOIDCAttributeReleaseConsent,
  OIDCAttributeReleaseConsentRequiredError,
  normalizeAttributeReleaseConsentPolicy,
} from '../oidc-attribute-release-consent';
import { resolveAuthCorePersistenceAdapterFromEnv } from '../auth-core-persistence-context';
import { MockDatabaseAdapter } from '../../repositories/__tests__/mock-adapter';

vi.mock('../auth-core-persistence-context', () => ({
  resolveAuthCorePersistenceAdapterFromEnv: vi.fn(),
}));

describe('OIDC attribute release consent', () => {
  let adapter: MockDatabaseAdapter;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
    adapter.initTable('attribute_release_consents', 'id');
    adapter.initTable('oauth_client_consents', 'id');
    vi.mocked(resolveAuthCorePersistenceAdapterFromEnv).mockResolvedValue(adapter);
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
    adapter.seed('oauth_client_consents', [
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
  });

  it('rejects OIDC every-time claim release when OAuth consent is not recent', async () => {
    adapter.seed('oauth_client_consents', [
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
