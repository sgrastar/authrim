/**
 * Login by a HAIP 1.0 presentation of the administrator credential (design D-L, S4): the request
 * object Authrim signs and the one way a response is accepted.
 *
 * Profile: signed request object (JAR) with client identifier `x509_hash:<SHA-256 of the verifier
 * certificate>`, the leaf's chain in `x5c`; DCQL; response mode `direct_post.jwt` with ECDH-ES
 * P-256 and A128GCM/A256GCM to a per-request ephemeral key; same-device (a redirect with a
 * response code the browser session binds) and cross-device (a QR) flows.
 *
 * Unlike the step-up (admin-vp-protocol.ts), the request names no administrator: the credential
 * does, so every rule that ties it to the tenant is checked here, and the issuer signature must
 * come with an `x5c` chain that certifies the tenant's VC key and ends at the pinned Authrim CA.
 */

import {
  calculateJwkThumbprint,
  compactDecrypt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
} from 'jose';
import { validateVcSigningChain } from '@authrim/ar-lib-core';
import {
  extractAdminPresentation,
  sha256Base64url,
  base64url,
  type AdminCredentialRecord,
} from '../admin/admin-vp-protocol';

export const HAIP_LOGIN_QUERY_ID = 'admin';
export const HAIP_LOGIN_REQUEST_TTL_SECONDS = 300;
export const HAIP_LOGIN_RESPONSE_ENC_VALUES = ['A128GCM', 'A256GCM'] as const;
export const X509_HASH_PREFIX = 'x509_hash:';
const REQUEST_OBJECT_TYP = 'oauth-authz-req+jwt';
const KB_JWT_MAX_AGE_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 60;
const MAX_JWE_LENGTH = 64 * 1024;

/** `x509_hash:` and the base64url SHA-256 of the DER of the verifier's leaf certificate. */
export async function x509HashClientId(leafDer: Uint8Array): Promise<string> {
  return `${X509_HASH_PREFIX}${base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', leafDer)))}`;
}

export interface HaipLoginRequestInput {
  clientId: string;
  /** Where the wallet posts the encrypted response. */
  responseUri: string;
  nonce: string;
  /** Binds the wallet's answer to the browser's session. */
  state: string;
  now: number;
  vct: string;
  /** The ephemeral public key the wallet encrypts to (with its `kid`). */
  encryptionKey: JWK;
  /**
   * Base64url `subjectKeyIdentifier` of the Authrim issuing CA: the wallet offers only credentials
   * issued under it (DCQL `trusted_authorities`, type `aki`).
   */
  issuingCaAki?: string;
}

export function buildHaipLoginRequestPayload(input: HaipLoginRequestInput): JWTPayload {
  if (!input.clientId.startsWith(X509_HASH_PREFIX)) throw new Error('haip_login_client_id_scheme');
  if (!input.encryptionKey.kid) throw new Error('haip_login_encryption_key_kid');
  return {
    aud: 'https://self-issued.me/v2',
    client_id: input.clientId,
    response_type: 'vp_token',
    response_mode: 'direct_post.jwt',
    response_uri: input.responseUri,
    nonce: input.nonce,
    state: input.state,
    iat: input.now,
    exp: input.now + HAIP_LOGIN_REQUEST_TTL_SECONDS,
    client_metadata: {
      jwks: { keys: [input.encryptionKey] },
      encrypted_response_enc_values_supported: [...HAIP_LOGIN_RESPONSE_ENC_VALUES],
      vp_formats_supported: {
        'dc+sd-jwt': { 'sd-jwt_alg_values': ['ES256'], 'kb-jwt_alg_values': ['ES256'] },
      },
    },
    dcql_query: {
      credentials: [
        {
          id: HAIP_LOGIN_QUERY_ID,
          format: 'dc+sd-jwt',
          meta: { vct_values: [input.vct] },
          claims: [{ path: ['sub'] }, { path: ['tenant_id'] }],
          ...(input.issuingCaAki
            ? { trusted_authorities: [{ type: 'aki', values: [input.issuingCaAki] }] }
            : {}),
        },
      ],
    },
  };
}

/** Signs the request object with the verifier leaf key; the chain travels in `x5c`, anchor excluded. */
export async function signHaipLoginRequestObject(
  payload: JWTPayload,
  x5c: string[],
  privateKey: CryptoKey
): Promise<string> {
  if (x5c.length === 0) throw new Error('haip_login_x5c_required');
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', typ: REQUEST_OBJECT_TYP, x5c })
    .sign(privateKey);
}

/** What the response must be tied to, kept with the request. */
export interface HaipLoginRequest {
  tenantId: string;
  /** The credential issuer (https origin of the tenant). */
  credentialIssuer: string;
  clientId: string;
  nonce: string;
  state: string;
  /** `kid` of the ephemeral encryption key the request offered. */
  encryptionKid: string;
}

export type HaipLoginErrorCode =
  | 'invalid_response'
  | 'state_mismatch'
  | 'invalid_vp_token'
  | 'invalid_credential'
  | 'untrusted_issuer_chain'
  | 'wrong_tenant'
  | 'credential_not_active'
  | 'invalid_key_binding';

class Refusal extends Error {
  constructor(readonly code: HaipLoginErrorCode) {
    super(code);
  }
}
function refuse(code: HaipLoginErrorCode): never {
  throw new Refusal(code);
}

/**
 * The decrypted `direct_post.jwt` response: `{ vp_token, state }`. The JWE must be ECDH-ES with an
 * accepted `enc` and the `kid` of this request's key; anything else is refused.
 */
export async function decryptHaipLoginResponse(
  response: unknown,
  privateJwk: string,
  request: Pick<HaipLoginRequest, 'state' | 'encryptionKid'>
): Promise<unknown> {
  try {
    if (typeof response !== 'string' || response.length === 0 || response.length > MAX_JWE_LENGTH) {
      refuse('invalid_response');
    }
    const header = decodeProtectedHeader(response);
    if (
      header.alg !== 'ECDH-ES' ||
      !HAIP_LOGIN_RESPONSE_ENC_VALUES.includes(
        header.enc as (typeof HAIP_LOGIN_RESPONSE_ENC_VALUES)[number]
      ) ||
      header.kid !== request.encryptionKid ||
      'zip' in header
    ) {
      refuse('invalid_response');
    }
    const key = await importJWK(JSON.parse(privateJwk) as JWK, 'ECDH-ES');
    const { plaintext } = await compactDecrypt(response, key, {
      keyManagementAlgorithms: ['ECDH-ES'],
      contentEncryptionAlgorithms: [...HAIP_LOGIN_RESPONSE_ENC_VALUES],
    });
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as {
      vp_token?: unknown;
      state?: unknown;
    };
    if (typeof payload !== 'object' || payload === null || payload.vp_token === undefined) {
      refuse('invalid_response');
    }
    // The state is the browser session's: a response for another request is not this one's.
    if (payload.state !== request.state) refuse('state_mismatch');
    return payload.vp_token;
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse('invalid_response');
  }
}

export interface HaipLoginVerifierDeps {
  /** The tenant's VC issuer public keys (KeyManager), including keys retained after rotation. */
  issuerKeys(): Promise<JWK[]>;
  /** The credential at a status list entry of the tenant, or null. */
  findCredential(listId: string, index: number): Promise<AdminCredentialRecord | null>;
  /** Lower-case hex SHA-256 of the Authrim issuing CA certificates the chain may end at. */
  trustedIssuingCaSha256: string[];
}

export type HaipLoginVerification =
  | { ok: true; adminUserId: string; holderJkt: string; credentialId: string }
  | { ok: false; error: HaipLoginErrorCode };

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++)
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

function publicEcJwk(value: unknown): JWK | null {
  if (typeof value !== 'object' || value === null) return null;
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || 'd' in jwk) return null;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

function statusEntry(
  payload: JWTPayload,
  credentialIssuer: string
): { listId: string; idx: number } {
  const status = (payload.status as { status_list?: { idx?: unknown; uri?: unknown } } | undefined)
    ?.status_list;
  const prefix = `${new URL(credentialIssuer).origin}/vci/status-lists/`;
  if (
    !status ||
    !Number.isSafeInteger(status.idx) ||
    (status.idx as number) < 0 ||
    typeof status.uri !== 'string' ||
    !status.uri.startsWith(prefix)
  ) {
    refuse('invalid_credential');
  }
  const listId = decodeURIComponent(status.uri.slice(prefix.length));
  if (!listId || listId.includes('/')) refuse('invalid_credential');
  return { listId, idx: status.idx as number };
}

/**
 * Verifies the presentation of a login response against its request. Every refusal is final for
 * the request; errors of the dependencies (keys, database) are thrown as they are.
 */
export async function verifyHaipLoginPresentation(
  vpToken: unknown,
  request: HaipLoginRequest,
  vct: string,
  deps: HaipLoginVerifierDeps,
  nowSeconds: number
): Promise<HaipLoginVerification> {
  try {
    return await verify(vpToken, request, vct, deps, nowSeconds);
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.code };
    throw error;
  }
}

async function verify(
  vpToken: unknown,
  request: HaipLoginRequest,
  vct: string,
  deps: HaipLoginVerifierDeps,
  now: number
): Promise<HaipLoginVerification> {
  let presentation: string;
  try {
    presentation = extractAdminPresentation(vpToken);
  } catch {
    refuse('invalid_vp_token');
  }
  const parts = presentation.split('~');
  if (parts.length < 2) refuse('invalid_vp_token');
  // No key binding is a presentation of a credential anyone could replay: refused by name.
  const kbJwt = parts[parts.length - 1];
  const disclosures = parts.slice(1, -1);
  if (!kbJwt || disclosures.some((disclosure) => !disclosure)) refuse('invalid_key_binding');
  const issuerJwt = parts[0];

  // 1. The issuer signature, by the tenant's VC key named by `kid`, with a chain that certifies it.
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(issuerJwt);
  } catch {
    refuse('invalid_credential');
  }
  if (header.alg !== 'ES256' || header.typ !== 'dc+sd-jwt' || typeof header.kid !== 'string') {
    refuse('invalid_credential');
  }
  const issuerJwk = (await deps.issuerKeys()).find((key) => key.kid === header.kid);
  if (!issuerJwk) refuse('invalid_credential');
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(issuerJwt, await importJWK(issuerJwk, 'ES256'), {
      issuer: request.credentialIssuer,
      algorithms: ['ES256'],
      currentDate: new Date(now * 1000),
      clockTolerance: CLOCK_SKEW_SECONDS,
      requiredClaims: ['exp', 'iat'],
    }));
  } catch {
    refuse('invalid_credential');
  }
  // HAIP: the issuer's `x5c` chain must certify the very key that signed and end at the pinned CA.
  if (!Array.isArray(header.x5c) || header.x5c.some((entry) => typeof entry !== 'string')) {
    refuse('untrusted_issuer_chain');
  }
  try {
    await validateVcSigningChain(header.x5c, {
      publicKey: issuerJwk,
      issuerHost: new URL(request.credentialIssuer).hostname,
      now: now * 1000,
      expectedLength: 2,
      authrimProfile: true,
      trustedFinalCertificateSha256: deps.trustedIssuingCaSha256,
    });
  } catch {
    refuse('untrusted_issuer_chain');
  }
  if (payload.vct !== vct) refuse('invalid_credential');
  if (payload._sd_alg !== undefined && payload._sd_alg !== 'sha-256') refuse('invalid_credential');
  const holderJwk = publicEcJwk((payload.cnf as { jwk?: unknown } | undefined)?.jwk);
  if (!holderJwk) refuse('invalid_credential');

  // 2. Every disclosure sent must be one the issuer committed to, once.
  const committed = new Set(Array.isArray(payload._sd) ? (payload._sd as unknown[]) : []);
  const seen = new Set<string>();
  for (const disclosure of disclosures) {
    const digest = await sha256Base64url(disclosure);
    if (!committed.has(digest) || seen.has(digest)) refuse('invalid_credential');
    seen.add(digest);
  }

  // 3. Whose credential: an administrator of this tenant (the credential says which).
  if (typeof payload.sub !== 'string' || !payload.sub) refuse('invalid_credential');
  if (payload.tenant_id !== request.tenantId) refuse('wrong_tenant');
  const adminUserId = payload.sub;

  // 4. Its state, read from the credential row itself rather than a cached status list.
  const entry = statusEntry(payload, request.credentialIssuer);
  const record = await deps.findCredential(entry.listId, entry.idx);
  const holderJkt = await calculateJwkThumbprint(holderJwk, 'sha256');
  if (
    !record ||
    record.userId !== adminUserId ||
    record.credentialType !== vct ||
    !record.holderBinding ||
    (await calculateJwkThumbprint(record.holderBinding, 'sha256')) !== holderJkt
  ) {
    refuse('invalid_credential');
  }
  if (record.status !== 'active') refuse('credential_not_active');

  // 5. Key binding: signed by the holder key, for this request, over this very presentation.
  let kbHeader: ReturnType<typeof decodeProtectedHeader>;
  try {
    kbHeader = decodeProtectedHeader(kbJwt);
  } catch {
    refuse('invalid_key_binding');
  }
  if (kbHeader.alg !== 'ES256' || kbHeader.typ !== 'kb+jwt') refuse('invalid_key_binding');
  let kb: JWTPayload;
  try {
    ({ payload: kb } = await jwtVerify(kbJwt, await importJWK(holderJwk, 'ES256'), {
      algorithms: ['ES256'],
      // Over direct_post the audience is the client identifier, here the `x509_hash:` one.
      audience: request.clientId,
      currentDate: new Date(now * 1000),
      clockTolerance: CLOCK_SKEW_SECONDS,
      requiredClaims: ['iat'],
    }));
  } catch {
    refuse('invalid_key_binding');
  }
  if (
    typeof kb.iat !== 'number' ||
    kb.iat < now - KB_JWT_MAX_AGE_SECONDS ||
    kb.iat > now + CLOCK_SKEW_SECONDS ||
    typeof kb.nonce !== 'string' ||
    !timingSafeEqual(kb.nonce, request.nonce)
  ) {
    refuse('invalid_key_binding');
  }
  // RFC 9901: sd_hash covers the presentation up to and including the `~` before the KB-JWT.
  const sdHash = await sha256Base64url(presentation.slice(0, presentation.length - kbJwt.length));
  if (kb.sd_hash !== sdHash) refuse('invalid_key_binding');

  return { ok: true, adminUserId, holderJkt, credentialId: record.publicId };
}
