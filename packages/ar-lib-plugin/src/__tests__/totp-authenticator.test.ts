import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry } from '../core/registry';
import { totpAuthenticatorPlugin, TOTPConfigSchema } from '../builtin/authenticator/totp';
import type { AuthenticatorHandler } from '../core/registry';

const rfcSecretSha1 = '12345678901234567890';
const rfcSecretSha256 = '12345678901234567890123456789012';
const rfcSecretSha512 = '1234567890123456789012345678901234567890123456789012345678901234';
const rfcSecretSha1Base32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function handler(config: Record<string, unknown> = {}): AuthenticatorHandler {
  const registry = new CapabilityRegistry();
  totpAuthenticatorPlugin.register(registry, TOTPConfigSchema.parse(config));
  const registered = registry.getAuthenticator('totp');
  if (!registered) throw new Error('TOTP handler was not registered');
  return registered;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('built-in TOTP authenticator', () => {
  it('creates a setup challenge with an encoded account label and matching secret URI', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const totp = handler({
      issuer: 'Acme & Co',
      algorithm: 'sha256',
      digits: 8,
      period: 60,
      secretLength: 32,
    });

    const result = await totp.startChallenge({
      userId: 'user-a',
      metadata: { setup: true, email: 'a+b@example.test' },
    });
    const challenge = result.challenge as {
      type: string;
      secret: string;
      otpauthUri: string;
      algorithm: string;
      digits: number;
      period: number;
      _secretBytes: number[];
    };
    const uri = new URL(challenge.otpauthUri);

    expect(result.challengeId).toMatch(/^totp_[0-9a-f-]+$/u);
    expect(result.expiresAt).toBe(Date.now() + 5 * 60 * 1000);
    expect(challenge.type).toBe('totp_setup');
    expect(challenge._secretBytes).toHaveLength(32);
    expect(challenge._secretBytes.every((byte) => byte >= 0 && byte <= 255)).toBe(true);
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.pathname).toBe('/Acme%20%26%20Co:a%2Bb%40example.test');
    expect(uri.searchParams.get('secret')).toBe(challenge.secret);
    expect(uri.searchParams.get('issuer')).toBe('Acme & Co');
    expect(uri.searchParams.get('algorithm')).toBe('SHA256');
    expect(uri.searchParams.get('digits')).toBe('8');
    expect(uri.searchParams.get('period')).toBe('60');
  });

  it('keeps the enrollment secret out of an ordinary verification challenge', async () => {
    const totp = handler();
    const result = await totp.startChallenge({ userId: 'user-a' });

    expect(result.challenge).toEqual({ type: 'totp_verify', digits: 6, period: 30 });
    expect(JSON.stringify(result.challenge)).not.toContain('secret');
    await expect(totp.isAvailable?.('user-a')).resolves.toBe(true);
  });

  it.each([
    ['sha1', rfcSecretSha1, '94287082'],
    ['sha256', rfcSecretSha256, '46119246'],
    ['sha512', rfcSecretSha512, '90693936'],
  ] as const)('verifies the RFC 6238 %s vector at 59 seconds', async (algorithm, secret, code) => {
    vi.useFakeTimers();
    vi.setSystemTime(59_000);
    const totp = handler({ algorithm, digits: 8, window: 0 });

    await expect(
      totp.verifyResponse({
        challengeId: 'challenge-a',
        response: { code, secret: Array.from(new TextEncoder().encode(secret)) },
      })
    ).resolves.toEqual({ success: true, credentialId: 'challenge-a' });
  });

  it('accepts a stored Base32 secret and six-digit truncation of the RFC vector', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(59_000);
    const totp = handler({ algorithm: 'sha1', digits: 6, window: 0 });

    await expect(
      totp.verifyResponse({
        challengeId: 'challenge-b',
        response: { code: '287082', storedSecret: ` ${rfcSecretSha1Base32.toLowerCase()}= ` },
      })
    ).resolves.toEqual({ success: true, credentialId: 'challenge-b' });
  });

  it('accepts one adjacent time step only when the configured drift window permits it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(89_000);
    const response = { code: '94287082', secret: rfcSecretSha1Base32 };

    await expect(
      handler({ digits: 8, window: 1 }).verifyResponse({ challengeId: 'c', response })
    ).resolves.toEqual({ success: true, credentialId: 'c' });
    await expect(
      handler({ digits: 8, window: 0 }).verifyResponse({ challengeId: 'c', response })
    ).resolves.toEqual({ success: false, error: 'Invalid TOTP code' });
    vi.setSystemTime(119_000);
    await expect(
      handler({ digits: 8, window: 1 }).verifyResponse({ challengeId: 'c', response })
    ).resolves.toEqual({ success: false, error: 'Invalid TOTP code' });
  });

  it.each([
    [{}, 'Invalid TOTP code format'],
    [{ code: 123456 }, 'Invalid TOTP code format'],
    [{ code: '12345' }, 'TOTP code must be 6 digits'],
    [{ code: '12345x' }, 'TOTP code must be 6 digits'],
    [{ code: '123456' }, 'No TOTP secret available for verification'],
    [{ code: '123456', secret: 123 }, 'Invalid secret format'],
  ])('rejects malformed response %o', async (response, error) => {
    await expect(
      handler().verifyResponse({ challengeId: 'challenge-a', response })
    ).resolves.toEqual({ success: false, error });
  });

  it('rejects an invalid Base32 secret instead of treating it as another account secret', async () => {
    await expect(
      handler().verifyResponse({
        challengeId: 'challenge-a',
        response: { code: '123456', secret: 'BAD!' },
      })
    ).rejects.toThrow('Invalid Base32 character: !');
  });

  it('rejects an incorrect code with the right format and secret', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(59_000);
    await expect(
      handler({ digits: 8, window: 0 }).verifyResponse({
        challengeId: 'challenge-a',
        response: { code: '00000000', secret: rfcSecretSha1Base32 },
      })
    ).resolves.toEqual({ success: false, error: 'Invalid TOTP code' });
  });
});
