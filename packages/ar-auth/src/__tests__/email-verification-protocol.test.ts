import { beforeAll, describe, expect, it, vi } from 'vitest';
import { base64url, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWK, JWTHeaderParameters, JWTPayload } from 'jose';
import type { SafeFetchOptions } from '@authrim/ar-lib-core';
import {
  verifyEmailVerificationProtocol,
  type EmailVerificationProtocolFetchJson,
  type VerifyEmailVerificationProtocolOptions,
} from '../email-verification-protocol';

const NOW = 2_000_000_000;
const EMAIL = 'user@example.com';
const NONCE = 'browser-issued-nonce';
const AUDIENCE = 'https://rp.example';
const ISSUER = 'https://issuer.example';
const JWKS_URL = 'https://keys.cdn.example/email-verification.jwks';

type SupportedAlgorithm = 'EdDSA' | 'ES256' | 'RS256';
type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

interface SigningFixture {
  issuerKeys: KeyPair;
  holderKeys: KeyPair;
  issuerJwk: JWK;
  holderJwk: JWK;
}

interface DisclosureInput {
  name: string;
  value: unknown;
  salt?: string;
}

interface PresentationOptions {
  algorithm?: SupportedAlgorithm;
  issuerPayload?: Record<string, unknown>;
  keyBindingPayload?: Record<string, unknown>;
  issuerHeader?: Partial<JWTHeaderParameters>;
  keyBindingHeader?: Partial<JWTHeaderParameters>;
  disclosures?: DisclosureInput[];
  issuerPrivateKey?: KeyPair['privateKey'];
  holderPrivateKey?: KeyPair['privateKey'];
  holderJwk?: JWK;
}

const fixtures = new Map<SupportedAlgorithm, SigningFixture>();

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64url.encode(new Uint8Array(digest));
}

async function createFixture(algorithm: SupportedAlgorithm): Promise<SigningFixture> {
  const issuerKeys = await generateKeyPair(algorithm, { extractable: true });
  const holderKeys = await generateKeyPair(algorithm, { extractable: true });
  const issuerJwk = await exportJWK(issuerKeys.publicKey);
  const holderJwk = await exportJWK(holderKeys.publicKey);

  issuerJwk.alg = algorithm;
  issuerJwk.kid = `${algorithm}-issuer-key`;
  issuerJwk.use = 'sig';
  issuerJwk.key_ops = ['verify'];
  holderJwk.alg = algorithm;
  holderJwk.kid = `${algorithm}-holder-key`;
  holderJwk.use = 'sig';
  holderJwk.key_ops = ['verify'];

  return { issuerKeys, holderKeys, issuerJwk, holderJwk };
}

async function createPresentation(options: PresentationOptions = {}): Promise<string> {
  const algorithm = options.algorithm ?? 'EdDSA';
  const fixture = fixtures.get(algorithm);
  if (!fixture) {
    throw new Error(`Missing ${algorithm} signing fixture`);
  }

  const disclosures = (options.disclosures ?? []).map((disclosure, index) =>
    base64url.encode(
      new TextEncoder().encode(
        JSON.stringify([disclosure.salt ?? `salt-${index}`, disclosure.name, disclosure.value])
      )
    )
  );
  const disclosureDigests = await Promise.all(disclosures.map(hash));

  const issuerPayload: Record<string, unknown> = {
    iss: ISSUER,
    iat: NOW,
    email: EMAIL,
    email_verified: true,
    cnf: { jwk: options.holderJwk ?? fixture.holderJwk },
    ...(disclosureDigests.length > 0 ? { _sd_alg: 'sha-256', _sd: disclosureDigests } : {}),
    ...options.issuerPayload,
  };
  const issuerJwt = await new SignJWT(issuerPayload as JWTPayload)
    .setProtectedHeader({
      alg: algorithm,
      typ: 'evt+jwt',
      kid: fixture.issuerJwk.kid,
      ...options.issuerHeader,
    })
    .sign(options.issuerPrivateKey ?? fixture.issuerKeys.privateKey);

  const sdJwt = `${[issuerJwt, ...disclosures].join('~')}~`;
  const keyBindingPayload: Record<string, unknown> = {
    iat: NOW,
    aud: AUDIENCE,
    nonce: NONCE,
    sd_hash: await hash(sdJwt),
    ...options.keyBindingPayload,
  };
  const keyBindingJwt = await new SignJWT(keyBindingPayload as JWTPayload)
    .setProtectedHeader({
      alg: algorithm,
      typ: 'kb+jwt',
      kid: fixture.holderJwk.kid,
      ...options.keyBindingHeader,
    })
    .sign(options.holderPrivateKey ?? fixture.holderKeys.privateKey);

  return `${sdJwt}${keyBindingJwt}`;
}

function createProviderFetch(
  issuerJwk: JWK,
  overrides: { metadata?: unknown; jwks?: unknown; throwAt?: 'metadata' | 'jwks' } = {}
) {
  return vi.fn(async (url: string, _options?: SafeFetchOptions): Promise<unknown> => {
    if (url === `${ISSUER}/.well-known/email-verification`) {
      if (overrides.throwAt === 'metadata') {
        throw new Error('provider unavailable');
      }
      return overrides.metadata ?? { jwks_uri: JWKS_URL };
    }
    if (url === JWKS_URL) {
      if (overrides.throwAt === 'jwks') {
        throw new Error('key service unavailable');
      }
      return overrides.jwks ?? { keys: [issuerJwk] };
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

function defaultFixture(): SigningFixture {
  const fixture = fixtures.get('EdDSA');
  if (!fixture) {
    throw new Error('Missing EdDSA fixture');
  }
  return fixture;
}

async function verify(
  presentationToken: string,
  overrides: Partial<VerifyEmailVerificationProtocolOptions> = {}
) {
  const fixture = defaultFixture();
  return verifyEmailVerificationProtocol({
    presentationToken,
    expectedEmail: EMAIL,
    expectedNonce: NONCE,
    expectedAudience: AUDIENCE,
    nowSeconds: NOW,
    resolveDnsTxt: async () => ['iss=issuer.example'],
    fetchJson: createProviderFetch(fixture.issuerJwk),
    ...overrides,
  });
}

function replaceIssuerAlgorithm(token: string, algorithm: string): string {
  const presentationParts = token.split('~');
  const jwtParts = presentationParts[0].split('.');
  const header = JSON.parse(new TextDecoder().decode(base64url.decode(jwtParts[0]))) as Record<
    string,
    unknown
  >;
  jwtParts[0] = base64url.encode(
    new TextEncoder().encode(JSON.stringify({ ...header, alg: algorithm }))
  );
  presentationParts[0] = jwtParts.join('.');
  return presentationParts.join('~');
}

beforeAll(async () => {
  const algorithms: SupportedAlgorithm[] = ['EdDSA', 'ES256', 'RS256'];
  await Promise.all(
    algorithms.map(async (algorithm) => {
      fixtures.set(algorithm, await createFixture(algorithm));
    })
  );
});

describe('verifyEmailVerificationProtocol', () => {
  describe('valid presentations', () => {
    it.each<SupportedAlgorithm>(['EdDSA', 'ES256', 'RS256'])(
      'accepts %s issuer and holder signatures',
      async (algorithm) => {
        const fixture = fixtures.get(algorithm)!;
        const token = await createPresentation({ algorithm });

        const result = await verify(token, {
          fetchJson: createProviderFetch(fixture.issuerJwk),
        });

        expect(result).toEqual({ verified: true, issuer: ISSUER });
      }
    );

    it('validates selectively disclosed email claims and ASCII case-insensitive email', async () => {
      const token = await createPresentation({
        issuerPayload: { email: undefined, email_verified: undefined },
        disclosures: [
          { name: 'email', value: 'USER@example.com' },
          { name: 'email_verified', value: true },
        ],
      });

      await expect(verify(token)).resolves.toEqual({ verified: true, issuer: ISSUER });
    });

    it('strictly parses the default DoH response and applies bounded fetch options', async () => {
      const fixture = defaultFixture();
      const token = await createPresentation();
      const fetchJson = vi.fn<EmailVerificationProtocolFetchJson>(async (url) => {
        if (url.startsWith('https://cloudflare-dns.com/dns-query?')) {
          return {
            Status: 0,
            TC: false,
            RD: true,
            RA: true,
            AD: true,
            CD: false,
            Question: [{ name: '_email-verification.example.com.', type: 16 }],
            Answer: [
              {
                name: '_email-verification.example.com.',
                type: 16,
                TTL: 60,
                data: '"iss=issuer\\." "example"',
              },
            ],
          };
        }
        if (url === `${ISSUER}/.well-known/email-verification`) {
          return { jwks_uri: JWKS_URL };
        }
        if (url === JWKS_URL) {
          return { keys: [fixture.issuerJwk] };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await verifyEmailVerificationProtocol({
        presentationToken: token,
        expectedEmail: EMAIL,
        expectedNonce: NONCE,
        expectedAudience: `${AUDIENCE}/`,
        nowSeconds: NOW,
        fetchJson,
      });

      expect(result).toEqual({ verified: true, issuer: ISSUER });
      expect(fetchJson).toHaveBeenCalledTimes(3);
      expect(fetchJson.mock.calls[0][0]).toContain('name=_email-verification.example.com');
      for (const [, options] of fetchJson.mock.calls) {
        expect(options).toMatchObject({
          redirect: 'error',
          requireHttps: true,
          allowLocalhost: false,
          timeoutMs: 5_000,
          maxResponseSize: 65_536,
        });
      }
    });
  });

  describe('presentation and disclosure validation', () => {
    it('rejects malformed SD-JWT+KB grammar without provider I/O', async () => {
      const resolveDnsTxt = vi.fn(async () => ['iss=issuer.example']);

      const result = await verify('not-an-sd-jwt', { resolveDnsTxt });

      expect(result).toEqual({ verified: false, reason: 'invalid_presentation' });
      expect(resolveDnsTxt).not.toHaveBeenCalled();
    });

    it('requires the current evt+jwt and kb+jwt type values', async () => {
      const issuerType = await createPresentation({
        issuerHeader: { typ: 'evp+sd-jwt' },
      });
      const keyBindingType = await createPresentation({
        keyBindingHeader: { typ: 'JWT' },
      });

      await expect(verify(issuerType)).resolves.toEqual({
        verified: false,
        reason: 'invalid_presentation',
      });
      await expect(verify(keyBindingType)).resolves.toEqual({
        verified: false,
        reason: 'invalid_presentation',
      });
    });

    it.each([true, false])(
      'accepts a Gmail-shaped JWKS without key ids (token kid present: %s)',
      async (tokenHasKid) => {
        const fixture = defaultFixture();
        const issuerJwk = { ...fixture.issuerJwk };
        delete issuerJwk.kid;
        const token = await createPresentation({
          issuerHeader: tokenHasKid ? undefined : { kid: undefined },
        });

        await expect(verify(token, { fetchJson: createProviderFetch(issuerJwk) })).resolves.toEqual(
          { verified: true, issuer: ISSUER }
        );
      }
    );

    it('rejects algorithms outside EdDSA, ES256, and RS256', async () => {
      const token = replaceIssuerAlgorithm(await createPresentation(), 'HS256');

      await expect(verify(token)).resolves.toEqual({
        verified: false,
        reason: 'invalid_presentation',
      });
    });

    it('rejects a disclosure that is not bound by the signed digest', async () => {
      const token = await createPresentation({
        issuerPayload: { email: undefined },
        disclosures: [{ name: 'email', value: EMAIL }],
      });
      const parts = token.split('~');
      parts[1] = base64url.encode(
        new TextEncoder().encode(JSON.stringify(['different-salt', 'email', EMAIL]))
      );

      await expect(verify(parts.join('~'))).resolves.toEqual({
        verified: false,
        reason: 'invalid_presentation',
      });
    });
  });

  describe('claim and holder-binding validation', () => {
    it.each([
      ['email', { issuerPayload: { email: 'other@example.com' } }],
      ['email_verified', { issuerPayload: { email_verified: false } }],
      ['nonce', { keyBindingPayload: { nonce: 'wrong' } }],
      ['audience', { keyBindingPayload: { aud: 'https://other.example' } }],
      ['sd_hash', { keyBindingPayload: { sd_hash: 'wrong' } }],
    ] as const)('rejects a mismatched %s claim', async (_name, buildOptions) => {
      const token = await createPresentation(buildOptions);

      await expect(verify(token)).resolves.toEqual({
        verified: false,
        reason: 'invalid_claims',
      });
    });

    it.each([
      ['issuer stale iat', { issuerPayload: { iat: NOW - 301 } }],
      ['issuer future iat', { issuerPayload: { iat: NOW + 61 } }],
      ['issuer expiration', { issuerPayload: { exp: NOW } }],
      ['key binding stale iat', { keyBindingPayload: { iat: NOW - 301 } }],
      ['key binding future iat', { keyBindingPayload: { iat: NOW + 61 } }],
      ['key binding expiration', { keyBindingPayload: { exp: NOW } }],
    ] as const)('rejects a non-current %s', async (_name, buildOptions) => {
      const token = await createPresentation(buildOptions);

      await expect(verify(token)).resolves.toEqual({
        verified: false,
        reason: 'token_not_current',
      });
    });

    it('rejects an issuer signature not represented by the authoritative JWKS', async () => {
      const fixture = defaultFixture();
      const token = await createPresentation({
        issuerPrivateKey: fixture.holderKeys.privateKey,
      });

      await expect(verify(token)).resolves.toEqual({
        verified: false,
        reason: 'invalid_signature',
      });
    });

    it('rejects a key-binding signature that does not match cnf.jwk', async () => {
      const fixture = defaultFixture();
      const token = await createPresentation({
        holderPrivateKey: fixture.issuerKeys.privateKey,
      });

      await expect(verify(token)).resolves.toEqual({
        verified: false,
        reason: 'invalid_signature',
      });
    });
  });

  describe('issuer discovery and metadata failures', () => {
    it.each([
      ['missing', []],
      ['multiple', ['iss=issuer.example', 'iss=backup.example']],
      ['wrong prefix', ['ISS=issuer.example']],
      ['URL instead of issuer domain', ['iss=https://issuer.example']],
    ] as const)('rejects %s authoritative TXT data', async (_name, records) => {
      const token = await createPresentation();

      await expect(verify(token, { resolveDnsTxt: async () => records })).resolves.toEqual({
        verified: false,
        reason: 'issuer_discovery_failed',
      });
    });

    it('normalizes DNS resolver exceptions to a discovery failure', async () => {
      const token = await createPresentation();

      await expect(
        verify(token, {
          resolveDnsTxt: async () => {
            throw new Error('resolver unavailable');
          },
        })
      ).resolves.toEqual({ verified: false, reason: 'issuer_discovery_failed' });
    });

    it('rejects truncated or non-authoritative DoH answers', async () => {
      const token = await createPresentation();
      const fetchJson = vi.fn<EmailVerificationProtocolFetchJson>(async () => ({
        Status: 0,
        TC: true,
        Question: [{ name: '_email-verification.example.com.', type: 16 }],
        Answer: [],
      }));

      await expect(
        verifyEmailVerificationProtocol({
          presentationToken: token,
          expectedEmail: EMAIL,
          expectedNonce: NONCE,
          expectedAudience: AUDIENCE,
          nowSeconds: NOW,
          fetchJson,
        })
      ).resolves.toEqual({ verified: false, reason: 'issuer_discovery_failed' });
    });

    it.each([
      ['HTTP JWKS', { jwks_uri: 'http://keys.example/jwks' }],
      ['internal JWKS', { jwks_uri: 'https://127.0.0.1/jwks' }],
      [
        'cross-domain issuance endpoint',
        { jwks_uri: JWKS_URL, issuance_endpoint: 'https://attacker.example/issue' },
      ],
    ] as const)('rejects metadata with an unsafe %s URL', async (_name, metadata) => {
      const fixture = defaultFixture();
      const token = await createPresentation();

      await expect(
        verify(token, {
          fetchJson: createProviderFetch(fixture.issuerJwk, { metadata }),
        })
      ).resolves.toEqual({ verified: false, reason: 'issuer_metadata_failed' });
    });

    it('normalizes metadata network errors and does not expose their details', async () => {
      const fixture = defaultFixture();
      const token = await createPresentation();

      await expect(
        verify(token, {
          fetchJson: createProviderFetch(fixture.issuerJwk, { throwAt: 'metadata' }),
        })
      ).resolves.toEqual({ verified: false, reason: 'issuer_metadata_failed' });
    });
  });

  describe('programmer input validation', () => {
    it.each([
      ['invalid email', { expectedEmail: 'not-a-mailbox' }],
      ['empty nonce', { expectedNonce: '' }],
      ['non-origin audience', { expectedAudience: 'https://rp.example/callback' }],
      ['invalid clock', { nowSeconds: Number.NaN }],
    ] as const)('throws for %s', async (_name, invalidInput) => {
      const token = await createPresentation();

      await expect(verify(token, invalidInput)).rejects.toThrow(TypeError);
    });
  });
});
