/**
 * The ways an account can still sign in, so self-service removal of one (a passkey, a TOTP
 * authenticator, a linked external account) never leaves the user locked out.
 *
 * A method counts only where the tenant lets it sign in and sign-in can find the account with it:
 * a passkey while passkey login is on and its credential route reaches the account; a verified
 * email while email-code login is on and a TOTP authenticator while TOTP login is on, both only
 * when the account's email route reaches it; and a linked external account while its provider is
 * enabled and its route reaches the account.
 */

import type { Env } from '../types/env';
import type { DatabaseAdapter } from '../db/adapter';
import type {
  ConsumeChallengeRequest,
  StoreChallengeRequest,
} from '../durable-objects/ChallengeStore';
import { CanonicalRuntimeUserStore } from '../repositories/identity/canonical-runtime-user-store';
import { getChallengeStoreForLease } from '../utils/challenge-sharding';
import { resolveAuthCorePersistenceAdapterFromEnv } from './auth-core-persistence-context';
import { passkeyCredentialLookupSubject } from './account-provisioning';
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

/** A way the account could sign in, and whether it actually can (checked lazily, once). */
interface Candidate {
  kind: LoginMethodRemoval['kind'] | 'email';
  id: string;
  usable: () => Promise<boolean>;
}

/** At most this many routes are checked per method kind; one usable method is enough. */
const MAX_ROUTE_CHECKS = 10;

async function candidates(env: Env, input: RemainingLoginMethodInput): Promise<Candidate[]> {
  const { tenantId, userId, coreAdapter, piiAdapter } = input;
  const reaches = (
    indexKind: 'email_exact' | 'external_subject',
    identifier: string | { issuer: string; subject: string }
  ) => routeReachesAccount(env, tenantId, userId, indexKind, identifier);
  const [passkeyLogin, totpLogin, emailLogin] = await Promise.all([
    isAuthenticationMethodUsageAvailable(env, tenantId, 'passkey', 'login'),
    isAuthenticationMethodUsageAvailable(env, tenantId, 'totp', 'login'),
    isAuthenticationMethodUsageAvailable(env, tenantId, 'email_otp', 'login'),
  ]);
  const list: Candidate[] = [];

  // A passkey signs in through its credential's directory route.
  const passkeys = await coreAdapter.query<{
    id: string;
    rp_id: string | null;
    credential_id: string;
  }>(`SELECT id, rp_id, credential_id FROM passkeys WHERE tenant_id = ? AND user_id = ?`, [
    tenantId,
    userId,
  ]);
  for (const passkey of passkeys) {
    list.push({
      kind: 'passkey',
      id: passkey.id,
      usable: async () => {
        if (!passkeyLogin || !passkey.rp_id) return false;
        let subject: { issuer: string; subject: string };
        try {
          subject = passkeyCredentialLookupSubject({
            rpId: passkey.rp_id,
            credentialId: passkey.credential_id,
          });
        } catch {
          return false;
        }
        return reaches('external_subject', subject);
      },
    });
  }

  // TOTP and email-code sign-in find the account by its email address (the email route).
  let emailReach: Promise<{ reachable: boolean; verified: boolean }> | null = null;
  const email = () =>
    (emailReach ??= (async () => {
      const users = new CanonicalRuntimeUserStore({ coreAdapter, piiAdapter, tenantId });
      const user = await users.findById(userId);
      const address = user?.email ?? null;
      return {
        reachable: address !== null && (await reaches('email_exact', address)),
        verified: user?.email_verified === 1,
      };
    })());
  list.push({
    kind: 'email',
    id: 'email',
    usable: async () => {
      if (!emailLogin) return false;
      const { reachable, verified } = await email();
      return reachable && verified;
    },
  });
  const totp = await coreAdapter.query<{ id: string }>(
    `SELECT id FROM totp_credentials WHERE tenant_id = ? AND user_id = ? AND status = 'active'`,
    [tenantId, userId]
  );
  for (const credential of totp) {
    list.push({
      kind: 'totp',
      id: credential.id,
      usable: async () => totpLogin && (await email()).reachable,
    });
  }

  // A linked account signs in while its provider is enabled, through its directory route.
  const linked = await piiAdapter.query<{
    id: string;
    provider_id: string;
    provider_user_id: string;
  }>(
    `SELECT id, provider_id, provider_user_id FROM linked_identities
      WHERE tenant_id = ? AND user_id = ? AND provisioning_state = 'active'`,
    [tenantId, userId]
  );
  let enabledProviders: Promise<Set<string>> | null = null;
  const providersEnabled = () =>
    (enabledProviders ??= (async () => {
      const providerIds = [...new Set(linked.map((row) => row.provider_id))];
      if (providerIds.length === 0) return new Set<string>();
      const providers = await resolveAuthCorePersistenceAdapterFromEnv(
        env,
        'account-login-methods:providers',
        { tenantId }
      );
      const rows = await providers.query<{ id: string }>(
        `SELECT id FROM upstream_providers
          WHERE tenant_id = ? AND enabled = 1 AND id IN (${providerIds.map(() => '?').join(', ')})`,
        [tenantId, ...providerIds]
      );
      return new Set(rows.map((row) => row.id));
    })());
  for (const row of linked) {
    list.push({
      kind: 'linked_identity',
      id: row.id,
      usable: async () =>
        (await providersEnabled()).has(row.provider_id) &&
        (await reaches('external_subject', {
          issuer: row.provider_id,
          subject: row.provider_user_id,
        })),
    });
  }
  return list;
}

/**
 * Whether the account keeps a way to sign in once `removing` is gone: another method the tenant
 * lets sign in and that sign-in can find this account with. Store and directory failures throw: a
 * removal that cannot be checked must not go ahead.
 */
export async function hasRemainingLoginMethod(
  env: Env,
  input: RemainingLoginMethodInput
): Promise<boolean> {
  const checked: Record<string, number> = {};
  for (const candidate of await candidates(env, input)) {
    if (candidate.kind === input.removing.kind && candidate.id === input.removing.id) continue;
    checked[candidate.kind] = (checked[candidate.kind] ?? 0) + 1;
    if (checked[candidate.kind] > MAX_ROUTE_CHECKS) continue;
    if (await candidate.usable()) return true;
  }
  return false;
}

/**
 * Whether removing `removing` leaves the account able to sign in as well as before: either the
 * method could not sign in anyway (its login is off, or sign-in cannot find the account with it),
 * or another usable method remains.
 */
export async function isLoginMethodRemovalSafe(
  env: Env,
  input: RemainingLoginMethodInput
): Promise<boolean> {
  const all = await candidates(env, input);
  const target = all.find(
    (candidate) => candidate.kind === input.removing.kind && candidate.id === input.removing.id
  );
  if (!target || !(await target.usable())) return true;
  return hasRemainingLoginMethod(env, input);
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

/** The challenge store calls the lease makes (the stub is untyped). */
interface LeaseStore {
  claimChallengeRpc(request: StoreChallengeRequest): Promise<{ claimed: boolean }>;
  isClaimHeldRpc(request: {
    id: string;
    tenantId: string;
    challenge: string;
    minRemainingMs: number;
  }): Promise<{ held: boolean }>;
  consumeChallengeRpc(request: ConsumeChallengeRequest): Promise<unknown>;
}

/** Longest a removal may hold the account's lease (it is released as soon as it finishes). */
const LOGIN_METHOD_REMOVAL_LEASE_SECONDS = 120;
/**
 * The lease must outlast the write it guards by at least this much: twice the longest single
 * database operation (D1's 30 s), so only a request stalled far beyond that can write unguarded.
 */
const LOGIN_METHOD_REMOVAL_WRITE_MARGIN_MS = 60_000;

/** What a removal holds while it runs. */
export interface LoginMethodRemovalLease {
  /**
   * Throws LoginMethodRemovalInProgressError unless the lease is still this removal's with time to
   * spare. Call it right before the write that removes the method: a removal that outlived its
   * lease (a stalled request) must not remove anything after another removal has checked.
   */
  assertHeld(): Promise<void>;
}

/**
 * Runs `removal` (the remaining-method check and the removal itself) while no other removal of the
 * account's sign-in methods runs, so two removals cannot each count the other's method as the one
 * that remains. The sign-in methods live in different databases, so no single transaction covers
 * them; a lease in the challenge store does. Throws LoginMethodRemovalInProgressError when another
 * removal holds it.
 *
 * Keep slow work (reading the request, calls to other services) outside `removal` where it can be,
 * and call `lease.assertHeld()` right before the removing write.
 */
export async function withLoginMethodRemovalLock<T>(
  env: Env,
  tenantId: string,
  userId: string,
  removal: (lease: LoginMethodRemovalLease) => Promise<T>
): Promise<T> {
  const id = `login-method-removal:${userId}`;
  const owner = crypto.randomUUID();
  const store = getChallengeStoreForLease(env, id, tenantId) as LeaseStore;
  const { claimed } = await store.claimChallengeRpc({
    id,
    tenantId,
    type: 'login_method_removal_lock',
    userId,
    challenge: owner,
    ttl: LOGIN_METHOD_REMOVAL_LEASE_SECONDS,
  });
  if (!claimed) throw new LoginMethodRemovalInProgressError();
  const lease: LoginMethodRemovalLease = {
    async assertHeld() {
      const { held } = await store.isClaimHeldRpc({
        id,
        tenantId,
        challenge: owner,
        minRemainingMs: LOGIN_METHOD_REMOVAL_WRITE_MARGIN_MS,
      });
      if (!held) throw new LoginMethodRemovalInProgressError();
    },
  };
  try {
    return await removal(lease);
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
