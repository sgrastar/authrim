import { describe, expect, it } from 'vitest';
import type { Env } from '../../types/env';
import { createOAuthConfigManager } from '../oauth-config';

function consentEnv(values: Record<string, string>): Partial<Env> {
  return values as Partial<Env>;
}

describe('OAuthConfigManager consent environment fallback', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('resolves CONSENT_GRANULAR_SCOPES=%s', async (value, expected) => {
    const manager = createOAuthConfigManager(consentEnv({ CONSENT_GRANULAR_SCOPES: value }));
    await expect(manager.getConsentGranularScopes()).resolves.toBe(expected);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
  ])('resolves CONSENT_EXPIRATION_ENABLED=%s', async (value, expected) => {
    const manager = createOAuthConfigManager(consentEnv({ CONSENT_EXPIRATION_ENABLED: value }));
    await expect(manager.getConsentExpirationEnabled()).resolves.toBe(expected);
  });

  it.each([
    ['30', 30],
    ['0', 0],
    ['-1', 0],
    ['invalid', 0],
  ])('validates CONSENT_DEFAULT_EXPIRATION_DAYS=%s', async (value, expected) => {
    const manager = createOAuthConfigManager(
      consentEnv({ CONSENT_DEFAULT_EXPIRATION_DAYS: value })
    );
    await expect(manager.getConsentDefaultExpirationDays()).resolves.toBe(expected);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
  ])('resolves CONSENT_VERSIONING_ENABLED=%s', async (value, expected) => {
    const manager = createOAuthConfigManager(consentEnv({ CONSENT_VERSIONING_ENABLED: value }));
    await expect(manager.getConsentVersioningEnabled()).resolves.toBe(expected);
  });
});
