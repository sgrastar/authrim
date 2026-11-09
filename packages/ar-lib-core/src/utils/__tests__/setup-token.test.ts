import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { base64UrlToArrayBuffer } from '../crypto';
import {
  completeSetup,
  generateSetupToken,
  isSetupDisabled,
  storeSetupToken,
  validateSetupToken,
} from '../setup-token';

function environment() {
  const values = new Map<string, string>();
  const operations: string[] = [];
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const put = vi.fn(async (key: string, value: string) => {
    operations.push(`put:${key}`);
    values.set(key, value);
  });
  const remove = vi.fn(async (key: string) => {
    operations.push(`delete:${key}`);
    values.delete(key);
  });
  const env = { AUTHRIM_CONFIG: { get, put, delete: remove } } as unknown as Env;
  return { env, values, operations, get, put, remove };
}

describe('initial administrator setup token', () => {
  it('generates a unique URL-safe token with 256 bits of random source data', () => {
    const first = generateSetupToken();
    const second = generateSetupToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new Uint8Array(base64UrlToArrayBuffer(first))).toHaveLength(32);
    expect(second).not.toBe(first);
  });

  it('stores the token with a bounded default or explicit KV expiry', async () => {
    const { env, put } = environment();
    await storeSetupToken(env, 'secret-a');
    await storeSetupToken(env, 'secret-b', 120);
    expect(put).toHaveBeenNthCalledWith(1, 'setup:token', 'secret-a', {
      expirationTtl: 3600,
    });
    expect(put).toHaveBeenNthCalledWith(2, 'setup:token', 'secret-b', {
      expirationTtl: 120,
    });
  });

  it('requires a configured KV binding for token creation and completion', async () => {
    await expect(storeSetupToken({} as Env, 'secret')).rejects.toThrow(
      'AUTHRIM_CONFIG KV namespace is not available'
    );
    await expect(completeSetup({} as Env)).rejects.toThrow(
      'AUTHRIM_CONFIG KV namespace is not available'
    );
    expect(await validateSetupToken({} as Env, 'secret')).toEqual({
      valid: false,
      reason: 'no_token',
    });
    expect(await isSetupDisabled({} as Env)).toBe(false);
  });

  it('accepts only the exact stored token while setup is open', async () => {
    const { env, get } = environment();
    await storeSetupToken(env, 'secret-a');
    expect(await validateSetupToken(env, 'secret-a')).toEqual({ valid: true });
    expect(await validateSetupToken(env, 'secret-b')).toEqual({
      valid: false,
      reason: 'invalid_token',
    });
    expect(await validateSetupToken(env, 'secret-a-extra')).toEqual({
      valid: false,
      reason: 'invalid_token',
    });
    expect(get).toHaveBeenCalledWith('setup:completed');
    expect(get).toHaveBeenCalledWith('setup:token');
  });

  it('returns no_token when the stored token has expired or disappeared', async () => {
    const { env, values } = environment();
    await storeSetupToken(env, 'secret-a');
    values.delete('setup:token');
    expect(await validateSetupToken(env, 'secret-a')).toEqual({
      valid: false,
      reason: 'no_token',
    });
  });

  it('permanently closes setup before considering any newly stored token', async () => {
    const { env, operations, get, put, remove, values } = environment();
    await storeSetupToken(env, 'secret-a');
    await completeSetup(env);
    expect(operations.slice(-2)).toEqual(['delete:setup:token', 'put:setup:completed']);
    expect(remove).toHaveBeenCalledExactlyOnceWith('setup:token');
    expect(put).toHaveBeenLastCalledWith('setup:completed', 'true');
    expect(values.get('setup:token')).toBeUndefined();
    expect(await isSetupDisabled(env)).toBe(true);

    values.set('setup:token', 'secret-b');
    get.mockClear();
    expect(await validateSetupToken(env, 'secret-b')).toEqual({
      valid: false,
      reason: 'setup_completed',
    });
    expect(get).toHaveBeenCalledExactlyOnceWith('setup:completed');
  });
});
