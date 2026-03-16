import { describe, expect, it } from 'vitest';
import { DEFAULT_SECRET_TARGET_WORKERS } from '../core/deploy.js';

describe('DEFAULT_SECRET_TARGET_WORKERS', () => {
  it('includes ar-saml so SAML signing secrets are uploaded by default', () => {
    expect(DEFAULT_SECRET_TARGET_WORKERS).toContain('ar-saml');
  });
});
