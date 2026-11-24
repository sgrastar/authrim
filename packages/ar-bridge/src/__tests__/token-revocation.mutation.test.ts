/**
 * RFC 7009 revocation of a linked identity's provider tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { LinkedIdentity, UpstreamProvider } from '../types';
import { argRec, callArg } from './helpers/mock-args';

const mocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  safeFetchJson: vi.fn(),
  readText: vi.fn(),
  getProvider: vi.fn(),
  decryptTokens: vi.fn(),
  decrypt: vi.fn(),
  getKey: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => ({
  createLogger: () => ({
    module: () => ({ warn: mocks.warn, info: mocks.info, error: mocks.error }),
  }),
  safeFetch: mocks.safeFetch,
  safeFetchJson: mocks.safeFetchJson,
  readResponseTextWithLimit: mocks.readText,
}));
vi.mock('../services/provider-store', () => ({ getProvider: mocks.getProvider }));
vi.mock('../services/linked-identity-store', () => ({
  decryptLinkedIdentityTokens: mocks.decryptTokens,
}));
vi.mock('../utils/crypto', () => ({
  decrypt: mocks.decrypt,
  getEncryptionKeyOrUndefined: mocks.getKey,
}));

import { revokeLinkedIdentityTokens } from '../services/token-revocation';

const ENV = {} as Env;
const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
const identity = { tenantId: 't1', providerId: 'p1' } as unknown as LinkedIdentity;
const provider = (overrides: Partial<UpstreamProvider> = {}): UpstreamProvider =>
  ({
    id: 'p1',
    name: 'Corp',
    clientId: 'client-1',
    clientSecretEncrypted: 'enc-secret',
    providerQuirks: { revocationEndpoint: 'https://idp.example/revoke' },
    ...overrides,
  }) as unknown as UpstreamProvider;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  mocks.getProvider.mockResolvedValue(provider());
  mocks.decryptTokens.mockResolvedValue({ accessToken: 'at-1', refreshToken: 'rt-1' });
  mocks.getKey.mockReturnValue('key');
  mocks.decrypt.mockResolvedValue('client-secret');
  mocks.safeFetch.mockImplementation(async () => new Response(null, { status: 200 }));
  mocks.readText.mockImplementation(async (response: Response) => response.text());
});
afterEach(() => vi.useRealTimers());

const form = (call: number) => new URLSearchParams(String(argRec(mocks.safeFetch, call, 1).body));

describe('revocation request', () => {
  it('revokes the access then the refresh token, each with client authentication', async () => {
    expect(await revokeLinkedIdentityTokens(ENV, identity)).toEqual({
      success: true,
      accessTokenRevoked: true,
      refreshTokenRevoked: true,
      errors: [],
    });
    expect(mocks.getProvider).toHaveBeenCalledWith(ENV, 't1', 'p1');
    expect(mocks.decryptTokens).toHaveBeenCalledWith(ENV, identity);
    expect(mocks.decrypt).toHaveBeenCalledWith('enc-secret', 'key');
    expect(mocks.safeFetch).toHaveBeenCalledTimes(2);
    for (const call of [0, 1]) {
      expect(callArg(mocks.safeFetch, call, 0)).toBe('https://idp.example/revoke');
      const options = argRec(mocks.safeFetch, call, 1);
      expect(options).toMatchObject({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeoutMs: 10000,
        maxResponseSize: 16 * 1024,
      });
    }
    expect(Object.fromEntries(form(0))).toEqual({
      token: 'at-1',
      token_type_hint: 'access_token',
      client_id: 'client-1',
      client_secret: 'client-secret',
    });
    expect(Object.fromEntries(form(1))).toEqual({
      token: 'rt-1',
      token_type_hint: 'refresh_token',
      client_id: 'client-1',
      client_secret: 'client-secret',
    });
    expect(mocks.info).toHaveBeenCalledWith('Token revocation completed', {
      accessTokenRevoked: true,
      refreshTokenRevoked: true,
    });
  });

  it('revokes only the tokens that exist', async () => {
    mocks.decryptTokens.mockResolvedValue({ accessToken: null, refreshToken: 'rt-1' });
    expect(await revokeLinkedIdentityTokens(ENV, identity)).toEqual({
      success: true,
      accessTokenRevoked: false,
      refreshTokenRevoked: true,
      errors: [],
    });
    expect(mocks.safeFetch).toHaveBeenCalledTimes(1);
    expect(form(0).get('token_type_hint')).toBe('refresh_token');
    mocks.safeFetch.mockClear();
    mocks.decryptTokens.mockResolvedValue({ accessToken: 'at-1', refreshToken: null });
    expect(await revokeLinkedIdentityTokens(ENV, identity)).toMatchObject({
      accessTokenRevoked: true,
      refreshTokenRevoked: false,
      success: true,
    });
    expect(mocks.safeFetch).toHaveBeenCalledTimes(1);
  });

  it('succeeds with nothing to revoke, calling no provider', async () => {
    mocks.decryptTokens.mockResolvedValue({ accessToken: null, refreshToken: null });
    expect(await revokeLinkedIdentityTokens(ENV, identity)).toEqual({
      success: true,
      accessTokenRevoked: false,
      refreshTokenRevoked: false,
      errors: [],
    });
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledTimes(1);
  });

  it('succeeds when one token revokes and reports the other failure', async () => {
    mocks.safeFetch
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response('{"error":"invalid_token"}', { status: 400 }));
    expect(await revokeLinkedIdentityTokens(ENV, identity)).toEqual({
      success: true,
      accessTokenRevoked: true,
      refreshTokenRevoked: false,
      errors: ['Refresh token: invalid_token'],
    });
    expect(mocks.warn).toHaveBeenCalledWith('Token revocation failed', { status: 400 });
  });

  it('fails when neither token revokes, naming only safe error codes', async () => {
    mocks.safeFetch
      .mockResolvedValueOnce(
        new Response('{"error":"unsupported_token_type","error_description":"secret"}', {
          status: 400,
        })
      )
      .mockResolvedValueOnce(new Response('not json', { status: 503 }));
    const result = await revokeLinkedIdentityTokens(ENV, identity);
    expect(result).toEqual({
      success: false,
      accessTokenRevoked: false,
      refreshTokenRevoked: false,
      errors: ['Access token: unsupported_token_type', 'Refresh token: HTTP 503'],
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('falls back to the HTTP status when the error body has no error code', async () => {
    mocks.safeFetch.mockImplementation(async () => new Response('{"other":1}', { status: 500 }));
    expect((await revokeLinkedIdentityTokens(ENV, identity)).errors).toEqual([
      'Access token: HTTP 500',
      'Refresh token: HTTP 500',
    ]);
  });

  it('hides a network failure behind a generic message', async () => {
    mocks.safeFetch.mockRejectedValue(new TypeError('connect ECONNREFUSED 10.0.0.1'));
    const result = await revokeLinkedIdentityTokens(ENV, identity);
    expect(result.errors).toEqual([
      'Access token: Request failed',
      'Refresh token: Request failed',
    ]);
    expect(mocks.error).toHaveBeenCalledWith('Token revocation request error', {
      errorName: 'TypeError',
    });
    mocks.safeFetch.mockRejectedValue('text');
    await revokeLinkedIdentityTokens(ENV, identity);
    expect(mocks.error).toHaveBeenLastCalledWith('Token revocation request error', {
      errorName: 'UnknownError',
    });
  });
});

describe('prerequisites', () => {
  it('reports an unknown provider without naming it', async () => {
    mocks.getProvider.mockResolvedValue(null);
    expect(await revokeLinkedIdentityTokens(ENV, identity)).toEqual({
      success: false,
      accessTokenRevoked: false,
      refreshTokenRevoked: false,
      errors: ['Provider not found'],
    });
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('reports a missing encryption key after decrypting the stored tokens', async () => {
    mocks.getKey.mockReturnValue(undefined);
    expect(await revokeLinkedIdentityTokens(ENV, identity)).toEqual({
      success: false,
      accessTokenRevoked: false,
      refreshTokenRevoked: false,
      errors: ['Encryption key not configured'],
    });
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('turns any internal failure into a generic error', async () => {
    mocks.decryptTokens.mockRejectedValue(new RangeError('bad key at /secret/path'));
    const result = await revokeLinkedIdentityTokens(ENV, identity);
    expect(result).toEqual({
      success: false,
      accessTokenRevoked: false,
      refreshTokenRevoked: false,
      errors: ['Token revocation failed'],
    });
    expect(mocks.error).toHaveBeenCalledWith('Token revocation error', { errorName: 'RangeError' });
    mocks.decryptTokens.mockRejectedValue('text');
    await revokeLinkedIdentityTokens(ENV, identity);
    expect(mocks.error).toHaveBeenLastCalledWith('Token revocation error', {
      errorName: 'Unknown error',
    });
  });
});

describe('finding the revocation endpoint', () => {
  const discovery = (issuer: string) =>
    `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;

  it('prefers the configured endpoint without discovery', async () => {
    await revokeLinkedIdentityTokens(ENV, identity);
    expect(mocks.safeFetchJson).not.toHaveBeenCalled();
  });

  it('uses the discovery document of the issuer, trimming a trailing slash', async () => {
    mocks.getProvider.mockResolvedValue(
      provider({ providerQuirks: {}, issuer: 'https://op.example/' })
    );
    mocks.safeFetchJson.mockResolvedValue({ revocation_endpoint: 'https://op.example/rev' });
    await revokeLinkedIdentityTokens(ENV, identity);
    expect(mocks.safeFetchJson).toHaveBeenCalledWith(discovery('https://op.example/'), {
      timeoutMs: 5000,
      maxResponseSize: 64 * 1024,
    });
    expect(callArg(mocks.safeFetch, 0, 0)).toBe('https://op.example/rev');
  });

  it('treats an issuer without a revocation endpoint as not supporting revocation', async () => {
    mocks.getProvider.mockResolvedValue(
      provider({ providerQuirks: {}, issuer: 'https://op.example' })
    );
    mocks.safeFetchJson.mockResolvedValue({});
    expect(await revokeLinkedIdentityTokens(ENV, identity)).toEqual({
      success: true,
      accessTokenRevoked: false,
      refreshTokenRevoked: false,
      errors: [],
    });
    expect(mocks.safeFetch).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith('Provider does not support token revocation', {
      provider: 'Corp',
    });
  });

  it('falls back to the known Google endpoint when discovery fails or has none', async () => {
    mocks.getProvider.mockResolvedValue(
      provider({ providerQuirks: {}, issuer: 'https://accounts.google.com' })
    );
    mocks.safeFetchJson.mockRejectedValue(new Error('offline'));
    await revokeLinkedIdentityTokens(ENV, identity);
    expect(callArg(mocks.safeFetch, 0, 0)).toBe('https://oauth2.googleapis.com/revoke');
    mocks.safeFetch.mockClear();
    mocks.safeFetchJson.mockResolvedValue({});
    await revokeLinkedIdentityTokens(ENV, identity);
    expect(callArg(mocks.safeFetch, 0, 0)).toBe('https://oauth2.googleapis.com/revoke');
  });

  it('has no endpoint for Microsoft, or a provider without an issuer or quirks', async () => {
    mocks.safeFetchJson.mockRejectedValue(new Error('offline'));
    for (const overrides of [
      { providerQuirks: {}, issuer: 'https://login.microsoftonline.com/tenant/v2.0' },
      { providerQuirks: {}, issuer: undefined },
      { providerQuirks: undefined, issuer: undefined },
      { providerQuirks: { revocationEndpoint: '' }, issuer: undefined },
    ]) {
      mocks.getProvider.mockResolvedValue(provider(overrides));
      const result = await revokeLinkedIdentityTokens(ENV, identity);
      expect(result.success).toBe(true);
    }
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });
});

describe('deadline', () => {
  it('bounds each provider request by the time left, never above the default', async () => {
    await revokeLinkedIdentityTokens(ENV, identity, { deadlineMs: T0 + 3000 });
    expect(argRec(mocks.safeFetch, 0, 1).timeoutMs).toBe(3000);
    expect(argRec(mocks.safeFetch, 1, 1).timeoutMs).toBe(3000);
    mocks.safeFetch.mockClear();
    await revokeLinkedIdentityTokens(ENV, identity, { deadlineMs: T0 + 60_000 });
    expect(argRec(mocks.safeFetch, 0, 1).timeoutMs).toBe(10000);
  });

  it('bounds the discovery request too', async () => {
    mocks.getProvider.mockResolvedValue(
      provider({ providerQuirks: {}, issuer: 'https://op.example' })
    );
    mocks.safeFetchJson.mockResolvedValue({ revocation_endpoint: 'https://op.example/rev' });
    await revokeLinkedIdentityTokens(ENV, identity, { deadlineMs: T0 + 2000 });
    expect(argRec(mocks.safeFetchJson, 0, 1).timeoutMs).toBe(2000);
    mocks.safeFetchJson.mockClear();
    await revokeLinkedIdentityTokens(ENV, identity, { deadlineMs: T0 + 20_000 });
    expect(argRec(mocks.safeFetchJson, 0, 1).timeoutMs).toBe(5000);
  });

  it('fails when the deadline has already passed, calling nothing at the provider', async () => {
    for (const deadlineMs of [T0, T0 - 1]) {
      const result = await revokeLinkedIdentityTokens(ENV, identity, { deadlineMs });
      expect(result.errors).toEqual(['Token revocation failed']);
      expect(result.success).toBe(false);
    }
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('does not take running out of time during discovery for a provider without revocation', async () => {
    mocks.getProvider.mockResolvedValue(
      provider({ providerQuirks: {}, issuer: 'https://accounts.google.com' })
    );
    mocks.safeFetchJson.mockImplementation(async () => {
      vi.setSystemTime(T0 + 5000);
      throw new Error('timeout');
    });
    const result = await revokeLinkedIdentityTokens(ENV, identity, { deadlineMs: T0 + 4000 });
    expect(result).toEqual({
      success: false,
      accessTokenRevoked: false,
      refreshTokenRevoked: false,
      errors: ['Token revocation failed'],
    });
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('still falls back to the known endpoint when discovery fails inside the deadline', async () => {
    mocks.getProvider.mockResolvedValue(
      provider({ providerQuirks: {}, issuer: 'https://accounts.google.com' })
    );
    mocks.safeFetchJson.mockRejectedValue(new Error('timeout'));
    const result = await revokeLinkedIdentityTokens(ENV, identity, { deadlineMs: T0 + 4000 });
    expect(result.success).toBe(true);
    expect(callArg(mocks.safeFetch, 0, 0)).toBe('https://oauth2.googleapis.com/revoke');
  });
});
