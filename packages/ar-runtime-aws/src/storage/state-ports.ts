/** Storage-independent contracts used by the AWS SAML runtime. */
import type {
  SAMLRequestData,
  AccountAuthenticationLifecycle,
  AccountAuthenticationSnapshot,
} from '@authrim/ar-lib-core';
import type { StoreCodeRequest } from '@authrim/ar-lib-core/durable-objects/AuthorizationCodeStore';

export interface TransientSession {
  tenantId: string;
  sessionId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  revocationBoundAtMs: number;
  data?: Record<string, unknown>;
}

export interface StoreSessionInput {
  tenantId: string;
  sessionId: string;
  userId: string;
  ttlMs: number;
  data?: Record<string, unknown>;
}

export interface StoreChallengeInput {
  tenantId: string;
  id: string;
  type: string;
  userId: string;
  challenge: string;
  ttlMs: number;
  /** Absolute upper bound in milliseconds, for a parent interaction's deadline. */
  notAfterMs?: number;
  email?: string;
  redirectUri?: string;
  metadata?: Record<string, unknown>;
}

export interface ConsumeChallengeInput {
  tenantId: string;
  id: string;
  type: string;
  /** Omit only when `id` itself is a high-entropy bearer secret. */
  challenge?: string;
}

export interface TransientChallenge {
  id: string;
  tenantId: string;
  type: string;
  userId: string;
  challenge: string;
  createdAt: number;
  expiresAt: number;
  email?: string;
  redirectUri?: string;
  metadata?: Record<string, unknown>;
}

export interface StoreSamlRequestInput {
  tenantId: string;
  spEntityId: string;
  request: SAMLRequestData;
}

export interface ConsumeSamlRequestInput {
  tenantId: string;
  spEntityId: string;
  requestId: string;
}

export interface PutTransientKeyInput {
  tenantId: string;
  key: string;
  value: string;
  ttlMs: number;
}

export interface TransientStateStore {
  createSession(input: StoreSessionInput): Promise<TransientSession>;
  getSession(input: { tenantId: string; sessionId: string }): Promise<TransientSession | null>;
  deleteSession(input: { tenantId: string; sessionId: string }): Promise<boolean>;
  storeChallenge(input: StoreChallengeInput): Promise<boolean>;
  claimChallenge(input: StoreChallengeInput): Promise<boolean>;
  consumeChallenge(input: ConsumeChallengeInput): Promise<TransientChallenge | null>;
  getChallenge(input: { tenantId: string; id: string }): Promise<TransientChallenge | null>;
  isChallengeClaimHeld(input: {
    tenantId: string;
    id: string;
    challenge: string;
    minRemainingMs: number;
  }): Promise<boolean>;
  deleteChallenge(input: { tenantId: string; id: string }): Promise<boolean>;
  storeSamlRequest(input: StoreSamlRequestInput): Promise<void>;
  consumeSamlRequest(input: ConsumeSamlRequestInput): Promise<SAMLRequestData | null>;
  putKey(input: PutTransientKeyInput): Promise<void>;
  getKey(input: { tenantId: string; key: string }): Promise<string | null>;
  deleteKey(input: { tenantId: string; key: string }): Promise<boolean>;
}

export interface AccountAuthStateStore {
  getAccountStateRpc(
    tenantId: string,
    userId: string,
    accountId: string
  ): Promise<AccountAuthenticationSnapshot>;
  initializeAccountStateRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    lifecycle: AccountAuthenticationLifecycle,
    sourceVersionMs: number
  ): Promise<AccountAuthenticationSnapshot>;
  advancePasskeyCounterRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    credentialId: string,
    sourceCounter: number,
    newCounter: number,
    observedAtMs: number
  ): Promise<{ counter: number; advanced: boolean }>;
}

export interface CheckRateLimitInput {
  tenantId?: string;
  key: string;
  windowSeconds: number;
  maxRequests: number;
}

export interface RateLimitStore {
  check(
    input: CheckRateLimitInput
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }>;
}

export interface AuthorizationCodeStore {
  store(request: StoreCodeRequest): Promise<{ success: boolean; expiresAt: number }>;
}

export interface PersistentNameIDStore {
  get(input: { tenantId: string; key: string }): Promise<string | null>;
  put(input: { tenantId: string; key: string; value: string }): Promise<void>;
}

export interface AwsStateStores {
  state: TransientStateStore;
  accountAuthentication: AccountAuthStateStore;
  authorizationCodes: AuthorizationCodeStore;
  rateLimit: RateLimitStore;
  persistentNameIDs: PersistentNameIDStore;
}
