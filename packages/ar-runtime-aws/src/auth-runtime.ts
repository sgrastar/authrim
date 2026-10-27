/** AWS state composition for the existing Authrim Direct Auth passkey handlers. */

import { randomBytes } from 'node:crypto';
import type { AuthRuntimePorts } from '@authrim/ar-lib-core/types/auth-runtime-ports';
import type {
  Challenge,
  ChallengeType,
  StoreChallengeRequest,
} from '@authrim/ar-lib-core/durable-objects/ChallengeStore';
import type { Session } from '@authrim/ar-lib-core/durable-objects/SessionStore';
import type { RegionKey } from '@authrim/ar-lib-core/utils/region-sharding';
import type {
  AccountAuthStateStore,
  AuthorizationCodeStore,
  RateLimitStore,
  TransientStateStore,
  StoreChallengeInput,
  TransientChallenge,
  TransientSession,
} from './storage/state-ports';

const SESSION_REVOCATION_AUTHORITY = 'user-session-do-v1' as const;
const TENANT_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/u;
const REGION_KEYS = new Set<RegionKey>(['apac', 'weur', 'eeur', 'enam', 'wnam', 'oc', 'afr', 'me']);

export interface CreateAuthRuntimePortsInput {
  state: TransientStateStore;
  accountAuthentication: AccountAuthStateStore;
  /** Normal SAML passkey sign-in emits a Direct Auth code before session redemption. */
  authorizationCodes: AuthorizationCodeStore;
  rateLimit: RateLimitStore;
  /** Stored only in the opaque session ID; The state store does not shard by this label. */
  sessionRegion?: RegionKey;
}

function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId)) throw new Error('auth_runtime_tenant_invalid');
}

function assertIdentity(value: string, name: string): void {
  if (!value.trim()) throw new Error(`auth_runtime_${name}_missing`);
}

function assertAccountIdentity(
  expectedTenantId: string,
  expectedUserId: string,
  tenantId: string,
  userId: string,
  accountId: string
): void {
  if (
    tenantId !== expectedTenantId ||
    userId !== expectedUserId ||
    accountId !== `account:${expectedUserId}`
  ) {
    throw new Error('auth_runtime_account_identity_mismatch');
  }
}

function challengeInput(request: StoreChallengeRequest): StoreChallengeInput {
  return {
    id: request.id,
    tenantId: request.tenantId,
    type: request.type,
    userId: request.userId,
    challenge: request.challenge,
    ttlMs: request.ttl * 1000,
    ...(request.notAfterMs !== undefined ? { notAfterMs: request.notAfterMs } : {}),
    ...(request.email !== undefined ? { email: request.email } : {}),
    ...(request.redirectUri !== undefined ? { redirectUri: request.redirectUri } : {}),
    ...(request.metadata !== undefined ? { metadata: request.metadata } : {}),
  };
}

function challengeRecord(row: TransientChallenge): Challenge {
  return {
    id: row.id,
    tenantId: row.tenantId,
    type: row.type as ChallengeType,
    userId: row.userId,
    challenge: row.challenge,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumed: false,
    ...(row.email !== undefined ? { email: row.email } : {}),
    ...(row.redirectUri !== undefined ? { redirectUri: row.redirectUri } : {}),
    ...(row.metadata !== undefined ? { metadata: row.metadata } : {}),
  };
}

function sessionRecord(row: TransientSession): Session {
  return {
    id: row.sessionId,
    tenantId: row.tenantId,
    userId: row.userId,
    accountId: `account:${row.userId}`,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revocationAuthority: SESSION_REVOCATION_AUTHORITY,
    revocationBoundAtMs: row.revocationBoundAtMs,
    sessionClientNamespaceVersion: 2,
    ...(row.data ? { data: row.data } : {}),
  };
}

async function requireActiveSessionAccount(
  accountAuthentication: AccountAuthStateStore,
  row: TransientSession
): Promise<void> {
  const state = await accountAuthentication.getAccountStateRpc(
    row.tenantId,
    row.userId,
    `account:${row.userId}`
  );
  if (
    state.lifecycle !== 'active' ||
    (state.revokedAfterMs !== null && row.revocationBoundAtMs <= state.revokedAfterMs)
  ) {
    throw new Error('account_authentication_not_allowed');
  }
}

/**
 * Returned selectors close over tenant and account identity. No Cloudflare namespace or DO stub
 * is emulated; each RPC maps to an atomic state operation or a scoped account check.
 */
export function createAuthRuntimePorts(input: CreateAuthRuntimePortsInput): AuthRuntimePorts {
  const sessionRegion = input.sessionRegion ?? 'apac';
  if (!REGION_KEYS.has(sessionRegion)) throw new Error('auth_runtime_session_region_invalid');

  return {
    rateLimit: { check: (request) => input.rateLimit.check(request) },
    authorizationCodes: { store: (request) => input.authorizationCodes.store(request) },
    challenges: {
      forIdentity(identity) {
        assertTenantId(identity.tenantId);
        assertIdentity(identity.key, 'challenge_identity');
        const tenantId = identity.tenantId;
        return {
          async storeChallengeRpc(request) {
            if (request.tenantId !== tenantId) {
              throw new Error('auth_runtime_challenge_tenant_mismatch');
            }
            const stored = await input.state.storeChallenge(challengeInput(request));
            if (!stored) throw new Error('Challenge already exists');
            return { success: true };
          },
          async consumeChallengeRpc(request) {
            if (request.tenantId !== tenantId) {
              throw new Error('auth_runtime_challenge_tenant_mismatch');
            }
            const row = await input.state.consumeChallenge(request);
            if (!row) throw new Error('Challenge not found or already consumed');
            return {
              challenge: row.challenge,
              userId: row.userId,
              ...(row.email !== undefined ? { email: row.email } : {}),
              ...(row.redirectUri !== undefined ? { redirectUri: row.redirectUri } : {}),
              ...(row.metadata !== undefined ? { metadata: row.metadata } : {}),
              createdAt: row.createdAt,
            };
          },
          async claimChallengeRpc(request) {
            if (request.tenantId !== tenantId) {
              throw new Error('auth_runtime_challenge_tenant_mismatch');
            }
            return { claimed: await input.state.claimChallenge(challengeInput(request)) };
          },
          async isClaimHeldRpc(request) {
            if (request.tenantId !== tenantId) {
              throw new Error('auth_runtime_challenge_tenant_mismatch');
            }
            return { held: await input.state.isChallengeClaimHeld(request) };
          },
          async deleteChallengeRpc(id) {
            return { deleted: await input.state.deleteChallenge({ tenantId, id }) };
          },
          async getChallengeRpc(id) {
            const row = await input.state.getChallenge({ tenantId, id });
            return row ? challengeRecord(row) : null;
          },
        };
      },
    },
    sessionRevocation: {
      forAccount(identity) {
        assertTenantId(identity.tenantId);
        assertIdentity(identity.userId, 'user_id');
        const { tenantId, userId } = identity;
        return {
          async getAccountStateRpc(requestTenantId, requestUserId, accountId) {
            assertAccountIdentity(tenantId, userId, requestTenantId, requestUserId, accountId);
            return input.accountAuthentication.getAccountStateRpc(tenantId, userId, accountId);
          },
          async initializeAccountStateRpc(
            requestTenantId,
            requestUserId,
            accountId,
            lifecycle,
            sourceVersionMs
          ) {
            assertAccountIdentity(tenantId, userId, requestTenantId, requestUserId, accountId);
            return input.accountAuthentication.initializeAccountStateRpc(
              tenantId,
              userId,
              accountId,
              lifecycle,
              sourceVersionMs
            );
          },
          async advancePasskeyCounterRpc(
            requestTenantId,
            requestUserId,
            accountId,
            credentialId,
            sourceCounter,
            newCounter,
            observedAtMs
          ) {
            assertAccountIdentity(tenantId, userId, requestTenantId, requestUserId, accountId);
            return input.accountAuthentication.advancePasskeyCounterRpc(
              tenantId,
              userId,
              accountId,
              credentialId,
              sourceCounter,
              newCounter,
              observedAtMs
            );
          },
        };
      },
    },
    sessions: {
      newSessionId({ tenantId }) {
        assertTenantId(tenantId);
        const entropy = btoa(String.fromCharCode(...randomBytes(16)))
          .replace(/\+/gu, '-')
          .replace(/\//gu, '_')
          .replace(/=+$/u, '');
        return `g1:${sessionRegion}:0:session_${entropy}`;
      },
      forSession(identity) {
        assertTenantId(identity.tenantId);
        assertIdentity(identity.sessionId, 'session_id');
        const { tenantId, sessionId } = identity;
        return {
          async createSessionRpc(requestedSessionId, userId, ttl, data, requestedTenantId) {
            if (requestedTenantId !== tenantId || requestedSessionId !== sessionId) {
              throw new Error('auth_runtime_session_identity_mismatch');
            }
            assertIdentity(userId, 'user_id');
            const before = await input.accountAuthentication.getAccountStateRpc(
              tenantId,
              userId,
              `account:${userId}`
            );
            if (before.lifecycle !== 'active') {
              throw new Error('account_authentication_not_allowed');
            }
            const row = await input.state.createSession({
              tenantId,
              sessionId,
              userId,
              ttlMs: ttl * 1000,
              ...(data ? { data } : {}),
            });
            try {
              await requireActiveSessionAccount(input.accountAuthentication, row);
            } catch (error) {
              await input.state.deleteSession({ tenantId, sessionId });
              throw error;
            }
            return sessionRecord(row);
          },
          async getSessionRpc(requestedSessionId) {
            if (requestedSessionId !== sessionId) {
              throw new Error('auth_runtime_session_identity_mismatch');
            }
            const row = await input.state.getSession({ tenantId, sessionId });
            if (!row) return null;
            try {
              await requireActiveSessionAccount(input.accountAuthentication, row);
            } catch (error) {
              if (
                error instanceof Error &&
                error.message === 'account_authentication_not_allowed'
              ) {
                return null;
              }
              throw error;
            }
            return sessionRecord(row);
          },
          async invalidateSessionRpc(requestedSessionId) {
            if (requestedSessionId !== sessionId) {
              throw new Error('auth_runtime_session_identity_mismatch');
            }
            return input.state.deleteSession({ tenantId, sessionId });
          },
        };
      },
    },
  } satisfies AuthRuntimePorts;
}
