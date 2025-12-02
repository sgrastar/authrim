/**
 * op-auth specific test setup
 * Configures global variables for Cloudflare Workers environment
 */

import { webcrypto } from 'crypto';

// Make crypto available globally for tests (Cloudflare Workers compatibility)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(globalThis as any).crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}

// Note: WebAuthn mocks (@simplewebauthn/server and @simplewebauthn/server/helpers)
// are defined locally in passkey.test.ts to ensure proper mock hoisting
