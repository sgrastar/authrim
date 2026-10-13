import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import {
  readExternalProviderReauthPolicy,
  readExternalProviderUsagePolicy,
} from '../account-login-methods';

function env(settings: Record<string, unknown> | null | 'invalid'): Pick<Env, 'SETTINGS'> {
  return {
    SETTINGS: {
      get: vi.fn(async () =>
        settings === null ? null : settings === 'invalid' ? '{' : JSON.stringify(settings)
      ),
    } as unknown as KVNamespace,
  };
}

const corp = { providerId: 'provider-a', ids: ['provider-a', 'corp'] };

const usage = (items: unknown) => ({
  'authentication-methods.external_provider_usage': JSON.stringify(items),
});

describe('readExternalProviderReauthPolicy', () => {
  it('keeps re-authentication on, without the weaker evidence, where nothing is saved', async () => {
    const expected = { reauthEnabled: true, acceptWithoutAuthTime: false };
    await expect(readExternalProviderReauthPolicy(env(null), 't', corp)).resolves.toEqual(expected);
    await expect(
      readExternalProviderReauthPolicy(
        env(usage([{ id: 'other', providerId: 'p-other', reauthEnabled: false }])),
        't',
        corp
      )
    ).resolves.toEqual(expected);
  });

  it('reads the entry naming the provider, or an older entry by id', async () => {
    const saved = usage([
      { id: 'saml:idp-1', providerId: 'idp-1', reauthEnabled: false },
      { id: 'corp', reauthEnabled: true, reauthAcceptWithoutAuthTime: true },
    ]);
    await expect(readExternalProviderReauthPolicy(env(saved), 't', corp)).resolves.toEqual({
      reauthEnabled: true,
      acceptWithoutAuthTime: true,
    });
    await expect(
      readExternalProviderReauthPolicy(env(saved), 't', {
        providerId: 'idp-1',
        ids: ['saml:idp-1', 'idp-1'],
      })
    ).resolves.toEqual({ reauthEnabled: false, acceptWithoutAuthTime: false });
  });

  it("never applies another provider's entry that once had the same slug", async () => {
    // Provider A was "corp" and accepted undated logins; B now uses the slug "corp".
    const saved = usage([
      { id: 'corp', providerId: 'provider-a', reauthAcceptWithoutAuthTime: true },
    ]);
    await expect(
      readExternalProviderReauthPolicy(env(saved), 't', {
        providerId: 'provider-b',
        ids: ['provider-b', 'corp'],
      })
    ).resolves.toEqual({ reauthEnabled: true, acceptWithoutAuthTime: false });
  });

  it('throws on unreadable settings rather than allowing a re-authentication', async () => {
    await expect(readExternalProviderReauthPolicy(env('invalid'), 't', corp)).rejects.toThrow();
    await expect(
      readExternalProviderReauthPolicy(
        env({ 'authentication-methods.external_provider_usage': '{"not":"a list"}' }),
        't',
        corp
      )
    ).rejects.toThrow('external_provider_usage_invalid');
    // A setting present but not understood (a switch that is not a boolean) is not allowing.
    await expect(
      readExternalProviderReauthPolicy(
        env(usage([{ id: 'corp', providerId: 'provider-a', reauthEnabled: 'yes' }])),
        't',
        corp
      )
    ).rejects.toThrow('external_provider_usage_invalid');
    // An explicit null is a value not understood, not an unset one.
    await expect(
      readExternalProviderReauthPolicy(
        env(usage([{ id: 'corp', providerId: 'provider-a', reauthEnabled: null }])),
        't',
        corp
      )
    ).rejects.toThrow('external_provider_usage_invalid');
    await expect(
      readExternalProviderReauthPolicy(
        env({ 'authentication-methods.external_provider_usage': null }),
        't',
        corp
      )
    ).rejects.toThrow('external_provider_usage_invalid');
    await expect(
      readExternalProviderReauthPolicy(env(null), 't', { providerId: '', ids: ['corp'] })
    ).rejects.toThrow('external_provider_key_invalid');
  });
});

describe('readExternalProviderUsagePolicy', () => {
  const on = { loginEnabled: true, signupEnabled: true };

  it('keeps sign-in and sign-up on where nothing is saved, as the login screen shows them', async () => {
    await expect(readExternalProviderUsagePolicy(env(null), 't', corp)).resolves.toEqual(on);
    await expect(readExternalProviderUsagePolicy(env({}), 't', corp)).resolves.toEqual(on);
    await expect(readExternalProviderUsagePolicy(env(usage([])), 't', corp)).resolves.toEqual(on);
    // An entry for another provider, and an entry that leaves the switches out, change nothing.
    await expect(
      readExternalProviderUsagePolicy(
        env(
          usage([
            { id: 'other', providerId: 'p-other', loginEnabled: false, signupEnabled: false },
            { id: 'corp', providerId: 'provider-a', reauthEnabled: false },
          ])
        ),
        't',
        corp
      )
    ).resolves.toEqual(on);
    // A blank value is nothing saved (every screen that lists the providers reads it so).
    for (const blank of [null, '', '  ']) {
      await expect(
        readExternalProviderUsagePolicy(
          env({ 'authentication-methods.external_provider_usage': blank }),
          't',
          corp
        )
      ).resolves.toEqual(on);
    }
  });

  it('turns a provider off only where its own entry saves the switch as off', async () => {
    const saved = usage([
      { id: 'corp', providerId: 'provider-a', loginEnabled: false, signupEnabled: true },
      { id: 'saml:idp-1', providerId: 'idp-1', loginEnabled: true, signupEnabled: 'false' },
    ]);
    await expect(readExternalProviderUsagePolicy(env(saved), 't', corp)).resolves.toEqual({
      loginEnabled: false,
      signupEnabled: true,
    });
    await expect(
      readExternalProviderUsagePolicy(env(saved), 't', {
        providerId: 'idp-1',
        ids: ['saml:idp-1', 'idp-1'],
      })
    ).resolves.toEqual({ loginEnabled: true, signupEnabled: false });
    // The usage may be saved as a list rather than as JSON text.
    await expect(
      readExternalProviderUsagePolicy(
        env({
          'authentication-methods.external_provider_usage': [
            { id: 'corp', providerId: 'provider-a', loginEnabled: false },
          ],
        }),
        't',
        corp
      )
    ).resolves.toEqual({ loginEnabled: false, signupEnabled: true });
  });

  it("matches an older entry by id and never applies another provider's entry", async () => {
    const older = usage([{ id: 'corp', loginEnabled: false }]);
    await expect(readExternalProviderUsagePolicy(env(older), 't', corp)).resolves.toEqual({
      loginEnabled: false,
      signupEnabled: true,
    });
    // Provider A was "corp" and was turned off; B now uses the slug "corp".
    const reused = usage([{ id: 'corp', providerId: 'provider-a', loginEnabled: false }]);
    await expect(
      readExternalProviderUsagePolicy(env(reused), 't', {
        providerId: 'provider-b',
        ids: ['provider-b', 'corp'],
      })
    ).resolves.toEqual(on);
  });

  it('throws on settings it cannot read or understand rather than guess', async () => {
    await expect(readExternalProviderUsagePolicy(env('invalid'), 't', corp)).rejects.toThrow();
    await expect(
      readExternalProviderUsagePolicy(
        env({ 'authentication-methods.external_provider_usage': '{"not":"a list"}' }),
        't',
        corp
      )
    ).rejects.toThrow('external_provider_usage_invalid');
    await expect(
      readExternalProviderUsagePolicy(
        env({ 'authentication-methods.external_provider_usage': '[' }),
        't',
        corp
      )
    ).rejects.toThrow();
    for (const bad of ['yes', null, 0]) {
      await expect(
        readExternalProviderUsagePolicy(
          env(usage([{ id: 'corp', providerId: 'provider-a', signupEnabled: bad }])),
          't',
          corp
        )
      ).rejects.toThrow('external_provider_usage_invalid');
    }
    const failing: Pick<Env, 'SETTINGS'> = {
      SETTINGS: {
        get: vi.fn(async () => {
          throw new Error('kv down');
        }),
      } as unknown as KVNamespace,
    };
    await expect(readExternalProviderUsagePolicy(failing, 't', corp)).rejects.toThrow('kv down');
    await expect(
      readExternalProviderUsagePolicy(env(null), 't', { providerId: '', ids: ['corp'] })
    ).rejects.toThrow('external_provider_key_invalid');
  });
});
