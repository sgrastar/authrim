/**
 * The ways an account can still sign in, so self-service removal of one (a passkey, a TOTP
 * authenticator, a linked external account) never leaves the user locked out.
 *
 * A method counts only where the tenant lets it sign in: a passkey while passkey login is on, a
 * verified email while email-code login is on, a TOTP authenticator while TOTP login is on, and a
 * linked external account while its provider is enabled.
 */

import type { Env } from '../types/env';
import type { DatabaseAdapter } from '../db/adapter';
import { CanonicalRuntimeUserStore } from '../repositories/identity/canonical-runtime-user-store';
import { resolveAuthCorePersistenceAdapterFromEnv } from './auth-core-persistence-context';

const AUTHENTICATION_METHODS_CATEGORY = 'authentication-methods';

export type BuiltInAuthenticationMethod = 'passkey' | 'email_otp' | 'totp';
export type AuthenticationMethodUsage = 'login' | 'signup' | 'reauth' | 'account_link';

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

/** A method's switch where a tenant sets none: passkeys on, the others off. */
function defaultAuthenticationMethodEnabled(method: BuiltInAuthenticationMethod): boolean {
  return method === 'passkey';
}

function authenticationMethodSettingKey(
  method: BuiltInAuthenticationMethod,
  usage: AuthenticationMethodUsage
): string {
  return usage === 'account_link'
    ? `authentication-methods.${method}.account_link_enabled`
    : `authentication-methods.${method}.${usage}_enabled`;
}

/**
 * Whether the tenant lets `method` be used for `usage`: the usage's own switch, else the method's
 * switch, else the method's default. Unreadable settings give the default.
 */
export async function isAuthenticationMethodUsageAvailable(
  env: Pick<Env, 'SETTINGS'>,
  tenantId: string,
  method: BuiltInAuthenticationMethod,
  usage: AuthenticationMethodUsage
): Promise<boolean> {
  const methodDefault = defaultAuthenticationMethodEnabled(method);
  try {
    const raw = await env.SETTINGS?.get(
      `settings:tenant:${tenantId}:${AUTHENTICATION_METHODS_CATEGORY}`
    );
    if (!raw) return methodDefault;
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const legacyEnabled = normalizeBoolean(
      settings[`authentication-methods.${method}.enabled`],
      methodDefault
    );
    return normalizeBoolean(settings[authenticationMethodSettingKey(method, usage)], legacyEnabled);
  } catch {
    return methodDefault;
  }
}

/** The sign-in method being removed, which does not count as remaining. */
export type LoginMethodRemoval =
  | { kind: 'passkey'; id: string }
  | { kind: 'totp'; id: string }
  | { kind: 'linked_identity'; id: string };

export interface RemainingLoginMethodInput {
  tenantId: string;
  userId: string;
  /** The account's Core database (passkeys, TOTP authenticators, user status). */
  coreAdapter: DatabaseAdapter;
  /** The account's PII database (email, linked identities). */
  piiAdapter: DatabaseAdapter;
  removing: LoginMethodRemoval;
}

function excluded(removing: LoginMethodRemoval, kind: LoginMethodRemoval['kind']): string | null {
  return removing.kind === kind ? removing.id : null;
}

/**
 * Whether the account keeps a way to sign in once `removing` is gone. Store failures throw: a
 * removal that cannot be checked must not go ahead.
 */
export async function hasRemainingLoginMethod(
  env: Env,
  input: RemainingLoginMethodInput
): Promise<boolean> {
  const { tenantId, userId, coreAdapter, piiAdapter, removing } = input;

  if (await isAuthenticationMethodUsageAvailable(env, tenantId, 'passkey', 'login')) {
    const skip = excluded(removing, 'passkey');
    const row = await coreAdapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM passkeys
        WHERE tenant_id = ? AND user_id = ? AND id <> ?`,
      [tenantId, userId, skip ?? '']
    );
    if ((row?.count ?? 0) > 0) return true;
  }

  if (await isAuthenticationMethodUsageAvailable(env, tenantId, 'totp', 'login')) {
    const skip = excluded(removing, 'totp');
    const row = await coreAdapter.queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM totp_credentials
        WHERE tenant_id = ? AND user_id = ? AND status = 'active' AND id <> ?`,
      [tenantId, userId, skip ?? '']
    );
    if ((row?.count ?? 0) > 0) return true;
  }

  if (await isAuthenticationMethodUsageAvailable(env, tenantId, 'email_otp', 'login')) {
    const users = new CanonicalRuntimeUserStore({ coreAdapter, piiAdapter, tenantId });
    const user = await users.findById(userId);
    if (user?.email && user.email_verified === 1) return true;
  }

  {
    const skip = excluded(removing, 'linked_identity');
    const linked = await piiAdapter.query<{ provider_id: string }>(
      `SELECT DISTINCT provider_id FROM linked_identities
        WHERE tenant_id = ? AND user_id = ? AND provisioning_state = 'active' AND id <> ?`,
      [tenantId, userId, skip ?? '']
    );
    if (linked.length > 0) {
      const providers = await resolveAuthCorePersistenceAdapterFromEnv(
        env,
        'account-login-methods:providers',
        { tenantId }
      );
      const placeholders = linked.map(() => '?').join(', ');
      const enabled = await providers.queryOne<{ count: number }>(
        `SELECT COUNT(*) AS count FROM upstream_providers
          WHERE tenant_id = ? AND enabled = 1 AND id IN (${placeholders})`,
        [tenantId, ...linked.map((row) => row.provider_id)]
      );
      if ((enabled?.count ?? 0) > 0) return true;
    }
  }

  return false;
}
