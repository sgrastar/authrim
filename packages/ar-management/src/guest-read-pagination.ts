/** Guest inspection cursors retain selection state only; authorization runs on every request. */
import type { Context } from 'hono';
import { getTenantIdFromContext, type Env } from '@authrim/ar-lib-core';
import { guestMapStores, type GuestCoreStore } from './guest-account-storage';
import { compareGuestCleanupKey, guestCleanupInventoryDigest } from './guest-cleanup-cursor';

// Same bounds and lifetime as the existing Guest lifecycle inspection API.
export const GUEST_READ_DEFAULT_LIMIT = 50;
export const GUEST_READ_MAX_LIMIT = 100;
export const GUEST_READ_CURSOR_TTL_SECONDS = 15 * 60;

export function guestReadInteger(value: unknown): number {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0)
    throw new Error('guest_read_storage_invalid');
  return number;
}
export function guestReadNullableInteger(value: unknown): number | null {
  return value === null ? null : guestReadInteger(value);
}
/** Optional login metadata follows the runtime user store's tolerant JSON/finite-number rules. */
export function guestReadLastLoginAt(metadataJson: string | null): number | null {
  if (!metadataJson) return null;
  try {
    const metadata: unknown = JSON.parse(metadataJson);
    if (
      metadata &&
      typeof metadata === 'object' &&
      !Array.isArray(metadata) &&
      'last_login_at' in metadata
    ) {
      const at = metadata.last_login_at;
      return typeof at === 'number' && Number.isFinite(at) ? at : null;
    }
  } catch {
    // Malformed optional metadata is ignored, as in CanonicalRuntimeUserStore.
  }
  return null;
}
interface Key {
  at: number;
  id: string;
}
interface Position {
  version: 1;
  inventoryDigest: string;
  filter: string;
  after: Array<Key | null>;
  observedAt: number;
  expiresAt: number;
}
export class GuestReadCursorError extends Error {}
export function guestReadFailure(c: Context<{ Bindings: Env }>, error: unknown): Response {
  return c.json(
    {
      error:
        error instanceof GuestReadCursorError
          ? 'guest_read_cursor_invalid'
          : 'guest_read_unavailable',
    },
    error instanceof GuestReadCursorError ? 409 : 503
  );
}

/** Each shard returns at most limit+1 rows, merged by time DESC, id ASC, then shard order. */
export async function readGuestPage<T>(
  c: Context<{ Bindings: Env }>,
  stores: readonly GuestCoreStore[],
  input: { kind: 'users' | 'upgrades'; filter: string; limit: number },
  read: (
    store: GuestCoreStore,
    after: Key | null,
    observedAt: number
  ) => Promise<Array<Key & { value: T }>>
): Promise<{ items: T[]; nextCursor: string | null }> {
  if (!stores.length) throw new Error('guest_read_inventory_unavailable');
  const tenantId = getTenantIdFromContext(c);
  const inventoryDigest = await guestCleanupInventoryDigest(stores);
  const now = Math.floor(Date.now() / 1000);
  const config = c.env.AUTHRIM_CONFIG;
  const prefix = `guest-account-read-v1:${tenantId}:${input.kind}:`;
  const token = c.req.query('cursor');
  let position: Position = {
    version: 1,
    inventoryDigest,
    filter: input.filter,
    after: stores.map(() => null),
    observedAt: Date.now(),
    expiresAt: now + GUEST_READ_CURSOR_TTL_SECONDS,
  };
  if (token !== undefined) {
    if (!/^[a-f0-9-]{36}$/u.test(token)) throw new GuestReadCursorError();
    if (!config) throw new Error('guest_read_cursor_store_unavailable');
    const raw = await config.get(prefix + token);
    let saved: Position | null = null;
    try {
      saved = raw ? (JSON.parse(raw) as Position) : null;
    } catch {
      /* Refuse corrupt state. */
    }
    if (
      !saved ||
      saved.version !== 1 ||
      saved.inventoryDigest !== inventoryDigest ||
      saved.filter !== input.filter ||
      !Number.isSafeInteger(saved.expiresAt) ||
      saved.expiresAt <= now ||
      !Number.isSafeInteger(saved.observedAt) ||
      saved.observedAt < 0 ||
      !Array.isArray(saved.after) ||
      saved.after.length !== stores.length ||
      saved.after.some(
        (key) =>
          key !== null &&
          (typeof key !== 'object' ||
            !Number.isSafeInteger(key.at) ||
            key.at < 0 ||
            typeof key.id !== 'string' ||
            !key.id)
      )
    )
      throw new GuestReadCursorError();
    position = saved;
  }
  const pages = await guestMapStores(stores, async (store) => {
    const source = stores.indexOf(store);
    const rows = await read(store, position.after[source], position.observedAt);
    if (rows.length > input.limit + 1) throw new Error('guest_read_page_unbounded');
    return rows.map((row) => ({ ...row, source }));
  });
  const rows = pages
    .flat()
    .sort(
      (left, right) =>
        right.at - left.at ||
        compareGuestCleanupKey(left.id, right.id) ||
        left.source - right.source
    );
  const selected = rows.slice(0, input.limit);
  let nextCursor: string | null = null;
  if (rows.length > input.limit) {
    if (!config) throw new Error('guest_read_cursor_store_unavailable');
    const after = [...position.after];
    for (const row of selected) after[row.source] = { at: row.at, id: row.id };
    nextCursor = crypto.randomUUID();
    await config.put(prefix + nextCursor, JSON.stringify({ ...position, after }), {
      expirationTtl: Math.max(1, position.expiresAt - now),
    });
  }
  return { items: selected.map((row) => row.value), nextCursor };
}
