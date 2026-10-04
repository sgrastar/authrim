import { describe, expect, it } from 'vitest';
import {
  ALL_CATEGORY_META,
  createSettingsManager,
  type CategoryMeta,
  type Env,
} from '@authrim/ar-lib-core';
import {
  CERTIFICATION_PROFILE_MANAGED_KEYS,
  certificationProfiles,
  getCertificationProfile,
} from '../certification-profiles';
import { validateSettingValue } from '../routes/settings-v2/patch-validation';

describe('certification profiles', () => {
  it('sets only managed settings, with values a tenant PATCH accepts', () => {
    const manager = createSettingsManager({ env: {}, kv: null, cacheTTL: 0 });
    for (const meta of Object.values(ALL_CATEGORY_META)) {
      manager.registerCategory(meta as CategoryMeta);
    }
    for (const [id, profile] of Object.entries(certificationProfiles)) {
      for (const [category, values] of Object.entries(profile.settings)) {
        const managed = CERTIFICATION_PROFILE_MANAGED_KEYS.get(category as never) ?? [];
        for (const [key, value] of Object.entries(values ?? {})) {
          expect(managed, `${id} ${key}`).toContain(key);
          expect(
            validateSettingValue(category, 'tenant', key, value, {} as Env),
            `${id} ${key}`
          ).toBeNull();
        }
        expect(manager.validate(category, values ?? {}), `${id} ${category}`).toMatchObject({
          valid: true,
        });
      }
    }
  });

  it('turns off the tenant’s app security floor, which the test plans would trip on', () => {
    expect(CERTIFICATION_PROFILE_MANAGED_KEYS.get('security')).toEqual(
      expect.arrayContaining([
        'security.pkce_required',
        'security.dpop_bound_access_tokens',
        'security.require_encrypted_request_object',
      ])
    );
    for (const [id, profile] of Object.entries(certificationProfiles)) {
      expect(profile.settings.security, id).toMatchObject({
        'security.pkce_required': false,
        'security.dpop_bound_access_tokens': false,
        'security.require_encrypted_request_object': false,
      });
    }
  });

  it('defines a FAPI 2.0 Client Credentials DPoP profile', () => {
    expect(getCertificationProfile('fapi-2-client-credentials-dpop')?.settings).toMatchObject({
      security: {
        'security.fapi_enabled': true,
        'security.dpop_required': 'always',
        'security.fapi_allow_public_clients': false,
        'security.par_required': false,
      },
      oauth: { 'oauth.token_endpoint_auth_methods_supported': ['private_key_jwt'] },
      'feature-flags': {
        'feature.enable_client_credentials': true,
        'feature.enable_ai_ephemeral_auth': true,
      },
    });
  });

  it('defines a FAPI 2.0 Message Signing profile without changing the normal FAPI profile', () => {
    expect(getCertificationProfile('fapi-2-message-signing-dpop')?.settings).toMatchObject({
      security: {
        'security.fapi_enabled': true,
        'security.dpop_required': 'always',
        'security.fapi_message_signing_enabled': true,
        'security.require_signed_request_object': true,
        'security.require_jarm': true,
        'security.request_object_signing_algs': 'ES256,PS256,EdDSA',
        'security.authorization_signing_algs': 'ES256',
        'security.default_authorization_signing_alg': 'ES256',
        'security.par_required': true,
      },
    });
    expect(getCertificationProfile('fapi-2-dpop')?.settings.security).not.toHaveProperty(
      'security.fapi_message_signing_enabled'
    );
  });

  it('finds only defined profiles', () => {
    expect(getCertificationProfile('constructor')).toBeNull();
    expect(getCertificationProfile('unknown')).toBeNull();
  });
});
