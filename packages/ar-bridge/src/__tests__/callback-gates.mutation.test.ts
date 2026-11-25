/**
 * External callback: parameter intake, state checks and provider error responses.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {} from './helpers/mock-args';
import { M, T0, setupCallbackMocks } from './helpers/callback-mocks';
import { ExternalIdPError, ExternalIdPErrorCode } from '../types';
import {
  ENV,
  STATE,
  authState,
  callback,
  locationOf,
  must,
  oauthProvider,
  paramsOf,
} from './helpers/callback-harness';

beforeEach(setupCallbackMocks);

describe('intake and rejections', () => {
  it('rejects a callback without a provider segment', async () => {
    const response = await callback({ path: '/noprovider' });
    expect(response.status).toBe(302);
    expect(paramsOf(response)).toEqual({
      error: 'invalid_request',
      error_description: 'Missing provider',
    });
    expect(locationOf(response).pathname).toBe('/login');
  });

  it('answers a bare GET (fragment response) with the relay page, touching nothing', async () => {
    const response = await callback({ query: '' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(M.getProvider).not.toHaveBeenCalled();
  });

  it('does not answer the relay page when any response parameter is present', async () => {
    for (const query of ['code=c', 'state=s', 'error=e', 'response=r']) {
      M.getProvider.mockClear();
      await callback({ query });
      expect(M.getProvider).toHaveBeenCalledTimes(1);
    }
  });

  it('redirects to the login page with the tenant hint omitted for the default tenant', async () => {
    M.getProvider.mockResolvedValue(null);
    const response = await callback();
    expect(response.status).toBe(302);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(locationOf(response).origin).toBe('https://login.example.com');
    expect(paramsOf(response)).toEqual({
      error: 'unknown_provider',
      error_description: 'Provider not found',
    });
    expect(M.getProvider).toHaveBeenCalledWith(ENV, 'corp', 'default');
  });

  it('reads a form_post body, which takes precedence over the query', async () => {
    await callback({
      method: 'POST',
      query: 'code=query-code&state=query-state&user=query-user',
      body: { code: 'body-code', state: STATE },
    });
    expect(M.exchangeCode).toHaveBeenCalledWith('body-code', 'verifier-a');
  });

  it('lets the form body override the query for the error fields too', async () => {
    const first = await callback({
      method: 'POST',
      query: `state=${STATE}&error=server_error&error_description=from-query`,
      body: { error: 'access_denied', error_description: 'from-body', state: STATE },
    });
    expect(paramsOf(first)).toEqual({ error: 'access_denied', error_description: 'from-body' });
    const fallback = await callback({
      method: 'POST',
      query: `state=${STATE}&error=server_error&error_description=from-query`,
      body: { error: 'access_denied', state: STATE },
    });
    expect(paramsOf(fallback)).toEqual({ error: 'access_denied', error_description: 'from-query' });
  });

  it('falls back to the query for fields the body leaves out', async () => {
    await callback({ method: 'POST', query: `code=query-code&state=${STATE}`, body: { x: 'y' } });
    expect(M.exchangeCode).toHaveBeenCalledWith('query-code', 'verifier-a');
  });

  it('requires a state', async () => {
    const response = await callback({ query: 'code=c' });
    expect(paramsOf(response)).toEqual({
      error: 'invalid_request',
      error_description: 'Missing state',
    });
    expect(M.consumeAuthState).not.toHaveBeenCalled();
  });

  it('refuses a malformed JARM response', async () => {
    const response = await callback({ query: 'response=not-a-jwt' });
    expect(paramsOf(response)).toEqual({
      error: 'invalid_request',
      error_description: 'Invalid JARM response',
    });
  });

  it('takes the state from an unverified JARM response when none is given', async () => {
    const jwt = `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify({ state: STATE }))}.`;
    await callback({ query: `response=${jwt.replaceAll('=', '')}` });
    expect(M.consumeAuthState).toHaveBeenCalledWith(ENV, 'default', STATE);
  });

  it('refuses a callback that does not come from the browser that started it', async () => {
    const response = await callback({ bound: false });
    expect(paramsOf(response)).toEqual({
      error: 'invalid_state',
      error_description: 'State is not bound to this browser',
    });
    expect(M.consumeAuthState).not.toHaveBeenCalled();
  });

  it('refuses a binding cookie holding another value', async () => {
    const { getAuthStateCookieName } = await import('../utils/state');
    const response = await callback({
      bound: false,
      headers: { Cookie: `${await getAuthStateCookieName(STATE)}=${STATE}x` },
    });
    expect(paramsOf(response).error).toBe('invalid_state');
  });

  it('clears the binding cookie once it matched', async () => {
    const response = await callback();
    const cookie = must(response.headers.get('Set-Cookie'));
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Path=/auth/external/');
  });

  it('refuses an unknown or expired state', async () => {
    M.consumeAuthState.mockResolvedValue(null);
    const response = await callback();
    expect(paramsOf(response)).toEqual({
      error: 'invalid_state',
      error_description: 'State validation failed or expired',
    });
    expect(M.consumeAuthState).toHaveBeenCalledWith(ENV, 'default', STATE);
    expect(M.fromProvider).not.toHaveBeenCalled();
  });

  it('refuses a state that belongs to another provider', async () => {
    M.consumeAuthState.mockResolvedValue(authState({ providerId: 'other' }));
    const response = await callback();
    expect(paramsOf(response)).toEqual({
      error: 'invalid_state',
      error_description: 'Provider mismatch',
    });
    expect(M.fromProvider).not.toHaveBeenCalled();
  });

  it('gives a reserved invitation back when the state is refused', async () => {
    M.consumeAuthState.mockResolvedValue(
      authState({ providerId: 'other', inviteId: 'inv', inviteReservationId: 'res' })
    );
    await callback();
    expect(M.release).toHaveBeenCalledWith(ENV, expect.anything(), {
      inviteId: 'inv',
      inviteReservationId: 'res',
      tenantId: 'default',
    });
  });

  it('does not release an invitation that was never reserved', async () => {
    M.consumeAuthState.mockResolvedValue(authState({ providerId: 'other' }));
    await callback();
    expect(M.release).not.toHaveBeenCalled();
  });

  it('checks the usage switch for a plain sign-in, not for a link or re-authentication', async () => {
    await callback();
    expect(M.usageGate).toHaveBeenCalledWith(ENV, 'default', oauthProvider, 'login_or_signup');
    M.usageGate.mockClear();
    M.consumeAuthState.mockResolvedValue(authState({ reauthRequestedAt: T0 }));
    await callback();
    expect(M.usageGate).not.toHaveBeenCalled();
    M.consumeAuthState.mockResolvedValue(authState({ userId: 'user-1', sessionId: 's' }));
    await callback();
    expect(M.usageGate).not.toHaveBeenCalled();
  });

  it('maps a usage-gate refusal to its error code without details', async () => {
    M.usageGate.mockRejectedValue(
      new ExternalIdPError(ExternalIdPErrorCode.LOGIN_DISABLED, 'secret internal text')
    );
    const response = await callback();
    expect(paramsOf(response)).toEqual({
      error: ExternalIdPErrorCode.LOGIN_DISABLED,
      error_description: 'Authentication failed. Please try again.',
    });
    expect(M.publishEvent).toHaveBeenCalledWith(expect.anything(), {
      type: 'auth.external_idp.failed',
      tenantId: 'default',
      data: {
        method: 'external_idp',
        clientId: 'provider-a',
        errorCode: ExternalIdPErrorCode.LOGIN_DISABLED,
      },
    });
  });

  it('adds the diagnostic flow id header once the state is known', async () => {
    const response = await callback();
    expect(response.headers.get('X-Authrim-Diagnostic-Flow-Id')).toBe('flow-a');
    M.consumeAuthState.mockResolvedValue(authState({ flowId: undefined }));
    const without = await callback();
    expect(without.headers.get('X-Authrim-Diagnostic-Flow-Id')).toBeNull();
  });
});

describe('provider error responses', () => {
  it('redirects the provider error with its description for a sign-in', async () => {
    const response = await callback({
      query: `state=${STATE}&error=access_denied&error_description=user%20said%20no`,
    });
    expect(paramsOf(response)).toEqual({
      error: 'access_denied',
      error_description: 'user said no',
    });
    expect(M.exchangeCode).not.toHaveBeenCalled();
  });

  it('requires a code when the provider reported no error', async () => {
    const response = await callback({ query: `state=${STATE}` });
    expect(paramsOf(response)).toEqual({
      error: 'invalid_request',
      error_description: 'Missing code',
    });
  });

  it.each([
    ['cancelled', 'access_denied'],
    ['failed', 'server_error'],
  ])('returns a link to the account page as %s', async (reason, error) => {
    M.consumeAuthState.mockResolvedValue(authState({ userId: 'user-1', sessionId: 's-1' }));
    const response = await callback({ query: `state=${STATE}&error=${error}` });
    const location = locationOf(response);
    expect(location.origin + location.pathname).toBe('https://login.example.com/account');
    expect(Object.fromEntries(location.searchParams)).toEqual({
      social_link: 'error',
      reason,
    });
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns a link without a code to the account page as failed', async () => {
    M.consumeAuthState.mockResolvedValue(authState({ userId: 'user-1', sessionId: 's-1' }));
    const response = await callback({ query: `state=${STATE}` });
    expect(paramsOf(response)).toEqual({ social_link: 'error', reason: 'failed' });
  });
});
