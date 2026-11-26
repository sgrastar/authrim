/**
 * Issuer trust: signing-key rules, metadata fetch options, DID method selection and the
 * self-issuance guard.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';

const m = vi.hoisted(() => {
  const logger = { module: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.module.mockReturnValue(logger);
  return {
    logger,
    importECPublicKey: vi.fn(),
    safeFetchJson: vi.fn(),
    resolveDID: vi.fn(),
    importJWK: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => m.logger),
    importECPublicKey: m.importECPublicKey,
    safeFetchJson: m.safeFetchJson,
    resolveDID: m.resolveDID,
  };
});
vi.mock('jose', () => ({ importJWK: m.importJWK }));

import { checkSelfIssuance, getIssuerPublicKey, jwtVcIssuerMetadataUrl } from '../issuer-trust';

const loggerModuleNames = m.logger.module.mock.calls.map((call): unknown => call[0]);
const env = {} as Env;
const DID = 'did:web:issuer.example';
const JWKS_URI = 'https://issuer.example/jwks';
const EC = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };

beforeEach(() => {
  vi.clearAllMocks();
  m.logger.module.mockReturnValue(m.logger);
  m.importECPublicKey.mockResolvedValue('ec-key');
  m.importJWK.mockResolvedValue('okp-key');
});

describe('issuer trust logging and metadata URL', () => {
  it('names its logger module', () => {
    expect(loggerModuleNames).toContain('VC-ISSUER-TRUST');
  });

  it.each([
    ['a query', 'https://issuer.example/t?x=1'],
    ['a fragment', 'https://issuer.example/t#frag'],
    ['credentials', 'https://user:pw@issuer.example/t'],
    ['a username only', 'https://user@issuer.example/t'],
    ['http', 'http://issuer.example/t'],
  ])('refuses an issuer URL with %s', (_name, url) => {
    expect(() => jwtVcIssuerMetadataUrl(url)).toThrow(
      'Issuer must be an https URL without query, fragment or credentials'
    );
  });

  it('inserts the well-known segment and drops one trailing slash', () => {
    expect(jwtVcIssuerMetadataUrl('https://issuer.example')).toBe(
      'https://issuer.example/.well-known/jwt-vc-issuer'
    );
    expect(jwtVcIssuerMetadataUrl('https://issuer.example/t/a/')).toBe(
      'https://issuer.example/.well-known/jwt-vc-issuer/t/a'
    );
  });
});

describe('SD-JWT VC issuer metadata', () => {
  const ISSUER = 'https://issuer.example';

  it('fetches the metadata with the bounded options', async () => {
    m.safeFetchJson.mockResolvedValue({ issuer: ISSUER, jwks: { keys: [EC] } });
    await getIssuerPublicKey(env, ISSUER);
    expect(m.safeFetchJson).toHaveBeenCalledWith(
      'https://issuer.example/.well-known/jwt-vc-issuer',
      {
        headers: { Accept: 'application/json' },
        requireHttps: true,
        timeoutMs: 10000,
        maxResponseSize: 256 * 1024,
      }
    );
  });

  it.each([
    ['null jwks', null],
    ['jwks without keys', {}],
    ['jwks whose keys is not a list', { keys: 'x' }],
  ])('refuses %s', async (_name, jwks) => {
    m.safeFetchJson.mockResolvedValue({ issuer: ISSUER, jwks });
    await expect(getIssuerPublicKey(env, ISSUER)).rejects.toThrow(
      'Issuer metadata jwks has no keys'
    );
  });

  it('refuses a jwks_uri that is not a URL and one that is not a string', async () => {
    m.safeFetchJson.mockResolvedValue({ issuer: ISSUER, jwks_uri: 'not a url' });
    await expect(getIssuerPublicKey(env, ISSUER)).rejects.toThrow(
      'Issuer metadata jwks_uri is not a URL'
    );
    m.safeFetchJson.mockResolvedValue({ issuer: ISSUER, jwks_uri: 5 });
    await expect(getIssuerPublicKey(env, ISSUER)).rejects.toThrow(
      'Issuer metadata has neither jwks nor jwks_uri'
    );
  });

  it('refuses a jwks_uri on the issuer host with another scheme', async () => {
    m.safeFetchJson.mockResolvedValue({ issuer: ISSUER, jwks_uri: 'http://issuer.example/jwks' });
    await expect(getIssuerPublicKey(env, ISSUER)).rejects.toThrow(
      'Issuer metadata jwks_uri must be on the issuer origin'
    );
    expect(m.safeFetchJson).toHaveBeenCalledTimes(1);
  });

  it('lets a jwks_uri of the metadata serve keys without use and alg', async () => {
    m.safeFetchJson
      .mockResolvedValueOnce({ issuer: ISSUER, jwks_uri: 'https://issuer.example/keys' })
      .mockResolvedValueOnce({ keys: [EC] });
    expect(await getIssuerPublicKey(env, ISSUER)).toBe('ec-key');
    expect(m.safeFetchJson).toHaveBeenLastCalledWith('https://issuer.example/keys', {
      headers: { Accept: 'application/json' },
      requireHttps: true,
      timeoutMs: 10000,
      maxResponseSize: 256 * 1024,
    });
    expect(m.importECPublicKey).toHaveBeenCalledWith({ ...EC, alg: 'ES256' });
  });
});

describe('JWKS signing-key rules', () => {
  const fromJwks = (keys: unknown[], kid?: string) => {
    m.safeFetchJson.mockResolvedValue({ keys });
    return getIssuerPublicKey(env, DID, JWKS_URI, kid);
  };
  const sig = { ...EC, use: 'sig', alg: 'ES256' };

  it('accepts ES512 keys and a verify-only key_ops list', async () => {
    await fromJwks([{ kty: 'EC', crv: 'P-521', x: 'x', y: 'y', use: 'sig', alg: 'ES512' }]);
    expect(m.importECPublicKey).toHaveBeenCalledTimes(1);
    await fromJwks([{ ...sig, key_ops: ['verify'], kid: 'a' }], 'a');
    expect(m.importECPublicKey).toHaveBeenCalledTimes(2);
  });

  it('refuses a key without use or without alg when no kid names it', async () => {
    for (const key of [
      EC,
      { ...EC, use: 'sig' },
      { ...EC, alg: 'ES256' },
      { ...EC, use: 'sig', alg: 'none' },
      { ...EC, use: 'sig', alg: '' },
    ]) {
      await expect(fromJwks([key])).rejects.toThrow('No suitable EC signing key found in JWKS');
    }
    expect(m.importECPublicKey).not.toHaveBeenCalled();
  });

  it('lets a kid name a key that omits use and alg and fills in the curve algorithm', async () => {
    await fromJwks([{ ...EC, kid: 'a' }], 'a');
    expect(m.importECPublicKey).toHaveBeenCalledWith({ ...EC, kid: 'a', alg: 'ES256' });
  });

  it('refuses a key whose alg or curve does not fit, even by kid', async () => {
    for (const key of [
      { ...EC, kid: 'a', alg: 'ES384' },
      { ...EC, kid: 'a', crv: 'secp256k1' },
      { ...EC, kid: 'a', crv: undefined },
      { ...EC, kid: 'a', use: 'enc' },
      { ...EC, kid: 'a', key_ops: ['sign'] },
      { kty: 'OKP', crv: 'Ed25519', x: 'x', kid: 'a', use: 'sig', alg: 'EdDSA' },
    ]) {
      await expect(fromJwks([key], 'a')).rejects.toThrow(
        'No suitable EC signing key found in JWKS'
      );
    }
  });

  it('refuses several keys with one kid', async () => {
    await expect(
      fromJwks(
        [
          { ...sig, kid: 'a' },
          { ...sig, kid: 'a' },
        ],
        'a'
      )
    ).rejects.toThrow(
      'JWKS has several matching signing keys: the signature must name one with kid'
    );
  });

  it('fetches a JWKS with the bounded options', async () => {
    await fromJwks([sig]);
    expect(m.safeFetchJson).toHaveBeenCalledWith(JWKS_URI, {
      headers: { Accept: 'application/json' },
      requireHttps: true,
      timeoutMs: 10000,
      maxResponseSize: 256 * 1024,
    });
  });
});

describe('DID document keys', () => {
  const method = (id: string, publicKeyJwk?: Record<string, unknown>, controller = DID) => ({
    id,
    type: 'JsonWebKey2020',
    controller,
    publicKeyJwk,
  });
  const resolveWith = (doc: Record<string, unknown>) => m.resolveDID.mockResolvedValue(doc);

  it('refuses a named method without a key, with the unsupported-key error', async () => {
    resolveWith({ verificationMethod: [method('#k', undefined)], assertionMethod: ['#k'] });
    await expect(getIssuerPublicKey(env, DID, undefined, 'k')).rejects.toThrow(
      'Verification method is not a supported signing key'
    );
  });

  it('refuses a named method whose controller is another DID', async () => {
    resolveWith({
      verificationMethod: [method('#k', { ...EC }, 'did:web:other.example')],
      assertionMethod: ['#k'],
    });
    await expect(getIssuerPublicKey(env, DID, undefined, 'k')).rejects.toThrow(
      'Verification method is controlled by another DID'
    );
  });

  it('refuses keys of an unsupported type or with mismatched or ruled-out stated fields', async () => {
    for (const jwk of [
      { kty: 'RSA', n: 'n', e: 'e' },
      { kty: 'RSA', crv: 'Ed25519', x: 'x' },
      { kty: 'OKP', crv: 'X25519', x: 'x' },
      { kty: 'OKP', crv: 'Ed25519', x: 'x', alg: 'ES256' },
      { ...EC, alg: 'ES384' },
      { ...EC, key_ops: ['sign'] },
    ]) {
      resolveWith({ verificationMethod: [method('#k', jwk)], assertionMethod: ['#k'] });
      await expect(getIssuerPublicKey(env, DID, undefined, 'k')).rejects.toThrow(
        'Verification method is not a supported signing key'
      );
    }
    expect(m.importECPublicKey).not.toHaveBeenCalled();
    expect(m.importJWK).not.toHaveBeenCalled();
  });

  it('imports an Ed25519 key as EdDSA when it states no alg, else with its own alg', async () => {
    const okp = { kty: 'OKP', crv: 'Ed25519', x: 'x' };
    resolveWith({ verificationMethod: [method('#k', okp)], assertionMethod: ['#k'] });
    expect(await getIssuerPublicKey(env, DID)).toBe('okp-key');
    expect(m.importJWK).toHaveBeenCalledWith(okp, 'EdDSA');
    resolveWith({
      verificationMethod: [method('#k', { ...okp, alg: 'EdDSA' })],
      assertionMethod: ['#k'],
    });
    await getIssuerPublicKey(env, DID);
    expect(m.importJWK).toHaveBeenLastCalledWith({ ...okp, alg: 'EdDSA' }, 'EdDSA');
  });

  it('finds a method by the kid of its JWK when no method id matches', async () => {
    resolveWith({
      verificationMethod: [
        method('#a', { ...EC, kid: 'wanted' }),
        method('#b', { ...EC, kid: 'o' }),
      ],
      assertionMethod: ['#a', '#b'],
    });
    await getIssuerPublicKey(env, DID, undefined, 'wanted');
    expect(m.importECPublicKey).toHaveBeenCalledWith({ ...EC, kid: 'wanted', alg: 'ES256' });
  });

  it('fails on a missing verificationMethod list instead of guessing', async () => {
    resolveWith({ assertionMethod: ['#k'] });
    await expect(getIssuerPublicKey(env, DID, undefined, 'k')).rejects.toThrow(
      'No verification method matches the key id'
    );
  });

  it('keeps the stated alg of an EC key it imports', async () => {
    resolveWith({
      verificationMethod: [method('#k', { ...EC, alg: 'ES256' })],
      assertionMethod: ['#k'],
    });
    await getIssuerPublicKey(env, DID);
    expect(m.importECPublicKey).toHaveBeenCalledWith({ ...EC, alg: 'ES256' });
  });
});

describe('checkSelfIssuance', () => {
  const tenantEnv = (overrides: Record<string, unknown>) =>
    ({ BASE_DOMAIN: 'example.com', DEFAULT_TENANT_ID: 'default', ...overrides }) as unknown as Env;

  it('rejects a blank tenant without checking the issuer', async () => {
    expect(await checkSelfIssuance(tenantEnv({}), 'did:web:other.example', '   ')).toBe(false);
    expect(m.logger.warn).toHaveBeenCalledWith(
      'Rejected issuer trust check without tenant context',
      {}
    );
  });

  it('compares against a custom identifier as it is, ignoring the tenant host', async () => {
    const e = tenantEnv({ VERIFIER_IDENTIFIER: 'custom-verifier' });
    expect(await checkSelfIssuance(e, 'custom-verifier', 't1')).toBe(false);
    expect(await checkSelfIssuance(e, 'did:web:t1.example.com', 't1')).toBe(true);
    expect(await checkSelfIssuance(e, 'did:web:authrim.com', 't1')).toBe(true);
  });

  it.each(['did:web:static.example', 'https://verifier.example', 'http://verifier.example'])(
    'derives the self identifier from the tenant host for %s',
    async (identifier) => {
      const e = tenantEnv({ VERIFIER_IDENTIFIER: identifier });
      expect(await checkSelfIssuance(e, 'did:web:t1.example.com', 't1')).toBe(false);
      expect(await checkSelfIssuance(e, identifier, 't1')).toBe(true);
    }
  );

  it('falls back to the configured identifier when no tenant host can be built', async () => {
    const e = { VERIFIER_IDENTIFIER: 'did:web:static.example' } as unknown as Env;
    expect(await checkSelfIssuance(e, 'did:web:static.example', 't1')).toBe(false);
    expect(await checkSelfIssuance(e, 'did:web:other.example', 't1')).toBe(true);
  });

  it('falls back to the Authrim default without any identifier', async () => {
    const e = {} as unknown as Env;
    expect(await checkSelfIssuance(e, 'did:web:authrim.com', 't1')).toBe(false);
    expect(await checkSelfIssuance(e, 'did:web:other.example', 't1')).toBe(true);
  });
});
