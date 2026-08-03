import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';

const IDENTITY_KEY = 'identity';
const STATE_KEY = 'state';
const SAFE_TENANT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_USER_ID = /^[a-zA-Z0-9_-][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_CREDENTIAL_ID = /^[a-zA-Z0-9_.:-]{1,256}$/u;

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
export class SessionRevocationStore extends DurableObject<Env> {
  private validateIdentity(
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

  private validateTimestamp(value: number, context: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${context}_timestamp_invalid`);
    }
    return value;
  }

  private validateLifecycle(value: string): AccountAuthenticationLifecycle {
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

  private validateCredentialId(value: string): string {
    if (!SAFE_CREDENTIAL_ID.test(value)) {
      throw new Error('account_authentication_credential_id_invalid');
    }
    return value;
  }

  private normalizeState(state: SessionRevocationState | undefined): AccountAuthenticationSnapshot {
    return {
      revokedAfterMs: state?.revokedAfterMs ?? null,
      lastLoginAtMs: state?.lastLoginAtMs ?? null,
      lifecycle: state?.lifecycle ?? null,
      lifecycleVersionMs: state?.lifecycleVersionMs ?? null,
      lifecycleOperationId: state?.lifecycleOperationId ?? null,
    };
  }

  private requireActive(state: AccountAuthenticationSnapshot): void {
    if (state.lifecycle === null) {
      throw new Error('account_auth_state_uninitialized');
    }
    if (state.lifecycle !== 'active') {
      throw new Error('account_authentication_not_allowed');
    }
  }

  private async ensureIdentity(
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
    requestedAtMs: number
  ): Promise<SessionRegistrationResult> {
    const identity = this.validateIdentity(tenantId, userId, accountId);
    const requested = this.validateTimestamp(requestedAtMs, 'session_registration');
    return this.ctx.storage.transaction(async (storage) => {
      await this.ensureIdentity(storage, identity);
      const state = (await storage.get<SessionRevocationState>(STATE_KEY)) ?? {
        revokedAfterMs: null,
        lastLoginAtMs: null,
      };
      if (state.lifecycle !== undefined && state.lifecycle !== null) {
        this.requireActive(this.normalizeState(state));
      }
      const revocationBoundAtMs = Math.max(requested, (state.revokedAfterMs ?? 0) + 1);
      await storage.put(STATE_KEY, {
        ...state,
        lastLoginAtMs: Math.max(state.lastLoginAtMs ?? 0, revocationBoundAtMs),
      } satisfies SessionRevocationState);
      return { revokedAfterMs: state.revokedAfterMs, revocationBoundAtMs };
    });
  }

  async getRevokedAfterRpc(
    tenantId: string,
    userId: string,
    accountId: string
  ): Promise<number | null> {
    const identity = this.validateIdentity(tenantId, userId, accountId);
    return this.ctx.storage.transaction(async (storage) => {
      await this.ensureIdentity(storage, identity);
      return (await storage.get<SessionRevocationState>(STATE_KEY))?.revokedAfterMs ?? null;
    });
  }

  async getAccountStateRpc(
    tenantId: string,
    userId: string,
    accountId: string
  ): Promise<AccountAuthenticationSnapshot> {
    const identity = this.validateIdentity(tenantId, userId, accountId);
    return this.ctx.storage.transaction(async (storage) => {
      await this.ensureIdentity(storage, identity);
      return this.normalizeState(await storage.get<SessionRevocationState>(STATE_KEY));
    });
  }

  async getSessionValidationStateRpc(
    tenantId: string,
    userId: string,
    accountId: string
  ): Promise<Pick<AccountAuthenticationSnapshot, 'revokedAfterMs' | 'lifecycle'>> {
    const state = await this.getAccountStateRpc(tenantId, userId, accountId);
    return { revokedAfterMs: state.revokedAfterMs, lifecycle: state.lifecycle };
  }

  async initializeAccountStateRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    lifecycle: AccountAuthenticationLifecycle,
    sourceVersionMs: number
  ): Promise<AccountAuthenticationSnapshot> {
    const identity = this.validateIdentity(tenantId, userId, accountId);
    const validatedLifecycle = this.validateLifecycle(lifecycle);
    const version = this.validateTimestamp(sourceVersionMs, 'account_auth_state');
    return this.ctx.storage.transaction(async (storage) => {
      await this.ensureIdentity(storage, identity);
      const state = this.normalizeState(await storage.get<SessionRevocationState>(STATE_KEY));
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
    const identity = this.validateIdentity(tenantId, userId, accountId);
    const validatedLifecycle = this.validateLifecycle(lifecycle);
    const version = this.validateTimestamp(sourceVersionMs, 'account_auth_state');
    if (!SAFE_CREDENTIAL_ID.test(operationId)) {
      throw new Error('account_authentication_operation_id_invalid');
    }
    return this.ctx.storage.transaction(async (storage) => {
      await this.ensureIdentity(storage, identity);
      const state = this.normalizeState(await storage.get<SessionRevocationState>(STATE_KEY));
      if (state.lifecycleVersionMs !== null && version < state.lifecycleVersionMs) {
        throw new Error('account_authentication_lifecycle_stale');
      }
      if (state.lifecycleVersionMs === version) {
        if (state.lifecycle === validatedLifecycle && state.lifecycleOperationId === operationId) {
          return state;
        }
        throw new Error('account_authentication_lifecycle_conflict');
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
      return next;
    });
  }

  async assertAccountActiveRpc(
    tenantId: string,
    userId: string,
    accountId: string
  ): Promise<AccountAuthenticationSnapshot> {
    const state = await this.getAccountStateRpc(tenantId, userId, accountId);
    this.requireActive(state);
    return state;
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
    const identity = this.validateIdentity(tenantId, userId, accountId);
    const key = `passkey-counter:${this.validateCredentialId(credentialId)}`;
    const observedAt = this.validateTimestamp(observedAtMs, 'passkey_counter');
    if (
      !Number.isSafeInteger(sourceCounter) ||
      sourceCounter < 0 ||
      !Number.isSafeInteger(newCounter) ||
      newCounter < 0
    ) {
      throw new Error('passkey_counter_invalid');
    }
    return this.ctx.storage.transaction(async (storage) => {
      await this.ensureIdentity(storage, identity);
      this.requireActive(this.normalizeState(await storage.get<SessionRevocationState>(STATE_KEY)));
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
    const identity = this.validateIdentity(tenantId, userId, accountId);
    const key = `totp-time-step:${this.validateCredentialId(credentialId)}`;
    const observedAt = this.validateTimestamp(observedAtMs, 'totp_time_step');
    if (
      (sourceLastAcceptedTimeStep !== null &&
        (!Number.isSafeInteger(sourceLastAcceptedTimeStep) || sourceLastAcceptedTimeStep < 0)) ||
      !Number.isSafeInteger(acceptedTimeStep) ||
      acceptedTimeStep < 0
    ) {
      throw new Error('totp_time_step_invalid');
    }
    return this.ctx.storage.transaction(async (storage) => {
      await this.ensureIdentity(storage, identity);
      this.requireActive(this.normalizeState(await storage.get<SessionRevocationState>(STATE_KEY)));
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
  }

  async deleteCredentialStateRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    method: 'passkey' | 'totp',
    credentialId: string
  ): Promise<boolean> {
    const identity = this.validateIdentity(tenantId, userId, accountId);
    const prefix = method === 'passkey' ? 'passkey-counter' : 'totp-time-step';
    const key = `${prefix}:${this.validateCredentialId(credentialId)}`;
    return this.ctx.storage.transaction(async (storage) => {
      await this.ensureIdentity(storage, identity);
      return storage.delete(key);
    });
  }

  async revokeAllRpc(
    tenantId: string,
    userId: string,
    accountId: string,
    revokedAfterMs: number
  ): Promise<number> {
    const identity = this.validateIdentity(tenantId, userId, accountId);
    const requested = this.validateTimestamp(revokedAfterMs, 'session_revocation');
    return this.ctx.storage.transaction(async (storage) => {
      await this.ensureIdentity(storage, identity);
      const state = (await storage.get<SessionRevocationState>(STATE_KEY)) ?? {
        revokedAfterMs: null,
        lastLoginAtMs: null,
      };
      const effectiveRevokedAfterMs = Math.max(state.revokedAfterMs ?? 0, requested);
      await storage.put(STATE_KEY, {
        ...state,
        revokedAfterMs: effectiveRevokedAfterMs,
      } satisfies SessionRevocationState);
      return effectiveRevokedAfterMs;
    });
  }

  async getLastLoginAtRpc(
    tenantId: string,
    userId: string,
    accountId: string
  ): Promise<number | null> {
    const identity = this.validateIdentity(tenantId, userId, accountId);
    return this.ctx.storage.transaction(async (storage) => {
      await this.ensureIdentity(storage, identity);
      return (await storage.get<SessionRevocationState>(STATE_KEY))?.lastLoginAtMs ?? null;
    });
  }
}
