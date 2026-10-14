/**
 * Helpers for the DID login tests that run with REAL cryptography (no mocked `jose`, no mocked
 * `resolveDID`): a spec-correct `did:key` generator (Ed25519 and P-256), a proof signer, and
 * in-memory stand-ins for the storage the handlers talk to (challenge store with the real
 * single-use / type / tenant / TTL semantics, linked-identity repository, route directory).
 *
 * Nothing in here depends on vitest, so it can be imported from `vi.hoisted` factories.
 */

import { SignJWT, exportJWK, generateKeyPair, base64url, type JWK } from 'jose';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58btc encoder (the repository only ships a decoder). */
export function base58btcEncode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;

  let num = 0n;
  for (const byte of bytes) num = (num << 8n) | BigInt(byte);

  let out = '';
  while (num > 0n) {
    out = BASE58_ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  return '1'.repeat(leadingZeros) + out;
}

export type DidKeyAlgorithm = 'EdDSA' | 'ES256' | 'ES384' | 'ES512';

/** did:key multicodec prefixes (varint) of the EC curves. */
const EC_MULTICODEC: Record<string, [number, number]> = {
  ES256: [0x80, 0x24],
  ES384: [0x81, 0x24],
  ES512: [0x82, 0x24],
};

/** Anything that can sign a DID proof: a DID, its verification method id and the key pair. */
export interface SigningIdentity {
  alg: string;
  did: string;
  /** Verification method id, `<did>#<fragment>`. */
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export interface DidKeyIdentity extends SigningIdentity {
  alg: DidKeyAlgorithm;
  /** `z...` multibase key; also the fragment of the verification method id. */
  multibaseKey: string;
}

/** A JWK-based identity for a DID the test publishes itself (did:web), with any algorithm. */
export async function createJwkIdentity(
  did: string,
  fragment: string,
  alg: string
): Promise<SigningIdentity> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return { alg, did, kid: `${did}#${fragment}`, privateKey, publicJwk };
}

/**
 * A DID document exposing the given identities as JsonWebKey2020 verification methods.
 * `jwkAlg: false` publishes the JWKs without the optional `alg` member (common in real documents).
 */
export function didWebDocument(
  did: string,
  methods: SigningIdentity[],
  authentication: string[] = methods.map((m) => m.kid),
  options: { jwkAlg?: boolean } = {}
) {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    verificationMethod: methods.map((m) => ({
      id: m.kid,
      type: 'JsonWebKey2020',
      controller: did,
      publicKeyJwk: options.jwkAlg === false ? m.publicJwk : { ...m.publicJwk, alg: m.alg },
    })),
    authentication,
  };
}

/**
 * The same EC key as a did:key in the UNCOMPRESSED point form (0x04 || x || y), which did:key
 * does not allow. Returns the DID and the verification method id.
 */
export function uncompressedDidKey(identity: DidKeyIdentity): { did: string; kid: string } {
  const x = base64url.decode(identity.publicJwk.x as string);
  const y = base64url.decode(identity.publicJwk.y as string);
  const multibaseKey = `z${base58btcEncode(new Uint8Array([...EC_MULTICODEC[identity.alg], 0x04, ...x, ...y]))}`;
  const did = `did:key:${multibaseKey}`;
  return { did, kid: `${did}#${multibaseKey}` };
}

/**
 * Generates a key pair and builds the matching `did:key`:
 * - Ed25519: `z` + base58btc(0xed 0x01 || 32-byte public key)
 * - P-256/384/521: `z` + base58btc(multicodec || compressed public key)
 */
export async function createDidKeyIdentity(
  alg: DidKeyAlgorithm = 'EdDSA'
): Promise<DidKeyIdentity> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = await exportJWK(publicKey);

  let prefixed: Uint8Array;
  if (alg === 'EdDSA') {
    const raw = base64url.decode(publicJwk.x as string);
    if (raw.length !== 32) throw new Error('unexpected Ed25519 public key length');
    prefixed = new Uint8Array([0xed, 0x01, ...raw]);
  } else {
    // The compressed point form, the only one did:key allows.
    const x = base64url.decode(publicJwk.x as string);
    const y = base64url.decode(publicJwk.y as string);
    const compressed = new Uint8Array([y[y.length - 1] % 2 === 0 ? 0x02 : 0x03, ...x]);
    prefixed = new Uint8Array([...EC_MULTICODEC[alg], ...compressed]);
  }

  const multibaseKey = `z${base58btcEncode(prefixed)}`;
  const did = `did:key:${multibaseKey}`;
  return { alg, did, multibaseKey, kid: `${did}#${multibaseKey}`, privateKey, publicJwk };
}

export interface ProofOptions {
  /** Key used to sign (defaults to the identity's own key). */
  key?: CryptoKey | Uint8Array;
  /** `alg` of the protected header (defaults to the identity's algorithm). */
  alg?: string;
  /** `kid` of the protected header (defaults to the identity's verification method id). */
  kid?: string | null;
  iss?: string;
  aud?: string;
  nonce?: string | null;
  /** Seconds since epoch; `null` leaves `exp` out of the proof. */
  exp?: number | null;
}

export const TEST_ISSUER = 'https://issuer.example.com';

/** Signs a DID proof JWS with `SignJWT`. Fields default to a valid proof for `identity`. */
export async function signProof(
  identity: SigningIdentity,
  challenge: { nonce: string },
  options: ProofOptions = {}
): Promise<string> {
  const nonce = options.nonce === undefined ? challenge.nonce : options.nonce;
  const kid = options.kid === undefined ? identity.kid : options.kid;
  const header: { alg: string; kid?: string } = { alg: options.alg ?? identity.alg };
  if (kid !== null) header.kid = kid;

  let jwt = new SignJWT(nonce === null ? {} : { nonce })
    .setProtectedHeader(header)
    .setIssuer(options.iss ?? identity.did)
    .setAudience(options.aud ?? TEST_ISSUER)
    .setIssuedAt();
  if (options.exp !== null) {
    jwt = jwt.setExpirationTime(options.exp ?? Math.floor(Date.now() / 1000) + 120);
  }
  return jwt.sign(options.key ?? identity.privateKey);
}

/** A JWS with `alg: none` and an empty signature, built by hand (jose refuses to sign it). */
export function unsecuredProof(
  identity: SigningIdentity,
  challenge: { nonce: string },
  aud: string = TEST_ISSUER
): string {
  const encode = (value: unknown) => base64url.encode(JSON.stringify(value));
  return `${encode({ alg: 'none', kid: identity.kid })}.${encode({
    iss: identity.did,
    aud,
    nonce: challenge.nonce,
    exp: Math.floor(Date.now() / 1000) + 120,
  })}.`;
}

// ---------------------------------------------------------------------------------------------
// In-memory stand-ins for storage
// ---------------------------------------------------------------------------------------------

interface StoredChallenge {
  id: string;
  tenantId: string;
  type: string;
  userId: string;
  challenge: string;
  metadata?: Record<string, unknown>;
  expiresAt: number;
  consumed: boolean;
}

/**
 * ChallengeStore Durable Object stand-in with the semantics of the real one
 * (`ChallengeStore.consumeChallenge`): unknown, wrong type, wrong tenant, already consumed and
 * expired challenges throw; a successful consume marks the challenge used.
 */
export class InMemoryChallengeStore {
  readonly records = new Map<string, StoredChallenge>();
  readonly storeCalls: Array<Record<string, unknown>> = [];
  readonly consumeCalls: Array<Record<string, unknown>> = [];
  /** Milliseconds; tests move it forward to run past a challenge's TTL. */
  now = Date.now();

  async storeChallengeRpc(input: {
    id: string;
    tenantId: string;
    type: string;
    userId: string;
    challenge: string;
    ttl: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ success: true }> {
    this.storeCalls.push(input);
    this.records.set(input.id, {
      id: input.id,
      tenantId: input.tenantId,
      type: input.type,
      userId: input.userId,
      challenge: input.challenge,
      metadata: input.metadata,
      expiresAt: this.now + input.ttl * 1000,
      consumed: false,
    });
    return { success: true };
  }

  async consumeChallengeRpc(input: { id: string; tenantId: string; type: string }) {
    this.consumeCalls.push(input);
    const record = this.records.get(input.id);
    if (!record) throw new Error('Challenge not found or already consumed');
    if (record.type !== input.type) throw new Error('Challenge type mismatch');
    if (record.tenantId !== input.tenantId) throw new Error('Challenge tenant mismatch');
    if (record.consumed) throw new Error('Challenge already consumed');
    if (record.expiresAt <= this.now) throw new Error('Challenge expired');
    record.consumed = true;
    return {
      challenge: record.challenge,
      userId: record.userId,
      metadata: record.metadata,
      createdAt: this.now,
    };
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
  }

  get consumedCount(): number {
    return [...this.records.values()].filter((record) => record.consumed).length;
  }
}

export interface LinkedIdentityRow {
  id: string;
  tenant_id: string;
  user_id: string;
  provider_id: string;
  provider_user_id: string;
  raw_attributes: string | null;
  linked_at: number;
  last_used_at: number | null;
}

/** `LinkedIdentityRepository` stand-in over a shared row list (UNIQUE on provider + subject). */
export class InMemoryLinkedIdentities {
  readonly rows: LinkedIdentityRow[] = [];
  private sequence = 0;

  async findByProviderUser(tenantId: string, providerId: string, providerUserId: string) {
    return (
      this.rows.find(
        (row) =>
          row.tenant_id === tenantId &&
          row.provider_id === providerId &&
          row.provider_user_id === providerUserId
      ) ?? null
    );
  }

  async findByUserId(tenantId: string, userId: string) {
    return this.rows.filter((row) => row.tenant_id === tenantId && row.user_id === userId);
  }

  async createLinkedIdentity(input: {
    tenant_id: string;
    user_id: string;
    provider_id: string;
    provider_user_id: string;
    raw_attributes?: Record<string, unknown>;
  }) {
    if (await this.findByProviderUser(input.tenant_id, input.provider_id, input.provider_user_id)) {
      throw new Error('UNIQUE constraint failed: linked_identities.provider_user_id');
    }
    const row: LinkedIdentityRow = {
      id: `link-${++this.sequence}`,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      provider_id: input.provider_id,
      provider_user_id: input.provider_user_id,
      raw_attributes: input.raw_attributes ? JSON.stringify(input.raw_attributes) : null,
      linked_at: Date.now(),
      last_used_at: null,
    };
    this.rows.push(row);
    return row;
  }
}

/** Mirrors `AuthDidRoutePublicationInput` (the part the tests look at). */
export interface DidRoutePublication {
  schemaVersion: number;
  operationId: string;
  idempotencyKey: string;
  tenantId: string;
  accountId: string;
  userId: string;
  linkedIdentityId: string;
  did: string;
}

/**
 * The lookup directory plus the account provisioner that fills it: `publishAuthDidRoute` records
 * the call and, like the real service, makes the DID resolvable for DID login afterwards.
 */
export class InMemoryDidDirectory {
  readonly published: DidRoutePublication[] = [];
  private readonly routes = new Map<string, { accountId: string; legacyUserId: string }>();

  readonly provisioner = {
    publishAuthDidRoute: async (input: DidRoutePublication) => {
      this.published.push(input);
      this.routes.set(input.did, { accountId: input.accountId, legacyUserId: input.userId });
      return { status: 201 as const, operationId: input.operationId, accountId: input.accountId };
    },
  };

  /** Publishes a route without going through the link flow (a "fixture" link). */
  addRoute(did: string, userId: string): void {
    this.routes.set(did, { accountId: `account:${userId}`, legacyUserId: userId });
  }

  /** Same contract as `resolveAccountDataContextByIdentifierFromHono`. */
  lookup(did: string) {
    const route = this.routes.get(did);
    if (!route) throw new Error('account_data_route_not_found');
    return {
      tenantId: 'default',
      accountId: route.accountId,
      legacyUserId: route.legacyUserId,
    };
  }
}

/**
 * P-256 did:key strings in the compressed form whose bytes are NOT a point of the curve: x equal
 * to the field prime p (out of range), and an x whose x^3 + ax + b is a quadratic non-residue.
 */
export function invalidP256DidKeys(): { outOfRange: string; nonResidue: string } {
  const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  const a = p - 3n;
  const b = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
  const modPow = (base: bigint, exponent: bigint) => {
    let result = 1n;
    let value = base % p;
    for (let e = exponent; e > 0n; e >>= 1n) {
      if (e & 1n) result = (result * value) % p;
      value = (value * value) % p;
    }
    return result;
  };
  const toBytes = (value: bigint) =>
    Array.from({ length: 32 }, (_, i) => Number((value >> BigInt(8 * (31 - i))) & 0xffn));
  const encode = (x: bigint) =>
    `did:key:z${base58btcEncode(new Uint8Array([...EC_MULTICODEC.ES256, 0x02, ...toBytes(x)]))}`;

  let x = 1n;
  while (modPow((x ** 3n + a * x + b) % p, (p - 1n) / 2n) !== p - 1n) x += 1n;
  return { outOfRange: encode(p), nonResidue: encode(x) };
}
