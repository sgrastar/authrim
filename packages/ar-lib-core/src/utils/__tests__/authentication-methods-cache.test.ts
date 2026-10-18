import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATION_METHODS_RESPONSE_SHAPE_VERSION,
  bumpAuthenticationMethodsCacheRevision,
  readAuthenticationMethodsCacheRevision,
} from '../authentication-methods-cache';

const PACKAGES = resolve(__dirname, '../../../..');

function readSource(path: string): string {
  return readFileSync(resolve(PACKAGES, path), 'utf8');
}

describe('the shape version of the authentication methods response', () => {
  it('is past 1, the shape before humanVerification reported required and available', () => {
    expect(Number.isInteger(AUTHENTICATION_METHODS_RESPONSE_SHAPE_VERSION)).toBe(true);
    expect(AUTHENTICATION_METHODS_RESPONSE_SHAPE_VERSION).toBeGreaterThanOrEqual(2);
  });

  // The cache key builders are private to their workers, so the keys are checked where they are
  // written: both must carry the shape version, or a deploy that changes the response keeps
  // serving what was cached before it.
  it.each([
    ['the router cache key', 'ar-router/src/index.ts', '/cache/authentication-methods/v3/shape-'],
    [
      'the edge cache key',
      'ar-management/src/authentication-methods.ts',
      '/cache/authentication-methods/v2/shape-',
    ],
  ])('is part of %s', (_name, path, prefix) => {
    const source = readSource(path);
    expect(source).toContain(`${prefix}\${AUTHENTICATION_METHODS_RESPONSE_SHAPE_VERSION}`);
  });
});

describe('the revision of the authentication methods cache', () => {
  function kv() {
    const store = new Map<string, string>();
    return {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    } as unknown as KVNamespace;
  }

  it('moves when a setting is saved, which is not what moves the shape version', async () => {
    const env = { SETTINGS: kv() };
    const before = await readAuthenticationMethodsCacheRevision(env, 'default');
    await bumpAuthenticationMethodsCacheRevision(env, 'default');
    const after = await readAuthenticationMethodsCacheRevision(env, 'default');
    expect(after).not.toBe(before);
  });
});
