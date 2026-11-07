/**
 * The admin side of the lite Login UI's compatibility guard.
 *
 * While a tenant is in lite mode (`always`), a change that would give it something the lite UI
 * cannot do (a sign-in method, a Flow component, a screen block, an application's own Login UI,
 * another issuer origin) is refused with `lite_mode_unsupported` and the reasons. The check and
 * the write run under the tenant's LitePolicyStore lease, so a switch to `always` and such a
 * change cannot both pass their checks at the same time.
 *
 * What this does NOT protect: human verification and the other security decisions do not depend
 * on this guard. The runtimes read the policy store themselves, and the lite UI stops at anything
 * it cannot render, before any side effect. A change that slips past the guard (a lease that ran
 * out mid-write) therefore ends in an error page, not a bypass.
 *
 * For a tenant that is not in lite mode the guard reads the store once and lets the change
 * through, unless a switch is being made right now (`lite_mode_change_in_progress`, retry).
 */
import type { Context } from 'hono';
import {
  createLogger,
  getLitePolicyStore,
  normalizeLiteModeIssues,
  type Env,
  type LiteHumanVerificationRequired,
  type LiteModeIssue,
} from '@authrim/ar-lib-core';

type AnyContext = Context;

const log = createLogger().module('LITE-MODE-GUARD');

export function liteModeUnsupportedResponse(c: AnyContext, issues: LiteModeIssue[]): Response {
  return c.json(
    {
      error: 'lite_mode_unsupported',
      error_description:
        'The tenant uses the lite Login UI, and this change would give it something the lite Login UI cannot do',
      issues: normalizeLiteModeIssues(issues),
    },
    409
  );
}

export function liteModeChangeInProgressResponse(c: AnyContext, retryAfterMs: number): Response {
  c.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return c.json(
    {
      error: 'lite_mode_change_in_progress',
      error_description:
        'The tenant’s lite Login UI setting is being changed; try again in a few seconds',
    },
    409
  );
}

export function litePolicyUnavailableResponse(c: AnyContext): Response {
  c.header('Cache-Control', 'no-store');
  return c.json(
    {
      error: 'lite_policy_unavailable',
      error_description: 'The tenant’s lite Login UI policy could not be read; try again',
    },
    503
  );
}

function sameRequired(a: LiteHumanVerificationRequired, b: LiteHumanVerificationRequired): boolean {
  return a.login === b.login && a.signup === b.signup && a.reauth === b.reauth;
}

function unionRequired(
  a: LiteHumanVerificationRequired,
  b: LiteHumanVerificationRequired
): LiteHumanVerificationRequired {
  return { login: a.login || b.login, signup: a.signup || b.signup, reauth: a.reauth || b.reauth };
}

export interface LiteGuardedWrite {
  /**
   * The issues the change would leave. Runs only when the tenant is in lite mode, under the
   * lease; an empty list lets the write run.
   */
  check: () => Promise<LiteModeIssue[]>;
  /** The change itself. A response that is not `ok` is passed on and publishes nothing. */
  write: () => Promise<Response>;
  /**
   * For a change that can alter which actions require human verification: the required actions
   * after it (null: unchanged). Called after `check`, before the write. The stricter of the old
   * and new sets is published before the write, the new set after it (the old one if it failed).
   */
  humanVerificationAfter?: () => LiteHumanVerificationRequired | null;
  /**
   * Take the lease even while the tenant is not in lite mode, so a switch to `always` (which
   * reads these settings to publish its policy) cannot run in the middle of this change.
   */
  serializeWithSwitch?: boolean;
}

/** Runs a change under the tenant's lite compatibility guard (see the module comment). */
export async function runLiteGuardedWrite(
  c: AnyContext,
  tenantId: string,
  spec: LiteGuardedWrite
): Promise<Response> {
  const store = getLitePolicyStore((c.env ?? {}) as Env, tenantId);
  // Without the store no tenant can be in lite mode.
  if (!store) return spec.write();

  let status: Awaited<ReturnType<typeof store.getStatusRpc>>;
  try {
    status = await store.getStatusRpc(tenantId);
  } catch (error) {
    log.error('Lite policy store unreadable before a guarded change', {
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
    return litePolicyUnavailableResponse(c);
  }
  if (status.snapshot.liteMode === 'off' && !spec.serializeWithSwitch) {
    if (status.changeInProgress) return liteModeChangeInProgressResponse(c, 1000);
    return spec.write();
  }

  const lease = await store.acquireLeaseRpc(tenantId);
  if (!lease.acquired) return liteModeChangeInProgressResponse(c, lease.retryAfterMs);
  let leaseOpen = true;
  try {
    // Read again under the lease: the mode may have changed since the status read.
    const current = await store.getSnapshotRpc(tenantId);
    if (current.liteMode !== 'always') return await spec.write();
    let issues: LiteModeIssue[];
    try {
      issues = await spec.check();
    } catch (error) {
      // A change that could not be judged is not made.
      log.error('Lite compatibility check failed', {
        errorType: error instanceof Error ? error.name : 'Unknown',
      });
      return litePolicyUnavailableResponse(c);
    }
    if (issues.length > 0) return liteModeUnsupportedResponse(c, issues);

    const before = current.humanVerificationRequired;
    const after = spec.humanVerificationAfter?.() ?? null;
    if (!after || sameRequired(before, after)) return await spec.write();

    // Publish the stricter of before and after first, so that whatever fails later the lite
    // runtime never requires less than the saved settings ask for; then the final set.
    const publish = async (
      required: LiteHumanVerificationRequired,
      expectedGeneration: number,
      keepLease: boolean
    ) => {
      const result = await store.commitRpc({
        tenantId,
        token: lease.token,
        expectedGeneration,
        liteMode: 'always',
        humanVerificationRequired: required,
        keepLease,
      });
      if (!keepLease) leaseOpen = false;
      return result;
    };
    const stricter = await publish(unionRequired(before, after), lease.generation, true);
    if (!stricter.committed) {
      leaseOpen = false;
      return liteModeChangeInProgressResponse(c, 1000);
    }
    const response = await spec.write();
    const final = await publish(response.ok ? after : before, stricter.snapshot.generation, false);
    if (!final.committed) {
      // The stricter set stays published: safe, and corrected by the next change.
      log.error('Lite policy left at the stricter human verification set', {
        reason: final.reason,
      });
    }
    return response;
  } finally {
    if (leaseOpen) {
      await store.releaseRpc(tenantId, lease.token).catch((error: unknown) => {
        log.warn('Lite policy lease not released (it runs out by itself)', {
          errorType: error instanceof Error ? error.name : 'Unknown',
        });
      });
    }
  }
}
