/**
 * What a tenant allows for each authentication method and use (login, signup, re-authentication,
 * account linking): the tenant's `authentication-methods` settings in KV. Shared by every
 * endpoint that sends or verifies a code, so one switch governs them all.
 */
import type { Env } from '@authrim/ar-lib-core';

export type AuthenticationMethodUsage = 'login' | 'signup' | 'reauth' | 'account_link';

export interface AuthenticationMethodKVSettings {
  'authentication-methods.passkey.enabled'?: boolean | string;
  'authentication-methods.passkey.login_enabled'?: boolean | string;
  'authentication-methods.passkey.signup_enabled'?: boolean | string;
  'authentication-methods.passkey.reauth_enabled'?: boolean | string;
  'authentication-methods.passkey.account_link_enabled'?: boolean | string;
  'authentication-methods.email_otp.enabled'?: boolean | string;
  'authentication-methods.email_otp.login_enabled'?: boolean | string;
  'authentication-methods.email_otp.signup_enabled'?: boolean | string;
  'authentication-methods.email_otp.reauth_enabled'?: boolean | string;
  'authentication-methods.email_otp.account_link_enabled'?: boolean | string;
  'authentication-methods.did.login_enabled'?: unknown;
}

export function normalizeBooleanSetting(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

/**
 * `strict`: settings that cannot be understood (not JSON, not an object) throw instead of reading
 * as "nothing set". For a decision that lets someone in, where a method on by default (passkey)
 * must not stay on because the switch that would turn it off could not be read.
 */
export async function readAuthenticationMethodSettings(
  env: Env,
  tenantId: string,
  options: { strict?: boolean } = {}
): Promise<AuthenticationMethodKVSettings> {
  const raw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
  // Only a missing document means "nothing set". An empty or blank one is damaged: it goes
  // through the parse below, which rejects it (strict) or reads it as nothing set (otherwise).
  if (raw === null || raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AuthenticationMethodKVSettings;
    }
    if (options.strict) throw new Error('authentication_methods_settings_invalid');
    return {};
  } catch (error) {
    if (options.strict) throw error;
    return {};
  }
}

export function methodUsageEnabled(
  settings: AuthenticationMethodKVSettings,
  method: 'passkey' | 'email_otp',
  usage: AuthenticationMethodUsage
): boolean {
  const legacyEnabled = settings[`authentication-methods.${method}.enabled`];
  const defaultEnabled = method === 'passkey';
  const legacyFallback = normalizeBooleanSetting(legacyEnabled, defaultEnabled);
  const key =
    usage === 'account_link'
      ? `authentication-methods.${method}.account_link_enabled`
      : `authentication-methods.${method}.${usage}_enabled`;
  return normalizeBooleanSetting(
    settings[key as keyof AuthenticationMethodKVSettings],
    legacyFallback
  );
}

export async function isAuthenticationMethodUsageEnabled(
  env: Env,
  tenantId: string,
  method: 'passkey' | 'email_otp',
  usage: AuthenticationMethodUsage,
  options: { strict?: boolean } = {}
): Promise<boolean> {
  const settings = await readAuthenticationMethodSettings(env, tenantId, options);
  return methodUsageEnabled(settings, method, usage);
}

/**
 * Whether the tenant lets accounts sign in with a DID. Off unless the tenant turned it on: only the
 * boolean `true` is on. A missing value, a string ("true" included), a number or anything else
 * reads as off; this key is new, so it carries none of the older switches' string leniency.
 */
export function didLoginEnabled(settings: AuthenticationMethodKVSettings): boolean {
  return settings['authentication-methods.did.login_enabled'] === true;
}

export async function isDidLoginEnabled(
  env: Env,
  tenantId: string,
  options: { strict?: boolean } = {}
): Promise<boolean> {
  return didLoginEnabled(await readAuthenticationMethodSettings(env, tenantId, options));
}

/**
 * Whether the tenant lets a new person sign up with a method of its own: passkey, email code or
 * authenticator app, each by its sign-up switch (passkey and email code as for login, the
 * authenticator app off unless the tenant turned it on). Settings that cannot be read give
 * `false`: a request for the sign-up page is then treated as the sign-in it would otherwise be.
 * Sign-up through an external provider is not counted (it is set per provider, and the sign-in
 * page offers it).
 */
export async function isSelfRegistrationAvailable(env: Env, tenantId: string): Promise<boolean> {
  let settings: AuthenticationMethodKVSettings;
  try {
    settings = await readAuthenticationMethodSettings(env, tenantId, { strict: true });
  } catch {
    return false;
  }
  if (
    methodUsageEnabled(settings, 'passkey', 'signup') ||
    methodUsageEnabled(settings, 'email_otp', 'signup')
  ) {
    return true;
  }
  const totpSettings = settings as Record<string, unknown>;
  return normalizeBooleanSetting(
    totpSettings['authentication-methods.totp.signup_enabled'],
    normalizeBooleanSetting(totpSettings['authentication-methods.totp.enabled'], false)
  );
}
