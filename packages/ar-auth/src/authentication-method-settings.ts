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

export async function readAuthenticationMethodSettings(
  env: Env,
  tenantId: string
): Promise<AuthenticationMethodKVSettings> {
  const raw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:authentication-methods`);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as AuthenticationMethodKVSettings) : {};
  } catch {
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
  usage: AuthenticationMethodUsage
): Promise<boolean> {
  const settings = await readAuthenticationMethodSettings(env, tenantId);
  return methodUsageEnabled(settings, method, usage);
}
