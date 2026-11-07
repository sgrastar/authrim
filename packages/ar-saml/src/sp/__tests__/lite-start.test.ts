/**
 * Whether a SAML sign-in may create an account in a tenant that may be in lite mode: only one
 * begun at a lite start (its stored request carries the lite return), unless the store says now
 * that the tenant is not lite; and where a lite sign-in's failure goes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const reads = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  readLiteModeAuthoritative: reads.current,
}));

import { liteSamlErrorRedirect, samlSignInMayCreateAccount } from '../lite-start';

const env = {} as Env;
const LITE_RETURN = 'https://auth.example.com/callback?lite_txn=txn-1&lite_grant=grant-1';

beforeEach(() => reads.current.mockReset());

describe('samlSignInMayCreateAccount', () => {
  it('lets a sign-in begun at a lite start create one without reading the mode', async () => {
    await expect(samlSignInMayCreateAccount(env, 't', LITE_RETURN)).resolves.toBe(true);
    expect(reads.current).not.toHaveBeenCalled();
  });

  it('goes by the store now for any other sign-in, and creates nothing when it cannot read it', async () => {
    reads.current.mockResolvedValueOnce('always');
    await expect(samlSignInMayCreateAccount(env, 't', null)).resolves.toBe(false);
    reads.current.mockResolvedValueOnce('off');
    await expect(samlSignInMayCreateAccount(env, 't', null)).resolves.toBe(true);
    reads.current.mockRejectedValueOnce(new Error('policy unavailable'));
    await expect(samlSignInMayCreateAccount(env, 't', null)).resolves.toBe(false);
  });
});

describe('liteSamlErrorRedirect', () => {
  it('returns to the lite callback with an error, keeping its transaction and grant', () => {
    const response = liteSamlErrorRedirect(LITE_RETURN, 400);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('lite_txn')).toBe('txn-1');
    expect(location.searchParams.get('lite_grant')).toBe('grant-1');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(
      new URL(
        liteSamlErrorRedirect(LITE_RETURN, 500).headers.get('location') ?? ''
      ).searchParams.get('error')
    ).toBe('server_error');
  });
});
