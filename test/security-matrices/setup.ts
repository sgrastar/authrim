import { beforeEach, expect } from 'vitest';

const blockedFetch: typeof fetch = async () => {
  throw new Error('Security matrix tests must not access the external network');
};

Object.defineProperty(blockedFetch, 'name', {
  value: 'authrimSecurityMatrixNetworkGuard',
  configurable: false,
});
Object.freeze(blockedFetch);
Object.defineProperty(globalThis, 'fetch', {
  value: blockedFetch,
  writable: false,
  configurable: false,
});

beforeEach(() => {
  expect.hasAssertions();
});
