/**
 * The user's revocation with the real per-identity revocation (RFC 7009 requests mocked at the
 * fetch): no token value, client secret or provider subject reaches a log or the answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logs: [] as unknown[][],
  fetches: [] as Array<{ url: string; body: string }>,
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  const logger = {
    info: (...args: unknown[]) => mocks.logs.push(args),
    warn: (...args: unknown[]) => mocks.logs.push(args),
    error: (...args: unknown[]) => mocks.logs.push(args),
    debug: (...args: unknown[]) => mocks.logs.push(args),
  };
  return {
    isValidPersistedUserId: actual.isValidPersistedUserId,
    USER_TOKEN_REVOCATION_TIMED_OUT: actual.USER_TOKEN_REVOCATION_TIMED_OUT,
    normalizeExternalIdpTokenRevocationTimeoutMs:
      actual.normalizeExternalIdpTokenRevocationTimeoutMs,
    createLogger: () => ({ module: () => logger }),
    resolveAccountDataContext: vi.fn(async () => ({ legacyUserId: 'user-1', piiDb: {} })),
    safeFetchJson: vi.fn(async () => ({ revocation_endpoint: 'https://idp.example/revoke' })),
    safeFetch: vi.fn(async (url: string, init: { body: string }) => {
      mocks.fetches.push({ url, body: init.body });
      // The provider echoes the token back in its error description.
      return new Response(
        JSON.stringify({
          error: 'invalid_request',
          error_description: `bad token ${new URLSearchParams(init.body).get('token')}`,
        }),
        { status: 400 }
      );
    }),
    readResponseTextWithLimit: (response: Response) => response.text(),
  };
});

vi.mock('../services/provider-store', () => ({
  getProvider: vi.fn(async () => ({
    id: 'provider-1',
    name: 'Example',
    issuer: 'https://idp.example',
    clientId: 'client-1',
    clientSecretEncrypted: 'enc-secret',
  })),
}));

vi.mock('../services/linked-identity-store', () => ({
  listLinkedIdentities: vi.fn(async () => [
    {
      id: 'li-1',
      tenantId: 'tenant-a',
      userId: 'user-1',
      providerId: 'provider-1',
      providerUserId: 'subject-at-idp',
      accessTokenEncrypted: 'enc-access',
      refreshTokenEncrypted: 'enc-refresh',
    },
  ]),
  decryptLinkedIdentityTokens: vi.fn(async () => ({
    accessToken: 'plain-access-token',
    refreshToken: 'plain-refresh-token',
  })),
}));

vi.mock('../utils/crypto', () => ({
  getEncryptionKeyOrUndefined: vi.fn(() => 'key'),
  decrypt: vi.fn(async () => 'plain-client-secret'),
}));

import { safeFetch, safeFetchJson } from '@authrim/ar-lib-core';
import { revokeLinkedIdentityTokens } from '../services/token-revocation';
import { revokeUserLinkedIdentityTokens } from '../services/user-token-revocation';

describe('revokeUserLinkedIdentityTokens logs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs and answers a refused revocation without any token value', async () => {
    const consoleOutput: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => consoleOutput.push(args));
    }

    const result = await revokeUserLinkedIdentityTokens({} as never, {
      schemaVersion: 1,
      tenantId: 'tenant-a',
      userId: 'user-1',
      timeoutMs: 2000,
    });

    // Both tokens were sent to the provider (and refused).
    expect(mocks.fetches.map(({ body }) => new URLSearchParams(body).get('token'))).toEqual([
      'plain-access-token',
      'plain-refresh-token',
    ]);
    expect(result.identities).toEqual([{ providerId: 'provider-1', outcome: 'failed' }]);
    const text = JSON.stringify([result, mocks.logs, consoleOutput]);
    expect(text).not.toMatch(/plain-|subject-at-idp|li-1|enc-/u);
    expect(mocks.logs.length).toBeGreaterThan(0);
  });
});

describe('revokeLinkedIdentityTokens deadline', () => {
  const linked = {
    id: 'li-1',
    tenantId: 'tenant-a',
    userId: 'user-1',
    providerId: 'provider-1',
    providerUserId: 'subject-at-idp',
    refreshTokenEncrypted: 'enc-refresh',
    emailVerified: false,
    linkedAt: 1,
    updatedAt: 1,
  };

  it('gives every provider request no more than the time left', async () => {
    vi.mocked(safeFetchJson).mockClear();
    vi.mocked(safeFetch).mockClear();

    await revokeLinkedIdentityTokens({} as never, linked, { deadlineMs: Date.now() + 1500 });

    const discovery = vi.mocked(safeFetchJson).mock.calls[0][1] as { timeoutMs: number };
    const revocation = vi.mocked(safeFetch).mock.calls[0][1] as { timeoutMs: number };
    expect(discovery.timeoutMs).toBeLessThanOrEqual(1500);
    expect(revocation.timeoutMs).toBeLessThanOrEqual(1500);
  });

  it('does not take a provider that ran out of time for one without revocation', async () => {
    vi.mocked(safeFetch).mockClear();

    const result = await revokeLinkedIdentityTokens({} as never, linked, {
      deadlineMs: Date.now() - 1,
    });

    expect(result).toMatchObject({ success: false, refreshTokenRevoked: false });
    expect(safeFetch).not.toHaveBeenCalled();
  });
});
