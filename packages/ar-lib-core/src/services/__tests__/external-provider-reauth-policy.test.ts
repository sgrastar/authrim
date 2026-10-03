import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { readExternalProviderReauthPolicy } from '../account-login-methods';

function env(settings: Record<string, unknown> | null | 'invalid'): Pick<Env, 'SETTINGS'> {
  return {
    SETTINGS: {
      get: vi.fn(async () =>
        settings === null ? null : settings === 'invalid' ? '{' : JSON.stringify(settings)
      ),
    } as unknown as KVNamespace,
  };
}

const usage = (items: unknown) => ({
  'authentication-methods.external_provider_usage': JSON.stringify(items),
});

describe('readExternalProviderReauthPolicy', () => {
  it('keeps re-authentication on, without the weaker evidence, where nothing is saved', async () => {
    const expected = { reauthEnabled: true, acceptWithoutAuthTime: false };
    await expect(readExternalProviderReauthPolicy(env(null), 't', ['corp'])).resolves.toEqual(
      expected
    );
    await expect(
      readExternalProviderReauthPolicy(env(usage([{ id: 'other', reauthEnabled: false }])), 't', [
        'corp',
      ])
    ).resolves.toEqual(expected);
  });

  it('reads the saved entry by its id or provider id', async () => {
    const saved = usage([
      { id: 'saml:idp-1', providerId: 'idp-1', reauthEnabled: false },
      { id: 'corp', reauthEnabled: true, reauthAcceptWithoutAuthTime: true },
    ]);
    await expect(
      readExternalProviderReauthPolicy(env(saved), 't', ['provider-a', 'corp'])
    ).resolves.toEqual({ reauthEnabled: true, acceptWithoutAuthTime: true });
    await expect(readExternalProviderReauthPolicy(env(saved), 't', ['idp-1'])).resolves.toEqual({
      reauthEnabled: false,
      acceptWithoutAuthTime: false,
    });
  });

  it('throws on unreadable settings rather than allowing a re-authentication', async () => {
    await expect(readExternalProviderReauthPolicy(env('invalid'), 't', ['corp'])).rejects.toThrow();
    await expect(
      readExternalProviderReauthPolicy(
        env({ 'authentication-methods.external_provider_usage': '{"not":"a list"}' }),
        't',
        ['corp']
      )
    ).rejects.toThrow('external_provider_usage_invalid');
  });
});
