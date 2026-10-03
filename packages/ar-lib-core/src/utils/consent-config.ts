/**
 * Consent screen and consent data export options: AUTHRIM_CONFIG `consent:*` (set directly in
 * KV), else the CONSENT_* environment variables, else the defaults. A value that cannot be read
 * from KV falls back to env, as it always has.
 */

import type { Env } from '../types/env';

/** The KV binding and the CONSENT_* environment variables (any Worker env). */
type ConsentEnv = Partial<Pick<Env, 'AUTHRIM_CONFIG'>>;

async function readKv(env: ConsentEnv, key: string): Promise<string | null> {
  try {
    return (await env.AUTHRIM_CONFIG?.get(key)) ?? null;
  } catch {
    return null;
  }
}

function envString(env: ConsentEnv, name: string): string | undefined {
  const value = (env as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

const isTrue = (value: string) => value.toLowerCase() === 'true' || value === '1';

async function readBoolean(
  env: ConsentEnv,
  key: string,
  envName: string,
  fallback: boolean
): Promise<boolean> {
  const kvValue = await readKv(env, key);
  if (kvValue !== null) return isTrue(kvValue);
  const envValue = envString(env, envName);
  if (envValue === undefined || envValue === '') return fallback;
  return isTrue(envValue);
}

async function readNumber(
  env: ConsentEnv,
  key: string,
  envName: string,
  min: number,
  fallback: number
): Promise<number> {
  for (const value of [await readKv(env, key), envString(env, envName)]) {
    if (!value) continue;
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed) && parsed >= min) return parsed;
  }
  return fallback;
}

/** Whether users can select individual scopes on the consent screen. */
export function getConsentGranularScopes(env: ConsentEnv): Promise<boolean> {
  return readBoolean(env, 'consent:granular_scopes', 'CONSENT_GRANULAR_SCOPES', false);
}

/** Whether consents expire. */
export function getConsentExpirationEnabled(env: ConsentEnv): Promise<boolean> {
  return readBoolean(env, 'consent:expiration_enabled', 'CONSENT_EXPIRATION_ENABLED', false);
}

/** Default consent lifetime in days (0: no expiration). */
export function getConsentDefaultExpirationDays(env: ConsentEnv): Promise<number> {
  return readNumber(
    env,
    'consent:default_expiration_days',
    'CONSENT_DEFAULT_EXPIRATION_DAYS',
    0,
    0
  );
}

/** Whether consent records policy versions. */
export function getConsentVersioningEnabled(env: ConsentEnv): Promise<boolean> {
  return readBoolean(env, 'consent:versioning_enabled', 'CONSENT_VERSIONING_ENABLED', false);
}

/** Whether users can export their consent data (default: enabled). */
export function getConsentDataExportEnabled(env: ConsentEnv): Promise<boolean> {
  return readBoolean(env, 'consent:data_export_enabled', 'CONSENT_DATA_EXPORT_ENABLED', true);
}

/** Exports smaller than this (KB) are produced synchronously; larger ones asynchronously. */
export function getConsentDataExportSyncThresholdKB(env: ConsentEnv): Promise<number> {
  return readNumber(
    env,
    'consent:data_export_sync_threshold_kb',
    'CONSENT_DATA_EXPORT_SYNC_THRESHOLD_KB',
    64,
    512
  );
}
