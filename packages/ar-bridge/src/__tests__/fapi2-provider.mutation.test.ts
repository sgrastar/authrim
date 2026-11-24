import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getFapi2ProviderQuirks,
  isFapi2Provider,
  loadFapi2ProviderConfig,
  validateFapi2ProviderMetadata,
} from '../services/fapi2-provider';
import type { ProviderMetadata, UpstreamProvider } from '../types';
import { decrypt } from '../utils/crypto';

vi.mock('../utils/crypto', () => ({ decrypt: vi.fn() }));

const providerWith = (quirks: unknown): UpstreamProvider =>
  ({ providerQuirks: quirks }) as unknown as UpstreamProvider;
const fapi2 = (value: unknown) => providerWith({ fapi2: value });

describe('getFapi2ProviderQuirks / isFapi2Provider', () => {
  it('returns the fapi2 object only', () => {
    const quirks = { enabled: true };
    expect(getFapi2ProviderQuirks(fapi2(quirks))).toBe(quirks);
    expect(getFapi2ProviderQuirks(fapi2(undefined))).toBeUndefined();
    expect(getFapi2ProviderQuirks(fapi2(null))).toBeUndefined();
    expect(getFapi2ProviderQuirks(fapi2('yes'))).toBeUndefined();
    expect(getFapi2ProviderQuirks(fapi2(5))).toBeUndefined();
    expect(getFapi2ProviderQuirks(fapi2([{ enabled: true }]))).toBeUndefined();
    expect(getFapi2ProviderQuirks(providerWith(undefined))).toBeUndefined();
    expect(getFapi2ProviderQuirks({} as UpstreamProvider)).toBeUndefined();
  });

  it('is true only for enabled: true', () => {
    expect(isFapi2Provider(fapi2({ enabled: true }))).toBe(true);
    expect(isFapi2Provider(fapi2({ enabled: false }))).toBe(false);
    expect(isFapi2Provider(fapi2({ enabled: 'true' }))).toBe(false);
    expect(isFapi2Provider(fapi2({}))).toBe(false);
    expect(isFapi2Provider(fapi2(null))).toBe(false);
    expect(isFapi2Provider(providerWith(undefined))).toBe(false);
  });
});

describe('validateFapi2ProviderMetadata', () => {
  const good: ProviderMetadata = {
    issuer: 'https://idp.example',
    pushed_authorization_request_endpoint: 'https://idp.example/par',
    require_pushed_authorization_requests: true,
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: ['PS256', 'ES256'],
    dpop_signing_alg_values_supported: ['ES256'],
    id_token_signing_alg_values_supported: ['ES256'],
    request_object_signing_alg_values_supported: ['ES256'],
    authorization_signing_alg_values_supported: ['PS256'],
  } as unknown as ProviderMetadata;
  const without = (key: string, value?: unknown): ProviderMetadata => ({ ...good, [key]: value });

  it('accepts complete metadata in either profile', () => {
    expect(() => validateFapi2ProviderMetadata(good, 'oidc')).not.toThrow();
    expect(() => validateFapi2ProviderMetadata(good, 'plain_oauth')).not.toThrow();
  });

  it('requires a PAR endpoint that is mandatory', () => {
    expect(() =>
      validateFapi2ProviderMetadata(without('pushed_authorization_request_endpoint'), 'oidc')
    ).toThrow('FAPI2 provider metadata has no pushed_authorization_request_endpoint');
    expect(() =>
      validateFapi2ProviderMetadata(without('pushed_authorization_request_endpoint', ''), 'oidc')
    ).toThrow('has no pushed_authorization_request_endpoint');
    for (const value of [undefined, false, 'true', 1]) {
      expect(() =>
        validateFapi2ProviderMetadata(
          without('require_pushed_authorization_requests', value),
          'oidc'
        )
      ).toThrow('FAPI2 provider metadata does not require pushed authorization requests');
    }
  });

  it('requires private_key_jwt, ES256 client assertions and ES256 DPoP', () => {
    for (const value of [undefined, [], ['client_secret_basic']]) {
      expect(() =>
        validateFapi2ProviderMetadata(
          without('token_endpoint_auth_methods_supported', value),
          'oidc'
        )
      ).toThrow('FAPI2 provider metadata does not support private_key_jwt');
    }
    for (const value of [undefined, [], ['PS256']]) {
      expect(() =>
        validateFapi2ProviderMetadata(
          without('token_endpoint_auth_signing_alg_values_supported', value),
          'oidc'
        )
      ).toThrow('FAPI2 provider metadata does not support ES256 client assertions');
    }
    for (const value of [undefined, [], ['RS256']]) {
      expect(() =>
        validateFapi2ProviderMetadata(without('dpop_signing_alg_values_supported', value), 'oidc')
      ).toThrow('FAPI2 provider metadata does not support ES256 DPoP proofs');
    }
  });

  it('requires ID token algorithms only for the oidc profile', () => {
    for (const value of [undefined, []]) {
      expect(() =>
        validateFapi2ProviderMetadata(
          without('id_token_signing_alg_values_supported', value),
          'oidc'
        )
      ).toThrow('FAPI2 OIDC provider metadata has no ID token signing algorithms');
      expect(() =>
        validateFapi2ProviderMetadata(
          without('id_token_signing_alg_values_supported', value),
          'plain_oauth'
        )
      ).not.toThrow();
    }
  });

  it('requires ES256 request objects only when request object signing is on', () => {
    const off = {
      requestObjectSigning: false,
      jarm: false,
      authorizationSignedResponseAlg: 'ES256' as const,
    };
    const on = { ...off, requestObjectSigning: true };
    for (const value of [undefined, [], ['PS256']]) {
      const metadata = without('request_object_signing_alg_values_supported', value);
      expect(() => validateFapi2ProviderMetadata(metadata, 'oidc', on)).toThrow(
        'FAPI2 Message Signing provider does not support ES256 request objects'
      );
      expect(() => validateFapi2ProviderMetadata(metadata, 'oidc', off)).not.toThrow();
      expect(() => validateFapi2ProviderMetadata(metadata, 'oidc')).not.toThrow();
    }
    expect(() => validateFapi2ProviderMetadata(good, 'oidc', on)).not.toThrow();
  });

  it('requires the configured JARM algorithm only when JARM is on', () => {
    const jarm = (alg: 'ES256' | 'PS256') => ({
      requestObjectSigning: false,
      jarm: true,
      authorizationSignedResponseAlg: alg,
    });
    expect(() => validateFapi2ProviderMetadata(good, 'oidc', jarm('PS256'))).not.toThrow();
    expect(() => validateFapi2ProviderMetadata(good, 'oidc', jarm('ES256'))).toThrow(
      'FAPI2 Message Signing provider does not support the configured JARM algorithm'
    );
    expect(() =>
      validateFapi2ProviderMetadata(
        without('authorization_signing_alg_values_supported'),
        'oidc',
        jarm('PS256')
      )
    ).toThrow('does not support the configured JARM algorithm');
    expect(() =>
      validateFapi2ProviderMetadata(good, 'oidc', {
        requestObjectSigning: false,
        jarm: false,
        authorizationSignedResponseAlg: 'ES256',
      })
    ).not.toThrow();
  });
});

describe('loadFapi2ProviderConfig', () => {
  const key = (kid: string, extra: Record<string, unknown> = {}) => ({
    kty: 'EC',
    crv: 'P-256',
    alg: 'ES256',
    use: 'sig',
    kid,
    x: `${kid}-x`,
    y: `${kid}-y`,
    d: `${kid}-d`,
    ...extra,
  });
  const base = {
    enabled: true,
    clientAssertionPrivateJwkEncrypted: 'enc-assertion',
    dpopPrivateJwkEncrypted: 'enc-dpop',
  };
  const load = (quirks: Record<string, unknown> = {}) =>
    loadFapi2ProviderConfig(fapi2({ ...base, ...quirks }), 'encryption-key');
  const keys = (assertion: unknown, dpop: unknown) =>
    vi
      .mocked(decrypt)
      .mockImplementation(async (value: string) =>
        typeof (value === 'enc-assertion' ? assertion : dpop) === 'string'
          ? String(value === 'enc-assertion' ? assertion : dpop)
          : JSON.stringify(value === 'enc-assertion' ? assertion : dpop)
      );

  beforeEach(() => {
    vi.mocked(decrypt).mockReset();
    keys(key('assertion'), key('dpop'));
  });

  it('decrypts each key with the encryption key and returns the defaults', async () => {
    expect(await load()).toEqual({
      clientAssertionPrivateJwk: key('assertion'),
      dpopPrivateJwk: key('dpop'),
      resourceUrl: undefined,
      discoveryUrl: undefined,
      profile: 'oidc',
      requestObjectSigning: false,
      jarm: false,
      authorizationSignedResponseAlg: 'ES256',
    });
    expect(decrypt).toHaveBeenCalledWith('enc-assertion', 'encryption-key');
    expect(decrypt).toHaveBeenCalledWith('enc-dpop', 'encryption-key');
  });

  it('applies the configured profile, signing options and URLs', async () => {
    expect(
      await load({
        profile: 'plain_oauth',
        resourceUrl: 'https://r.example/res',
        discoveryUrl: 'https://d.example/.well-known/openid-configuration',
        messageSigning: {
          requestObjectSigning: true,
          jarm: true,
          authorizationSignedResponseAlg: 'PS256',
        },
      })
    ).toMatchObject({
      profile: 'plain_oauth',
      resourceUrl: 'https://r.example/res',
      discoveryUrl: 'https://d.example/.well-known/openid-configuration',
      requestObjectSigning: true,
      jarm: true,
      authorizationSignedResponseAlg: 'PS256',
    });
  });

  it('treats anything but the exact values as the defaults', async () => {
    expect(
      await load({
        profile: 'other',
        messageSigning: {
          requestObjectSigning: 'true',
          jarm: 1,
          authorizationSignedResponseAlg: 'RS256',
        },
      })
    ).toMatchObject({
      profile: 'oidc',
      requestObjectSigning: false,
      jarm: false,
      authorizationSignedResponseAlg: 'ES256',
    });
  });

  it('requires an enabled provider with both encrypted keys', async () => {
    await expect(loadFapi2ProviderConfig(fapi2({ ...base, enabled: false }), 'k')).rejects.toThrow(
      'FAPI2 is not enabled for this provider'
    );
    await expect(loadFapi2ProviderConfig(providerWith(undefined), 'k')).rejects.toThrow(
      'FAPI2 is not enabled for this provider'
    );
    await expect(load({ clientAssertionPrivateJwkEncrypted: undefined })).rejects.toThrow(
      'FAPI2 client assertion key is not configured'
    );
    await expect(load({ clientAssertionPrivateJwkEncrypted: 5 })).rejects.toThrow(
      'FAPI2 client assertion key is not configured'
    );
    await expect(load({ dpopPrivateJwkEncrypted: undefined })).rejects.toThrow(
      'FAPI2 DPoP key is not configured'
    );
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('rejects a key that is not a JSON object', async () => {
    keys('{not json', key('dpop'));
    await expect(load()).rejects.toThrow('FAPI2 client assertion key is not valid JSON');
    keys(key('assertion'), '{not json');
    await expect(load()).rejects.toThrow('FAPI2 DPoP key is not valid JSON');
    for (const text of ['null', '[]', '"str"', '5']) {
      keys(text, key('dpop'));
      await expect(load()).rejects.toThrow('FAPI2 client assertion key must be a JWK object');
    }
    keys(key('assertion'), 'null');
    await expect(load()).rejects.toThrow('FAPI2 DPoP key must be a JWK object');
  });

  it.each([
    ['kty', { kty: 'RSA' }],
    ['crv', { crv: 'P-384' }],
    ['alg', { alg: 'ES384' }],
    ['use', { use: 'enc' }],
    ['kid missing', { kid: undefined }],
    ['kid empty', { kid: '' }],
    ['kid not a string', { kid: 5 }],
    ['x missing', { x: undefined }],
    ['x not a string', { x: 1 }],
    ['y missing', { y: undefined }],
    ['y not a string', { y: 1 }],
    ['d missing (a public key)', { d: undefined }],
    ['d not a string', { d: 1 }],
  ])('rejects a key with a bad %s', async (_label, change) => {
    keys(key('assertion', change), key('dpop'));
    await expect(load()).rejects.toThrow(
      'FAPI2 client assertion key must be a private EC P-256 ES256 signing JWK with kid'
    );
    keys(key('assertion'), key('dpop', change));
    await expect(load()).rejects.toThrow(
      'FAPI2 DPoP key must be a private EC P-256 ES256 signing JWK with kid'
    );
  });

  it('requires the two keys to differ in both identifier and point', async () => {
    keys(key('same'), key('same', { x: 'other-x', y: 'other-y' }));
    await expect(load()).rejects.toThrow('FAPI2 client assertion and DPoP keys must be distinct');
    keys(key('assertion'), key('dpop', { x: 'assertion-x', y: 'assertion-y' }));
    await expect(load()).rejects.toThrow('FAPI2 client assertion and DPoP keys must be distinct');
    keys(key('assertion'), key('dpop', { x: 'assertion-x' }));
    await expect(load()).resolves.toMatchObject({});
    keys(key('assertion'), key('dpop', { y: 'assertion-y' }));
    await expect(load()).resolves.toMatchObject({});
  });

  it('requires https for the resource and discovery URLs, and a parseable URL', async () => {
    await expect(load({ resourceUrl: 'http://r.example/res' })).rejects.toThrow(
      'FAPI2 resource URL must use HTTPS'
    );
    await expect(load({ discoveryUrl: 'http://d.example/x' })).rejects.toThrow(
      'FAPI2 discovery URL must use HTTPS'
    );
    await expect(load({ resourceUrl: 'not a url' })).rejects.toThrow();
    await expect(load({ discoveryUrl: '' })).rejects.toThrow();
  });
});
