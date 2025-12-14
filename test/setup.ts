/**
 * Test setup and utilities
 * Configures global variables for Cloudflare Workers environment
 */

import { webcrypto } from 'crypto';
import { vi } from 'vitest';

// Make crypto available globally for tests (Cloudflare Workers compatibility)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(globalThis as any).crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: false,
    configurable: true,
  });
}

// Mock cloudflare:workers module (not available in Node.js test environment)
vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject<Env = unknown> {
    ctx: DurableObjectState;
    env: Env;

    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
