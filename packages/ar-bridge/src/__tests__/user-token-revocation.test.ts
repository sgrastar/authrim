import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveAccount: vi.fn(),
  listIdentities: vi.fn(),
  revokeTokens: vi.fn(),
  logs: [] as unknown[][],
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
    resolveAccountDataContext: mocks.resolveAccount,
  };
});

vi.mock('../services/linked-identity-store', () => ({
  listLinkedIdentities: mocks.listIdentities,
}));

vi.mock('../services/token-revocation', () => ({
  revokeLinkedIdentityTokens: mocks.revokeTokens,
}));

import {
  revokeUserLinkedIdentityTokens,
  UserTokenRevocationInputError,
} from '../services/user-token-revocation';

const env = {} as never;
const input = { schemaVersion: 1, tenantId: 'tenant-a', userId: 'user-1', timeoutMs: 500 };
const piiDb = { kind: 'account-pii' };

function identity(id: string, providerId: string, tokens: { access?: string; refresh?: string }) {
  return {
    id,
    tenantId: 'tenant-a',
    userId: 'user-1',
    providerId,
    providerUserId: `subject-${id}`,
    accessTokenEncrypted: tokens.access,
    refreshTokenEncrypted: tokens.refresh,
    linkedAt: 1,
    updatedAt: 1,
    emailVerified: false,
  };
}

const revoked = (access: boolean, refresh: boolean, errors: string[] = []) => ({
  success: access || refresh || errors.length === 0,
  accessTokenRevoked: access,
  refreshTokenRevoked: refresh,
  errors,
});

describe('revokeUserLinkedIdentityTokens', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.logs.length = 0;
    mocks.resolveAccount.mockReset().mockResolvedValue({ legacyUserId: 'user-1', piiDb });
    mocks.listIdentities.mockReset();
    mocks.revokeTokens.mockReset();
  });

  it("reads the tenant's account and revokes only the identities holding a stored token", async () => {
    const google = identity('li-google', 'provider-google', { refresh: 'enc-r' });
    const github = identity('li-github', 'provider-github', { access: 'enc-a', refresh: 'enc-r' });
    const empty = identity('li-empty', 'provider-empty', {});
    const unsupported = identity('li-x', 'provider-x', { access: 'enc-a' });
    mocks.listIdentities.mockResolvedValue([google, github, empty, unsupported]);
    mocks.revokeTokens.mockImplementation(async (_env, linked: { id: string }) => {
      if (linked.id === 'li-google') return revoked(false, true);
      if (linked.id === 'li-github') return revoked(false, true, ['Access token: invalid_token']);
      return { success: true, accessTokenRevoked: false, refreshTokenRevoked: false, errors: [] };
    });

    const result = await revokeUserLinkedIdentityTokens(env, input);

    expect(mocks.resolveAccount).toHaveBeenCalledWith(env, {
      tenantId: 'tenant-a',
      accountId: 'account:user-1',
    });
    expect(mocks.listIdentities).toHaveBeenCalledWith(env, 'tenant-a', 'user-1', piiDb);
    expect(mocks.revokeTokens).toHaveBeenCalledTimes(3);
    expect(mocks.revokeTokens).not.toHaveBeenCalledWith(env, empty);
    expect(result).toEqual({
      schemaVersion: 1,
      identities: [
        { providerId: 'provider-google', outcome: 'revoked' },
        { providerId: 'provider-github', outcome: 'partially_revoked' },
        { providerId: 'provider-x', outcome: 'not_supported' },
      ],
    });
    // Neither the answer nor the logs name the link or the person's subject at the provider.
    const text = JSON.stringify([result, mocks.logs]);
    expect(text).not.toMatch(/li-google|subject-|enc-/u);
  });

  it('answers failed for a refused or throwing revocation', async () => {
    mocks.listIdentities.mockResolvedValue([
      identity('li-1', 'provider-1', { access: 'enc-a' }),
      identity('li-2', 'provider-2', { refresh: 'enc-r' }),
    ]);
    mocks.revokeTokens
      .mockResolvedValueOnce({
        success: false,
        accessTokenRevoked: false,
        refreshTokenRevoked: false,
        errors: ['Provider not found'],
      })
      .mockRejectedValueOnce(new Error('boom'));

    const result = await revokeUserLinkedIdentityTokens(env, input);

    expect(result.identities.map((entry) => entry.outcome)).toEqual(['failed', 'failed']);
  });

  it('answers timed_out at the deadline, which every provider request is given', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    mocks.listIdentities.mockResolvedValue([identity('li-1', 'provider-1', { refresh: 'enc-r' })]);
    mocks.revokeTokens.mockReturnValue(new Promise(() => undefined));

    const pending = revokeUserLinkedIdentityTokens(env, { ...input, timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.identities).toEqual([{ providerId: 'provider-1', outcome: 'timed_out' }]);
    // The provider requests end by the same deadline: nothing is left running.
    expect(mocks.revokeTokens).toHaveBeenCalledWith(env, expect.anything(), {
      deadlineMs: 1_001_000,
    });
  });

  it.each([
    ['take longer than the deadline', 1200],
    ['never finish', null],
  ])(
    'answers timed out (not "nothing to revoke") at the deadline when the reads %s',
    async (_name, readMs) => {
      vi.useFakeTimers();
      mocks.listIdentities.mockImplementation(
        () =>
          new Promise((resolve) => {
            if (readMs !== null) {
              setTimeout(
                () => resolve([identity('li-1', 'provider-1', { refresh: 'enc-r' })]),
                readMs
              );
            }
          })
      );

      const pending = revokeUserLinkedIdentityTokens(env, { ...input, timeoutMs: 1000 });
      const outcome = expect(pending).rejects.toThrow('user_token_revocation_timed_out');
      await vi.advanceTimersByTimeAsync(1000);
      await outcome;
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.revokeTokens).not.toHaveBeenCalled();
    }
  );

  it('does not start the identity read once the account read used up the deadline', async () => {
    vi.useFakeTimers();
    mocks.resolveAccount.mockImplementation(
      () =>
        new Promise((resolve) => setTimeout(() => resolve({ legacyUserId: 'user-1', piiDb }), 1500))
    );

    const pending = revokeUserLinkedIdentityTokens(env, { ...input, timeoutMs: 1000 });
    const outcome = expect(pending).rejects.toThrow('user_token_revocation_timed_out');
    await vi.advanceTimersByTimeAsync(1500);
    await outcome;

    expect(mocks.listIdentities).not.toHaveBeenCalled();
  });

  it('gives the revocations what the reads left of the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    mocks.listIdentities.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return [identity('li-1', 'provider-1', { refresh: 'enc-r' })];
    });
    mocks.revokeTokens.mockReturnValue(new Promise(() => undefined));
    let settled = false;

    const pending = revokeUserLinkedIdentityTokens(env, { ...input, timeoutMs: 1000 }).then(
      (result) => {
        settled = true;
        return result;
      }
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect((await pending).identities[0].outcome).toBe('timed_out');
    expect(mocks.revokeTokens).toHaveBeenCalledWith(env, expect.anything(), {
      deadlineMs: 3_001_000,
    });
  });

  it('normalizes an out-of-range time limit to the default', async () => {
    vi.useFakeTimers();
    mocks.listIdentities.mockResolvedValue([identity('li-1', 'provider-1', { refresh: 'enc-r' })]);
    mocks.revokeTokens.mockReturnValue(new Promise(() => undefined));

    const pending = revokeUserLinkedIdentityTokens(env, { ...input, timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(3000);

    expect((await pending).identities[0].outcome).toBe('timed_out');
  });

  it.each([
    ['no input', null],
    ['another schema', { ...input, schemaVersion: 2 }],
    ['no tenant', { ...input, tenantId: '' }],
    ['an unsafe user id', { ...input, userId: "user' OR 1=1" }],
  ])('refuses %s before reading anything', async (_name, value) => {
    await expect(revokeUserLinkedIdentityTokens(env, value)).rejects.toBeInstanceOf(
      UserTokenRevocationInputError
    );
    expect(mocks.resolveAccount).not.toHaveBeenCalled();
    expect(mocks.revokeTokens).not.toHaveBeenCalled();
  });

  it('accepts a generated user id that starts with _ or -', async () => {
    const userId = '_abcdefghij-klmnopqrs';
    mocks.resolveAccount.mockResolvedValue({ legacyUserId: userId, piiDb });
    mocks.listIdentities.mockResolvedValue([]);

    await expect(revokeUserLinkedIdentityTokens(env, { ...input, userId })).resolves.toEqual({
      schemaVersion: 1,
      identities: [],
    });
    expect(mocks.resolveAccount).toHaveBeenCalledWith(env, {
      tenantId: 'tenant-a',
      accountId: `account:${userId}`,
    });
  });

  it('revokes at most four at a time within one deadline; one not started by then is not', async () => {
    vi.useFakeTimers();
    mocks.listIdentities.mockResolvedValue(
      Array.from({ length: 9 }, (_, index) =>
        identity(`li-${index}`, `provider-${index}`, { refresh: 'enc-r' })
      )
    );
    let running = 0;
    let peak = 0;
    mocks.revokeTokens.mockImplementation(async (_env, linked: { id: string }) => {
      running += 1;
      peak = Math.max(peak, running);
      // Each takes 400 ms, the fifth hangs: the second round (fifth to eighth) is still running
      // at the 600 ms deadline, and the ninth never starts.
      await new Promise((resolve) => setTimeout(resolve, linked.id === 'li-4' ? 60_000 : 400));
      running -= 1;
      return revoked(false, true);
    });
    const pending = revokeUserLinkedIdentityTokens(env, { ...input, timeoutMs: 600 });
    await vi.advanceTimersByTimeAsync(600);
    const result = await pending;

    expect(peak).toBe(4);
    expect(result.identities.map((entry) => entry.outcome)).toEqual([
      ...Array<string>(4).fill('revoked'),
      ...Array<string>(5).fill('timed_out'),
    ]);
    // The second round was cut at the deadline; the ninth was never started.
    expect(mocks.revokeTokens).toHaveBeenCalledTimes(8);
  });

  it('refuses an account route that names another user', async () => {
    mocks.resolveAccount.mockResolvedValue({ legacyUserId: 'user-2', piiDb });

    await expect(revokeUserLinkedIdentityTokens(env, input)).rejects.toThrow(
      'user_token_revocation_account_mismatch'
    );
    expect(mocks.listIdentities).not.toHaveBeenCalled();
  });
});
