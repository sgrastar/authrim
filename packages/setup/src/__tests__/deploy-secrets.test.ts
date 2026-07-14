import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECRET_TARGET_WORKERS,
  getSecretNamesForWorker,
  getSecretTargetWorkers,
  SECRET_UPLOAD_PLAN,
} from '../core/deploy.js';
import { getMissingRequiredDeploySecrets } from '../core/secrets.js';

describe('DEFAULT_SECRET_TARGET_WORKERS', () => {
  it('includes ar-saml so SAML signing secrets are uploaded by default', () => {
    expect(DEFAULT_SECRET_TARGET_WORKERS).toContain('ar-saml');
  });

  it('does not include workers with no secret requirements', () => {
    expect(DEFAULT_SECRET_TARGET_WORKERS).not.toContain('ar-router');
    expect(DEFAULT_SECRET_TARGET_WORKERS).not.toContain('ar-policy');
  });
});

describe('getSecretTargetWorkers', () => {
  it('returns the default secret-bearing workers when no override is provided', () => {
    expect(getSecretTargetWorkers()).toEqual(DEFAULT_SECRET_TARGET_WORKERS);
  });

  it('limits uploads to enabled workers that actually require secrets', () => {
    expect(
      getSecretTargetWorkers([
        'ar-lib-core',
        'ar-discovery',
        'ar-auth',
        'ar-token',
        'ar-userinfo',
        'ar-management',
        'ar-bridge',
        'ar-policy',
        'ar-router',
      ])
    ).toEqual([
      'ar-lib-core',
      'ar-discovery',
      'ar-auth',
      'ar-token',
      'ar-userinfo',
      'ar-management',
      'ar-bridge',
    ]);
  });

  it('keeps ar-saml only when the component is enabled', () => {
    expect(
      getSecretTargetWorkers([
        'ar-lib-core',
        'ar-discovery',
        'ar-auth',
        'ar-token',
        'ar-userinfo',
        'ar-management',
        'ar-saml',
        'ar-router',
      ])
    ).toContain('ar-saml');
  });
});

describe('SECRET_UPLOAD_PLAN', () => {
  it('fails fresh Workers only for missing required secrets', () => {
    expect(
      getMissingRequiredDeploySecrets(
        {
          PUBLIC_JWK_JSON: '{}',
          DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID: '',
          DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET: '',
        },
        ['ar-discovery', 'ar-userinfo']
      )
    ).toEqual(['TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS']);
  });

  it('treats provider credentials as optional during a first deployment', () => {
    const authSecrets = Object.fromEntries(
      getSecretNamesForWorker('ar-auth')
        .filter((name) => name !== 'RESEND_API_KEY')
        .map((name) => [name, 'configured'])
    );

    expect(getMissingRequiredDeploySecrets(authSecrets, ['ar-auth'])).toEqual([]);
  });

  it('keeps discovery to public JWKS fallback only', () => {
    expect(getSecretNamesForWorker('ar-discovery')).toEqual(['PUBLIC_JWK_JSON']);
  });

  it('does not upload broad admin secrets to public discovery', () => {
    expect(SECRET_UPLOAD_PLAN['ar-discovery']).not.toContain('ADMIN_API_SECRET');
    expect(SECRET_UPLOAD_PLAN['ar-discovery']).not.toContain('KEY_MANAGER_SECRET');
    expect(SECRET_UPLOAD_PLAN['ar-discovery']).not.toContain('PRIVATE_KEY_PEM');
  });

  it('uploads downstream introspection credentials only to userinfo', () => {
    expect(getSecretNamesForWorker('ar-userinfo')).toContain(
      'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET'
    );
    expect(getSecretNamesForWorker('ar-management')).not.toContain(
      'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET'
    );
  });

  it('uses Durable Object bindings instead of static KeyManager or VersionManager credentials', () => {
    expect(getSecretNamesForWorker('ar-lib-core')).not.toContain('VERSION_MANAGER_SECRET');
    expect(getSecretNamesForWorker('ar-management')).not.toContain('VERSION_MANAGER_SECRET');
    expect(getSecretNamesForWorker('ar-auth')).not.toContain('KEY_MANAGER_SECRET');
    expect(getSecretNamesForWorker('ar-token')).not.toContain('KEY_MANAGER_SECRET');
    expect(getSecretNamesForWorker('ar-saml')).not.toContain('KEY_MANAGER_SECRET');
    expect(getSecretNamesForWorker('ar-management')).not.toContain('ADMIN_API_SECRET');
  });

  it('uploads the logging cursor secret only to management', () => {
    expect(getSecretNamesForWorker('ar-management')).toContain('LOGGING_CURSOR_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-auth')).not.toContain('LOGGING_CURSOR_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-token')).not.toContain('LOGGING_CURSOR_HMAC_SECRET');
  });

  it('uploads the Flow runtime HMAC secret only to the auth runtime worker', () => {
    expect(getSecretNamesForWorker('ar-auth')).toContain('FLOW_RUNTIME_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-management')).not.toContain('FLOW_RUNTIME_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-token')).not.toContain('FLOW_RUNTIME_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-router')).not.toContain('FLOW_RUNTIME_HMAC_SECRET');
  });

  it('uploads the transaction-code HMAC secret only to the VC worker', () => {
    expect(getSecretNamesForWorker('ar-vc')).toContain('VC_TRANSACTION_CODE_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-auth')).not.toContain('VC_TRANSACTION_CODE_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-management')).not.toContain(
      'VC_TRANSACTION_CODE_HMAC_SECRET'
    );
  });

  it('uploads TOTP and OTP secret material only to auth-capable workers', () => {
    expect(getSecretNamesForWorker('ar-auth')).toContain('OTP_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-auth')).toContain('PII_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-management')).toContain('OTP_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-management')).toContain('PII_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-token')).not.toContain('OTP_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-token')).not.toContain('PII_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-router')).not.toContain('OTP_HMAC_SECRET');
    expect(getSecretNamesForWorker('ar-router')).not.toContain('PII_ENCRYPTION_KEY');
  });

  it('uploads plugin encryption key only to plugin config/runtime workers', () => {
    expect(getSecretNamesForWorker('ar-management')).toContain('PLUGIN_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-auth')).toContain('PLUGIN_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-discovery')).not.toContain('PLUGIN_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-router')).not.toContain('PLUGIN_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-token')).not.toContain('PLUGIN_ENCRYPTION_KEY');
  });

  it('keeps email sender metadata out of Workers secrets because wrangler vars own those bindings', () => {
    expect(getSecretNamesForWorker('ar-auth')).not.toContain('EMAIL_FROM');
    expect(getSecretNamesForWorker('ar-auth')).not.toContain('EMAIL_FROM_NAME');
    expect(getSecretNamesForWorker('ar-management')).not.toContain('EMAIL_FROM');
    expect(getSecretNamesForWorker('ar-management')).not.toContain('EMAIL_FROM_NAME');
  });

  it('does not upload static internal bearer material to SAML or bridge workers', () => {
    expect(getSecretNamesForWorker('ar-saml')).not.toContain('KEY_MANAGER_SECRET');
    expect(getSecretNamesForWorker('ar-saml')).not.toContain('ADMIN_API_SECRET');
    expect(getSecretNamesForWorker('ar-bridge')).toEqual([
      'RP_TOKEN_ENCRYPTION_KEY',
      'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    ]);
    expect(getSecretNamesForWorker('ar-bridge')).not.toContain('ADMIN_API_SECRET');
  });

  it('keeps runtime registry private signing material limited to management', () => {
    expect(getSecretNamesForWorker('ar-management')).toContain(
      'TENANT_RUNTIME_REGISTRY_SIGNING_PRIVATE_JWK'
    );
    expect(getSecretNamesForWorker('ar-auth')).not.toContain(
      'TENANT_RUNTIME_REGISTRY_SIGNING_PRIVATE_JWK'
    );
    expect(getSecretNamesForWorker('ar-token')).not.toContain(
      'TENANT_RUNTIME_REGISTRY_SIGNING_PRIVATE_JWK'
    );
    expect(getSecretNamesForWorker('ar-auth')).toContain(
      'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS'
    );
  });
});
