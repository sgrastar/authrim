import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFapi2ProviderConfig, validateFapi2ProviderMetadata } from '../services/fapi2-provider';
import type { ProviderMetadata } from '../types';
import type { UpstreamProvider } from '../types';
import { decrypt } from '../utils/crypto';

vi.mock('../utils/crypto', () => ({ decrypt: vi.fn() }));

const assertionKey = {
  kty: 'EC',
  crv: 'P-256',
  alg: 'ES256',
  use: 'sig',
  kid: 'assertion',
  x: 'assertion-x',
  y: 'assertion-y',
  d: 'assertion-d',
};
const dpopKey = {
  ...assertionKey,
  kid: 'dpop',
  x: 'dpop-x',
  y: 'dpop-y',
  d: 'dpop-d',
};

function provider(fapi2: Record<string, unknown>): UpstreamProvider {
  return { providerQuirks: { fapi2 } } as unknown as UpstreamProvider;
}

describe('loadFapi2ProviderConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('decrypts and validates separated ES256 keys', async () => {
    vi.mocked(decrypt)
      .mockResolvedValueOnce(JSON.stringify(assertionKey))
      .mockResolvedValueOnce(JSON.stringify(dpopKey));

    const result = await loadFapi2ProviderConfig(
      provider({
        enabled: true,
        clientAssertionPrivateJwkEncrypted: 'encrypted-assertion',
        dpopPrivateJwkEncrypted: 'encrypted-dpop',
        profile: 'oidc',
        resourceUrl: 'https://resource.example.com/accounts',
      }),
      'encryption-key'
    );

    expect(result.clientAssertionPrivateJwk).toEqual(assertionKey);
    expect(result.dpopPrivateJwk).toEqual(dpopKey);
    expect(result.profile).toBe('oidc');
    expect(result).toMatchObject({
      requestObjectSigning: false,
      jarm: false,
      authorizationSignedResponseAlg: 'ES256',
    });
    expect(decrypt).toHaveBeenCalledTimes(2);
  });

  it('rejects a public-only key', async () => {
    const { d: _d, ...publicKey } = assertionKey;
    vi.mocked(decrypt)
      .mockResolvedValueOnce(JSON.stringify(publicKey))
      .mockResolvedValueOnce(JSON.stringify(dpopKey));

    await expect(
      loadFapi2ProviderConfig(
        provider({
          enabled: true,
          clientAssertionPrivateJwkEncrypted: 'encrypted-assertion',
          dpopPrivateJwkEncrypted: 'encrypted-dpop',
        }),
        'encryption-key'
      )
    ).rejects.toThrow('private EC P-256 ES256');
  });

  it('rejects reuse of the same key for client authentication and DPoP', async () => {
    vi.mocked(decrypt)
      .mockResolvedValueOnce(JSON.stringify(assertionKey))
      .mockResolvedValueOnce(JSON.stringify(assertionKey));

    await expect(
      loadFapi2ProviderConfig(
        provider({
          enabled: true,
          clientAssertionPrivateJwkEncrypted: 'encrypted-assertion',
          dpopPrivateJwkEncrypted: 'encrypted-dpop',
        }),
        'encryption-key'
      )
    ).rejects.toThrow('must be distinct');
  });

  it('rejects missing encrypted keys before decryption', async () => {
    await expect(
      loadFapi2ProviderConfig(provider({ enabled: true }), 'encryption-key')
    ).rejects.toThrow('client assertion key is not configured');
    expect(decrypt).not.toHaveBeenCalled();
  });
});

describe('validateFapi2ProviderMetadata', () => {
  const metadata = {
    pushed_authorization_request_endpoint: 'https://server.example.com/par',
    require_pushed_authorization_requests: true,
    token_endpoint_auth_methods_supported: ['private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: ['ES256'],
    dpop_signing_alg_values_supported: ['ES256'],
    id_token_signing_alg_values_supported: ['PS256'],
  } as ProviderMetadata;

  it('accepts metadata with the required FAPI2 capabilities', () => {
    expect(() => validateFapi2ProviderMetadata(metadata, 'oidc')).not.toThrow();
  });

  it('rejects PAR and algorithm downgrade metadata', () => {
    expect(() =>
      validateFapi2ProviderMetadata(
        { ...metadata, require_pushed_authorization_requests: false },
        'oidc'
      )
    ).toThrow('does not require pushed');
    expect(() =>
      validateFapi2ProviderMetadata(
        { ...metadata, dpop_signing_alg_values_supported: ['PS256'] },
        'oidc'
      )
    ).toThrow('ES256 DPoP');
  });

  it('requires configured Message Signing algorithms in metadata', () => {
    const messageSigningMetadata = {
      ...metadata,
      request_object_signing_alg_values_supported: ['ES256'],
      authorization_signing_alg_values_supported: ['ES256'],
    };
    expect(() =>
      validateFapi2ProviderMetadata(messageSigningMetadata, 'plain_oauth', {
        requestObjectSigning: true,
        jarm: true,
        authorizationSignedResponseAlg: 'ES256',
      })
    ).not.toThrow();
    expect(() =>
      validateFapi2ProviderMetadata(
        { ...messageSigningMetadata, authorization_signing_alg_values_supported: ['PS256'] },
        'plain_oauth',
        {
          requestObjectSigning: false,
          jarm: true,
          authorizationSignedResponseAlg: 'ES256',
        }
      )
    ).toThrow('configured JARM algorithm');
  });
});
