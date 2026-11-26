import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry } from '../core/registry';
import type { AuthenticatorHandler } from '../core/registry';
import { totpAuthenticatorPlugin, TOTPConfigSchema } from '../builtin/authenticator/totp';

const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function handler(config: Record<string, unknown> = {}): AuthenticatorHandler {
  const registry = new CapabilityRegistry();
  totpAuthenticatorPlugin.register(registry, TOTPConfigSchema.parse(config));
  const registered = registry.getAuthenticator('totp');
  if (!registered) throw new Error('TOTP handler was not registered');
  return registered;
}

/** Makes crypto.getRandomValues fill the buffer with 1, 2, 3, ... */
function fixedRandomBytes() {
  return vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
    for (let i = 0; i < array.length; i += 1) array[i] = i + 1;
    return array;
  }) as unknown as typeof crypto.getRandomValues);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('TOTP plugin metadata', () => {
  it('describes the official plugin', () => {
    expect(totpAuthenticatorPlugin.id).toBe('authenticator-totp');
    expect(totpAuthenticatorPlugin.version).toBe('1.0.0');
    expect(totpAuthenticatorPlugin.official).toBe(true);
    expect(totpAuthenticatorPlugin.capabilities).toEqual(['authenticator.totp']);
    expect(totpAuthenticatorPlugin.meta).toMatchObject({
      name: 'TOTP Authenticator',
      category: 'authentication',
      author: { name: 'Authrim', url: 'https://authrim.com' },
      license: 'MIT',
      icon: 'shield-check',
      tags: ['totp', 'otp', '2fa', 'mfa', 'authenticator', 'google-authenticator'],
      documentationUrl: 'https://datatracker.ietf.org/doc/html/rfc6238',
      repositoryUrl: 'https://github.com/sgrastar/authrim',
      minAuthrimVersion: '1.0.0',
      stability: 'stable',
    });
  });

  it('gives the administrator trimmed notes on its settings', () => {
    expect(totpAuthenticatorPlugin.meta.adminNotes).toBe(
      [
        '## Configuration Tips',
        '- algorithm: Google Authenticator only supports sha1. Microsoft Authenticator also supports sha256',
        '- period: Setting to 60 seconds or more allows more time for code entry, but reduces security',
        '- window: Setting to 2 or more improves tolerance for clock skew, but increases replay attack risk',
        '',
        '## Known Limitations',
        '- QR code generation must be done client-side (returns otpauth:// URI)',
      ].join('\n')
    );
  });

  it('is always healthy', async () => {
    await expect(totpAuthenticatorPlugin.healthCheck?.({} as never, {} as never)).resolves.toEqual({
      status: 'healthy',
      message: 'TOTP authenticator is ready',
    });
  });
});

describe('TOTP code validation', () => {
  it.each([[null], [undefined]])(
    'answers a missing response (%s) as a format error',
    async (response) => {
      await expect(
        handler().verifyResponse({ challengeId: 'c', response: response as never })
      ).resolves.toEqual({ success: false, error: 'Invalid TOTP code format' });
    }
  );

  it.each([
    [6, '1234567'],
    [6, 'x123456'],
    [6, '123456x'],
    [8, '123456789'],
    [8, 'x12345678'],
    [8, '12345678x'],
    [8, '123456'],
    [6, '12345678'],
  ])('requires exactly %s digits, not %s', async (digits, code) => {
    await expect(
      handler({ digits }).verifyResponse({
        challengeId: 'c',
        response: { code, secret: RFC_SECRET_BASE32 },
      })
    ).resolves.toEqual({ success: false, error: `TOTP code must be ${digits} digits` });
  });

  it('keeps leading zeros of an eight-digit code (RFC 6238 vector at 1111111109)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_111_111_109_000);
    await expect(
      handler({ digits: 8, window: 0 }).verifyResponse({
        challengeId: 'c',
        response: { code: '07081804', secret: RFC_SECRET_BASE32 },
      })
    ).resolves.toEqual({ success: true, credentialId: 'c' });
  });
});

describe('TOTP setup secret', () => {
  async function setup(secretLength: number) {
    const spy = fixedRandomBytes();
    const result = await handler({ secretLength }).startChallenge({
      userId: 'user-a',
      metadata: { setup: true },
    });
    const challenge = result.challenge as { secret: string; _secretBytes: number[] };
    return { spy, challenge };
  }

  it('draws the secret from the secure random source', async () => {
    const { spy, challenge } = await setup(20);
    expect(spy).toHaveBeenCalledTimes(1);
    const [buffer] = spy.mock.calls[0] ?? [];
    expect((buffer as Uint8Array).length).toBe(20);
    expect(challenge._secretBytes).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('encodes a secret that fills whole Base32 groups', async () => {
    const { challenge } = await setup(20);
    expect(challenge.secret).toBe('AEBAGBAFAYDQQCIKBMGA2DQPCAIREEYU');
  });

  it('encodes the leftover bits of a secret that does not fill the last group', async () => {
    expect((await setup(16)).challenge.secret).toBe('AEBAGBAFAYDQQCIKBMGA2DQPCA');
    expect((await setup(17)).challenge.secret).toBe('AEBAGBAFAYDQQCIKBMGA2DQPCAIQ');
  });

  it('labels the account with the user id when no email is given', async () => {
    fixedRandomBytes();
    const result = await handler({ issuer: 'Acme' }).startChallenge({
      userId: 'user a',
      metadata: { setup: true },
    });
    const uri = (result.challenge as { otpauthUri: string }).otpauthUri;
    expect(uri.startsWith('otpauth://totp/Acme:user%20a?')).toBe(true);
  });
});
