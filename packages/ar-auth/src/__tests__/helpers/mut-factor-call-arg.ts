/** The argument a mock was called with, typed for the assertion that reads it. */
export function callArg<T = Record<string, unknown>>(
  fn: { mock: { calls: unknown[][] } },
  call: number,
  index: number
): T {
  return fn.mock.calls[call]?.[index] as T;
}

/** Base64 of a UTF-8 string (no Buffer in the type environment). */
export function base64(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

/** Hex of bytes. */
export function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
