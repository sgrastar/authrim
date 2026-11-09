import { describe, expect, it } from 'vitest';
import type { GuestCoreStore } from '../guest-account-storage';
import {
  compareGuestCleanupKey,
  decodeGuestCleanupCursor,
  encodeGuestCleanupCursor,
  guestCleanupInventoryDigest,
  type GuestCleanupCursor,
} from '../guest-cleanup-cursor';

const cursor: GuestCleanupCursor = {
  version: 1,
  tenantId: 'tenant-a',
  inventoryDigest: 'a'.repeat(64),
  phase: 'pending',
  at: 1_700_000_000_000,
  id: 'guest-1',
  source: 2,
};

function encoded(value: unknown): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

describe('guest cleanup cursor', () => {
  it('round trips a bounded selection without storing physical database references', () => {
    const token = encodeGuestCleanupCursor(cursor);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeGuestCleanupCursor(token, 'tenant-a', cursor.inventoryDigest)).toEqual(cursor);
    expect(token).not.toContain('binding');
  });

  it('treats an absent cursor as a fresh scan', () => {
    expect(decodeGuestCleanupCursor(null, 'tenant-a', cursor.inventoryDigest)).toBeNull();
    expect(decodeGuestCleanupCursor(undefined, 'tenant-a', cursor.inventoryDigest)).toBeNull();
  });

  it('rejects a cursor replayed into another tenant or physical store inventory', () => {
    const token = encodeGuestCleanupCursor(cursor);
    expect(() => decodeGuestCleanupCursor(token, 'tenant-b', cursor.inventoryDigest)).toThrow(
      'guest_cleanup_cursor_invalid'
    );
    expect(() => decodeGuestCleanupCursor(token, 'tenant-a', 'b'.repeat(64))).toThrow(
      'guest_cleanup_cursor_invalid'
    );
  });

  it.each([
    '',
    '%%%invalid-base64',
    'A'.repeat(2049),
    encoded([]),
    encoded({ ...cursor, extra: 'untrusted' }),
    encoded({ ...cursor, version: 2 }),
    encoded({ ...cursor, phase: 'other' }),
    encoded({ ...cursor, at: -1 }),
    encoded({ ...cursor, at: Number.MAX_SAFE_INTEGER + 1 }),
    encoded({ ...cursor, id: '' }),
    encoded({ ...cursor, id: '界'.repeat(86) }),
    encoded({ ...cursor, source: 32 }),
    encoded({ ...cursor, source: 1.5 }),
  ])('rejects malformed or out-of-bound cursor data: %s', (value) => {
    expect(() => decodeGuestCleanupCursor(value, 'tenant-a', cursor.inventoryDigest)).toThrow(
      'guest_cleanup_cursor_invalid'
    );
  });

  it('uses UTF-8 byte order for non-ASCII legacy IDs', () => {
    expect(compareGuestCleanupKey('abc', 'abcd')).toBeLessThan(0);
    expect(compareGuestCleanupKey('é', 'z')).toBeGreaterThan(0);
    expect(compareGuestCleanupKey('same', 'same')).toBe(0);
  });

  it('binds the digest to ordered physical pins and uses binding refs for legacy stores', async () => {
    const storeA = {
      bindingRef: 'DB_A',
      pin: { databaseId: 'db-a', assignmentGeneration: 1 },
    } as GuestCoreStore;
    const storeB = { bindingRef: 'DB_B', pin: null } as GuestCoreStore;
    const first = await guestCleanupInventoryDigest([storeA, storeB]);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(await guestCleanupInventoryDigest([storeA, storeB])).toBe(first);
    expect(await guestCleanupInventoryDigest([storeB, storeA])).not.toBe(first);
    expect(
      await guestCleanupInventoryDigest([storeA, { ...storeB, bindingRef: 'DB_OTHER' }])
    ).not.toBe(first);
    expect(
      await guestCleanupInventoryDigest([{ ...storeA, bindingRef: 'REBOUND_TO_SAME_PIN' }, storeB])
    ).toBe(first);
  });
});
