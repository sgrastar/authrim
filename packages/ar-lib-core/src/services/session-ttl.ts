import type { Env } from '../types/env';

export type SessionTtlContext =
  | 'email_code'
  | 'totp'
  | 'directory_password'
  | 'direct_auth'
  | 'passkey'
  | 'passkey_registration'
  | 'admin_passkey'
  | 'guest'
  | 'did'
  // Sign-ins without a setting of their own: external IdP and SAML sign-in, a session made for an
  // app from a session token, and the authorization endpoint's test login.
  | 'default';

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
  guest: {
    key: 'session.ttl.guest',
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
  default: {
    key: 'session.default_ttl',
    envKey: 'DEFAULT_SESSION_TTL',
    defaultMs: ONE_DAY_MS,
    minMs: ONE_MINUTE_MS,
    maxMs: SEVEN_DAYS_MS,
  },
};

/** session.max_ttl: no session lasts longer than this from its creation, extensions included. */
export const SESSION_MAX_TTL_DEFINITION: SessionTtlDefinition = {
  key: 'session.max_ttl',
  envKey: 'MAX_SESSION_TTL_MS',
  defaultMs: THIRTY_DAYS_MS,
  minMs: ONE_DAY_MS,
  maxMs: THIRTY_DAYS_MS,
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
  return sessionTtlFromSettings(env, await readTenantSessionSettings(env, tenantId), context);
}

/** A session lifetime from the tenant's session settings (as read), the environment, or the default. */
export function sessionTtlFromSettings(
  env: Env,
  settings: Record<string, unknown>,
  context: SessionTtlContext
): SessionTtlResolution {
  const definition = SESSION_TTL_DEFINITIONS[context];
  // A lifetime above session.max_ttl is cut to it.
  const milliseconds = Math.min(
    configuredMilliseconds(env, settings, definition),
    sessionMaxTtlFromSettings(env, settings)
  );

  return {
    milliseconds,
    seconds: Math.max(1, Math.floor(milliseconds / 1000)),
    key: definition.key,
  };
}

/** session.max_ttl in milliseconds, from the tenant's session settings, the environment, or the default. */
export function sessionMaxTtlFromSettings(env: Env, settings: Record<string, unknown>): number {
  return configuredMilliseconds(env, settings, SESSION_MAX_TTL_DEFINITION);
}

export interface SessionExtensionPolicy {
  /** session.refresh_default: whether POST /api/sessions/refresh may extend a session. */
  enabled: boolean;
  /** session.max_ttl: an extension never takes a session past its creation plus this. */
  maxLifetimeMs: number;
}

export function sessionExtensionPolicyFromSettings(
  env: Env,
  settings: Record<string, unknown>
): SessionExtensionPolicy {
  return {
    enabled: sessionRefreshEnabled(env, settings),
    maxLifetimeMs: sessionMaxTtlFromSettings(env, settings),
  };
}

export async function resolveSessionExtensionPolicy(
  env: Env,
  tenantId: string
): Promise<SessionExtensionPolicy> {
  return sessionExtensionPolicyFromSettings(env, await readTenantSessionSettings(env, tenantId));
}

function sessionRefreshEnabled(env: Env, settings: Record<string, unknown>): boolean {
  const setting = settings['session.refresh_default'];
  if (typeof setting === 'boolean') return setting;
  const envValue = (env as unknown as Record<string, unknown>)['SESSION_REFRESH_DEFAULT'];
  if (envValue === 'false' || envValue === false) return false;
  return true;
}

function configuredMilliseconds(
  env: Env,
  settings: Record<string, unknown>,
  definition: SessionTtlDefinition
): number {
  const rawEnvValue = (env as unknown as Record<string, unknown>)[definition.envKey];
  const configuredValue =
    parsePositiveInteger(settings[definition.key]) ??
    parsePositiveInteger(rawEnvValue) ??
    definition.defaultMs;
  return clamp(configuredValue, definition.minMs, definition.maxMs);
}

/**
 * The tenant's session settings for an admin view: like readTenantSessionSettings, but a document
 * that cannot be read or is not an object throws instead of reading as no settings (sign-in then
 * uses the environment and defaults, which the view must not show as the tenant's).
 */
export async function readTenantSessionSettingsStrict(
  env: Env,
  tenantId: string
): Promise<Record<string, unknown>> {
  const raw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:session`);
  // Only a missing document is no settings; a stored empty string is unreadable data.
  if (raw === null || raw === undefined) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('session_settings_invalid');
  }
  return parsed as Record<string, unknown>;
}

/** The tenant's session settings as login reads them (the projected v2 document). */
export async function readTenantSessionSettings(
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
