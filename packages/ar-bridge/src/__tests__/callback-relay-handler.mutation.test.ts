/**
 * External callback on the platform issuer host of a tenant with a custom domain: a provider's form
 * post is kept for the sign-in it answers and the browser goes on to the custom domain.
 */
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { argRec, callArg } from './helpers/mock-args';
import { M, setupCallbackMocks } from './helpers/callback-mocks';
import { STATE, callback, paramsOf } from './helpers/callback-harness';

const CUSTOM = 'https://login.custom.example';

beforeEach(() => {
  setupCallbackMocks();
  M.relayOrigin.mockReturnValue(CUSTOM);
});

const error = (response: Response) => {
  const params = paramsOf(response);
  return [params.error, params.error_description];
};

describe('keeping the answer and sending the browser on', () => {
  it('keeps the answer for the state it names and answers 303 to the custom domain', async () => {
    const response = await callback({
      method: 'POST',
      path: '/auth/external/corp/callback',
      query: '',
      body: {
        code: 'c1',
        state: STATE,
        id_token: 'idt',
        iss: 'https://idp.example.com',
        user: '{"name":1}',
      },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(
      `${CUSTOM}/auth/external/corp/callback?relay=handle-1`
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(M.isPending).toHaveBeenCalledWith(expect.anything(), 'default', 'provider-a', STATE);
    expect(callArg(M.keepRelayed, 0, 1)).toEqual({
      tenantId: 'default',
      providerKey: 'corp',
      state: STATE,
      params: {
        code: 'c1',
        idToken: 'idt',
        state: STATE,
        issuer: 'https://idp.example.com',
        user: '{"name":1}',
      },
    });
    expect(M.consumeAuthState).not.toHaveBeenCalled();
    expect(M.exchangeCode).not.toHaveBeenCalled();
  });

  it('lets a posted value win over the query, and falls back to the query for an empty one', async () => {
    await callback({
      method: 'POST',
      query: `code=q-code&id_token=q-idt&state=${STATE}&error=q-err&error_description=q-desc&iss=q-iss&response=q-resp&user=q-user`,
      body: {
        code: 'b-code',
        id_token: 'b-idt',
        error: 'b-err',
        error_description: 'b-desc',
        iss: 'b-iss',
        response: 'b-resp',
        user: 'b-user',
      },
    });
    expect(argRec(M.keepRelayed, 0, 1).params).toEqual({
      code: 'b-code',
      idToken: 'b-idt',
      state: STATE,
      error: 'b-err',
      errorDescription: 'b-desc',
      issuer: 'b-iss',
      responseJwt: 'b-resp',
      user: 'b-user',
    });
    M.keepRelayed.mockClear();
    await callback({
      method: 'POST',
      query: `code=q-code&id_token=q-idt&state=${STATE}&iss=q-iss&user=q-user`,
      body: { code: '', id_token: '', state: '', iss: '', user: '' },
    });
    expect(argRec(M.keepRelayed, 0, 1).params).toEqual({
      code: 'q-code',
      idToken: 'q-idt',
      state: STATE,
      issuer: 'q-iss',
      user: 'q-user',
    });
  });

  it('reads the state of a JARM response when there is none beside it', async () => {
    const jwt = await new SignJWT({ state: STATE })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode('secret-secret-secret-secret-secret!'));
    const response = await callback({ query: `response=${jwt}` });
    expect(response.status).toBe(303);
    expect(argRec(M.keepRelayed, 0, 1).state).toBe(STATE);
    expect(M.isPending).toHaveBeenCalledWith(expect.anything(), 'default', 'provider-a', STATE);
  });

  it('prefers the explicit state over the one inside a JARM response', async () => {
    const jwt = await new SignJWT({ state: 'inside-state' })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode('secret-secret-secret-secret-secret!'));
    await callback({ query: `state=${STATE}&response=${jwt}` });
    expect(argRec(M.keepRelayed, 0, 1).state).toBe(STATE);
  });

  it('logs a failure to keep it, and answers a server error', async () => {
    M.keepRelayed.mockRejectedValue(new TypeError('store down'));
    const response = await callback();
    expect(error(response)).toEqual(['server_error', 'The sign-in could not be completed']);
    expect(M.warnLog).toHaveBeenCalledWith(
      'Failed to relay the provider response to the custom domain',
      {
        errorName: 'TypeError',
      }
    );
    M.keepRelayed.mockRejectedValue('text');
    await callback();
    expect(M.warnLog).toHaveBeenLastCalledWith(
      'Failed to relay the provider response to the custom domain',
      {
        errorName: 'Unknown',
      }
    );
  });

  it('logs under the CALLBACK module', async () => {
    await callback();
    expect(M.moduleNames).toContain('CALLBACK');
  });
});

describe('refusing what cannot be kept', () => {
  it('refuses an answer with a parameter longer than any provider sends', async () => {
    const response = await callback({ query: `code=${'x'.repeat(4097)}&state=${STATE}` });
    expect(error(response)).toEqual(['invalid_request', 'Invalid provider response']);
    expect(M.keepRelayed).not.toHaveBeenCalled();
  });

  it('refuses an answer without a state, or with a JARM response that has none', async () => {
    expect(error(await callback({ query: 'code=c1' }))).toEqual([
      'invalid_request',
      'Missing state',
    ]);
    const noState = await new SignJWT({ other: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode('secret-secret-secret-secret-secret!'));
    expect(error(await callback({ query: `response=${noState}` }))).toEqual([
      'invalid_request',
      'Missing state',
    ]);
    expect(error(await callback({ query: 'response=not-a-jwt' }))).toEqual([
      'invalid_request',
      'Missing state',
    ]);
    expect(M.getProvider).not.toHaveBeenCalled();
  });

  it('refuses an unknown provider', async () => {
    M.getProvider.mockResolvedValue(null);
    expect(error(await callback())).toEqual(['unknown_provider', 'Provider not found']);
    expect(M.getProvider).toHaveBeenCalledWith(expect.anything(), 'corp', 'default');
  });

  it('refuses a state that is not waiting for its answer', async () => {
    M.isPending.mockResolvedValue(false);
    expect(error(await callback())).toEqual([
      'invalid_state',
      'State validation failed or expired',
    ]);
    expect(M.keepRelayed).not.toHaveBeenCalled();
  });

  it('refuses an answer already kept for the state', async () => {
    M.keepRelayed.mockResolvedValue(null);
    const response = await callback();
    expect(error(response)).toEqual([
      'invalid_state',
      'The provider response was already received',
    ]);
    expect(response.status).toBe(302);
  });
});

describe('taking the kept answer on the custom domain', () => {
  beforeEach(() => {
    M.relayOrigin.mockReturnValue(null);
  });

  it('refuses a handle that is not for this browser', async () => {
    const response = await callback({ query: 'relay=handle-x' });
    expect(error(response)).toEqual([
      'invalid_state',
      'The provider response is not available to this browser',
    ]);
    expect(M.takeRelayed).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'default',
      providerKey: 'corp',
      handle: 'handle-x',
    });
    expect(M.consumeAuthState).not.toHaveBeenCalled();
  });

  it('goes on with the answer that was kept', async () => {
    M.takeRelayed.mockResolvedValue({ code: 'kept-code', state: STATE });
    const response = await callback({ query: 'relay=handle-1' });
    expect(response.status).toBe(302);
    expect(M.exchangeCode).toHaveBeenCalledWith('kept-code', 'verifier-a');
    expect(M.consumeAuthState).toHaveBeenCalledWith(expect.anything(), 'default', STATE);
  });

  it('does not take a handle from a POST', async () => {
    await callback({ method: 'POST', query: 'relay=handle-1', body: { code: 'c', state: STATE } });
    expect(M.takeRelayed).not.toHaveBeenCalled();
  });

  it('answers a request without a provider with an error', async () => {
    const response = await callback({ path: '/noprovider', query: '' });
    expect(error(response)).toEqual(['invalid_request', 'Missing provider']);
  });
});
