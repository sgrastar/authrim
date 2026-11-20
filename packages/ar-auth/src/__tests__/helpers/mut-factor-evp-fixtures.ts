/** Signed SD-JWT+KB presentations for the mut-factor-evp-* tests (copied from the protocol test). */
import { vi } from 'vitest';
import { base64url, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWK, JWTHeaderParameters } from 'jose';
import type { SafeFetchOptions } from '@authrim/ar-lib-core';
import {
  verifyEmailVerificationProtocol,
  type VerifyEmailVerificationProtocolOptions,
} from '../../email-verification-protocol';

export const NOW = 2_000_000_000;
export const EMAIL = 'user@example.com';
export const NONCE = 'browser-issued-nonce';
export const AUDIENCE = 'https://rp.example';
export const ISSUER = 'https://issuer.example';
export const JWKS_URL = 'https://keys.cdn.example/email-verification.jwks';

export type SupportedAlgorithm = 'EdDSA' | 'ES256' | 'RS256';
type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

export interface SigningFixture {
  issuerKeys: KeyPair;
  holderKeys: KeyPair;
  issuerJwk: JWK;
  holderJwk: JWK;
}

export interface DisclosureInput {
  name: string;
  value: unknown;
  salt?: string;
}

export interface PresentationOptions {
  algorithm?: SupportedAlgorithm;
  issuerPayload?: Record<string, unknown>;
  keyBindingPayload?: Record<string, unknown>;
  issuerHeader?: Partial<JWTHeaderParameters>;
  keyBindingHeader?: Partial<JWTHeaderParameters>;
  disclosures?: DisclosureInput[];
  /** Encoded disclosures used as they are (after `disclosures`), with their digests signed. */
  rawDisclosures?: string[];
  /** Digests signed in `_sd` instead of the computed ones. */
  sd?: unknown;
  issuerPrivateKey?: KeyPair['privateKey'];
  holderPrivateKey?: KeyPair['privateKey'];
  holderJwk?: JWK;
}

export const fixtures = new Map<SupportedAlgorithm, SigningFixture>();

export async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64url.encode(new Uint8Array(digest));
}

export function encodeDisclosure(value: unknown): string {
  return base64url.encode(new TextEncoder().encode(JSON.stringify(value)));
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

export async function loadFixtures(): Promise<void> {
  const algorithms: SupportedAlgorithm[] = ['EdDSA', 'ES256', 'RS256'];
  await Promise.all(
    algorithms.map(async (algorithm) => {
      fixtures.set(algorithm, await createFixture(algorithm));
    })
  );
}

export function fixture(algorithm: SupportedAlgorithm = 'EdDSA'): SigningFixture {
  const found = fixtures.get(algorithm);
  if (!found) throw new Error(`Missing ${algorithm} signing fixture`);
  return found;
}

export async function createPresentation(options: PresentationOptions = {}): Promise<string> {
  const algorithm = options.algorithm ?? 'EdDSA';
  const keys = fixture(algorithm);
  const disclosures = [
    ...(options.disclosures ?? []).map((disclosure, index) =>
      encodeDisclosure([disclosure.salt ?? `salt-${index}`, disclosure.name, disclosure.value])
    ),
    ...(options.rawDisclosures ?? []),
  ];
  const disclosureDigests = await Promise.all(disclosures.map(hash));
  const sd = options.sd !== undefined ? options.sd : disclosureDigests;
  const issuerPayload: Record<string, unknown> = {
    iss: ISSUER,
    iat: NOW,
    email: EMAIL,
    email_verified: true,
    cnf: { jwk: options.holderJwk ?? keys.holderJwk },
    ...(disclosureDigests.length > 0 || options.sd !== undefined
      ? { _sd_alg: 'sha-256', _sd: sd }
      : {}),
    ...options.issuerPayload,
  };
  const issuerJwt = await new SignJWT(issuerPayload)
    .setProtectedHeader({
      alg: algorithm,
      typ: 'evt+jwt',
      kid: keys.issuerJwk.kid,
      ...options.issuerHeader,
    })
    .sign(options.issuerPrivateKey ?? keys.issuerKeys.privateKey);
  const sdJwt = `${[issuerJwt, ...disclosures].join('~')}~`;
  const keyBindingPayload: Record<string, unknown> = {
    iat: NOW,
    aud: AUDIENCE,
    nonce: NONCE,
    sd_hash: await hash(sdJwt),
    ...options.keyBindingPayload,
  };
  const keyBindingJwt = await new SignJWT(keyBindingPayload)
    .setProtectedHeader({
      alg: algorithm,
      typ: 'kb+jwt',
      kid: keys.holderJwk.kid,
      ...options.keyBindingHeader,
    })
    .sign(options.holderPrivateKey ?? keys.holderKeys.privateKey);
  return `${sdJwt}${keyBindingJwt}`;
}

export function createProviderFetch(
  issuerJwk: JWK,
  overrides: { metadata?: unknown; jwks?: unknown; throwAt?: 'metadata' | 'jwks' } = {}
) {
  return vi.fn(async (url: string, _options?: SafeFetchOptions): Promise<unknown> => {
    if (url === `${ISSUER}/.well-known/email-verification`) {
      if (overrides.throwAt === 'metadata') throw new Error('provider unavailable');
      return 'metadata' in overrides ? overrides.metadata : { jwks_uri: JWKS_URL };
    }
    if (url === JWKS_URL) {
      if (overrides.throwAt === 'jwks') throw new Error('key service unavailable');
      return 'jwks' in overrides ? overrides.jwks : { keys: [issuerJwk] };
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

export function verify(
  presentationToken: string,
  overrides: Partial<VerifyEmailVerificationProtocolOptions> = {}
) {
  return verifyEmailVerificationProtocol({
    presentationToken,
    expectedEmail: EMAIL,
    expectedNonce: NONCE,
    expectedAudience: AUDIENCE,
    nowSeconds: NOW,
    resolveDnsTxt: async () => ['iss=issuer.example'],
    fetchJson: createProviderFetch(fixture().issuerJwk),
    ...overrides,
  });
}

/** Re-encodes one JWT segment of a presentation (signature then no longer matches). */
export function editSegment(
  token: string,
  which: 'issuer' | 'kb',
  part: 0 | 1,
  edit: (value: Record<string, unknown>) => Record<string, unknown>
): string {
  const parts = token.split('~');
  const index = which === 'issuer' ? 0 : parts.length - 1;
  const jwt = parts[index].split('.');
  const decoded = JSON.parse(new TextDecoder().decode(base64url.decode(jwt[part]))) as Record<
    string,
    unknown
  >;
  jwt[part] = base64url.encode(new TextEncoder().encode(JSON.stringify(edit(decoded))));
  parts[index] = jwt.join('.');
  return parts.join('~');
}

export const OK = { verified: true, issuer: ISSUER };
export const fail = (reason: string) => ({ verified: false, reason });
