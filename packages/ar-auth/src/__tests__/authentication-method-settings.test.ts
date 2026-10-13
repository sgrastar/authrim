import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  isAuthenticationMethodUsageEnabled,
  readAuthenticationMethodSettings,
} from '../authentication-method-settings';

const KEY = 'settings:tenant:t1:authentication-methods';

function envWith(value: string | null | undefined): Env {
  return { SETTINGS: { get: async (key: string) => (key === KEY ? value : null) } } as never;
}

describe('authentication method settings', () => {
  describe('a document that is not there', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
    ])(
      'reads as nothing set (%s), strict or not: passkeys on, email code off',
      async (_l, value) => {
        for (const strict of [false, true]) {
          const env = envWith(value);
          expect(await readAuthenticationMethodSettings(env, 't1', { strict })).toEqual({});
          expect(
            await isAuthenticationMethodUsageEnabled(env, 't1', 'passkey', 'login', { strict })
          ).toBe(true);
          expect(
            await isAuthenticationMethodUsageEnabled(env, 't1', 'email_otp', 'login', { strict })
          ).toBe(false);
        }
      }
    );

    it('reads as nothing set when the tenant has no SETTINGS binding', async () => {
      const env = {} as Env;
      expect(
        await isAuthenticationMethodUsageEnabled(env, 't1', 'passkey', 'signup', { strict: true })
      ).toBe(true);
    });
  });

  describe('a document that is damaged', () => {
    it.each([
      ['an empty string', ''],
      ['blank', '   \n'],
      ['not JSON', '{not json'],
      ['an array', '[]'],
      ['a number', '7'],
      ['null JSON', 'null'],
    ])('is refused when strict (%s)', async (_l, value) => {
      await expect(
        isAuthenticationMethodUsageEnabled(envWith(value), 't1', 'passkey', 'login', {
          strict: true,
        })
      ).rejects.toThrow();
    });

    it.each([
      ['an empty string', ''],
      ['not JSON', '{not json'],
      ['an array', '[]'],
    ])('keeps reading as the defaults when not strict (%s)', async (_l, value) => {
      const env = envWith(value);
      expect(await isAuthenticationMethodUsageEnabled(env, 't1', 'passkey', 'login')).toBe(true);
      expect(await isAuthenticationMethodUsageEnabled(env, 't1', 'email_otp', 'login')).toBe(false);
    });
  });

  it('a failing read is an error whichever way it is asked', async () => {
    const env = {
      SETTINGS: {
        get: async () => {
          throw new Error('KV down');
        },
      },
    } as never;
    await expect(
      isAuthenticationMethodUsageEnabled(env, 't1', 'passkey', 'login')
    ).rejects.toThrow();
    await expect(
      isAuthenticationMethodUsageEnabled(env, 't1', 'passkey', 'login', { strict: true })
    ).rejects.toThrow();
  });
});
