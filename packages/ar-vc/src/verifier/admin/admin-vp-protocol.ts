/**
 * The administrator presentation (OpenID4VP 1.0, cross-device `direct_post`): the request object
 * Authrim signs and the one way a response is accepted.
 *
 * The acceptance rules are fixed here and do not read the relying-party HAIP settings or the
 * trusted-issuer registry: the credential is Authrim's own admin credential, so its issuer key
 * comes from this tenant's KeyManager and its state from the credential row itself.
 */

import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from 'jose';
import type { AdminVPPurpose, AdminVPRequest } from './admin-vp-request-store';

/** The DCQL credential query id; the response's `vp_token` is keyed by it. */
export const ADMIN_VP_QUERY_ID = 'admin';
export const ADMIN_VP_TRANSACTION_DATA_TYPE = 'authrim_admin_step_up';
export const ADMIN_VP_MATCH_CODE_CLAIM = 'authrim_match_code';
const CLIENT_ID_PREFIX = 'decentralized_identifier:';
/** Lifetime of a request: the wallet has this long to answer. */
export const ADMIN_VP_REQUEST_TTL_SECONDS = 300;
const KB_JWT_MAX_AGE_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 60;
const MAX_VP_TOKEN_LENGTH = 32 * 1024;

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

export async function sha256Base64url(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

/** did:web of the host of the credential issuer (hostname only: did:web carries no port here). */
export function adminVPDid(credentialIssuer: string): string {
  const url = new URL(credentialIssuer);
  if (url.protocol !== 'https:' || url.port !== '') throw new Error('admin_vp_invalid_issuer');
  return `did:web:${url.hostname.toLowerCase()}`;
}

export function adminVPClientId(credentialIssuer: string): string {
  return `${CLIENT_ID_PREFIX}${adminVPDid(credentialIssuer)}`;
}

export function adminVPResponseUri(credentialIssuer: string): string {
  return `${new URL(credentialIssuer).origin}/vp/admin/response`;
}

export function adminVPRequestUri(credentialIssuer: string, requestId: string): string {
  return `${new URL(credentialIssuer).origin}/vp/admin/request/${encodeURIComponent(requestId)}`;
}

/** What the wallet scans: `openid4vp://` with the request passed by reference. */
export function adminVPQrValue(clientId: string, requestUri: string): string {
  return `openid4vp://?client_id=${encodeURIComponent(clientId)}&request_uri=${encodeURIComponent(requestUri)}`;
}

/** Two digits for the admin to type into the wallet; never part of the request. */
export function generateMatchCode(): string {
  const value = new Uint32Array(1);
  // Rejection sampling keeps the 100 codes equally likely.
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= 4_294_967_200);
  return String(value[0] % 100).padStart(2, '0');
}

export interface AdminVPTransactionDetails {
  purpose: AdminVPPurpose;
  /** Shown in the wallet: which tenant the admin is acting in. */
  tenant: string;
  requestedAt: number;
}

/** The single `transaction_data` entry, base64url-encoded JSON (OpenID4VP 1.0 section 8.4). */
export function encodeTransactionData(details: AdminVPTransactionDetails): string {
  return base64url(
    encoder.encode(
      JSON.stringify({
        type: ADMIN_VP_TRANSACTION_DATA_TYPE,
        credential_ids: [ADMIN_VP_QUERY_ID],
        purpose: details.purpose,
        tenant: details.tenant.slice(0, 200),
        requested_at: details.requestedAt,
        match_code_required: true,
      })
    )
  );
}

export function buildAdminVPRequestPayload(input: {
  credentialIssuer: string;
  vct: string;
  nonce: string;
  state: string;
  transactionData: string;
  now: number;
}): JWTPayload {
  return {
    aud: 'https://self-issued.me/v2',
    client_id: adminVPClientId(input.credentialIssuer),
    response_type: 'vp_token',
    response_mode: 'direct_post',
    response_uri: adminVPResponseUri(input.credentialIssuer),
    nonce: input.nonce,
    state: input.state,
    iat: input.now,
    exp: input.now + ADMIN_VP_REQUEST_TTL_SECONDS,
    dcql_query: {
      credentials: [
        {
          id: ADMIN_VP_QUERY_ID,
          format: 'dc+sd-jwt',
          meta: { vct_values: [input.vct] },
          claims: [{ path: ['sub'] }, { path: ['tenant_id'] }],
        },
      ],
    },
    transaction_data: [input.transactionData],
  };
}

/** The admin credential row the presentation's status entry points at. */
export interface AdminCredentialRecord {
  publicId: string;
  userId: string;
  credentialType: string;
  status: string;
  holderBinding: JWK | null;
}

export interface AdminVPVerifierDeps {
  /** The tenant's VC issuer public keys (KeyManager), including keys retained after rotation. */
  issuerKeys(): Promise<JWK[]>;
  /** The credential at a status list entry of the tenant, or null. */
  findCredential(listId: string, index: number): Promise<AdminCredentialRecord | null>;
}

export type AdminVPVerification =
  | { ok: true; holderJkt: string; credentialId: string }
  | { ok: false; error: AdminVPErrorCode };

export type AdminVPErrorCode =
  | 'invalid_vp_token'
  | 'invalid_credential'
  | 'credential_not_active'
  | 'wrong_admin'
  | 'holder_key_not_registered'
  | 'holder_key_already_registered'
  | 'invalid_key_binding'
  | 'transaction_data_mismatch'
  | 'match_code_mismatch';

class Refusal extends Error {
  constructor(readonly code: AdminVPErrorCode) {
    super(code);
  }
}

function refuse(code: AdminVPErrorCode): never {
  throw new Refusal(code);
}

/** The one presentation of the response: `vp_token` is `{ "admin": ["<SD-JWT+KB>"] }`. */
export function extractAdminPresentation(vpToken: unknown): string {
  if (typeof vpToken !== 'string' || vpToken.length > MAX_VP_TOKEN_LENGTH) {
    refuse('invalid_vp_token');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(vpToken) as unknown;
  } catch {
    refuse('invalid_vp_token');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    refuse('invalid_vp_token');
  }
  const entries = Object.entries(parsed);
  if (entries.length !== 1 || entries[0][0] !== ADMIN_VP_QUERY_ID) refuse('invalid_vp_token');
  const presentations: unknown = entries[0][1];
  if (
    !Array.isArray(presentations) ||
    presentations.length !== 1 ||
    typeof presentations[0] !== 'string'
  ) {
    refuse('invalid_vp_token');
  }
  return presentations[0];
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
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
 * Verify a wallet response against its request. Every refusal is final for the request; errors
 * of the dependencies (keys, database) are thrown as they are so the caller can release it.
 */
export async function verifyAdminPresentation(
  vpToken: unknown,
  request: AdminVPRequest,
  vct: string,
  deps: AdminVPVerifierDeps,
  nowSeconds: number
): Promise<AdminVPVerification> {
  try {
    return await verify(vpToken, request, vct, deps, nowSeconds);
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.code };
    throw error;
  }
}

async function verify(
  vpToken: unknown,
  request: AdminVPRequest,
  vct: string,
  deps: AdminVPVerifierDeps,
  now: number
): Promise<AdminVPVerification> {
  const presentation = extractAdminPresentation(vpToken);
  const parts = presentation.split('~');
  // issuer-signed JWT ~ disclosures... ~ KB-JWT; the KB-JWT is the last part, after a `~`.
  if (parts.length < 2) refuse('invalid_vp_token');
  const kbJwt = parts[parts.length - 1];
  const disclosures = parts.slice(1, -1);
  if (!kbJwt || disclosures.some((disclosure) => !disclosure)) refuse('invalid_vp_token');
  const issuerJwt = parts[0];

  // 1. The issuer signature, with this tenant's own VC issuer key named by kid.
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

  // 3. Whose credential: this admin, in the home tenant the request was made for.
  if (payload.sub !== request.adminUserId || payload.tenant_id !== request.tenantId) {
    refuse('wrong_admin');
  }

  // 4. Its state, read from the credential row itself rather than a cached status list.
  const entry = statusEntry(payload, request.credentialIssuer);
  const record = await deps.findCredential(entry.listId, entry.idx);
  const holderJkt = await calculateJwkThumbprint(holderJwk, 'sha256');
  if (
    !record ||
    record.userId !== request.adminUserId ||
    record.credentialType !== vct ||
    !record.holderBinding ||
    (await calculateJwkThumbprint(record.holderBinding, 'sha256')) !== holderJkt
  ) {
    refuse('invalid_credential');
  }
  if (record.status !== 'active') refuse('credential_not_active');

  // 5. The holder key against the admin's registered second factors.
  const registered = request.holderJkts.includes(holderJkt);
  if (request.purpose === 'step_up' && !registered) refuse('holder_key_not_registered');
  if (request.purpose === 'enroll' && registered) refuse('holder_key_already_registered');

  // 6. Key binding: signed by the holder key, for this request, over this very presentation.
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

  const hashes = kb.transaction_data_hashes;
  const expected = await sha256Base64url(request.transactionData);
  if (
    !Array.isArray(hashes) ||
    hashes.length !== 1 ||
    hashes[0] !== expected ||
    (kb.transaction_data_hashes_alg !== undefined && kb.transaction_data_hashes_alg !== 'sha-256')
  ) {
    refuse('transaction_data_mismatch');
  }

  // 7. The number shown in the console, typed by the admin and signed with the holder key.
  const code = kb[ADMIN_VP_MATCH_CODE_CLAIM];
  if (typeof code !== 'string' || !timingSafeEqual(code, request.matchCode)) {
    refuse('match_code_mismatch');
  }

  return { ok: true, holderJkt, credentialId: record.publicId };
}
