/**
 * The shadow comparison of the Mapping Set selection.
 *
 * The OIDC resolution a request uses today (`applyOIDCIdentityMapping`) is the app's own set when it
 * names one, else whatever activation applies to the whole tenant. The new selection
 * (identity-mapping-selection.ts) is the app's own set, else the tenant default, else the platform
 * default. While `identity_mapping.shadow_compare_enabled` is on, each request's resolution is also
 * run through the new selection and read, and a difference is logged as a warning, so the
 * environments can be checked before the release of claims moves to the new selection.
 *
 * It changes nothing for the request: it runs after the current resolution, never throws, and
 * goes through `waitUntil` where the caller has one. A record names the tenant, the app, the kind
 * of difference and the two sets and levels; it carries no claim, value or user, and no error
 * message. The same difference for the same app is recorded once per window per Worker instance,
 * with the number of repeats since (the way identity-mapping-swallowed-failure.ts does), and the
 * table of keys is bounded.
 */
import { createLogger, type Logger } from '../utils/logger';
import type { OIDCIdentityMappingFieldMappingSelector } from '../types/oidc';
import { IDENTITY_MAPPING_SHADOW_COMPARE_KEY } from '../types/settings/identity-mapping';
import {
  resolvePlatformSettingsWithSources,
  type EffectiveSettingsEnv,
} from './effective-settings';
import { RuntimeIdentityMappingOwnerError } from './identity-mapping-owner';
import { resolveOidcIdentityMappingBinding } from './identity-mapping-resolution';
import { IdentityMappingSelectionError } from './identity-mapping-selection';
import {
  IdentityMappingResolutionError,
  type IdentityMappingTier,
} from './identity-mapping-set-binding';
import type { Env } from '../types/env';

/** What the request resolved with. */
export interface ShadowCurrentResolution {
  /**
   * `explicit`: the app names its set. `implicit_tenant_activation`: the app names none and an
   * activation that applies to the tenant was found. `none`: no mapping applied.
   */
  tier: 'explicit' | 'implicit_tenant_activation' | 'none';
  setId?: string;
  /** The resolution failed and the request went on without a mapping (it is `none` then). */
  failed?: boolean;
}

/** What the new selection and read came to. */
export type ShadowNewResolution =
  | { kind: 'bound'; tier: IdentityMappingTier; setId: string }
  | { kind: 'none'; reason: string }
  | { kind: 'failed'; code: string; tier?: IdentityMappingTier };

export type ResolutionDiffKind =
  /** Both use the same set, as different levels (an activation of the tenant, now a default). */
  | 'tier_differs'
  | 'set_differs'
  | 'current_none_new_bound'
  | 'current_bound_new_none'
  /** The new selection or the read of its set failed (a default that is not usable, a set that is gone). */
  | 'new_selection_failed';

/** The difference between what the request used and what the new selection gives, or null. */
export function classifyResolutionDiff(
  current: ShadowCurrentResolution,
  next: ShadowNewResolution
): ResolutionDiffKind | null {
  if (next.kind === 'failed') return 'new_selection_failed';
  const currentBound = current.tier !== 'none';
  if (!currentBound) return next.kind === 'bound' ? 'current_none_new_bound' : null;
  if (next.kind === 'none') return 'current_bound_new_none';
  if (next.setId !== current.setId) return 'set_differs';
  // The same set. An app's own choice stays one; the tenant's activation is now a default.
  return current.tier === 'explicit' && next.tier === 'client' ? null : 'tier_differs';
}

/** The new selection and read, as the comparison sees them. It does not throw. */
export async function resolveShadowNewResolution(input: {
  env: Partial<Env>;
  tenantId: string;
  clientId: string;
  clientSelector: unknown;
}): Promise<ShadowNewResolution> {
  try {
    const { selection } = await resolveOidcIdentityMappingBinding({
      env: input.env,
      tenantId: input.tenantId,
      clientId: input.clientId,
      clientSelector: input.clientSelector,
    });
    return selection.kind === 'bound'
      ? { kind: 'bound', tier: selection.tier, setId: selection.setId }
      : { kind: 'none', reason: selection.reason };
  } catch (error) {
    if (error instanceof IdentityMappingSelectionError) {
      return { kind: 'failed', code: error.code, ...(error.tier ? { tier: error.tier } : {}) };
    }
    if (error instanceof IdentityMappingResolutionError) {
      return { kind: 'failed', code: error.code, tier: error.tier };
    }
    if (error instanceof RuntimeIdentityMappingOwnerError) {
      return { kind: 'failed', code: 'owner_invalid' };
    }
    return { kind: 'failed', code: 'unexpected_error' };
  }
}

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

export const IDENTITY_MAPPING_RESOLUTION_DIFF_LOG_WINDOW_MS = 60_000;
const MAX_THROTTLE_KEYS = 256;
const OVERFLOW_KEY_SUFFIX = '|overflow';
const COMPONENT = 'OIDC-IDENTITY-MAPPING-SHADOW';

interface ThrottleEntry {
  lastLoggedAt: number;
  suppressed: number;
  /** The shared record for keys that did not fit the table. */
  overflow?: boolean;
}
const throttle = new Map<string, ThrottleEntry>();

/** Forgets what was recorded (tests). */
export function resetIdentityMappingResolutionDiffThrottle(): void {
  throttle.clear();
}

function pruneExpired(now: number): void {
  for (const [key, entry] of throttle) {
    if (entry.overflow) continue;
    const age = now - entry.lastLoggedAt;
    if (age < 0 || age >= IDENTITY_MAPPING_RESOLUTION_DIFF_LOG_WINDOW_MS) throttle.delete(key);
  }
}

export interface LogResolutionDiffInput {
  tenantId: string;
  clientId: string;
  kind: ResolutionDiffKind;
  current: ShadowCurrentResolution;
  next: ShadowNewResolution;
  logger?: Logger;
  /** Overrides the clock (tests). */
  now?: number;
}

/** Records a difference as a warning, unless the same one was recorded within the window. */
export function logResolutionDiff(input: LogResolutionDiffInput): void {
  const now = input.now ?? Date.now();
  let key = [input.tenantId, input.clientId, input.kind].join('|');
  let overflow = false;
  if (!throttle.has(key) && throttle.size >= MAX_THROTTLE_KEYS) {
    pruneExpired(now);
    if (throttle.size >= MAX_THROTTLE_KEYS) {
      // Bounded: a new key that finds the table full shares one record (no tenant or app in it)
      // instead of clearing the table, which would let a cycle of distinct keys be logged on
      // every pass.
      key = `${COMPONENT}${OVERFLOW_KEY_SUFFIX}`;
      overflow = true;
    }
  }
  const entry = throttle.get(key);
  if (
    entry &&
    now - entry.lastLoggedAt >= 0 &&
    now - entry.lastLoggedAt < IDENTITY_MAPPING_RESOLUTION_DIFF_LOG_WINDOW_MS
  ) {
    entry.suppressed += 1;
    return;
  }
  const suppressed = entry?.suppressed ?? 0;
  throttle.set(key, { lastLoggedAt: now, suppressed: 0, ...(overflow ? { overflow: true } : {}) });

  const { current, next } = input;
  const logger = (input.logger ?? createLogger({ tenantId: input.tenantId })).module(COMPONENT);
  logger.warn('Identity mapping selection differs from the one this request used', {
    action: 'identity_mapping_resolution_diff',
    // The record stands for differences of several tenants or apps that did not fit the table.
    ...(overflow ? { throttle_overflow: true } : { clientId: input.clientId }),
    failure_kind: input.kind,
    current_tier: current.tier,
    ...(current.setId ? { current_set_id: current.setId } : {}),
    ...(current.failed ? { current_resolution_failed: true } : {}),
    ...(next.kind === 'bound'
      ? { new_tier: next.tier, new_set_id: next.setId }
      : next.kind === 'none'
        ? { new_tier: 'none', new_none_reason: next.reason }
        : { new_tier: next.tier ?? 'none', new_failure_code: next.code }),
    suppressed_since_last_log: suppressed,
  });
}

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

export interface OidcIdentityMappingShadowCompareInput {
  env: Partial<Env> | undefined;
  tenantId: string;
  clientId: string;
  /** The app's `identity_mapping`, as the request has it. */
  clientSelector: OIDCIdentityMappingFieldMappingSelector | null | undefined;
  current: ShadowCurrentResolution;
  logger?: Logger;
  now?: number;
}

/**
 * How long a failed read of the switch counts as "off" before it is tried again. Without it, a
 * KV that is down (or a platform document that cannot be read) is retried, and warned about by
 * the settings reader, on every OIDC request, even where the comparison was never turned on.
 */
export const IDENTITY_MAPPING_SHADOW_SETTING_FAILURE_TTL_MS = 60_000;

interface SwitchRead {
  /** The read under way, shared by the requests that arrive meanwhile. */
  inflight?: Promise<boolean>;
  /** Until when a failed read stands (the comparison is off). */
  failedUntil?: number;
}
/** Per settings store (the environment's KV), so one isolate's failure is read once. */
let switchReads = new WeakMap<object, SwitchRead>();

/** Forgets what was read of the switch (tests). */
export function resetIdentityMappingShadowCompareSettingCache(): void {
  switchReads = new WeakMap();
}

/**
 * Whether the platform has turned the comparison on. A read that fails counts as off for
 * `IDENTITY_MAPPING_SHADOW_SETTING_FAILURE_TTL_MS` and is not tried again meanwhile; requests that
 * arrive while a read is under way share it. (A read that succeeds is kept by the settings
 * reader itself.)
 */
export async function isIdentityMappingShadowCompareEnabled(
  env: EffectiveSettingsEnv
): Promise<boolean> {
  const key = (env.SETTINGS ?? env) as object;
  let entry = switchReads.get(key);
  if (!entry) {
    entry = {};
    switchReads.set(key, entry);
  }
  if (entry.failedUntil !== undefined && Date.now() < entry.failedUntil) return false;
  if (entry.inflight) return entry.inflight;

  const state = entry;
  const read = (async () => {
    try {
      const { values } = await resolvePlatformSettingsWithSources(env, 'identity-mapping');
      state.failedUntil = undefined;
      return values[IDENTITY_MAPPING_SHADOW_COMPARE_KEY] === true;
    } catch {
      state.failedUntil = Date.now() + IDENTITY_MAPPING_SHADOW_SETTING_FAILURE_TTL_MS;
      return false;
    } finally {
      state.inflight = undefined;
    }
  })();
  state.inflight = read;
  return read;
}

/** Runs the comparison once. It never throws: whatever goes wrong here is not the request's. */
export async function runOidcIdentityMappingShadowCompare(
  input: OidcIdentityMappingShadowCompareInput
): Promise<void> {
  try {
    if (!input.env) return;
    if (!(await isIdentityMappingShadowCompareEnabled(input.env))) return;
    const next = await resolveShadowNewResolution({
      env: input.env,
      tenantId: input.tenantId,
      clientId: input.clientId,
      clientSelector: input.clientSelector,
    });
    const kind = classifyResolutionDiff(input.current, next);
    if (!kind) return;
    logResolutionDiff({
      tenantId: input.tenantId,
      clientId: input.clientId,
      kind,
      current: input.current,
      next,
      logger: input.logger,
      now: input.now,
    });
  } catch {
    // Not the request's failure, and nothing here is worth a message that could name a value.
  }
}

/**
 * Starts the comparison without waiting for it. Through `waitUntil` where the caller has one, so
 * the Worker keeps it alive past the response; otherwise it runs on its own. The caller is never
 * delayed and never sees an error.
 */
export function scheduleOidcIdentityMappingShadowCompare(
  input: OidcIdentityMappingShadowCompareInput & {
    waitUntil?: (promise: Promise<unknown>) => void;
  }
): void {
  try {
    if (!input.env) return;
    const run = runOidcIdentityMappingShadowCompare(input).catch(() => undefined);
    if (input.waitUntil) {
      try {
        input.waitUntil(run);
      } catch {
        // No execution context to hand it to: it runs unattended.
      }
    }
  } catch {
    // Starting the comparison must not be able to fail the request.
  }
}
