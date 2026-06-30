import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECRET_TARGET_WORKERS,
  getSecretNamesForWorker,
  getSecretTargetWorkers,
  SECRET_UPLOAD_PLAN,
} from '../core/deploy.js';

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

  it('keeps VersionManager secret separate from broad Admin API secret', () => {
    expect(getSecretNamesForWorker('ar-lib-core')).toContain('VERSION_MANAGER_SECRET');
    expect(getSecretNamesForWorker('ar-management')).toContain('VERSION_MANAGER_SECRET');
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

  it('uploads plugin encryption key only to plugin config/runtime workers', () => {
    expect(getSecretNamesForWorker('ar-management')).toContain('PLUGIN_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-auth')).toContain('PLUGIN_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-discovery')).not.toContain('PLUGIN_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-router')).not.toContain('PLUGIN_ENCRYPTION_KEY');
    expect(getSecretNamesForWorker('ar-token')).not.toContain('PLUGIN_ENCRYPTION_KEY');
  });

  it('does not upload Admin API root bearer material to SAML or bridge workers', () => {
    expect(getSecretNamesForWorker('ar-saml')).toContain('KEY_MANAGER_SECRET');
    expect(getSecretNamesForWorker('ar-saml')).not.toContain('ADMIN_API_SECRET');
    expect(getSecretNamesForWorker('ar-bridge')).toEqual([
      'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
    ]);
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
