import { describe, expect, it } from 'vitest';
import type { Env } from '../../types/env';
import {
  getConsentDataExportEnabled,
  getConsentDataExportSyncThresholdKB,
  getConsentDefaultExpirationDays,
  getConsentExpirationEnabled,
  getConsentGranularScopes,
  getConsentVersioningEnabled,
} from '../consent-config';

function consentEnv(values: Record<string, string>): Partial<Env> {
  return values as Partial<Env>;
}

describe('consent options from env', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('resolves CONSENT_GRANULAR_SCOPES=%s', async (value, expected) => {
    await expect(
      getConsentGranularScopes(consentEnv({ CONSENT_GRANULAR_SCOPES: value }))
    ).resolves.toBe(expected);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
  ])('resolves CONSENT_EXPIRATION_ENABLED=%s', async (value, expected) => {
    await expect(
      getConsentExpirationEnabled(consentEnv({ CONSENT_EXPIRATION_ENABLED: value }))
    ).resolves.toBe(expected);
  });

  it.each([
    ['30', 30],
    ['0', 0],
    ['-1', 0],
    ['invalid', 0],
  ])('validates CONSENT_DEFAULT_EXPIRATION_DAYS=%s', async (value, expected) => {
    await expect(
      getConsentDefaultExpirationDays(consentEnv({ CONSENT_DEFAULT_EXPIRATION_DAYS: value }))
    ).resolves.toBe(expected);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
  ])('resolves CONSENT_VERSIONING_ENABLED=%s', async (value, expected) => {
    await expect(
      getConsentVersioningEnabled(consentEnv({ CONSENT_VERSIONING_ENABLED: value }))
    ).resolves.toBe(expected);
  });

  it('reads consent:* from AUTHRIM_CONFIG before env, and env for the data export options', async () => {
    const kv = {
      get: async (key: string) => (key === 'consent:granular_scopes' ? 'true' : null),
    } as unknown as KVNamespace;
    await expect(
      getConsentGranularScopes({
        AUTHRIM_CONFIG: kv,
        CONSENT_GRANULAR_SCOPES: 'false',
      } as Partial<Env>)
    ).resolves.toBe(true);
    await expect(getConsentDataExportEnabled({})).resolves.toBe(true);
    await expect(
      getConsentDataExportEnabled(consentEnv({ CONSENT_DATA_EXPORT_ENABLED: 'false' }))
    ).resolves.toBe(false);
    await expect(getConsentDataExportSyncThresholdKB({})).resolves.toBe(512);
    await expect(
      getConsentDataExportSyncThresholdKB(
        consentEnv({ CONSENT_DATA_EXPORT_SYNC_THRESHOLD_KB: '32' })
      )
    ).resolves.toBe(512);
  });
});
