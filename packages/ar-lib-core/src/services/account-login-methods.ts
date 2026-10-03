/**
 * The ways an account can still sign in, so self-service removal of one (a passkey, a TOTP
 * authenticator, a linked external account) never leaves the user locked out.
 *
 * A method counts only where the tenant lets it sign in and sign-in can find the account with it:
 * a passkey while passkey login is on; a verified email while email-code login is on and a TOTP
 * authenticator while TOTP login is on, both only when the account's email route reaches it; and a
 * linked external account while its provider is enabled and its route reaches the account.
 */

import type { Env } from '../types/env';
import type { DatabaseAdapter } from '../db/adapter';
import type {
  ConsumeChallengeRequest,
  StoreChallengeRequest,
} from '../durable-objects/ChallengeStore';
import { CanonicalRuntimeUserStore } from '../repositories/identity/canonical-runtime-user-store';
import { getChallengeStoreByChallengeId } from '../utils/challenge-sharding';
import { resolveAuthCorePersistenceAdapterFromEnv } from './auth-core-persistence-context';
import { resolveAccountDataContextByIdentifier } from './runtime-data-context';

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

  // TOTP and email-code sign-in find the account by its email address (the directory's email
  // route), so they count only when that route reaches this account.
  const [totpLogin, emailLogin] = await Promise.all([
    isAuthenticationMethodUsageAvailable(env, tenantId, 'totp', 'login'),
    isAuthenticationMethodUsageAvailable(env, tenantId, 'email_otp', 'login'),
  ]);
  if (totpLogin || emailLogin) {
    const users = new CanonicalRuntimeUserStore({ coreAdapter, piiAdapter, tenantId });
    const user = await users.findById(userId);
    const email = user?.email ?? null;
    const reachable =
      email !== null && (await routeReachesAccount(env, tenantId, userId, 'email_exact', email));
    if (reachable && emailLogin && user?.email_verified === 1) return true;
    if (reachable && totpLogin) {
      const skip = excluded(removing, 'totp');
      const row = await coreAdapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) AS count FROM totp_credentials
          WHERE tenant_id = ? AND user_id = ? AND status = 'active' AND id <> ?`,
        [tenantId, userId, skip ?? '']
      );
      if ((row?.count ?? 0) > 0) return true;
    }
  }

  {
    const skip = excluded(removing, 'linked_identity');
    const linked = await piiAdapter.query<{ provider_id: string; provider_user_id: string }>(
      `SELECT provider_id, provider_user_id FROM linked_identities
        WHERE tenant_id = ? AND user_id = ? AND provisioning_state = 'active' AND id <> ?`,
      [tenantId, userId, skip ?? '']
    );
    if (linked.length > 0) {
      const providers = await resolveAuthCorePersistenceAdapterFromEnv(
        env,
        'account-login-methods:providers',
        { tenantId }
      );
      const providerIds = [...new Set(linked.map((row) => row.provider_id))];
      const enabled = await providers.query<{ id: string }>(
        `SELECT id FROM upstream_providers
          WHERE tenant_id = ? AND enabled = 1 AND id IN (${providerIds.map(() => '?').join(', ')})`,
        [tenantId, ...providerIds]
      );
      const enabledIds = new Set(enabled.map((row) => row.id));
      for (const row of linked) {
        if (!enabledIds.has(row.provider_id)) continue;
        // Sign-in finds an external account through its directory route; a link whose route is not
        // (yet) published to this account cannot sign anyone in.
        const subject = { issuer: row.provider_id, subject: row.provider_user_id };
        if (await routeReachesAccount(env, tenantId, userId, 'external_subject', subject)) {
          return true;
        }
      }
    }
  }

  return false;
}

/** Whether sign-in by this identifier (its directory route) reaches this account. */
async function routeReachesAccount(
  env: Env,
  tenantId: string,
  userId: string,
  indexKind: 'email_exact' | 'external_subject',
  identifier: string | { issuer: string; subject: string }
): Promise<boolean> {
  try {
    const route = await resolveAccountDataContextByIdentifier(env, {
      tenantId,
      indexKind,
      identifier,
    });
    return route.legacyUserId === userId;
  } catch (error) {
    if (error instanceof Error && error.message === 'account_data_route_not_found') return false;
    throw error;
  }
}

/** Another removal of this account's sign-in methods is running; retry shortly. */
export class LoginMethodRemovalInProgressError extends Error {
  constructor() {
    super('login_method_removal_in_progress');
    this.name = 'LoginMethodRemovalInProgressError';
  }
}

/** The challenge store calls the lease makes (the sharded stub is untyped). */
interface LeaseStore {
  claimChallengeRpc(request: StoreChallengeRequest): Promise<{ claimed: boolean }>;
  consumeChallengeRpc(request: ConsumeChallengeRequest): Promise<unknown>;
}

/** Longest a removal may hold the account's lease (it is released as soon as it finishes). */
const LOGIN_METHOD_REMOVAL_LEASE_SECONDS = 60;

/**
 * Runs `removal` (the remaining-method check and the removal itself) while no other removal of the
 * account's sign-in methods runs, so two removals cannot each count the other's method as the one
 * that remains. The sign-in methods live in different databases, so no single transaction covers
 * them; a lease in the challenge store does. Throws LoginMethodRemovalInProgressError when another
 * removal holds it.
 */
export async function withLoginMethodRemovalLock<T>(
  env: Env,
  tenantId: string,
  userId: string,
  removal: () => Promise<T>
): Promise<T> {
  const id = `login-method-removal:${userId}`;
  const owner = crypto.randomUUID();
  const store = (await getChallengeStoreByChallengeId(env, id, tenantId)) as LeaseStore;
  const { claimed } = await store.claimChallengeRpc({
    id,
    tenantId,
    type: 'login_method_removal_lock',
    userId,
    challenge: owner,
    ttl: LOGIN_METHOD_REMOVAL_LEASE_SECONDS,
  });
  if (!claimed) throw new LoginMethodRemovalInProgressError();
  try {
    return await removal();
  } finally {
    // Release only our own lease (a lapsed one may already belong to the next removal).
    await store
      .consumeChallengeRpc({
        id,
        tenantId,
        type: 'login_method_removal_lock',
        challenge: owner,
      })
      .catch(() => undefined);
  }
}
