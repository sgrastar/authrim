import type { GuestCoreStore } from './guest-account-storage';
export interface GuestCleanupCursor {
  version: 1;
  tenantId: string;
  inventoryDigest: string;
  phase: 'pending' | 'expired';
  at: number;
  id: string;
  source: number;
}
/** Selection only: no physical IDs, binding names, authorization, secret or retention state. */
export function encodeGuestCleanupCursor(cursor: GuestCleanupCursor): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(cursor))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}
export function decodeGuestCleanupCursor(
  value: unknown,
  tenantId: string,
  inventoryDigest: string
): GuestCleanupCursor | null {
  if (value === undefined || value === null) return null;
  const invalid = (): never => {
    throw new Error('guest_cleanup_cursor_invalid');
  };
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2048 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  )
    return invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) =>
          character.charCodeAt(0)
        )
      )
    );
  } catch {
    return invalid();
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !== 'at,id,inventoryDigest,phase,source,tenantId,version'
  )
    return invalid();
  if (
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('tenantId' in parsed) ||
    parsed.tenantId !== tenantId ||
    !('inventoryDigest' in parsed) ||
    parsed.inventoryDigest !== inventoryDigest ||
    !('phase' in parsed) ||
    (parsed.phase !== 'pending' && parsed.phase !== 'expired') ||
    !('at' in parsed) ||
    typeof parsed.at !== 'number' ||
    !Number.isSafeInteger(parsed.at) ||
    parsed.at < 0 ||
    !('id' in parsed) ||
    typeof parsed.id !== 'string' ||
    !parsed.id ||
    new TextEncoder().encode(parsed.id).length > 256 ||
    !('source' in parsed) ||
    typeof parsed.source !== 'number' ||
    !Number.isSafeInteger(parsed.source) ||
    parsed.source < 0 ||
    parsed.source >= 32
  )
    return invalid();
  return {
    version: 1,
    tenantId,
    inventoryDigest,
    phase: parsed.phase,
    at: parsed.at,
    id: parsed.id,
    source: parsed.source,
  };
}
/** Match SQLite/PostgreSQL byte ordering of generated text keys, including non-ASCII legacy IDs. */
export function compareGuestCleanupKey(left: string, right: string): number {
  const a = new TextEncoder().encode(left),
    b = new TextEncoder().encode(right);
  for (let n = 0; n < Math.min(a.length, b.length); n++) if (a[n] !== b[n]) return a[n] - b[n];
  return a.length - b.length;
}
export async function guestCleanupInventoryDigest(
  stores: readonly GuestCoreStore[]
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify(stores.map((store) => store.pin ?? { legacyBindingRef: store.bindingRef }))
    )
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
