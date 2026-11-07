/**
 * Reading a tenant's lite Login UI policy from its LitePolicyStore (one instance per tenant).
 *
 * Without the `LITE_POLICY_STORE` binding no tenant can have switched the lite UI on (a switch
 * commits to the store), so the policy reads as `off`. A store that is bound but cannot be read
 * is an error: the caller decides (a side effect is refused; the Login UI answers 503).
 */
import type { Env } from '../types/env';
import {
  LITE_POLICY_INITIAL_REVISION,
  type LiteMode,
  type LitePolicySnapshot,
} from '../types/login-ui-lite';

/** The policy store is bound but could not be read. */
export class LitePolicyUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('lite_policy_unavailable');
    this.name = 'LitePolicyUnavailableError';
  }
}

export function litePolicyInstanceName(tenantId: string): string {
  return `lite-policy:${tenantId}`;
}

export function getLitePolicyStore(
  env: Pick<Env, 'LITE_POLICY_STORE'>,
  tenantId: string
): DurableObjectStub<import('../durable-objects/LitePolicyStore').LitePolicyStore> | null {
  const namespace = env.LITE_POLICY_STORE;
  if (!namespace) return null;
  return namespace.get(namespace.idFromName(litePolicyInstanceName(tenantId)));
}

/** The policy of a tenant whose store was never written (or is not bound). */
export function initialLitePolicySnapshot(tenantId: string): LitePolicySnapshot {
  return {
    tenantId,
    liteMode: 'off',
    humanVerificationRequired: { login: false, signup: false, reauth: false },
    policyRevision: LITE_POLICY_INITIAL_REVISION,
    generation: 0,
    updatedAt: 0,
  };
}

/** The tenant's authoritative lite policy. Throws {@link LitePolicyUnavailableError}. */
export async function readLitePolicySnapshot(
  env: Pick<Env, 'LITE_POLICY_STORE'>,
  tenantId: string
): Promise<LitePolicySnapshot> {
  const store = getLitePolicyStore(env, tenantId);
  if (!store) return initialLitePolicySnapshot(tenantId);
  try {
    return await store.getSnapshotRpc(tenantId);
  } catch (error) {
    throw new LitePolicyUnavailableError(error);
  }
}

export type LiteModeState = LiteMode | 'unknown';

export function litePolicyMarkerInstanceName(tenantId: string): string {
  return `lite-policy-marker:${tenantId}`;
}

/**
 * The tenant's marker instance: a separate LitePolicyStore object that only remembers whether the
 * tenant was ever switched to lite mode (set before the first switch on, never cleared).
 */
export function getLitePolicyMarkerStore(
  env: Pick<Env, 'LITE_POLICY_STORE'>,
  tenantId: string
): DurableObjectStub<import('../durable-objects/LitePolicyStore').LitePolicyStore> | null {
  const namespace = env.LITE_POLICY_STORE;
  if (!namespace) return null;
  return namespace.get(namespace.idFromName(litePolicyMarkerInstanceName(tenantId)));
}

/**
 * The KV record of a tenant that was ever switched to lite mode (`SETTINGS`, never deleted). It is
 * written before the marker instance, and read only when no LitePolicyStore object can be reached
 * and this isolate remembers nothing of the tenant (see {@link readLiteRuntimeState}).
 */
export function liteEverKvKey(tenantId: string): string {
  return `login_ui_lite_ever:${tenantId}`;
}

// --- The runtime's per-isolate cache -------------------------------------------------------
//
// Every sign-in path asks for the tenant's lite state, so it must not cost a Durable Object round
// trip each time (a DO lives in one region). Per isolate and per policy store namespace:
// - the policy snapshot, for LITE_POLICY_SNAPSHOT_TTL_MS;
// - the marker's answer: "ever lite" for the life of the isolate (the marker is never cleared),
//   "never lite" for LITE_NEVER_LITE_TTL_MS. A tenant that was never lite is answered `off` from
//   that alone, without reading its policy instance.
// Only answers are kept, never a pending read: a promise started by one request is not awaited
// by another (if that request is cancelled, its I/O may never settle). Concurrent requests before
// the first answer each read; that happens once per tenant, isolate and TTL. A read that fails is
// never answered from an older value (an
// older snapshot can carry older human verification requirements; an older "never lite" can
// predate a switch on): the outage path below decides instead.
//
// Evidence only moves one way: a snapshot read as `always`, or a KV record found, sets the cached
// marker to "ever lite", and a fresh snapshot is used before the cached marker is looked at.
//
// The cost is that a change reaches a runtime late, by what each isolate last read:
// - A tenant's first switch to `always`: an isolate that read "never lite" before it keeps
//   answering `off` until that answer expires, at most LITE_NEVER_LITE_TTL_MS (about 30 s) after
//   the first switch. Once an isolate has seen the tenant as ever lite, later switches reach it
//   within LITE_POLICY_SNAPSHOT_TTL_MS (5 s).
// - A switch to `off`: an isolate can apply the lite rules for up to 5 s more (the stricter side).
// - An outage of the whole namespace: a cold isolate goes by the KV record, which can take a
//   minute or more to be seen everywhere after it is first written.
// While an isolate answers `off` late, the normal Login UI's rules apply with the tenant's current
// settings. Human verification of a lite tenant does not use the cached snapshot: the runner reads
// the current policy before it verifies (its requirements must not lag). Anything else that must
// not see a late answer reads the store directly (readLiteModeAuthoritative, the admin routes).

export const LITE_POLICY_SNAPSHOT_TTL_MS = 5_000;
export const LITE_NEVER_LITE_TTL_MS = 30_000;
const LITE_CACHE_MAX_TENANTS = 1_000;

interface CacheEntry<T> {
  value: T;
  readAt: number;
}

interface CachedReads<T> {
  entries: Map<string, CacheEntry<T>>;
}

interface NamespaceCache {
  snapshots: CachedReads<LitePolicySnapshot>;
  markers: CachedReads<boolean>;
  /**
   * Tenants seen as ever lite. Kept apart from the bounded entries and never evicted: forgetting
   * one could turn it back into `off` in an outage. (Only tenants that use lite mode are here.)
   */
  everLite: Set<string>;
  /**
   * The newest policy generation seen per tenant, kept apart from the bounded entries and never
   * evicted (only tenants whose policy was ever committed are here), so a late answer from an
   * earlier commit is never taken for the current policy.
   */
  generations: Map<string, number>;
}

let namespaceCaches = new WeakMap<object, NamespaceCache>();

/** Forgets every cached lite state (tests). */
export function resetLitePolicyRuntimeCache(): void {
  namespaceCaches = new WeakMap();
}

function cacheFor(namespace: object): NamespaceCache {
  let cache = namespaceCaches.get(namespace);
  if (!cache) {
    cache = {
      snapshots: { entries: new Map() },
      markers: { entries: new Map() },
      everLite: new Set(),
      generations: new Map(),
    };
    namespaceCaches.set(namespace, cache);
  }
  return cache;
}

/**
 * Keeps `value`, read from a call started at `readAt` (its TTL counts from then, so a slow answer
 * does not extend it). With `isOlder`, an answer older than the one kept is dropped: answers from
 * separate calls can arrive out of order. Returns what is kept.
 */
function remember<T>(
  entries: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  readAt: number = Date.now(),
  isOlder?: (incoming: T, kept: T) => boolean
): T {
  const kept = entries.get(key);
  if (kept && isOlder?.(value, kept.value)) return kept.value;
  entries.delete(key);
  entries.set(key, { value, readAt: kept ? Math.max(kept.readAt, readAt) : readAt });
  while (entries.size > LITE_CACHE_MAX_TENANTS) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  return value;
}

/**
 * Keeps a snapshot read from a call started at `startedAt`, and returns the policy to act on.
 * Answers from separate calls can arrive out of order: one from an earlier commit than the newest
 * seen (the generation grows with each commit) is not kept; the newer snapshot kept is answered
 * instead, or, when that was evicted, the read counts as failed.
 */
function keepSnapshot(
  cache: NamespaceCache,
  tenantId: string,
  snapshot: LitePolicySnapshot,
  startedAt: number
): LitePolicySnapshot {
  const newest = cache.generations.get(tenantId) ?? 0;
  let current = snapshot;
  if (snapshot.generation < newest) {
    const kept = cache.snapshots.entries.get(tenantId)?.value;
    if (!kept || kept.generation < newest) {
      throw new LitePolicyUnavailableError(new Error('lite_policy_late_answer'));
    }
    current = kept;
  } else {
    if (snapshot.generation > 0) cache.generations.set(tenantId, snapshot.generation);
    remember(cache.snapshots.entries, tenantId, snapshot, startedAt, (incoming, kept) => {
      return incoming.generation < kept.generation;
    });
  }
  if (current.liteMode === 'always') rememberEverLite(cache, tenantId);
  return current;
}

function freshValue<T>(
  reads: CachedReads<T>,
  key: string,
  ttlMs: (value: T) => number
): T | undefined {
  const entry = reads.entries.get(key);
  return entry && Date.now() - entry.readAt < ttlMs(entry.value) ? entry.value : undefined;
}

/** The cached value when still fresh; otherwise a read of the store (a failed read throws). */
async function readThrough<T>(
  reads: CachedReads<T>,
  key: string,
  ttlMs: (value: T) => number,
  load: () => Promise<T>
): Promise<T> {
  const fresh = freshValue(reads, key, ttlMs);
  if (fresh !== undefined) return fresh;
  const startedAt = Date.now();
  return remember(reads.entries, key, await load(), startedAt);
}

/** The marker's answer (cached), or null when it cannot be read and nothing is remembered. */
async function readEverLite(
  env: Pick<Env, 'LITE_POLICY_STORE'>,
  namespace: object,
  tenantId: string
): Promise<boolean | null> {
  const cache = cacheFor(namespace);
  if (cache.everLite.has(tenantId)) return true;
  try {
    const everLite = await readThrough(
      cache.markers,
      tenantId,
      () => LITE_NEVER_LITE_TTL_MS,
      async () => {
        const marker = getLitePolicyMarkerStore(env, tenantId);
        if (!marker) throw new Error('lite_policy_marker_unbound');
        return marker.isEverLiteRpc(tenantId);
      }
    );
    if (everLite) rememberEverLite(cache, tenantId);
    return everLite;
  } catch {
    return null;
  }
}

function rememberEverLite(cache: NamespaceCache, tenantId: string): void {
  cache.everLite.add(tenantId);
  cache.markers.entries.delete(tenantId);
}

/** The KV record of an ever-lite tenant: true, false, or null when it cannot be read. */
async function readEverLiteKv(
  env: Pick<Env, 'SETTINGS'>,
  tenantId: string
): Promise<boolean | null> {
  if (!env.SETTINGS) return null;
  try {
    return (await env.SETTINGS.get(liteEverKvKey(tenantId))) !== null;
  } catch {
    return null;
  }
}

export type LiteRuntimeState = LitePolicySnapshot | 'off' | 'unknown';

/**
 * The tenant's lite state for a runtime: the policy snapshot while it is in lite mode, `off` when
 * it is not, `unknown` when that cannot be told (refused, as a lite tenant would be).
 *
 * - No `LITE_POLICY_STORE` binding: `off` (no tenant can have switched on; a switch commits there).
 * - The marker (cached) says the tenant was never lite: `off`, without reading the policy.
 * - Otherwise the policy snapshot (cached) decides.
 * - The policy cannot be read: `unknown` for a tenant that was ever lite. When the marker could not
 *   be read either (the namespace is down) and nothing is remembered, the KV record decides: no
 *   record is `off`, so tenants that never used lite mode keep working through an outage of the
 *   policy store; a record, or no answer, is `unknown`.
 */
export async function readLiteRuntimeState(
  env: Pick<Env, 'LITE_POLICY_STORE' | 'SETTINGS'>,
  tenantId: string
): Promise<LiteRuntimeState> {
  const namespace = env.LITE_POLICY_STORE;
  if (!namespace) return 'off';
  const cache = cacheFor(namespace);
  const modeOf = (snapshot: LitePolicySnapshot): LiteRuntimeState => {
    // `always` is committed only after the marker: remember the tenant as ever lite.
    if (snapshot.liteMode === 'always') rememberEverLite(cache, tenantId);
    return snapshot.liteMode === 'always' ? snapshot : 'off';
  };
  // A fresh snapshot is newer evidence than a cached "never lite".
  const fresh = freshValue(cache.snapshots, tenantId, () => LITE_POLICY_SNAPSHOT_TTL_MS);
  if (fresh) return modeOf(fresh);

  // A negative answer is checked again after each wait: another request may have learnt meanwhile
  // that the tenant is lite (a positive answer is never overruled by an older negative one).
  const learntMeanwhile = (): LiteRuntimeState | null => {
    const newer = freshValue(cache.snapshots, tenantId, () => LITE_POLICY_SNAPSHOT_TTL_MS);
    if (newer) return modeOf(newer);
    return cache.everLite.has(tenantId) ? 'unknown' : null;
  };

  let everLite = await readEverLite(env, namespace, tenantId);
  if (everLite === false) {
    const meanwhile = learntMeanwhile();
    if (meanwhile === null) return 'off';
    if (meanwhile !== 'unknown') return meanwhile;
    everLite = true;
  }
  try {
    const startedAt = Date.now();
    return modeOf(
      keepSnapshot(cache, tenantId, await readLitePolicySnapshot(env, tenantId), startedAt)
    );
  } catch {
    if (everLite === null) {
      const recorded = await readEverLiteKv(env, tenantId);
      if (recorded === true) rememberEverLite(cache, tenantId);
      if (recorded === false) return learntMeanwhile() ?? 'off';
    }
    return 'unknown';
  }
}

/** The tenant's lite mode for a runtime deciding whether to refuse something. */
export async function readLiteModeState(
  env: Pick<Env, 'LITE_POLICY_STORE' | 'SETTINGS'>,
  tenantId: string
): Promise<LiteModeState> {
  const state = await readLiteRuntimeState(env, tenantId);
  return typeof state === 'string' ? state : state.liteMode;
}

/**
 * The tenant's lite mode, read from the store now (no cache): for an answer that is kept (the
 * authentication methods response). The marker first, so a tenant that was never lite costs one
 * read; then the policy. Throws {@link LitePolicyUnavailableError} when the policy cannot be read.
 */
export async function readLiteModeAuthoritative(
  env: Pick<Env, 'LITE_POLICY_STORE'>,
  tenantId: string
): Promise<LiteMode> {
  if (!env.LITE_POLICY_STORE) return 'off';
  try {
    const marker = getLitePolicyMarkerStore(env, tenantId);
    if (marker && !(await marker.isEverLiteRpc(tenantId))) return 'off';
  } catch {
    // The marker cannot be read: the policy decides.
  }
  return (await readLitePolicySnapshot(env, tenantId)).liteMode;
}

/**
 * The tenant's current policy, read from the store now; the runtime cache is updated with it.
 * For a decision whose inputs must not lag (lite human verification). Throws
 * {@link LitePolicyUnavailableError}.
 */
export async function readCurrentLitePolicySnapshot(
  env: Pick<Env, 'LITE_POLICY_STORE'>,
  tenantId: string
): Promise<LitePolicySnapshot> {
  const startedAt = Date.now();
  const snapshot = await readLitePolicySnapshot(env, tenantId);
  const namespace = env.LITE_POLICY_STORE;
  // A newer snapshot kept meanwhile (a later commit) is what this read answers.
  return namespace ? keepSnapshot(cacheFor(namespace), tenantId, snapshot, startedAt) : snapshot;
}
