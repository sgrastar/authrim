import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  didLoginEnabled,
  isAuthenticationMethodUsageEnabled,
  isDidLoginEnabled,
  isSelfRegistrationAvailable,
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

  describe('DID login', () => {
    it('is on only for the boolean true: a string or number in the document is off', () => {
      for (const value of ['true', 'TRUE', ' true ', '1', 'on', 1, {}, [], null]) {
        expect(didLoginEnabled({ 'authentication-methods.did.login_enabled': value })).toBe(false);
      }
    });

    it('is off unless the tenant set it to true', () => {
      expect(didLoginEnabled({})).toBe(false);
      expect(didLoginEnabled({ 'authentication-methods.did.login_enabled': false })).toBe(false);
      expect(didLoginEnabled({ 'authentication-methods.did.login_enabled': 'false' })).toBe(false);
      expect(didLoginEnabled({ 'authentication-methods.did.login_enabled': 'yes' })).toBe(false);
      expect(didLoginEnabled({ 'authentication-methods.did.login_enabled': true })).toBe(true);
    });

    it('is not turned on by the other methods or by their legacy switches', () => {
      expect(
        didLoginEnabled({
          'authentication-methods.passkey.enabled': true,
          'authentication-methods.passkey.login_enabled': true,
          'authentication-methods.email_otp.login_enabled': true,
        })
      ).toBe(false);
    });

    it('reads the tenant document, strictly refusing a damaged one', async () => {
      expect(
        await isDidLoginEnabled(
          envWith(JSON.stringify({ 'authentication-methods.did.login_enabled': true })),
          't1',
          { strict: true }
        )
      ).toBe(true);
      expect(await isDidLoginEnabled(envWith(null), 't1', { strict: true })).toBe(false);
      await expect(
        isDidLoginEnabled(envWith('{not json'), 't1', { strict: true })
      ).rejects.toThrow();
      expect(await isDidLoginEnabled(envWith('{not json'), 't1')).toBe(false);
    });
  });
});

describe('isSelfRegistrationAvailable', () => {
  const available = (settings: Record<string, unknown> | string | null) =>
    isSelfRegistrationAvailable(
      envWith(
        settings === null || typeof settings === 'string' ? settings : JSON.stringify(settings)
      ),
      't1'
    );

  it('is available with nothing set: passkeys are on for sign-up', async () => {
    expect(await available(null)).toBe(true);
  });

  it('is not available once every sign-up method is off', async () => {
    expect(
      await available({
        'authentication-methods.passkey.signup_enabled': false,
        'authentication-methods.email_otp.signup_enabled': false,
        'authentication-methods.totp.signup_enabled': false,
      })
    ).toBe(false);
    expect(await available({ 'authentication-methods.passkey.enabled': false })).toBe(false);
  });

  it.each([
    ['email code', { 'authentication-methods.email_otp.signup_enabled': true }],
    ['email code through its method switch', { 'authentication-methods.email_otp.enabled': true }],
    ['an authenticator app', { 'authentication-methods.totp.signup_enabled': true }],
    [
      'an authenticator app through its method switch',
      { 'authentication-methods.totp.enabled': true },
    ],
  ])('is available with only %s on', async (_label, extra) => {
    expect(await available({ 'authentication-methods.passkey.enabled': false, ...extra })).toBe(
      true
    );
  });

  it('is not turned on by sign-in alone', async () => {
    expect(
      await available({
        'authentication-methods.passkey.enabled': false,
        'authentication-methods.email_otp.login_enabled': true,
        'authentication-methods.totp.login_enabled': true,
      })
    ).toBe(false);
  });

  it.each(['', '   ', '{not json', '[]', 'null'])(
    'is not available when the settings cannot be read (%j)',
    async (document) => {
      expect(await available(document)).toBe(false);
    }
  );

  it('is not available when the settings read fails', async () => {
    const env = {
      SETTINGS: {
        get: async () => {
          throw new Error('kv down');
        },
      },
    } as never;
    expect(await isSelfRegistrationAvailable(env, 't1')).toBe(false);
  });
});
