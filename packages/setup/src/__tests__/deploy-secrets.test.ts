import { describe, expect, it } from 'vitest';
import { DEFAULT_SECRET_TARGET_WORKERS, getSecretTargetWorkers } from '../core/deploy.js';

describe('DEFAULT_SECRET_TARGET_WORKERS', () => {
  it('includes ar-saml so SAML signing secrets are uploaded by default', () => {
    expect(DEFAULT_SECRET_TARGET_WORKERS).toContain('ar-saml');
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
