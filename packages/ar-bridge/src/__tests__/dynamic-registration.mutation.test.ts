import { beforeEach, describe, expect, it, vi } from 'vitest';
import { argRec, callArg } from './helpers/mock-args';
import type { Env } from '@authrim/ar-lib-core';
import type { UpstreamProvider } from '../types';
import { encrypt, decrypt } from '../utils/crypto';

const mocks = vi.hoisted(() => ({
  fromProvider: vi.fn(),
  registerClient: vi.fn(),
  updateProvider: vi.fn(),
}));

vi.mock('../clients/oidc-client', () => ({
  OIDCRPClient: { fromProvider: mocks.fromProvider },
}));
vi.mock('../services/provider-store', () => ({ updateProvider: mocks.updateProvider }));

import {
  ensureDynamicClientRegistration,
  getDynamicClientRegistrationConfig,
} from '../services/dynamic-registration';

const KEY = '3f9a1c7e5b2d48a06c91e7f3d5a8b2c4e6f10a9b8c7d6e5f4a3b2c1d0e9f8a7b';
const ENV = { RP_TOKEN_ENCRYPTION_KEY: KEY } as unknown as Env;

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

async function provider(overrides: Partial<UpstreamProvider> = {}): Promise<UpstreamProvider> {
  return {
    id: 'prov-1',
    name: 'Prov Name',
    issuer: 'https://op.example',
    clientId: 'old-client',
    clientSecretEncrypted: await encrypt('old-secret', KEY),
    providerQuirks: { dynamicClientRegistration: { enabled: true } },
    ...overrides,
  } as unknown as UpstreamProvider;
}

describe('getDynamicClientRegistrationConfig', () => {
  const withConfig = (value: unknown) =>
    getDynamicClientRegistrationConfig({
      providerQuirks: { dynamicClientRegistration: value },
    } as unknown as UpstreamProvider);

  it('returns undefined without quirks or with a non-object value', () => {
    expect(getDynamicClientRegistrationConfig({} as UpstreamProvider)).toBeUndefined();
    expect(withConfig(undefined)).toBeUndefined();
    expect(withConfig(null)).toBeUndefined();
    expect(withConfig('yes')).toBeUndefined();
    expect(withConfig(true)).toBeUndefined();
    expect(withConfig([{ enabled: true }])).toBeUndefined();
  });

  it('requires enabled to be strictly true', () => {
    expect(withConfig({ enabled: false })).toBeUndefined();
    expect(withConfig({ enabled: 'true' })).toBeUndefined();
    expect(withConfig({})).toBeUndefined();
  });

  it('returns only enabled with every optional field undefined when absent', () => {
    expect(withConfig({ enabled: true })).toEqual({
      enabled: true,
      registeredIssuer: undefined,
      clientName: undefined,
      initiateLoginUri: undefined,
      requestUris: undefined,
      userinfoSignedResponseAlg: undefined,
      initialAccessTokenEncrypted: undefined,
    });
  });

  it('copies each string field and filters requestUris to strings', () => {
    expect(
      withConfig({
        enabled: true,
        registeredIssuer: 'https://r.example',
        clientName: 'Name',
        initiateLoginUri: 'https://rp.example/login',
        requestUris: ['https://a', 3, null, 'https://b'],
        userinfoSignedResponseAlg: 'RS256',
        initialAccessTokenEncrypted: 'enc',
      })
    ).toEqual({
      enabled: true,
      registeredIssuer: 'https://r.example',
      clientName: 'Name',
      initiateLoginUri: 'https://rp.example/login',
      requestUris: ['https://a', 'https://b'],
      userinfoSignedResponseAlg: 'RS256',
      initialAccessTokenEncrypted: 'enc',
    });
  });

  it('drops non-string field values', () => {
    const config = must(
      withConfig({
        enabled: true,
        registeredIssuer: 1,
        clientName: 2,
        initiateLoginUri: 3,
        requestUris: 'x',
        userinfoSignedResponseAlg: 4,
        initialAccessTokenEncrypted: 5,
      })
    );
    expect(config.registeredIssuer).toBeUndefined();
    expect(config.clientName).toBeUndefined();
    expect(config.initiateLoginUri).toBeUndefined();
    expect(config.requestUris).toBeUndefined();
    expect(config.userinfoSignedResponseAlg).toBeUndefined();
    expect(config.initialAccessTokenEncrypted).toBeUndefined();
  });
});

describe('ensureDynamicClientRegistration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fromProvider.mockReturnValue({ registerClient: mocks.registerClient });
    mocks.registerClient.mockResolvedValue({
      client_id: 'new-client',
      client_secret: 'new-secret',
      token_endpoint_auth_method: 'client_secret_post',
    });
  });

  const run = (p: UpstreamProvider, extra: { force?: boolean; env?: Env } = {}) =>
    ensureDynamicClientRegistration({
      env: extra.env ?? ENV,
      tenantId: 'tenant-1',
      provider: p,
      callbackUri: 'https://rp.example/cb',
      force: extra.force,
    });

  it('fails when no encryption key is configured, before anything else', async () => {
    await expect(run(await provider(), { env: {} as Env })).rejects.toThrow(
      'RP token encryption key is not configured'
    );
    expect(mocks.fromProvider).not.toHaveBeenCalled();
  });

  it('returns the decrypted secret unregistered when the config is absent', async () => {
    const p = await provider({ providerQuirks: undefined });
    const result = await run(p);
    expect(result).toEqual({ provider: p, clientSecret: 'old-secret', registered: false });
    expect(mocks.fromProvider).not.toHaveBeenCalled();
  });

  it('skips registration when already registered for the same issuer', async () => {
    const p = await provider({
      providerQuirks: {
        dynamicClientRegistration: { enabled: true, registeredIssuer: 'https://op.example' },
      },
    });
    const result = await run(p);
    expect(result.registered).toBe(false);
    expect(result.clientSecret).toBe('old-secret');
    expect(mocks.registerClient).not.toHaveBeenCalled();
  });

  it('registers when the registered issuer differs', async () => {
    const p = await provider({
      providerQuirks: {
        dynamicClientRegistration: { enabled: true, registeredIssuer: 'https://other.example' },
      },
    });
    mocks.updateProvider.mockResolvedValue({ id: 'prov-1' });
    expect((await run(p)).registered).toBe(true);
  });

  it('force re-registers even when the issuer matches', async () => {
    const p = await provider({
      providerQuirks: {
        dynamicClientRegistration: { enabled: true, registeredIssuer: 'https://op.example' },
      },
    });
    mocks.updateProvider.mockResolvedValue({ id: 'prov-1' });
    expect((await run(p, { force: true })).registered).toBe(true);
    expect(mocks.registerClient).toHaveBeenCalledTimes(1);
  });

  it('requires an issuer', async () => {
    const p = await provider({ issuer: undefined });
    await expect(run(p, { force: true })).rejects.toThrow(
      'Dynamic registration requires an issuer'
    );
    expect(mocks.fromProvider).not.toHaveBeenCalled();
  });

  it('builds the registration client and sends the full request', async () => {
    const initialAccessTokenEncrypted = await encrypt('iat-token', KEY);
    const p = await provider({
      name: 'Prov Name',
      tokenEndpointAuthMethod: 'client_secret_post',
      useRequestObject: true,
      requestObjectSigningAlg: 'ES256',
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      providerQuirks: {
        dynamicClientRegistration: {
          enabled: true,
          clientName: 'Custom',
          initiateLoginUri: 'https://rp.example/initiate',
          requestUris: ['https://rp.example/ro'],
          userinfoSignedResponseAlg: 'RS256',
          initialAccessTokenEncrypted,
        },
      },
    });
    mocks.updateProvider.mockResolvedValue({ id: 'prov-1' });
    await run(p);
    expect(mocks.fromProvider).toHaveBeenCalledWith(p, 'https://rp.example/cb', 'old-secret');
    expect(mocks.registerClient).toHaveBeenCalledWith({
      redirect_uris: ['https://rp.example/cb'],
      client_name: 'Custom',
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      application_type: 'web',
      initiate_login_uri: 'https://rp.example/initiate',
      request_uris: ['https://rp.example/ro'],
      request_object_signing_alg: 'ES256',
      userinfo_signed_response_alg: 'RS256',
      jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }] },
      initialAccessToken: 'iat-token',
    });
  });

  it('uses defaults: provider name, basic auth, no request object, no jwks, no token', async () => {
    const p = await provider({
      useRequestObject: false,
      requestObjectSigningAlg: 'ES256',
    });
    mocks.updateProvider.mockResolvedValue({ id: 'prov-1' });
    await run(p);
    const request = argRec(mocks.registerClient);
    expect(request.client_name).toBe('Prov Name');
    expect(request.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(request.request_object_signing_alg).toBeUndefined();
    expect(request.jwks).toBeUndefined();
    expect(request.initialAccessToken).toBeUndefined();
  });

  it('rejects a registration without a secret before persisting', async () => {
    mocks.registerClient.mockResolvedValue({ client_id: 'new-client' });
    await expect(run(await provider())).rejects.toThrow(
      'Dynamic registration did not return a client secret'
    );
    expect(mocks.updateProvider).not.toHaveBeenCalled();
  });

  it('persists the new credentials encrypted and records the registered issuer', async () => {
    const updated = { id: 'prov-1', clientId: 'new-client' };
    mocks.updateProvider.mockResolvedValue(updated);
    const p = await provider({
      providerQuirks: {
        other: 'kept',
        dynamicClientRegistration: { enabled: true, clientName: 'Custom' },
      },
    });
    const result = await run(p);
    expect(result).toEqual({ provider: updated, clientSecret: 'new-secret', registered: true });
    expect(mocks.updateProvider).toHaveBeenCalledTimes(1);
    expect(callArg(mocks.updateProvider, 0, 0)).toBe(ENV);
    expect(callArg(mocks.updateProvider, 0, 1)).toBe('tenant-1');
    expect(callArg(mocks.updateProvider, 0, 2)).toBe('prov-1');
    const patch = argRec(mocks.updateProvider, 0, 3);
    expect(patch.clientId).toBe('new-client');
    expect(await decrypt(String(patch.clientSecretEncrypted), KEY)).toBe('new-secret');
    expect(patch.tokenEndpointAuthMethod).toBe('client_secret_post');
    expect(patch.providerQuirks).toEqual({
      other: 'kept',
      dynamicClientRegistration: {
        enabled: true,
        clientName: 'Custom',
        registeredIssuer: 'https://op.example',
      },
    });
  });

  it('falls back to client_secret_basic for any other returned auth method', async () => {
    mocks.registerClient.mockResolvedValue({
      client_id: 'c',
      client_secret: 's',
      token_endpoint_auth_method: 'private_key_jwt',
    });
    mocks.updateProvider.mockResolvedValue({ id: 'prov-1' });
    await run(await provider());
    expect(argRec(mocks.updateProvider, 0, 3).tokenEndpointAuthMethod).toBe('client_secret_basic');
  });

  it('fails when the provider vanished while persisting', async () => {
    mocks.updateProvider.mockResolvedValue(null);
    await expect(run(await provider())).rejects.toThrow(
      'Provider disappeared during dynamic registration'
    );
  });
});
