import { runSamlDrCoveredOperation } from '../services/tenant-portability/saml-dr-writer';
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';
import {
  assertSamlDrAccountSnapshotReleased,
  readSamlDrAccountSnapshotPage,
  releaseSamlDrAccountSnapshot,
  startSamlDrAccountSnapshot,
  type SamlDrAccountSnapshotIdentity,
  type SamlDrAccountSnapshotPage,
} from './saml-dr-account-snapshot';
import {
  getSamlDrNameId,
  initializeSamlDrNameIdRegistry,
  putSamlDrNameId,
} from './saml-dr-nameid-registry';
import type {
  SamlDrNameIdAccountIdentity,
  SamlDrNameIdRegistryInitialization,
} from '../services/saml-dr-nameid-registry';
import {
  acknowledgeSupportOpsReceipt,
  capturePendingSupportOpsSession,
  createSupportOpsReceipt,
  completeSupportOpsReceipt,
  replaySupportOpsReceipt,
  stepSupportOpsReceipt,
  type ReceiptRequest,
  type SupportOpsSessionReceiptLease,
  type SupportOpsSessionReceiptPage,
} from './support-ops-session-receipt';

const IDENTITY_KEY = 'identity';
const STATE_KEY = 'state';
const SESSION_INDEX_PREFIX = 'session-index:';
const EXTERNAL_PROVIDER_IDENTITY_KEY = 'external-provider-identity';
const EXTERNAL_PROVIDER_SESSION_PREFIX = 'external-provider-session:';
const SAFE_TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_USER_ID = /^[a-zA-Z0-9_-][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_CREDENTIAL_ID = /^[a-zA-Z0-9_.:-]{1,256}$/u;
const SAFE_SESSION_ID = /^[a-zA-Z0-9_.:-]{1,512}$/u;
const SAFE_DIGEST = /^[a-f0-9]{64}$/u;
const MAX_SESSION_INDEX_ENTRIES = 1_000;
const SESSION_INDEX_SCAN_LIMIT = MAX_SESSION_INDEX_ENTRIES + 1;
/** Index entries read per page when finding the sessions a revocation ended. */
const REVOCATION_SCAN_PAGE_SIZE = 500;
export type AccountAuthenticationLifecycle =
  | 'active'
  | 'suspended'
  | 'locked'
  | 'deleting'
  | 'deleted'
  | 'inactive';

interface SessionRevocationIdentity {
  tenantId: string;
  userId: string;
  accountId: string;
}

interface SessionRevocationState {
  revokedAfterMs: number | null;
  lastLoginAtMs: number | null;
  lifecycle?: AccountAuthenticationLifecycle | null;
  lifecycleVersionMs?: number | null;
  lifecycleOperationId?: string | null;
}

interface PasskeyCounterState {
  counter: number;
  updatedAtMs: number;
}

interface TotpTimeStepState {
  lastAcceptedTimeStep: number;
  updatedAtMs: number;
}

interface SessionRevocationTransactionStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string; limit: number; startAfter?: string }): Promise<Map<string, T>>;
}

export interface UserSessionIndexEntry {
  sessionId: string;
  tenantId: string;
  userId: string;
  accountId: string;
  createdAtMs: number;
  expiresAtMs: number;
  revocationBoundAtMs: number;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface ExternalProviderSessionIndexEntry {
  sessionId: string;
  userId: string;
  expiresAtMs: number;
}

interface ExternalProviderIndexIdentity {
  tenantId: string;
  providerId: string;
  claimKind: 'sid' | 'sub';
  claimDigest: string;
}

export interface SessionRegistrationResult {
  revokedAfterMs: number | null;
  revocationBoundAtMs: number;
}

export interface AccountAuthenticationSnapshot {
  revokedAfterMs: number | null;
  lastLoginAtMs: number | null;
  lifecycle: AccountAuthenticationLifecycle | null;
  lifecycleVersionMs: number | null;
  lifecycleOperationId: string | null;
}

/**
 * Strongly consistent user-wide session state.
 *
 * One object is addressed by tenant + user. This keeps revocation reads off a tenant's
 * single Core D1 while naturally distributing unrelated users across Durable Objects.
 */
/** Complete public source admission surface; checked against the class prototype in tests. */
export const SAML_DR_SESSION_REVOCATION_SURFACE = {
  guarded: [
    'initializeSamlDrNameIdRegistryRpc',
    'getSamlDrNameIdRpc',
    'putSamlDrNameIdRpc',
    'registerSessionRpc',
    'unregisterSessionRpc',
    'updateSessionExpirationRpc',
    'listActiveSessionsRpc',
    'registerExternalProviderSessionRpc',
    'listExternalProviderSessionsRpc',
    'unregisterExternalProviderSessionRpc',
    'getRevokedAfterRpc',
    'getAccountStateRpc',
    'getSessionValidationStateRpc',
    'initializeAccountStateRpc',
    'setAccountLifecycleRpc',
    'setAccountLifecycleEndingSessionsRpc',
    'beginSupportOpsSuspensionRpc',
    'readSupportOpsSuspensionReceiptRpc',
    'acknowledgeSupportOpsSuspensionReceiptRpc',
    'completeSupportOpsSuspensionReceiptRpc',
    'assertAccountActiveRpc',
    'advancePasskeyCounterRpc',
    'consumeTotpTimeStepRpc',
    'deleteCredentialStateRpc',
    'revokeAllRpc',
    'revokeAllEndingSessionsRpc',
    'getLastLoginAtRpc',
  ],
  snapshot: [
    'startSamlDrSnapshotRpc',
    'readSamlDrSnapshotPageRpc',
    'releaseSamlDrSnapshotRpc',
    'assertSamlDrSnapshotReleasedRpc',
  ],
  readonly: [],
} as const;

export class SessionRevocationStore extends DurableObject<Env> {
  #assertSamlDrEnabled(): void {
    if ((this.env as { ENABLE_SAML_DR_EXPORT?: string }).ENABLE_SAML_DR_EXPORT !== 'true')
      throw new Error('saml_dr_nameid_unavailable');
  }

  /** Provisioning-only RPC: never called by sign-in, export, or a public HTTP route. */
  async initializeSamlDrNameIdRegistryRpc(
    input: SamlDrNameIdRegistryInitialization
  ): Promise<void> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      this.#assertSamlDrEnabled();
      return initializeSamlDrNameIdRegistry(this.ctx.storage, input);
    });
  }

  async getSamlDrNameIdRpc(
    input: SamlDrNameIdAccountIdentity & { registryKey: string }
  ): Promise<string | null> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      this.#assertSamlDrEnabled();
      return getSamlDrNameId(this.ctx.storage, input);
    });
  }

  async putSamlDrNameIdRpc(
    input: SamlDrNameIdAccountIdentity & { registryKey: string; valueJson: string }
  ): Promise<void> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      this.#assertSamlDrEnabled();
      return putSamlDrNameId(this.ctx.storage, input);
    });
  }

  /** The caller must hold the existing covered-writer tenant backup boundary. */
  async startSamlDrSnapshotRpc(input: SamlDrAccountSnapshotIdentity): Promise<void> {
    this.#assertSamlDrEnabled();
    return startSamlDrAccountSnapshot(this.ctx.storage, input);
  }

  async readSamlDrSnapshotPageRpc(
    input: SamlDrAccountSnapshotIdentity & { cursor?: string }
  ): Promise<SamlDrAccountSnapshotPage> {
    return readSamlDrAccountSnapshotPage(this.ctx.storage, input);
  }

  async releaseSamlDrSnapshotRpc(input: SamlDrAccountSnapshotIdentity): Promise<void> {
    return releaseSamlDrAccountSnapshot(this.ctx.storage, input);
  }

  async assertSamlDrSnapshotReleasedRpc(input: SamlDrAccountSnapshotIdentity): Promise<void> {
    return assertSamlDrAccountSnapshotReleased(this.ctx.storage, input);
  }

  #validateIdentity(
    tenantId: string,
    userId: string,
    accountId: string
  ): SessionRevocationIdentity {
    if (
      !SAFE_TENANT_ID.test(tenantId) ||
      !SAFE_USER_ID.test(userId) ||
      !SAFE_TENANT_ID.test(accountId) ||
      accountId !== `account:${userId}`
    ) {
      throw new Error('session_revocation_identity_invalid');
    }
    return { tenantId, userId, accountId };
  }

  #validateTimestamp(value: number, context: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${context}_timestamp_invalid`);
    }
    return value;
  }

  #validateLifecycle(value: string): AccountAuthenticationLifecycle {
    if (
      value !== 'active' &&
      value !== 'suspended' &&
      value !== 'locked' &&
      value !== 'deleting' &&
      value !== 'deleted' &&
      value !== 'inactive'
    ) {
      throw new Error('account_authentication_lifecycle_invalid');
    }
    return value;
  }

  #validateCredentialId(value: string): string {
    if (!SAFE_CREDENTIAL_ID.test(value)) {
      throw new Error('account_authentication_credential_id_invalid');
    }
    return value;
  }

  #validateSessionId(value: string): string {
    if (!SAFE_SESSION_ID.test(value)) {
      throw new Error('session_registration_id_invalid');
    }
    return value;
  }

  #validateExternalProviderIdentity(
    tenantId: string,
    providerId: string,
    claimKind: 'sid' | 'sub',
    claimDigest: string
  ): ExternalProviderIndexIdentity {
    if (
      !SAFE_TENANT_ID.test(tenantId) ||
      !SAFE_TENANT_ID.test(providerId) ||
      (claimKind !== 'sid' && claimKind !== 'sub') ||
      !SAFE_DIGEST.test(claimDigest)
    ) {
      throw new Error('external_provider_session_identity_invalid');
    }
    return { tenantId, providerId, claimKind, claimDigest };
  }

  async #ensureExternalProviderIdentity(
    storage: SessionRevocationTransactionStorage,
    expected: ExternalProviderIndexIdentity
  ): Promise<void> {
    const existing = await storage.get<ExternalProviderIndexIdentity>(
      EXTERNAL_PROVIDER_IDENTITY_KEY
    );
    if (!existing) {
      await storage.put(EXTERNAL_PROVIDER_IDENTITY_KEY, expected);
      return;
    }
    if (
      existing.tenantId !== expected.tenantId ||
      existing.providerId !== expected.providerId ||
      existing.claimKind !== expected.claimKind ||
      existing.claimDigest !== expected.claimDigest
    ) {
      throw new Error('external_provider_session_identity_mismatch');
    }
  }

  #normalizeState(state: SessionRevocationState | undefined): AccountAuthenticationSnapshot {
    return {
      revokedAfterMs: state?.revokedAfterMs ?? null,
      lastLoginAtMs: state?.lastLoginAtMs ?? null,
      lifecycle: state?.lifecycle ?? null,
      lifecycleVersionMs: state?.lifecycleVersionMs ?? null,
      lifecycleOperationId: state?.lifecycleOperationId ?? null,
    };
  }

  #requireActive(state: AccountAuthenticationSnapshot): void {
    if (state.lifecycle === null) {
      throw new Error('account_auth_state_uninitialized');
    }
    if (state.lifecycle !== 'active') {
      throw new Error('account_authentication_not_allowed');
    }
  }

  async #ensureIdentity(
    storage: SessionRevocationTransactionStorage,
    expected: SessionRevocationIdentity
  ): Promise<void> {
    const existing = await storage.get<SessionRevocationIdentity>(IDENTITY_KEY);
    if (!existing) {
      await storage.put(IDENTITY_KEY, expected);
      return;
    }
    if (
      existing.tenantId !== expected.tenantId ||
      existing.userId !== expected.userId ||
      existing.accountId !== expected.accountId
    ) {
      throw new Error('session_revocation_identity_mismatch');
    }
  }

  async registerSessionRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    requestedAtMs: number,
    sessionId: string,
    expiresAtMs: number,
    metadata?: { ipAddress?: string; userAgent?: string }
  ): Promise<SessionRegistrationResult> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateIdentity(tenantId, userId, accountId);
      const requested = this.#validateTimestamp(requestedAtMs, 'session_registration');
      const validatedSessionId = this.#validateSessionId(sessionId);
      const expiresAt = this.#validateTimestamp(expiresAtMs, 'session_expiration');
      if (expiresAt <= requested) throw new Error('session_expiration_invalid');
      return this.ctx.storage.transaction(async (storage) => {
        await this.#ensureIdentity(storage, identity);
        const state = (await storage.get<SessionRevocationState>(STATE_KEY)) ?? {
          revokedAfterMs: null,
          lastLoginAtMs: null,
        };
        if (state.lifecycle !== undefined && state.lifecycle !== null) {
          this.#requireActive(this.#normalizeState(state));
        }
        const revocationBoundAtMs = Math.max(requested, (state.revokedAfterMs ?? 0) + 1);
        await storage.put(STATE_KEY, {
          ...state,
          lastLoginAtMs: Math.max(state.lastLoginAtMs ?? 0, revocationBoundAtMs),
        } satisfies SessionRevocationState);
        await capturePendingSupportOpsSession(
          storage,
          await storage.get<UserSessionIndexEntry>(`${SESSION_INDEX_PREFIX}${validatedSessionId}`),
          (id) => this.#validateSessionId(id)
        );
        await storage.put(`${SESSION_INDEX_PREFIX}${validatedSessionId}`, {
          sessionId: validatedSessionId,
          tenantId,
          userId,
          accountId,
          createdAtMs: requested,
          expiresAtMs: expiresAt,
          revocationBoundAtMs,
          ipAddress: metadata?.ipAddress ?? null,
          userAgent: metadata?.userAgent ?? null,
        } satisfies UserSessionIndexEntry);
        return { revokedAfterMs: state.revokedAfterMs, revocationBoundAtMs };
      });
    });
  }

  async unregisterSessionRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    sessionId: string
  ): Promise<boolean> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateIdentity(tenantId, userId, accountId);
      const validatedSessionId = this.#validateSessionId(sessionId);
      return this.ctx.storage.transaction(async (storage) => {
        await this.#ensureIdentity(storage, identity);
        await capturePendingSupportOpsSession(
          storage,
          await storage.get<UserSessionIndexEntry>(`${SESSION_INDEX_PREFIX}${validatedSessionId}`),
          (id) => this.#validateSessionId(id)
        );
        return storage.delete(`${SESSION_INDEX_PREFIX}${validatedSessionId}`);
      });
    });
  }

  async updateSessionExpirationRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    sessionId: string,
    expiresAtMs: number
  ): Promise<boolean> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateIdentity(tenantId, userId, accountId);
      const validatedSessionId = this.#validateSessionId(sessionId);
      const expiresAt = this.#validateTimestamp(expiresAtMs, 'session_expiration');
      return this.ctx.storage.transaction(async (storage) => {
        await this.#ensureIdentity(storage, identity);
        const key = `${SESSION_INDEX_PREFIX}${validatedSessionId}`;
        const existing = await storage.get<UserSessionIndexEntry>(key);
        if (!existing) return false;
        if (
          existing.tenantId !== tenantId ||
          existing.userId !== userId ||
          existing.accountId !== accountId ||
          existing.sessionId !== validatedSessionId
        ) {
          throw new Error('session_registration_identity_mismatch');
        }
        await capturePendingSupportOpsSession(storage, existing, (id) =>
          this.#validateSessionId(id)
        );
        await storage.put(key, { ...existing, expiresAtMs: expiresAt });
        return true;
      });
    });
  }

  async listActiveSessionsRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    nowMs: number
  ): Promise<UserSessionIndexEntry[]> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateIdentity(tenantId, userId, accountId);
      const now = this.#validateTimestamp(nowMs, 'session_list');
      await this.ctx.storage.transaction(async (storage) => {
        await this.#ensureIdentity(storage, identity);
      });
      const [state, entries] = await Promise.all([
        this.ctx.storage.get<SessionRevocationState>(STATE_KEY),
        this.ctx.storage.list<UserSessionIndexEntry>({
          prefix: SESSION_INDEX_PREFIX,
          limit: SESSION_INDEX_SCAN_LIMIT,
        }),
      ]);
      if (entries.size > MAX_SESSION_INDEX_ENTRIES) {
        throw new Error('session_index_limit_exceeded');
      }
      const revokedAfterMs = state?.revokedAfterMs ?? null;
      const active: UserSessionIndexEntry[] = [];
      const expiredKeys: string[] = [];
      for (const [key, entry] of entries) {
        if (entry.expiresAtMs <= now) {
          expiredKeys.push(key);
        } else if (revokedAfterMs === null || entry.revocationBoundAtMs > revokedAfterMs) {
          active.push(entry);
        }
      }
      await this.ctx.storage.transaction(async (storage) => {
        await this.#deleteExpiredSessionIndexEntries(storage, expiredKeys, now);
      });
      return active.sort((left, right) => right.createdAtMs - left.createdAtMs);
    });
  }

  async registerExternalProviderSessionRpc(
    tenantId: string,
    providerId: string,
    claimKind: 'sid' | 'sub',
    claimDigest: string,
    sessionId: string,
    userId: string,
    expiresAtMs: number
  ): Promise<void> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateExternalProviderIdentity(
        tenantId,
        providerId,
        claimKind,
        claimDigest
      );
      const validatedSessionId = this.#validateSessionId(sessionId);
      if (!SAFE_USER_ID.test(userId)) throw new Error('external_provider_session_user_invalid');
      const expiresAt = this.#validateTimestamp(
        expiresAtMs,
        'external_provider_session_expiration'
      );
      await this.ctx.storage.transaction(async (storage) => {
        await this.#ensureExternalProviderIdentity(storage, identity);
        await storage.put(`${EXTERNAL_PROVIDER_SESSION_PREFIX}${validatedSessionId}`, {
          sessionId: validatedSessionId,
          userId,
          expiresAtMs: expiresAt,
        } satisfies ExternalProviderSessionIndexEntry);
      });
    });
  }

  async listExternalProviderSessionsRpc(
    tenantId: string,
    providerId: string,
    claimKind: 'sid' | 'sub',
    claimDigest: string,
    nowMs: number
  ): Promise<ExternalProviderSessionIndexEntry[]> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateExternalProviderIdentity(
        tenantId,
        providerId,
        claimKind,
        claimDigest
      );
      const now = this.#validateTimestamp(nowMs, 'external_provider_session_list');
      await this.ctx.storage.transaction(async (storage) => {
        await this.#ensureExternalProviderIdentity(storage, identity);
      });
      const entries = await this.ctx.storage.list<ExternalProviderSessionIndexEntry>({
        prefix: EXTERNAL_PROVIDER_SESSION_PREFIX,
        limit: SESSION_INDEX_SCAN_LIMIT,
      });
      if (entries.size > MAX_SESSION_INDEX_ENTRIES) {
        throw new Error('external_provider_session_limit_exceeded');
      }
      const active: ExternalProviderSessionIndexEntry[] = [];
      const expiredKeys: string[] = [];
      for (const [key, entry] of entries) {
        if (entry.expiresAtMs <= now) expiredKeys.push(key);
        else active.push(entry);
      }
      if (expiredKeys.length > 0) await this.ctx.storage.delete(expiredKeys);
      return active;
    });
  }

  async unregisterExternalProviderSessionRpc(
    tenantId: string,
    providerId: string,
    claimKind: 'sid' | 'sub',
    claimDigest: string,
    sessionId: string
  ): Promise<boolean> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateExternalProviderIdentity(
        tenantId,
        providerId,
        claimKind,
        claimDigest
      );
      const validatedSessionId = this.#validateSessionId(sessionId);
      return this.ctx.storage.transaction(async (storage) => {
        await this.#ensureExternalProviderIdentity(storage, identity);
        return storage.delete(`${EXTERNAL_PROVIDER_SESSION_PREFIX}${validatedSessionId}`);
      });
    });
  }

  async getRevokedAfterRpc(
    tenantId: string,
    userId: string,
    accountId: string
  ): Promise<number | null> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateIdentity(tenantId, userId, accountId);
      return this.ctx.storage.transaction(async (storage) => {
        await this.#ensureIdentity(storage, identity);
        return (await storage.get<SessionRevocationState>(STATE_KEY))?.revokedAfterMs ?? null;
      });
    });
  }

  async getAccountStateRpc(
    tenantId: string,
    userId: string,
    accountId: string
  ): Promise<AccountAuthenticationSnapshot> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateIdentity(tenantId, userId, accountId);
      return this.ctx.storage.transaction(async (storage) => {
        await this.#ensureIdentity(storage, identity);
        return this.#normalizeState(await storage.get<SessionRevocationState>(STATE_KEY));
      });
    });
  }

  async getSessionValidationStateRpc(
    tenantId: string,
    userId: string,
    accountId: string
  ): Promise<Pick<AccountAuthenticationSnapshot, 'revokedAfterMs' | 'lifecycle'>> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const state = await this.getAccountStateRpc(tenantId, userId, accountId);
      return { revokedAfterMs: state.revokedAfterMs, lifecycle: state.lifecycle };
    });
  }

  async initializeAccountStateRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    lifecycle: AccountAuthenticationLifecycle,
    sourceVersionMs: number
  ): Promise<AccountAuthenticationSnapshot> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateIdentity(tenantId, userId, accountId);
      const validatedLifecycle = this.#validateLifecycle(lifecycle);
      const version = this.#validateTimestamp(sourceVersionMs, 'account_auth_state');
      return this.ctx.storage.transaction(async (storage) => {
        await this.#ensureIdentity(storage, identity);
        const state = this.#normalizeState(await storage.get<SessionRevocationState>(STATE_KEY));
        if (state.lifecycle !== null) return state;
        const initialized = {
          ...state,
          lifecycle: validatedLifecycle,
          lifecycleVersionMs: version,
          lifecycleOperationId: null,
        } satisfies AccountAuthenticationSnapshot;
        await storage.put(STATE_KEY, initialized);
        return initialized;
      });
    });
  }

  async setAccountLifecycleRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    lifecycle: AccountAuthenticationLifecycle,
    sourceVersionMs: number,
    operationId: string,
    revokeSessions: boolean
  ): Promise<AccountAuthenticationSnapshot> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      return (
        await this.#applyAccountLifecycle(
          tenantId,
          userId,
          accountId,
          lifecycle,
          sourceVersionMs,
          operationId,
          revokeSessions,
          null
        )
      ).state;
    });
  }

  /**
   * As `setAccountLifecycleRpc`, also returning the unexpired sessions this transition ended,
   * read in the same transaction as the epoch move: a session an earlier or a concurrent
   * revocation ended is not among them. A transition taken before (a retry) ended none.
   */
  async setAccountLifecycleEndingSessionsRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    lifecycle: AccountAuthenticationLifecycle,
    sourceVersionMs: number,
    operationId: string,
    revokeSessions: boolean,
    nowMs: number
  ): Promise<{ state: AccountAuthenticationSnapshot; endedSessions: UserSessionIndexEntry[] }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      return this.#applyAccountLifecycle(
        tenantId,
        userId,
        accountId,
        lifecycle,
        sourceVersionMs,
        operationId,
        revokeSessions,
        this.#validateTimestamp(nowMs, 'session_list')
      );
    });
  }

  /** Support Ops alone opts into a replayable, bounded session transfer. Legacy RPCs are unchanged. */
  async beginSupportOpsSuspensionRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    sourceVersionMs: number,
    operationId: string,
    owner: string,
    nowMs: number
  ): Promise<SupportOpsSessionReceiptLease & { currentState: AccountAuthenticationSnapshot }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      if (!SAFE_CREDENTIAL_ID.test(owner)) throw new Error('support_ops_receipt_owner_invalid');
      const result = await this.#applyAccountLifecycle(
        tenantId,
        userId,
        accountId,
        'suspended',
        sourceVersionMs,
        operationId,
        true,
        nowMs,
        { sourceVersionMs, operationId, owner, nowMs }
      );
      if (!result.receipt) throw new Error('support_ops_receipt_missing');
      return { ...result.receipt, currentState: result.state };
    });
  }

  async readSupportOpsSuspensionReceiptRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    operationId: string,
    owner: string,
    fence: number,
    nowMs: number
  ): Promise<SupportOpsSessionReceiptPage> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateIdentity(tenantId, userId, accountId);
      if (!SAFE_CREDENTIAL_ID.test(operationId) || !SAFE_CREDENTIAL_ID.test(owner))
        throw new Error('support_ops_receipt_identity_invalid');
      return this.ctx.storage.transaction(async (storage) => {
        await this.#ensureIdentity(storage, identity);
        return stepSupportOpsReceipt(storage, operationId, owner, fence, nowMs, (id) =>
          this.#validateSessionId(id)
        );
      });
    });
  }

  async acknowledgeSupportOpsSuspensionReceiptRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    operationId: string,
    owner: string,
    fence: number,
    sequence: number,
    nowMs: number
  ): Promise<void> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateIdentity(tenantId, userId, accountId);
      if (!SAFE_CREDENTIAL_ID.test(operationId) || !SAFE_CREDENTIAL_ID.test(owner))
        throw new Error('support_ops_receipt_identity_invalid');
      await this.ctx.storage.transaction(async (storage) => {
        await this.#ensureIdentity(storage, identity);
        await acknowledgeSupportOpsReceipt(storage, operationId, owner, fence, sequence, nowMs);
      });
    });
  }

  async completeSupportOpsSuspensionReceiptRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    sourceVersionMs: number,
    operationId: string,
    owner: string,
    fence: number,
    sequence: number,
    nowMs: number
  ): Promise<void> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateIdentity(tenantId, userId, accountId);
      if (!SAFE_CREDENTIAL_ID.test(operationId) || !SAFE_CREDENTIAL_ID.test(owner))
        throw new Error('support_ops_receipt_identity_invalid');
      await this.ctx.storage.transaction(async (storage) => {
        await this.#ensureIdentity(storage, identity);
        await completeSupportOpsReceipt(
          storage,
          operationId,
          sourceVersionMs,
          owner,
          fence,
          sequence,
          nowMs
        );
      });
    });
  }

  async #deleteExpiredSessionIndexEntries(
    storage: SessionRevocationTransactionStorage,
    keys: string[],
    now: number
  ): Promise<void> {
    // A concurrent renewal must not be deleted from an earlier read's expired-key list.
    for (const key of keys) {
      const entry = await storage.get<UserSessionIndexEntry>(key);
      if (!entry || entry.expiresAtMs > now) continue;
      await capturePendingSupportOpsSession(storage, entry, (id) => this.#validateSessionId(id));
      await storage.delete(key);
    }
  }

  async #applyAccountLifecycle(
    tenantId: string,
    userId: string,
    accountId: string,
    lifecycle: AccountAuthenticationLifecycle,
    sourceVersionMs: number,
    operationId: string,
    revokeSessions: boolean,
    /** When to read the sessions it ended against; null: not read (none returned). */
    nowMs: number | null,
    receiptRequest?: ReceiptRequest
  ): Promise<{
    state: AccountAuthenticationSnapshot;
    endedSessions: UserSessionIndexEntry[];
    receipt?: SupportOpsSessionReceiptLease;
  }> {
    const identity = this.#validateIdentity(tenantId, userId, accountId);
    const validatedLifecycle = this.#validateLifecycle(lifecycle);
    const version = this.#validateTimestamp(sourceVersionMs, 'account_auth_state');
    if (!SAFE_CREDENTIAL_ID.test(operationId)) {
      throw new Error('account_authentication_operation_id_invalid');
    }
    return this.ctx.storage.transaction(async (storage) => {
      await this.#ensureIdentity(storage, identity);
      const state = this.#normalizeState(await storage.get<SessionRevocationState>(STATE_KEY));
      if (receiptRequest) {
        const replay = await replaySupportOpsReceipt(storage, receiptRequest);
        if (replay) return { state, endedSessions: [], receipt: replay };
      }
      if (state.lifecycleVersionMs !== null && version < state.lifecycleVersionMs) {
        throw new Error('account_authentication_lifecycle_stale');
      }
      if (state.lifecycleVersionMs === version) {
        if (state.lifecycle === validatedLifecycle && state.lifecycleOperationId === operationId) {
          if (receiptRequest) throw new Error('support_ops_receipt_missing');
          return { state, endedSessions: [] };
        }
        throw new Error('account_authentication_lifecycle_conflict');
      }
      // Deletion only goes forward: an account being deleted becomes deleted, and a deleted one
      // stays so, whatever a transition of a later version asks. Starting a deletion again once
      // it is done (a retry of the steps after it) is answered with the done state.
      if (state.lifecycle === 'deleted' && validatedLifecycle === 'deleting') {
        return { state, endedSessions: [] };
      }
      if (
        (state.lifecycle === 'deleting' &&
          validatedLifecycle !== 'deleting' &&
          validatedLifecycle !== 'deleted') ||
        (state.lifecycle === 'deleted' && validatedLifecycle !== 'deleted')
      ) {
        throw new Error('account_authentication_lifecycle_terminal');
      }
      const next = {
        ...state,
        lifecycle: validatedLifecycle,
        lifecycleVersionMs: version,
        lifecycleOperationId: operationId,
        revokedAfterMs: revokeSessions
          ? Math.max(state.revokedAfterMs ?? 0, state.lastLoginAtMs ?? 0, version)
          : state.revokedAfterMs,
      } satisfies AccountAuthenticationSnapshot;
      await storage.put(STATE_KEY, next);
      if (receiptRequest) {
        const receipt = await createSupportOpsReceipt(
          storage,
          receiptRequest,
          state.revokedAfterMs,
          next.revokedAfterMs
        );
        return { state: next, endedSessions: [], receipt };
      }
      return {
        state: next,
        endedSessions: await this.#sessionsRevokedBetween(
          storage,
          state.revokedAfterMs,
          next.revokedAfterMs,
          nowMs
        ),
      };
    });
  }

  /**
   * The unexpired sessions the epoch moving from `previous` to `next` revoked (none when it did
   * not move, or when `nowMs` is null: the caller does not need them). Read inside the
   * transaction that moved it. A revoked session stays in the index until it expires or is
   * logged out; expired entries met on the way are removed. The whole index is read, page by
   * page: a session this revocation ended is never left out, however many entries come first.
   */
  async #sessionsRevokedBetween(
    storage: SessionRevocationTransactionStorage,
    previous: number | null,
    next: number | null,
    nowMs: number | null
  ): Promise<UserSessionIndexEntry[]> {
    if (nowMs === null || next === null || (previous !== null && next <= previous)) return [];
    const ended: UserSessionIndexEntry[] = [];
    let startAfter: string | undefined;
    for (;;) {
      const page = await storage.list<UserSessionIndexEntry>({
        prefix: SESSION_INDEX_PREFIX,
        limit: REVOCATION_SCAN_PAGE_SIZE,
        ...(startAfter ? { startAfter } : {}),
      });
      const expiredKeys: string[] = [];
      for (const [key, entry] of page) {
        startAfter = key;
        if (entry.expiresAtMs <= nowMs) {
          expiredKeys.push(key);
        } else if (
          entry.revocationBoundAtMs <= next &&
          (previous === null || entry.revocationBoundAtMs > previous)
        ) {
          ended.push(entry);
        }
      }
      await this.#deleteExpiredSessionIndexEntries(storage, expiredKeys, nowMs);
      if (page.size < REVOCATION_SCAN_PAGE_SIZE) return ended;
    }
  }

  async assertAccountActiveRpc(
    tenantId: string,
    userId: string,
    accountId: string
  ): Promise<AccountAuthenticationSnapshot> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const state = await this.getAccountStateRpc(tenantId, userId, accountId);
      this.#requireActive(state);
      return state;
    });
  }

  async advancePasskeyCounterRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    credentialId: string,
    sourceCounter: number,
    newCounter: number,
    observedAtMs: number
  ): Promise<{ counter: number; advanced: boolean }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateIdentity(tenantId, userId, accountId);
      const key = `passkey-counter:${this.#validateCredentialId(credentialId)}`;
      const observedAt = this.#validateTimestamp(observedAtMs, 'passkey_counter');
      if (
        !Number.isSafeInteger(sourceCounter) ||
        sourceCounter < 0 ||
        !Number.isSafeInteger(newCounter) ||
        newCounter < 0
      ) {
        throw new Error('passkey_counter_invalid');
      }
      return this.ctx.storage.transaction(async (storage) => {
        await this.#ensureIdentity(storage, identity);
        this.#requireActive(
          this.#normalizeState(await storage.get<SessionRevocationState>(STATE_KEY))
        );
        const stored = await storage.get<PasskeyCounterState>(key);
        const current = stored?.counter ?? sourceCounter;
        if (current === 0 && newCounter === 0) {
          await storage.put(key, {
            counter: 0,
            updatedAtMs: observedAt,
          } satisfies PasskeyCounterState);
          return { counter: 0, advanced: false };
        }
        if (newCounter <= current) throw new Error('passkey_counter_replay');
        await storage.put(key, {
          counter: newCounter,
          updatedAtMs: observedAt,
        } satisfies PasskeyCounterState);
        return { counter: newCounter, advanced: true };
      });
    });
  }

  async consumeTotpTimeStepRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    credentialId: string,
    sourceLastAcceptedTimeStep: number | null,
    acceptedTimeStep: number,
    observedAtMs: number
  ): Promise<{ lastAcceptedTimeStep: number }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateIdentity(tenantId, userId, accountId);
      const key = `totp-time-step:${this.#validateCredentialId(credentialId)}`;
      const observedAt = this.#validateTimestamp(observedAtMs, 'totp_time_step');
      if (
        (sourceLastAcceptedTimeStep !== null &&
          (!Number.isSafeInteger(sourceLastAcceptedTimeStep) || sourceLastAcceptedTimeStep < 0)) ||
        !Number.isSafeInteger(acceptedTimeStep) ||
        acceptedTimeStep < 0
      ) {
        throw new Error('totp_time_step_invalid');
      }
      return this.ctx.storage.transaction(async (storage) => {
        await this.#ensureIdentity(storage, identity);
        this.#requireActive(
          this.#normalizeState(await storage.get<SessionRevocationState>(STATE_KEY))
        );
        const stored = await storage.get<TotpTimeStepState>(key);
        const current = stored?.lastAcceptedTimeStep ?? sourceLastAcceptedTimeStep;
        if (current !== null && acceptedTimeStep <= current) {
          throw new Error('totp_time_step_replay');
        }
        await storage.put(key, {
          lastAcceptedTimeStep: acceptedTimeStep,
          updatedAtMs: observedAt,
        } satisfies TotpTimeStepState);
        return { lastAcceptedTimeStep: acceptedTimeStep };
      });
    });
  }

  async deleteCredentialStateRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    method: 'passkey' | 'totp',
    credentialId: string
  ): Promise<boolean> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateIdentity(tenantId, userId, accountId);
      const prefix = method === 'passkey' ? 'passkey-counter' : 'totp-time-step';
      const key = `${prefix}:${this.#validateCredentialId(credentialId)}`;
      return this.ctx.storage.transaction(async (storage) => {
        await this.#ensureIdentity(storage, identity);
        return storage.delete(key);
      });
    });
  }

  async revokeAllRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    revokedAfterMs: number
  ): Promise<number> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      return (await this.#revokeAll(tenantId, userId, accountId, revokedAfterMs, null))
        .revokedAfterMs;
    });
  }

  /**
   * As `revokeAllRpc`, also returning the unexpired sessions this revocation ended, read in the
   * same transaction as the epoch move.
   */
  async revokeAllEndingSessionsRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    revokedAfterMs: number,
    nowMs: number
  ): Promise<{ revokedAfterMs: number; endedSessions: UserSessionIndexEntry[] }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      return this.#revokeAll(
        tenantId,
        userId,
        accountId,
        revokedAfterMs,
        this.#validateTimestamp(nowMs, 'session_list')
      );
    });
  }

  async #revokeAll(
    tenantId: string,
    userId: string,
    accountId: string,
    revokedAfterMs: number,
    /** When to read the sessions it ended against; null: not read (none returned). */
    nowMs: number | null
  ): Promise<{ revokedAfterMs: number; endedSessions: UserSessionIndexEntry[] }> {
    const identity = this.#validateIdentity(tenantId, userId, accountId);
    const requested = this.#validateTimestamp(revokedAfterMs, 'session_revocation');
    return this.ctx.storage.transaction(async (storage) => {
      await this.#ensureIdentity(storage, identity);
      const state = (await storage.get<SessionRevocationState>(STATE_KEY)) ?? {
        revokedAfterMs: null,
        lastLoginAtMs: null,
      };
      const effectiveRevokedAfterMs = Math.max(state.revokedAfterMs ?? 0, requested);
      await storage.put(STATE_KEY, {
        ...state,
        revokedAfterMs: effectiveRevokedAfterMs,
      } satisfies SessionRevocationState);
      return {
        revokedAfterMs: effectiveRevokedAfterMs,
        endedSessions: await this.#sessionsRevokedBetween(
          storage,
          state.revokedAfterMs,
          effectiveRevokedAfterMs,
          nowMs
        ),
      };
    });
  }

  async getLastLoginAtRpc(
    tenantId: string,
    userId: string,
    accountId: string
  ): Promise<number | null> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      const identity = this.#validateIdentity(tenantId, userId, accountId);
      return this.ctx.storage.transaction(async (storage) => {
        await this.#ensureIdentity(storage, identity);
        return (await storage.get<SessionRevocationState>(STATE_KEY))?.lastLoginAtMs ?? null;
      });
    });
  }
}
