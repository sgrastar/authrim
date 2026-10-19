/**
 * What a tenant allows for each authentication method and use (login, signup, re-authentication,
 * account linking): the tenant's `authentication-methods` settings in KV. Shared by every
 * endpoint that sends or verifies a code, so one switch governs them all.
 */
import {
  EXTERNAL_PROVIDER_LIST_LIMIT,
  bridgeExternalProvidersListed,
  externalJitSignupPolicy,
  externalSignupProviderIds,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveEffectiveSettings,
  type Env,
} from '@authrim/ar-lib-core';

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

interface UpstreamSignupRow {
  id: string;
  slug: string | null;
  enabled: number;
  jit_provisioning: number;
}

/**
 * Whether the tenant lets a new person sign up through some external provider. Reads the
 * tenant's JIT settings (the settings cache) and up to `EXTERNAL_PROVIDER_LIST_LIMIT` provider
 * rows, in the order the bridge lists them for the sign-up page; `authenticationMethods` is the
 * tenant's `authentication-methods` document the caller already read. Throws when anything
 * cannot be read: the caller decides what that means.
 */
async function isExternalSignupAvailable(
  env: Env,
  tenantId: string,
  authenticationMethods: Record<string, unknown>
): Promise<boolean> {
  const jit = externalJitSignupPolicy(
    await resolveEffectiveSettings(env, 'external-idp', { tenantId })
  );
  // Nothing to read from the database when no provider could count.
  if (!jit.enabled || !bridgeExternalProvidersListed(authenticationMethods)) return false;

  const adapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'external-signup-availability',
    { tenantId }
  );
  const rows = await adapter.query<UpstreamSignupRow>(
    'SELECT id, slug, enabled, jit_provisioning FROM upstream_providers WHERE tenant_id = ? AND enabled = 1 ORDER BY priority ASC, name ASC LIMIT ?',
    [tenantId, EXTERNAL_PROVIDER_LIST_LIMIT]
  );
  return (
    externalSignupProviderIds({
      authenticationMethods,
      providers: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        enabled: row.enabled === 1,
        jitProvisioning: row.jit_provisioning === 1,
      })),
      jit,
    }).length > 0
  );
}

/**
 * Whether the tenant lets a new person sign up: with a method of its own (passkey, email code or
 * authenticator app, each by its sign-up switch: passkey and email code as for login, the
 * authenticator app off unless the tenant turned it on), or through an external provider that
 * the sign-up page offers and that can create the account (see `externalSignupProviderIds`:
 * the provider's sign-up switch, its own JIT switch and the tenant's JIT settings; a provider that
 * can only link an existing account does not count). Settings that cannot be read, in either
 * place, give `false`: a request for the sign-up page is then treated as the sign-in it would
 * otherwise be.
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
  if (
    normalizeBooleanSetting(
      totpSettings['authentication-methods.totp.signup_enabled'],
      normalizeBooleanSetting(totpSettings['authentication-methods.totp.enabled'], false)
    )
  ) {
    return true;
  }
  // Last, because it reads the provider list: only a tenant with no sign-up method of its own
  // gets here.
  try {
    return await isExternalSignupAvailable(env, tenantId, totpSettings);
  } catch {
    return false;
  }
}
