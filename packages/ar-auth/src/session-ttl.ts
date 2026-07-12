import type { Env } from '@authrim/ar-lib-core';

export type SessionTtlContext =
  | 'email_code'
  | 'totp'
  | 'directory_password'
  | 'direct_auth'
  | 'passkey'
  | 'passkey_registration'
  | 'admin_passkey'
  | 'anonymous'
  | 'did';

export interface SessionTtlDefinition {
  key: string;
  envKey: string;
  defaultMs: number;
  minMs: number;
  maxMs: number;
}

const ONE_MINUTE_MS = 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

export const SESSION_TTL_DEFINITIONS: Record<SessionTtlContext, SessionTtlDefinition> = {
  email_code: {
    key: 'session.ttl.email_code',
    envKey: 'SESSION_TTL_EMAIL_CODE_MS',
    defaultMs: ONE_DAY_MS,
    minMs: ONE_MINUTE_MS,
    maxMs: THIRTY_DAYS_MS,
  },
  totp: {
    key: 'session.ttl.totp',
    envKey: 'SESSION_TTL_TOTP_MS',
    defaultMs: ONE_DAY_MS,
    minMs: ONE_MINUTE_MS,
    maxMs: THIRTY_DAYS_MS,
  },
  directory_password: {
    key: 'session.ttl.directory_password',
    envKey: 'SESSION_TTL_DIRECTORY_PASSWORD_MS',
    defaultMs: ONE_DAY_MS,
    minMs: ONE_MINUTE_MS,
    maxMs: THIRTY_DAYS_MS,
  },
  direct_auth: {
    key: 'session.ttl.direct_auth',
    envKey: 'SESSION_TTL_DIRECT_AUTH_MS',
    defaultMs: ONE_DAY_MS,
    minMs: ONE_MINUTE_MS,
    maxMs: THIRTY_DAYS_MS,
  },
  passkey: {
    key: 'session.ttl.passkey',
    envKey: 'SESSION_TTL_PASSKEY_MS',
    defaultMs: SEVEN_DAYS_MS,
    minMs: ONE_MINUTE_MS,
    maxMs: THIRTY_DAYS_MS,
  },
  passkey_registration: {
    key: 'session.ttl.passkey_registration',
    envKey: 'SESSION_TTL_PASSKEY_REGISTRATION_MS',
    defaultMs: THIRTY_DAYS_MS,
    minMs: ONE_MINUTE_MS,
    maxMs: THIRTY_DAYS_MS,
  },
  admin_passkey: {
    key: 'session.ttl.admin_passkey',
    envKey: 'SESSION_TTL_ADMIN_PASSKEY_MS',
    defaultMs: SEVEN_DAYS_MS,
    minMs: ONE_MINUTE_MS,
    maxMs: THIRTY_DAYS_MS,
  },
  anonymous: {
    key: 'session.ttl.anonymous',
    envKey: 'SESSION_TTL_ANONYMOUS_MS',
    defaultMs: ONE_DAY_MS,
    minMs: ONE_MINUTE_MS,
    maxMs: THIRTY_DAYS_MS,
  },
  did: {
    key: 'session.ttl.did',
    envKey: 'SESSION_TTL_DID_MS',
    defaultMs: ONE_DAY_MS,
    minMs: ONE_MINUTE_MS,
    maxMs: THIRTY_DAYS_MS,
  },
};

export interface SessionTtlResolution {
  milliseconds: number;
  seconds: number;
  key: string;
}

export async function resolveSessionTtl(
  env: Env,
  tenantId: string,
  context: SessionTtlContext
): Promise<SessionTtlResolution> {
  const definition = SESSION_TTL_DEFINITIONS[context];
  const settings = await readTenantSessionSettings(env, tenantId);
  const rawSettingValue = settings[definition.key];
  const rawEnvValue = (env as unknown as Record<string, unknown>)[definition.envKey];
  const configuredValue =
    parsePositiveInteger(rawSettingValue) ??
    parsePositiveInteger(rawEnvValue) ??
    definition.defaultMs;
  const milliseconds = clamp(configuredValue, definition.minMs, definition.maxMs);

  return {
    milliseconds,
    seconds: Math.max(1, Math.floor(milliseconds / 1000)),
    key: definition.key,
  };
}

async function readTenantSessionSettings(
  env: Env,
  tenantId: string
): Promise<Record<string, unknown>> {
  try {
    const raw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:session`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
