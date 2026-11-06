/**
 * LitePolicyStore Durable Object (one instance per tenant)
 *
 * The authoritative lite Login UI policy of one tenant: whether the lite UI is on (`liteMode`),
 * which actions require human verification while it is, and the `policyRevision` that names this
 * combination. While `liteMode` is `always`, the human verification provider is the lite UI's
 * proof of work; the provider is not stored separately, so the two cannot disagree.
 *
 * Why a Durable Object: settings live in KV, which has no conditional write and is read with a
 * lag. A runtime that must refuse a side effect when the policy changed needs one value that
 * every Worker reads the same way, and an admin change needs to check and publish in one step.
 *
 * How a change is published:
 * 1. `acquireLeaseRpc` takes a short lease (30 seconds) and returns its token and the current
 *    `generation`. Only one lease is live at a time; a second caller gets `busy`.
 * 2. The caller checks the tenant's configuration (the compatibility guard) and writes what it
 *    writes elsewhere.
 * 3. `commitRpc` publishes the new policy only when the token is the live lease's and the
 *    generation is still the one the lease saw. A lease that ran out is refused, even when nobody
 *    else took one: the check it guarded may be out of date. The lease ends with the commit.
 *    `releaseRpc` ends a lease without a change. A commit with `keepLease` publishes and keeps
 *    the lease (at the new generation), so a change can publish a stricter policy before its
 *    write and the final one after it.
 *
 * `generation` grows with every commit. `policyRevision` changes only when the policy itself
 * changes (`liteMode` or a required action), so saving an unrelated setting under a lease does
 * not invalidate the lite transactions in flight.
 *
 * An instance that never committed reads as `off` with the revision `initial`. A tenant restored
 * from a backup into a new environment therefore starts in the normal Login UI; the saved setting
 * `login-ui.lite_mode` records what to re-apply through the lite-mode route.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';
import {
  LITE_POLICY_INITIAL_REVISION,
  type LiteHumanVerificationRequired,
  type LiteMode,
  type LitePolicySnapshot,
} from '../types/login-ui-lite';

const STATE_KEY = 'state';

/** How long a lease holds the store before another caller may take it. */
export const LITE_POLICY_LEASE_TTL_MS = 30_000;

interface StoredLease {
  token: string;
  generation: number;
  expiresAt: number;
}

interface StoredLitePolicy {
  version: 1;
  tenantId: string;
  liteMode: LiteMode;
  humanVerificationRequired: LiteHumanVerificationRequired;
  policyRevision: string;
  generation: number;
  updatedAt: number;
  lease: StoredLease | null;
}

export type LitePolicyLeaseResult =
  | { acquired: true; token: string; generation: number; expiresAt: number }
  | { acquired: false; reason: 'busy'; retryAfterMs: number };

export type LitePolicyCommitResult =
  | { committed: true; snapshot: LitePolicySnapshot }
  | { committed: false; reason: 'lease_lost' | 'generation_mismatch' };

export interface LitePolicyCommitRequest {
  tenantId: string;
  token: string;
  expectedGeneration: number;
  liteMode: LiteMode;
  humanVerificationRequired: LiteHumanVerificationRequired;
  /**
   * Keep the lease after this commit (its generation moves to the new one), for a change that
   * publishes an intermediate policy before its write and the final one after it.
   */
  keepLease?: boolean;
}

const NO_HUMAN_VERIFICATION: LiteHumanVerificationRequired = Object.freeze({
  login: false,
  signup: false,
  reauth: false,
});

function sameRequired(a: LiteHumanVerificationRequired, b: LiteHumanVerificationRequired): boolean {
  return a.login === b.login && a.signup === b.signup && a.reauth === b.reauth;
}

function normalizeRequired(value: LiteHumanVerificationRequired): LiteHumanVerificationRequired {
  return {
    login: value.login === true,
    signup: value.signup === true,
    reauth: value.reauth === true,
  };
}

function assertTenantId(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string' || !tenantId || tenantId.length > 256) {
    throw new Error('lite_policy_invalid_tenant');
  }
}

export class LitePolicyStore extends DurableObject<Env> {
  private async read(tenantId: string): Promise<StoredLitePolicy> {
    const stored = await this.ctx.storage.get<StoredLitePolicy>(STATE_KEY);
    if (!stored) {
      return {
        version: 1,
        tenantId,
        liteMode: 'off',
        humanVerificationRequired: NO_HUMAN_VERIFICATION,
        policyRevision: LITE_POLICY_INITIAL_REVISION,
        generation: 0,
        updatedAt: 0,
        lease: null,
      };
    }
    // One instance serves one tenant: a request for another tenant must not read its policy.
    if (stored.tenantId !== tenantId) throw new Error('lite_policy_tenant_mismatch');
    return stored;
  }

  private static snapshotOf(state: StoredLitePolicy): LitePolicySnapshot {
    return {
      tenantId: state.tenantId,
      liteMode: state.liteMode,
      humanVerificationRequired: { ...state.humanVerificationRequired },
      policyRevision: state.policyRevision,
      generation: state.generation,
      updatedAt: state.updatedAt,
    };
  }

  /** The tenant's current policy. */
  async getSnapshotRpc(tenantId: string): Promise<LitePolicySnapshot> {
    assertTenantId(tenantId);
    return LitePolicyStore.snapshotOf(await this.read(tenantId));
  }

  /**
   * The current policy and whether a change is being made now (a live lease). A writer that
   * changes something the guard checks waits for a change in progress instead of racing it.
   */
  async getStatusRpc(
    tenantId: string
  ): Promise<{ snapshot: LitePolicySnapshot; changeInProgress: boolean }> {
    assertTenantId(tenantId);
    const state = await this.read(tenantId);
    return {
      snapshot: LitePolicyStore.snapshotOf(state),
      changeInProgress: state.lease !== null && state.lease.expiresAt > Date.now(),
    };
  }

  async acquireLeaseRpc(tenantId: string): Promise<LitePolicyLeaseResult> {
    assertTenantId(tenantId);
    const state = await this.read(tenantId);
    const now = Date.now();
    if (state.lease && state.lease.expiresAt > now) {
      return { acquired: false, reason: 'busy', retryAfterMs: state.lease.expiresAt - now };
    }
    const lease: StoredLease = {
      token: crypto.randomUUID(),
      generation: state.generation,
      expiresAt: now + LITE_POLICY_LEASE_TTL_MS,
    };
    await this.ctx.storage.put<StoredLitePolicy>(STATE_KEY, { ...state, tenantId, lease });
    return {
      acquired: true,
      token: lease.token,
      generation: lease.generation,
      expiresAt: lease.expiresAt,
    };
  }

  async commitRpc(request: LitePolicyCommitRequest): Promise<LitePolicyCommitResult> {
    assertTenantId(request.tenantId);
    if (request.liteMode !== 'off' && request.liteMode !== 'always') {
      throw new Error('lite_policy_invalid_mode');
    }
    const state = await this.read(request.tenantId);
    const now = Date.now();
    const lease = state.lease;
    if (!lease || lease.token !== request.token || lease.expiresAt <= now) {
      return { committed: false, reason: 'lease_lost' };
    }
    if (lease.generation !== state.generation || request.expectedGeneration !== state.generation) {
      return { committed: false, reason: 'generation_mismatch' };
    }
    const required = normalizeRequired(request.humanVerificationRequired);
    const policyChanged =
      state.liteMode !== request.liteMode ||
      !sameRequired(state.humanVerificationRequired, required);
    const next: StoredLitePolicy = {
      version: 1,
      tenantId: request.tenantId,
      liteMode: request.liteMode,
      humanVerificationRequired: required,
      policyRevision: policyChanged ? crypto.randomUUID() : state.policyRevision,
      generation: state.generation + 1,
      updatedAt: now,
      lease: request.keepLease
        ? { token: lease.token, generation: state.generation + 1, expiresAt: lease.expiresAt }
        : null,
    };
    await this.ctx.storage.put<StoredLitePolicy>(STATE_KEY, next);
    return { committed: true, snapshot: LitePolicyStore.snapshotOf(next) };
  }

  /** Ends a lease without a change. Another caller's token is ignored. */
  async releaseRpc(tenantId: string, token: string): Promise<{ released: boolean }> {
    assertTenantId(tenantId);
    const state = await this.read(tenantId);
    if (!state.lease || state.lease.token !== token) return { released: false };
    await this.ctx.storage.put<StoredLitePolicy>(STATE_KEY, { ...state, lease: null });
    return { released: true };
  }
}
