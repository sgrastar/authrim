/**
 * Deterministic clock for security matrix tests.
 *
 * Production code reads `Date.now()` and `crypto.randomUUID()`; security matrix tests pin the
 * wall clock so expiry boundaries and token lifespans are fully deterministic. The clock is
 * process-wide, so it must be installed and restored per test.
 */

let frozenNow: number | null = null;
const originalDateNow = Date.now;

export function installFrozenNow(epochMs: number): void {
  frozenNow = epochMs;
  Date.now = () => frozenNow as number;
}

export function restoreRealClock(): void {
  frozenNow = null;
  Date.now = originalDateNow;
}

export function frozenNowMs(): number {
  if (frozenNow === null) {
    throw new Error('deterministic clock is not installed');
  }
  return frozenNow;
}

export function frozenNowEpochSeconds(): number {
  return Math.floor(frozenNowMs() / 1000);
}

export function advanceFrozenClockByMs(ms: number): void {
  if (frozenNow === null) {
    throw new Error('deterministic clock is not installed');
  }
  frozenNow += ms;
}

/**
 * Deterministic UUID v4 using Math.random replacement. Production code uses
 * `crypto.randomUUID()` directly, so this is only usable by test-local fakes
 * that need stable identifiers.
 */
export function deterministicUuid(seed: number): string {
  const bytes = new Uint8Array(16);
  let state = seed >>> 0;
  for (let index = 0; index < 16; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[index] = state & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
