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
