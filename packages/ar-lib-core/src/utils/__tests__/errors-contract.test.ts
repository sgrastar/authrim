import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorFactory,
  OIDCError,
  createCompatibilityError,
  createCompatibilityErrorResponse,
  getCompatibilityErrorUri,
  handleOIDCError,
  handleTokenError,
  handleUserInfoError,
  redirectWithError,
  withErrorHandling,
  type CompatibilityErrorCode,
} from '../errors';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('OIDC error contracts', () => {
  it('serializes only defined public fields', () => {
    expect(new OIDCError('invalid_request').toJSON()).toEqual({ error: 'invalid_request' });
    expect(
      new OIDCError('invalid_request', 'Bad request', 422, 'https://docs.example/error').toJSON()
    ).toEqual({
      error: 'invalid_request',
      error_description: 'Bad request',
      error_uri: 'https://docs.example/error',
    });
  });

  it.each(Object.entries(ErrorFactory))(
    'factory %s returns stable defaults and accepts a caller-safe description',
    (name, factory) => {
      const create = factory as (description?: string) => OIDCError;
      const fallback = create();
      const custom = create('Caller-safe description');
      expect(fallback).toBeInstanceOf(OIDCError);
      expect(fallback.error).toBeTruthy();
      expect(fallback.error_description).toBeTruthy();
      expect(custom.error).toBe(fallback.error);
      expect(custom.error_description).toBe('Caller-safe description');
      expect(custom.statusCode).toBe(fallback.statusCode);
      expect(name).toBeTruthy();
    }
  );

  it.each([
    'legacy_app_suite_not_supported',
    'legacy_native_sso_discovery_unsupported',
    'legacy_endpoint_not_supported',
    'legacy_passkey_error_unsupported',
  ] satisfies CompatibilityErrorCode[])(
    'creates documented compatibility response for %s',
    async (code) => {
      const error = createCompatibilityError(code, 410);
      expect(error).toMatchObject({ error: code, statusCode: 410 });
      expect(error.error_uri).toBe(getCompatibilityErrorUri(code));
      const response = createCompatibilityErrorResponse(code, 410);
      expect(response.status).toBe(410);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toMatchObject({
        error: code,
        error_uri: expect.stringContaining(`#${code.replace(/_/g, '-')}`),
        error_details: expect.anything(),
      });
    }
  );

  it.each(['development', 'production'])(
    'returns JSON OIDC and token errors in %s',
    async (mode) => {
      process.env.NODE_ENV = mode;
      const error = new OIDCError('invalid_client', 'Credentials rejected', 401);
      const oidc = handleOIDCError({} as never, error);
      expect(oidc.status).toBe(401);
      expect(await oidc.json()).toEqual(error.toJSON());
      const token = handleTokenError({} as never, error);
      expect(token.headers.get('Cache-Control')).toBe('no-store');
      expect(token.headers.get('Pragma')).toBe('no-cache');
    }
  );

  it('adds an escaped RFC 6750 challenge only to descriptive unauthorized errors', () => {
    const response = handleUserInfoError(
      {} as never,
      new OIDCError('invalid_token', 'bad "token" \\ value', 401)
    );
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer error="invalid_token", error_description="bad \\"token\\" \\\\ value"'
    );
    expect(
      handleUserInfoError({}, new OIDCError('invalid_request', undefined, 400)).headers.has(
        'WWW-Authenticate'
      )
    ).toBe(false);
  });

  it('redirects with only supplied authorization error parameters', () => {
    const full = redirectWithError(
      'https://client.example/callback?existing=1',
      'access_denied',
      'User denied',
      'state-1',
      'https://docs.example/denied'
    );
    const location = new URL(full.headers.get('Location')!);
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      existing: '1',
      error: 'access_denied',
      error_description: 'User denied',
      state: 'state-1',
      error_uri: 'https://docs.example/denied',
    });
    const minimal = new URL(
      redirectWithError('https://client.example/callback', 'server_error').headers.get('Location')!
    );
    expect([...minimal.searchParams.keys()]).toEqual(['error']);
  });

  it('passes successful handlers through and maps known and unknown failures safely', async () => {
    const context = {} as never;
    const customHandler = vi.fn(
      (_c, error: OIDCError) => new Response(error.error, { status: error.statusCode })
    );
    await expect(
      withErrorHandling(async () => new Response('ok'), customHandler)(context)
    ).resolves.toMatchObject({ status: 200 });
    const known = withErrorHandling(async () => {
      throw ErrorFactory.invalidGrant('Expired');
    }, customHandler);
    expect((await known(context)).status).toBe(400);
    const unknown = withErrorHandling(async () => {
      throw new Error('secret internal details');
    }, customHandler);
    const response = await unknown(context);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('server_error');
    expect(customHandler).toHaveBeenCalledTimes(2);
  });
});
