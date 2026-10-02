/**
 * A tenant's Settings API values for the generated smoke and load checks: read them, change a
 * few for a check, and put back what was there before (the tenant's own value again, or cleared
 * so it inherits as before).
 */
import { fetchJsonWithTimeout, isRecord, withTenantHeader } from './generated-smoke-common.js';

export interface TenantSettingsSnapshot {
  version: string;
  values: Record<string, unknown>;
  /** 'kv' where the tenant set the value itself. */
  sources: Record<string, string>;
}

export interface TenantSettingsTarget {
  baseUrl: string;
  adminSecret: string;
  tenantId: string;
  category: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 4;

/** A request, retried while it is rate limited (429 with retry_after) up to a few times. */
async function fetchWithRetry(url: string, timeoutMs: number, init: globalThis.RequestInit) {
  let response = await fetchJsonWithTimeout(url, timeoutMs, init);
  for (let attempt = 1; response.status === 429 && attempt < MAX_ATTEMPTS; attempt += 1) {
    const retryAfter =
      isRecord(response.payload) && typeof response.payload.retry_after === 'number'
        ? response.payload.retry_after
        : 0;
    if (retryAfter <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 1000));
    response = await fetchJsonWithTimeout(url, timeoutMs, init);
  }
  return response;
}

export function tenantSettingsPath(tenantId: string, category: string): string {
  return `/api/admin/tenants/${encodeURIComponent(tenantId)}/settings/${encodeURIComponent(category)}`;
}

function headers(target: TenantSettingsTarget): Record<string, string> {
  return withTenantHeader(
    {
      authorization: `Bearer ${target.adminSecret}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    target.tenantId
  );
}

/** The tenant's values for one category. Throws when they cannot be read. */
export async function readTenantSettings(
  target: TenantSettingsTarget
): Promise<TenantSettingsSnapshot> {
  const response = await fetchWithRetry(
    `${target.baseUrl}${tenantSettingsPath(target.tenantId, target.category)}`,
    target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    { headers: headers(target) }
  );
  const payload = response.payload;
  if (
    !response.ok ||
    !isRecord(payload) ||
    typeof payload.version !== 'string' ||
    !isRecord(payload.values) ||
    !isRecord(payload.sources)
  ) {
    throw new Error(
      `settings_read_failed:${target.category}:${response.status}:${response.error ?? response.bodyText ?? ''}`
    );
  }
  return {
    version: payload.version,
    values: payload.values,
    sources: Object.fromEntries(
      Object.entries(payload.sources).map(([key, source]) => [key, String(source)])
    ),
  };
}

/**
 * Set and clear the tenant's values. Throws when the change is not applied in full, and when it
 * is saved but not yet copied to the KV runtime reads (runtime would not see it yet).
 */
export async function patchTenantSettings(
  target: TenantSettingsTarget,
  change: { ifMatch: string; set?: Record<string, unknown>; clear?: string[] }
): Promise<void> {
  const response = await fetchWithRetry(
    `${target.baseUrl}${tenantSettingsPath(target.tenantId, target.category)}`,
    target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    { method: 'PATCH', headers: headers(target), body: JSON.stringify(change) }
  );
  const rejected =
    isRecord(response.payload) && isRecord(response.payload.rejected)
      ? Object.keys(response.payload.rejected)
      : [];
  if (!response.ok || rejected.length > 0) {
    throw new Error(
      `settings_update_failed:${target.category}:${response.status}:${rejected.join(',') || (response.error ?? response.bodyText ?? '')}`
    );
  }
  if (isRecord(response.payload) && response.payload.projection === 'pending') {
    throw new Error(`settings_projection_pending:${target.category}`);
  }
}

/** The change that puts `keys` back as the snapshot had them. */
export function restoreChange(
  snapshot: TenantSettingsSnapshot,
  keys: readonly string[]
): { set: Record<string, unknown>; clear: string[] } {
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  for (const key of keys) {
    if (snapshot.sources[key] === 'kv') set[key] = snapshot.values[key];
    else clear.push(key);
  }
  return { set, clear };
}

/** A temporary change: the values before it, and the values it sets. */
export interface TemporarySettingsChange {
  before: TenantSettingsSnapshot;
  set: Record<string, unknown>;
}

/**
 * Put back the keys that still hold the temporary values (the tenant's own value again, or
 * cleared): a key someone changed meanwhile, or that the change never reached, is left as it is
 * and reported. Throws when the settings cannot be read or saved (including a save that
 * conflicts with one made at the same time).
 */
export async function restoreTenantSettings(
  target: TenantSettingsTarget,
  change: TemporarySettingsChange
): Promise<{ restored: string[]; left: string[] }> {
  const current = await readTenantSettings(target);
  const restored: string[] = [];
  const left: string[] = [];
  for (const [key, value] of Object.entries(change.set)) {
    const ours =
      current.sources[key] === 'kv' &&
      JSON.stringify(current.values[key]) === JSON.stringify(value);
    (ours ? restored : left).push(key);
  }
  if (restored.length > 0) {
    await patchTenantSettings(target, {
      ifMatch: current.version,
      ...restoreChange(change.before, restored),
    });
  }
  return { restored, left };
}

/**
 * How long a saved setting can take to reach runtime: KV propagation and the runtime's settings
 * caches (about a minute each).
 */
export const SETTINGS_APPLY_TIMEOUT_MS = 120_000;
export const SETTINGS_APPLY_POLL_MS = 5_000;

/**
 * Repeat `probe` until it reports the setting in effect, or the time a setting can take to reach
 * runtime has passed. Returns whether it took effect.
 */
export async function waitForSettingsToApply(
  probe: () => Promise<boolean>,
  timeoutMs = SETTINGS_APPLY_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return true;
    if (Date.now() + SETTINGS_APPLY_POLL_MS > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, SETTINGS_APPLY_POLL_MS));
  }
}
