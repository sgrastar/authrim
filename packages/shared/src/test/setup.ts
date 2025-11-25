/**
 * Test setup and utilities
 * Configures global variables for Cloudflare Workers environment
 */

import { webcrypto } from 'crypto';

// Make crypto available globally for tests (Cloudflare Workers compatibility)
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}
