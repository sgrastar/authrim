/**
 * External start: silent sign-in SSO resolution, Apple response mode, request objects.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mocks, setupStartMocks } from './helpers/start-mocks';
import { argRec } from './helpers/mock-args';
import {
  FIXED_STATE,
  SIGN_IN,
  baseProvider,
  makeEnv,
  makeKv,
  must,
  start,
} from './helpers/start-harness';

const env = (extra: Record<string, unknown> = {}) => makeEnv(makeKv(), extra);
const stateArg = () => argRec(mocks.storeAuthState, 0, 1);

beforeEach(setupStartMocks);

const SSO_OFF = 'SSO is disabled for this client';
const silent = (extra = '', p = baseProvider) => {
  mocks.getProvider.mockResolvedValue(p);
  return start(`${SIGN_IN}&prompt=none${extra}`, env());
};
const errorOf = (response: Response) => {
  const location = new URL(must(response.headers.get('Location')));
  return Object.fromEntries(location.searchParams);
};

describe('silent sign-in (prompt=none)', () => {
  it('refuses prompt=none combined with other values, returning to the redirect target', async () => {
    const response = await start(
      `${SIGN_IN}&prompt=none%20login&state=client-state&redirect_uri=${encodeURIComponent('https://login.example.com/callback')}`,
      env()
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const location = new URL(must(response.headers.get('Location')));
    expect(location.origin + location.pathname).toBe('https://login.example.com/callback');
    expect(Object.fromEntries(location.searchParams)).toEqual({
      error: 'invalid_request',
      error_description: 'prompt=none cannot be combined with other values',
      state: 'client-state',
    });
  });

  it('stores the state before deciding, with prompt none', async () => {
    await silent();
    expect(stateArg()).toMatchObject({ prompt: 'none', state: FIXED_STATE });
  });

  it('settings: registers both categories and reads the client settings by client id', async () => {
    await silent();
    const managerArgs = argRec(mocks.createSettingsManager);
    expect(managerArgs.env).toEqual(
      expect.objectContaining({ ISSUER_URL: 'https://auth.example.com' })
    );
    expect(managerArgs.kv).toEqual(expect.anything());
    expect(mocks.registerCategory).toHaveBeenCalledWith({ name: 'client-meta' });
    expect(mocks.registerCategory).toHaveBeenCalledWith({ name: 'oauth-meta' });
    expect(mocks.getAll).toHaveBeenCalledWith('client', {
      type: 'client',
      id: 'client-a',
      tenantId: 'default',
    });
  });

  it('settings: passes a null kv when the binding is absent', async () => {
    mocks.getProvider.mockResolvedValue(baseProvider);
    await start(`${SIGN_IN}&prompt=none`, makeEnv(makeKv(), { SETTINGS: undefined }));
    expect(argRec(mocks.createSettingsManager, 0, 0).kv).toBeNull();
  });

  it('a client override of false turns SSO off, adds the client state, and skips the rest', async () => {
    mocks.getAll.mockResolvedValue({
      values: { 'client.sso_enabled': false },
      sources: { 'client.sso_enabled': 'kv' },
    });
    const response = await silent('&state=client-state');
    expect(response.status).toBe(302);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(errorOf(response)).toEqual({
      error: 'login_required',
      error_description: SSO_OFF,
      state: 'client-state',
    });
    expect(mocks.profileSso).not.toHaveBeenCalled();
    expect(mocks.resolveEffective).not.toHaveBeenCalled();
  });

  it('omits the state from the SSO-disabled redirect when the client sent none', async () => {
    mocks.getAll.mockResolvedValue({
      values: { 'client.sso_enabled': false },
      sources: { 'client.sso_enabled': 'kv' },
    });
    expect(errorOf(await silent())).toEqual({
      error: 'login_required',
      error_description: SSO_OFF,
    });
  });

  it('a client override of true keeps SSO on and does not consult profile or tenant', async () => {
    mocks.getAll.mockResolvedValue({
      values: { 'client.sso_enabled': true },
      sources: { 'client.sso_enabled': 'kv' },
    });
    const response = await silent('', { ...baseProvider, enableSso: false });
    expect(errorOf(response).error_description).not.toBe(SSO_OFF);
    expect(mocks.profileSso).not.toHaveBeenCalled();
    expect(mocks.resolveEffective).not.toHaveBeenCalled();
  });

  it('ignores a client category default (not an override) and asks the profile', async () => {
    mocks.getAll.mockResolvedValue({
      values: { 'client.sso_enabled': false },
      sources: { 'client.sso_enabled': 'default' },
    });
    mocks.profileSso.mockResolvedValue(false);
    expect(errorOf(await silent()).error_description).toBe(SSO_OFF);
    expect(mocks.profileSso).toHaveBeenCalledWith(
      expect.anything(),
      { marker: 'core' },
      'default',
      'client-a'
    );
    expect(mocks.resolveEffective).not.toHaveBeenCalled();
  });

  it('asks the profile when the client settings cannot be read', async () => {
    mocks.getAll.mockRejectedValue(new Error('kv'));
    mocks.profileSso.mockResolvedValue(false);
    expect(errorOf(await silent()).error_description).toBe(SSO_OFF);
  });

  it('a profile of true overrides a provider that defaults to off, skipping the tenant', async () => {
    mocks.profileSso.mockResolvedValue(true);
    const response = await silent('', { ...baseProvider, enableSso: false });
    expect(errorOf(response).error_description).not.toBe(SSO_OFF);
    expect(mocks.resolveEffective).not.toHaveBeenCalled();
  });

  it('falls to the tenant setting when neither client nor profile sets it', async () => {
    mocks.resolveEffective.mockResolvedValue({ 'oauth.sso_enabled': false });
    expect(errorOf(await silent()).error_description).toBe(SSO_OFF);
    expect(mocks.resolveEffective).toHaveBeenCalledWith(expect.anything(), 'oauth', {
      tenantId: 'default',
    });
  });

  it('a tenant setting of true turns SSO on for a provider that defaults to off', async () => {
    mocks.resolveEffective.mockResolvedValue({ 'oauth.sso_enabled': true });
    const response = await silent('', { ...baseProvider, enableSso: false });
    expect(errorOf(response).error_description).not.toBe(SSO_OFF);
  });

  it('keeps the provider default when the tenant sets nothing boolean', async () => {
    mocks.resolveEffective.mockResolvedValue({ 'oauth.sso_enabled': 'yes' });
    expect(errorOf(await silent()).error_description).not.toBe(SSO_OFF);
    expect(errorOf(await silent('', { ...baseProvider, enableSso: false })).error_description).toBe(
      SSO_OFF
    );
  });

  it('turns SSO off when the tenant setting cannot be read, and logs it', async () => {
    mocks.resolveEffective.mockRejectedValue(new Error('kv down'));
    expect(errorOf(await silent()).error_description).toBe(SSO_OFF);
    expect(mocks.warn).toHaveBeenCalledWith('Tenant SSO setting unreadable, single sign-on off', {
      tenantId: 'default',
      error: 'kv down',
    });
  });

  it('stringifies a non-Error tenant failure', async () => {
    mocks.resolveEffective.mockRejectedValue('plain');
    await silent();
    expect(argRec(mocks.warn, 0, 1).error).toBe('plain');
  });

  it('keeps the provider default when the settings machinery fails', async () => {
    mocks.createSettingsManager.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(errorOf(await silent()).error_description).not.toBe(SSO_OFF);
    expect(errorOf(await silent('', { ...baseProvider, enableSso: false })).error_description).toBe(
      SSO_OFF
    );
    expect(mocks.warn).toHaveBeenCalledWith('Failed to load SSO settings, using provider default', {
      action: 'sso_check_error',
      error: 'boom',
    });
  });
});

describe('Apple provider response mode', () => {
  const apple = (overrides: Record<string, unknown>) => ({
    ...baseProvider,
    issuer: 'https://appleid.apple.com',
    ...overrides,
  });
  const modeOf = async (p: unknown) => {
    mocks.getProvider.mockResolvedValue(p);
    mocks.createAuthorizationUrl.mockClear();
    await start(SIGN_IN, env());
    expect(mocks.createAuthorizationUrl).toHaveBeenCalledTimes(1);
    return argRec(mocks.createAuthorizationUrl, 0, 0).responseMode;
  };

  it('uses form_post when name or email is requested', async () => {
    expect(await modeOf(apple({ scopes: 'openid email' }))).toBe('form_post');
    expect(await modeOf(apple({ scopes: 'openid NAME' }))).toBe('form_post');
  });

  it('keeps the default response mode with neither scope, with useFormPost false, or off Apple', async () => {
    expect(await modeOf(apple({ scopes: 'openid' }))).toBeUndefined();
    expect(await modeOf(apple({ scopes: undefined }))).toBeUndefined();
    expect(
      await modeOf(apple({ scopes: 'openid email', providerQuirks: { useFormPost: false } }))
    ).toBeUndefined();
    expect(
      await modeOf(apple({ scopes: 'openid email', providerQuirks: { useFormPost: true } }))
    ).toBe('form_post');
    expect(await modeOf({ ...baseProvider, scopes: 'openid email' })).toBeUndefined();
  });
});

describe('request objects registered at the provider', () => {
  it('passes a per-state request_uri and a publisher bound to this state', async () => {
    mocks.dynamicConfig.mockReturnValue({
      requestUris: ['https://rp.example/request-object?existing=1', 'https://rp.example/other'],
    });
    await start(SIGN_IN, env());
    const options = argRec(mocks.createAuthorizationUrl, 0, 0);
    expect(options.requestUri).toBe(
      `https://rp.example/request-object?existing=1&id=${FIXED_STATE}`
    );
    const publish = options.publishRequestObject as (requestObject: string) => Promise<void>;
    await publish('signed.jwt.value');
    expect(mocks.publishRequestObject).toHaveBeenCalledWith(
      expect.anything(),
      'default',
      'provider-a',
      FIXED_STATE,
      'signed.jwt.value'
    );
  });

  it('passes no request_uri without a registered one', async () => {
    mocks.dynamicConfig.mockReturnValue({ requestUris: [] });
    await start(SIGN_IN, env());
    expect(argRec(mocks.createAuthorizationUrl, 0, 0).requestUri).toBeUndefined();
  });
});
