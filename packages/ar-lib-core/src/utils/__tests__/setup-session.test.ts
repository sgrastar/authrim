import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { createSetupSession, deleteSetupSession, validateSetupSession } from '../setup-session';

function environment() {
  const values = new Map<string, string>();
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const put = vi.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  const remove = vi.fn(async (key: string) => {
    values.delete(key);
  });
  const env = { AUTHRIM_CONFIG: { get, put, delete: remove } } as unknown as Env;
  return { env, values, get, put, remove };
}

afterEach(() => vi.restoreAllMocks());

describe('temporary administrator setup session', () => {
  it('stores an opaque token with the passkey-only purpose, creation time, and short TTL', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const { env, get, put } = environment();

    const token = await createSetupSession(env, {
      userId: 'admin-1',
      email: 'admin@example.test',
      name: 'Administrator',
      setupTokenId: 'token-1',
    });

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(put).toHaveBeenCalledExactlyOnceWith(
      `setup:session:${token}`,
      JSON.stringify({
        userId: 'admin-1',
        email: 'admin@example.test',
        name: 'Administrator',
        setupTokenId: 'token-1',
        createdAt: 1_700_000_000_000,
        purpose: 'passkey_registration',
      }),
      { expirationTtl: 300 }
    );
    expect(await validateSetupSession(env, token)).toEqual({
      valid: true,
      data: {
        userId: 'admin-1',
        email: 'admin@example.test',
        name: 'Administrator',
        setupTokenId: 'token-1',
        createdAt: 1_700_000_000_000,
        purpose: 'passkey_registration',
      },
    });
    expect(get).toHaveBeenCalledWith(`setup:session:${token}`);
  });

  it('honors an explicit shorter TTL and deletes only the matching session', async () => {
    const { env, values, put, remove } = environment();
    const first = await createSetupSession(env, { userId: 'admin-1', email: 'a@example.test' }, 60);
    const second = await createSetupSession(env, { userId: 'admin-2', email: 'b@example.test' });
    expect(first).not.toBe(second);
    expect(put).toHaveBeenNthCalledWith(1, `setup:session:${first}`, expect.any(String), {
      expirationTtl: 60,
    });

    await deleteSetupSession(env, first);
    expect(remove).toHaveBeenCalledExactlyOnceWith(`setup:session:${first}`);
    expect(values.has(`setup:session:${first}`)).toBe(false);
    expect(values.has(`setup:session:${second}`)).toBe(true);
  });

  it('fails closed for absent or corrupt KV data', async () => {
    const { env, values } = environment();
    expect(await validateSetupSession(env, 'missing')).toEqual({
      valid: false,
      reason: 'no_session',
    });
    values.set('setup:session:bad', '{bad-json');
    expect(await validateSetupSession(env, 'bad')).toEqual({
      valid: false,
      reason: 'invalid',
    });
  });

  it('handles a missing KV binding without creating or deleting session state', async () => {
    await expect(
      createSetupSession({} as Env, { userId: 'admin-1', email: 'a@example.test' })
    ).rejects.toThrow('AUTHRIM_CONFIG KV namespace is not available');
    expect(await validateSetupSession({} as Env, 'token')).toEqual({
      valid: false,
      reason: 'no_session',
    });
    await expect(deleteSetupSession({} as Env, 'token')).resolves.toBeUndefined();
  });
});
