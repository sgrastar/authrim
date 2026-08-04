import type { Env } from '../types/env';
import type { SessionRevocationStore } from '../durable-objects/SessionRevocationStore';
import type {
  AccountAuthenticationLifecycle,
  AccountAuthenticationSnapshot,
} from '../durable-objects/SessionRevocationStore';

export const SESSION_REVOCATION_AUTHORITY = 'user-session-do-v1' as const;

export function getSessionRevocationStore(
  env: Pick<Env, 'SESSION_REVOCATION_STORE'>,
  tenantId: string,
  userId: string
): DurableObjectStub<SessionRevocationStore> {
  const namespace = env.SESSION_REVOCATION_STORE;
  if (!namespace) throw new Error('session_revocation_store_unavailable');
  return namespace.get(namespace.idFromName(`tenant:${tenantId}:user-session:${userId}`));
}

export interface AccountAuthenticationHydration {
  lifecycle: AccountAuthenticationLifecycle;
  sourceVersionMs: number;
}

export function isAccountAuthenticationDeniedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === 'account_authentication_not_allowed' ||
    error.message === 'passkey_counter_replay' ||
    error.message === 'totp_time_step_replay'
  );
}

function isAccountAuthenticationStateUninitialized(error: unknown): boolean {
  return error instanceof Error && error.message === 'account_auth_state_uninitialized';
}

async function initializeAccountAuthenticationState(
  store: DurableObjectStub<SessionRevocationStore>,
  tenantId: string,
  userId: string,
  loader: () => Promise<AccountAuthenticationHydration | null>
): Promise<void> {
  const hydration = await loader();
  if (!hydration) throw new Error('account_authentication_not_allowed');
  await store.initializeAccountStateRpc(
    tenantId,
    userId,
    `account:${userId}`,
    hydration.lifecycle,
    hydration.sourceVersionMs
  );
}

export async function ensureAccountAuthenticationState(
  env: Pick<Env, 'SESSION_REVOCATION_STORE'>,
  tenantId: string,
  userId: string,
  loader: () => Promise<AccountAuthenticationHydration | null>
): Promise<AccountAuthenticationSnapshot> {
  const accountId = `account:${userId}`;
  const store = getSessionRevocationStore(env, tenantId, userId);
  let state = await store.getAccountStateRpc(tenantId, userId, accountId);
  if (state.lifecycle === null) {
    const hydration = await loader();
    if (!hydration) throw new Error('account_authentication_not_allowed');
    state = await store.initializeAccountStateRpc(
      tenantId,
      userId,
      accountId,
      hydration.lifecycle,
      hydration.sourceVersionMs
    );
  }
  if (state.lifecycle !== 'active') throw new Error('account_authentication_not_allowed');
  return state;
}

/**
 * Accept a verified WebAuthn assertion in one DO round trip for initialized accounts. D1 is read
 * only during lazy migration of an account whose DO state has not been initialized yet.
 */
export async function advancePasskeyAuthenticationState(
  env: Pick<Env, 'SESSION_REVOCATION_STORE'>,
  input: {
    tenantId: string;
    userId: string;
    credentialId: string;
    storedCounter: number;
    observedCounter: number;
    observedAtMs: number;
  },
  loader: () => Promise<AccountAuthenticationHydration | null>
): Promise<{ counter: number; advanced: boolean }> {
  const store = getSessionRevocationStore(env, input.tenantId, input.userId);
  const advance = () =>
    store.advancePasskeyCounterRpc(
      input.tenantId,
      input.userId,
      `account:${input.userId}`,
      input.credentialId,
      input.storedCounter,
      input.observedCounter,
      input.observedAtMs
    );
  try {
    return await advance();
  } catch (error) {
    if (!isAccountAuthenticationStateUninitialized(error)) throw error;
    await initializeAccountAuthenticationState(store, input.tenantId, input.userId, loader);
    return advance();
  }
}

/**
 * Consume a verified TOTP time step in one DO round trip for initialized accounts. D1 is read only
 * for lazy state initialization.
 */
export async function consumeTotpAuthenticationState(
  env: Pick<Env, 'SESSION_REVOCATION_STORE'>,
  input: {
    tenantId: string;
    userId: string;
    credentialId: string;
    storedLastUsedTimeStep: number | null;
    observedTimeStep: number;
    observedAtMs: number;
  },
  loader: () => Promise<AccountAuthenticationHydration | null>
): Promise<{ lastAcceptedTimeStep: number }> {
  const store = getSessionRevocationStore(env, input.tenantId, input.userId);
  const consume = () =>
    store.consumeTotpTimeStepRpc(
      input.tenantId,
      input.userId,
      `account:${input.userId}`,
      input.credentialId,
      input.storedLastUsedTimeStep,
      input.observedTimeStep,
      input.observedAtMs
    );
  try {
    return await consume();
  } catch (error) {
    if (!isAccountAuthenticationStateUninitialized(error)) throw error;
    await initializeAccountAuthenticationState(store, input.tenantId, input.userId, loader);
    return consume();
  }
}

export async function transitionAccountAuthenticationState(
  env: Pick<Env, 'SESSION_REVOCATION_STORE'>,
  input: {
    tenantId: string;
    userId: string;
    lifecycle: AccountAuthenticationLifecycle;
    sourceVersionMs: number;
    operationId: string;
    revokeSessions: boolean;
  }
): Promise<AccountAuthenticationSnapshot> {
  return getSessionRevocationStore(env, input.tenantId, input.userId).setAccountLifecycleRpc(
    input.tenantId,
    input.userId,
    `account:${input.userId}`,
    input.lifecycle,
    input.sourceVersionMs,
    input.operationId,
    input.revokeSessions
  );
}

/** Advance the sole per-user session revocation authority. */
export async function recordUserSessionRevocation(
  env: Pick<Env, 'SESSION_REVOCATION_STORE'>,
  tenantId: string,
  userId: string,
  revokedAfterMs = Date.now()
): Promise<number> {
  const accountId = `account:${userId}`;
  await getSessionRevocationStore(env, tenantId, userId).revokeAllRpc(
    tenantId,
    userId,
    accountId,
    revokedAfterMs
  );
  return revokedAfterMs;
}
