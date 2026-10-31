import type { ChallengeStore } from '../durable-objects/ChallengeStore';
import type { StoreCodeRequest } from '../durable-objects/AuthorizationCodeStore';
import type { SessionRevocationStore } from '../durable-objects/SessionRevocationStore';
import type { SessionStore } from '../durable-objects/SessionStore';

/** The ChallengeStore operations used by an AWS sign-in profile. */
export type AuthChallengeStoreRpc = Pick<
  ChallengeStore,
  | 'storeChallengeRpc'
  | 'consumeChallengeRpc'
  | 'claimChallengeRpc'
  | 'isClaimHeldRpc'
  | 'deleteChallengeRpc'
  | 'getChallengeRpc'
>;

/** The per-account authentication state needed to verify a passkey assertion. */
export type AuthSessionRevocationRpc = Pick<
  SessionRevocationStore,
  'getAccountStateRpc' | 'initializeAccountStateRpc' | 'advancePasskeyCounterRpc'
>;

/** The session operations needed to complete and use a managed browser sign-in. */
export type AuthSessionStoreRpc = Pick<
  SessionStore,
  'createSessionRpc' | 'getSessionRpc' | 'invalidateSessionRpc'
>;

export interface AuthRuntimePorts {
  /** Atomic, tenant-scoped request counter used by existing rate-limit middleware. */
  rateLimit?: {
    check(input: {
      tenantId?: string;
      key: string;
      windowSeconds: number;
      maxRequests: number;
    }): Promise<{ allowed: boolean; remaining: number; resetAt: number }>;
  };
  /** Required only if this runtime enables an OIDC Direct Auth code flow. */
  authorizationCodes?: {
    store(request: StoreCodeRequest): Promise<{ success: boolean; expiresAt: number }>;
  };
  challenges: {
    /**
     * The returned RPC object is scoped to this identity. In particular, reads and deletes,
     * whose Cloudflare RPC signatures omit tenantId, must enforce this tenant boundary.
     */
    forIdentity(input: {
      tenantId: string;
      kind: 'challenge' | 'user' | 'email' | 'lease' | 'did';
      key: string;
    }): AuthChallengeStoreRpc;
  };
  sessionRevocation: {
    /** Both tenantId and userId identify the state holding passkey replay counters. */
    forAccount(input: { tenantId: string; userId: string }): AuthSessionRevocationRpc;
  };
  sessions: {
    /** Must return an unguessable ID accepted by parseRegionShardedSessionId. */
    newSessionId(input: { tenantId: string }): string | Promise<string>;
    /** The returned RPC object must enforce tenantId for every operation. */
    forSession(input: { tenantId: string; sessionId: string }): AuthSessionStoreRpc;
  };
}
