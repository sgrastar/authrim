/**
 * Login by a HAIP presentation, the operations behind the internal RPC (the admin sign-in of the
 * authentication Worker) and the two public wallet endpoints (`GET /vp/login/request/:id`,
 * `POST /vp/login/response`).
 */

import { decodeProtectedHeader, exportJWK, generateKeyPair, type JWK, type JWTPayload } from 'jose';
import { isValidTenantIdentifier } from '@authrim/ar-lib-core';
import type { Env } from '../../types';
import { isConfiguredShard } from '../../utils/configured-shard';
import {
  getVPRequestStoreById,
  getVPRequestStoreForNewRequest,
} from '../../utils/vp-request-sharding';
import {
  adminCredentialVct,
  findAdminCredential,
  findAdminCredentialStatus,
} from '../admin/admin-vp-service';
import { base64url, sha256Base64url } from '../admin/admin-vp-protocol';
import {
  buildHaipLoginRequestPayload,
  decryptHaipLoginResponse,
  verifyHaipLoginPresentation,
  HAIP_LOGIN_REQUEST_TTL_SECONDS,
} from './haip-login-protocol';
import type {
  HaipLoginFlow,
  HaipLoginRequestInput,
  HaipLoginResult,
  HaipLoginStatus,
  ReserveHaipLoginResult,
} from './haip-login-request-store';

/** The Durable Object methods used here (VPRequestStoreV2). */
interface HaipLoginStoreStub {
  createHaipLoginRequestRpc(input: HaipLoginRequestInput): Promise<void>;
  getHaipLoginRequestObjectRpc(input: {
    id: string;
    tenantId: string;
    now: number;
  }): Promise<string | null>;
  reserveHaipLoginResponseRpc(input: {
    id: string;
    tenantId: string;
    responseFingerprint: string;
    now: number;
  }): Promise<ReserveHaipLoginResult>;
  completeHaipLoginResponseRpc(input: {
    id: string;
    tenantId: string;
    reservationId: string;
    adminUserId: string;
    holderJkt: string;
    credentialId: string;
    responseCodeHash?: string;
    now: number;
  }): Promise<boolean>;
  failHaipLoginResponseRpc(input: {
    id: string;
    tenantId: string;
    reservationId: string;
    errorCode: string;
  }): Promise<boolean>;
  releaseHaipLoginResponseRpc(input: {
    id: string;
    tenantId: string;
    reservationId: string;
    now: number;
  }): Promise<boolean>;
  getHaipLoginStatusRpc(input: {
    id: string;
    tenantId: string;
    bindingHash: string;
    now: number;
  }): Promise<{
    status: HaipLoginStatus;
    flow: HaipLoginFlow;
    expiresAt: number;
    errorCode?: string;
  } | null>;
  consumeHaipLoginResultRpc(input: {
    id: string;
    tenantId: string;
    bindingHash: string;
    responseCodeHash?: string;
    now: number;
  }): Promise<HaipLoginResult | null>;
}

interface KeyManagerStub {
  signHaipLoginRequestRpc(payload: JWTPayload): Promise<{ token: string }>;
  getHaipLoginVerifierRpc(): Promise<{
    clientId: string;
    issuingCaAki: string;
    issuerHost: string;
    chainNotAfter: number;
  } | null>;
  getVcIssuerJwksRpc(): Promise<{ keys: JWK[] }>;
}

const RESPONSE_CODE = /^[A-Za-z0-9_-]{43}$/u;
const MAX_KID_LENGTH = 256;

function keyManager(env: Env, tenantId: string): KeyManagerStub {
  return env.KEY_MANAGER.get(
    env.KEY_MANAGER.idFromName(`${tenantId}-v3`)
  ) as unknown as KeyManagerStub;
}

async function storeFor(env: Env, requestId: string, tenantId: string) {
  let located: ReturnType<typeof getVPRequestStoreById>;
  try {
    located = getVPRequestStoreById(env, requestId, tenantId);
  } catch {
    return null;
  }
  if (!(await isConfiguredShard(env, tenantId, located.resolution))) return null;
  return located.stub as unknown as HaipLoginStoreStub;
}

/** `https://host` with no path, query or port: the tenant's canonical issuer. */
function canonicalIssuer(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('invalid_credential_issuer');
  }
  return url.origin;
}

/** The Authrim issuing CA certificates (hex SHA-256) the issuer chain may end at. */
export function trustedIssuingCaSha256(env: Env): string[] {
  return (env.VC_X5C_ISSUING_CA_SHA256 ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^[0-9a-f]{64}$/u.test(entry));
}

export interface CreateHaipLoginInput {
  tenantId: string;
  /** https origin of the tenant: the Credential Issuer, the verifier host and the response host. */
  credentialIssuer: string;
  flow: HaipLoginFlow;
  /** The secret the starting browser holds (never stored; its SHA-256 is). */
  bindingSecret: string;
  /** same_device: where the wallet sends the browser after it answered (https, no query). */
  redirectUri?: string;
}

export interface CreateHaipLoginResult {
  requestId: string;
  expiresAt: number;
  /** What a QR code carries (cross-device). */
  qr: string;
  /** The `haip-vp://` link a wallet on the same device opens. */
  deepLink: string;
}

function walletUri(scheme: string, clientId: string, requestUri: string): string {
  return `${scheme}?client_id=${encodeURIComponent(clientId)}&request_uri=${encodeURIComponent(requestUri)}&request_uri_method=get`;
}

function trustedConsoleOrigin(env: Env): string | null {
  const configured = (env as unknown as { ADMIN_UI_URL?: string }).ADMIN_UI_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

export async function createHaipLoginRequest(
  env: Env,
  input: CreateHaipLoginInput,
  now: number = Date.now()
): Promise<CreateHaipLoginResult> {
  if (!isValidTenantIdentifier(input.tenantId)) throw new Error('invalid_tenant_id');
  const bindingHash = await bindingHashOf(input.bindingSecret);
  if (input.flow !== 'cross_device' && input.flow !== 'same_device')
    throw new Error('invalid_flow');
  const credentialIssuer = canonicalIssuer(input.credentialIssuer);
  if (input.flow === 'same_device') {
    const redirect = new URL(input.redirectUri ?? '');
    // Back to this tenant's own console only: its issuer origin, or the configured console origin.
    if (redirect.origin !== credentialIssuer && redirect.origin !== trustedConsoleOrigin(env)) {
      throw new Error('invalid_redirect_uri');
    }
  }

  // The login is offered only while the key has a usable chain for this host.
  const verifier = await keyManager(env, input.tenantId).getHaipLoginVerifierRpc();
  if (!verifier || verifier.issuerHost !== new URL(credentialIssuer).hostname) {
    throw new Error('haip_login_unavailable');
  }

  const { stub, requestId } = await getVPRequestStoreForNewRequest(
    env,
    input.tenantId,
    'haip-login',
    crypto.randomUUID()
  );
  const nowSeconds = Math.floor(now / 1000);
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const pair = await generateKeyPair('ECDH-ES', { crv: 'P-256', extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  const encryptionKey: JWK = {
    kty: 'EC',
    crv: 'P-256',
    x: publicJwk.x,
    y: publicJwk.y,
    kid: requestId,
    use: 'enc',
    alg: 'ECDH-ES',
  };
  const payload = buildHaipLoginRequestPayload({
    clientId: verifier.clientId,
    responseUri: `${credentialIssuer}/vp/login/response`,
    nonce,
    state,
    now: nowSeconds,
    vct: adminCredentialVct(),
    encryptionKey,
    issuingCaAki: verifier.issuingCaAki,
  });
  const { token: requestObject } = await keyManager(env, input.tenantId).signHaipLoginRequestRpc(
    payload
  );
  const expiresAt = (nowSeconds + HAIP_LOGIN_REQUEST_TTL_SECONDS) * 1000;
  await (stub as unknown as HaipLoginStoreStub).createHaipLoginRequestRpc({
    id: requestId,
    tenantId: input.tenantId,
    flow: input.flow,
    bindingHash,
    clientId: verifier.clientId,
    credentialIssuer,
    nonce,
    state,
    encryptionJwk: JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid: requestId }),
    requestObject,
    ...(input.flow === 'same_device' ? { redirectUri: input.redirectUri } : {}),
    createdAt: now,
    expiresAt,
  });
  const requestUri = `${credentialIssuer}/vp/login/request/${encodeURIComponent(requestId)}`;
  return {
    requestId,
    expiresAt,
    qr: walletUri('openid4vp://', verifier.clientId, requestUri),
    deepLink: walletUri('haip-vp://', verifier.clientId, requestUri),
  };
}

/** The signed request object for a wallet, or null when it can no longer be answered. */
export async function getHaipLoginRequestObject(
  env: Env,
  tenantId: string,
  requestId: string,
  now: number = Date.now()
): Promise<string | null> {
  const store = await storeFor(env, requestId, tenantId);
  if (!store) return null;
  return store.getHaipLoginRequestObjectRpc({ id: requestId, tenantId, now });
}

export type HaipLoginResponseOutcome =
  | { kind: 'verified'; redirectUri?: string }
  | { kind: 'refused'; error: string }
  | { kind: 'unknown' }
  | { kind: 'replayed' }
  | { kind: 'unavailable' };

/**
 * Accept one wallet response (`direct_post.jwt`): the JWE names its request by `kid`. The request
 * is reserved first, so a response is verified at most once; a refusal fails the request for good,
 * an infrastructure error gives it back so the wallet can post again.
 */
export async function acceptHaipLoginResponse(
  env: Env,
  tenantId: string,
  response: string,
  now: number = Date.now()
): Promise<HaipLoginResponseOutcome> {
  let requestId: string;
  try {
    const kid = decodeProtectedHeader(response).kid;
    if (typeof kid !== 'string' || !kid || kid.length > MAX_KID_LENGTH) return { kind: 'unknown' };
    requestId = kid;
  } catch {
    return { kind: 'unknown' };
  }
  const store = await storeFor(env, requestId, tenantId);
  if (!store) return { kind: 'unknown' };
  const reservation = await store.reserveHaipLoginResponseRpc({
    id: requestId,
    tenantId,
    responseFingerprint: await sha256Base64url(`${requestId}\u0000${response}`),
    now,
  });
  if (!reservation.reserved) {
    if (reservation.reason === 'not_found' || reservation.reason === 'expired') {
      return { kind: 'unknown' };
    }
    return reservation.reason === 'replayed' ? { kind: 'replayed' } : { kind: 'unavailable' };
  }
  const { reservationId, request } = reservation;
  const fail = async (error: string): Promise<HaipLoginResponseOutcome> => {
    await store.failHaipLoginResponseRpc({
      id: requestId,
      tenantId,
      reservationId,
      errorCode: error,
    });
    return { kind: 'refused', error };
  };
  try {
    let vpToken: unknown;
    try {
      vpToken = await decryptHaipLoginResponse(response, request.encryptionJwk, {
        state: request.state,
        encryptionKid: requestId,
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      return await fail(code === 'state_mismatch' ? 'state_mismatch' : 'invalid_response');
    }
    const result = await verifyHaipLoginPresentation(
      vpToken,
      {
        tenantId,
        credentialIssuer: request.credentialIssuer,
        clientId: request.clientId,
        nonce: request.nonce,
        state: request.state,
        encryptionKid: requestId,
      },
      adminCredentialVct(),
      {
        issuerKeys: async () => (await keyManager(env, tenantId).getVcIssuerJwksRpc()).keys,
        findCredential: (listId, index) => findAdminCredential(env, tenantId, listId, index),
        trustedIssuingCaSha256: trustedIssuingCaSha256(env),
      },
      Math.floor(now / 1000)
    );
    if (!result.ok) return await fail(result.error);
    // A same-device login hands the browser a response code in the redirect; only its hash stays.
    const responseCode =
      request.flow === 'same_device' ? base64url(crypto.getRandomValues(new Uint8Array(32))) : null;
    const completed = await store.completeHaipLoginResponseRpc({
      id: requestId,
      tenantId,
      reservationId,
      adminUserId: result.adminUserId,
      holderJkt: result.holderJkt,
      credentialId: result.credentialId,
      ...(responseCode ? { responseCodeHash: await sha256Base64url(responseCode) } : {}),
      now,
    });
    if (!completed) return { kind: 'unavailable' };
    if (responseCode && request.redirectUri) {
      return {
        kind: 'verified',
        redirectUri: `${request.redirectUri}?request_id=${encodeURIComponent(requestId)}&response_code=${encodeURIComponent(responseCode)}`,
      };
    }
    return { kind: 'verified' };
  } catch (error) {
    await store
      .releaseHaipLoginResponseRpc({ id: requestId, tenantId, reservationId, now })
      .catch(() => false);
    throw error;
  }
}

export interface HaipLoginRef {
  tenantId: string;
  requestId: string;
  /** The secret the starting browser holds (never stored; its hash is). */
  bindingSecret: string;
}

async function bindingHashOf(secret: string): Promise<string> {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256) {
    throw new Error('invalid_binding');
  }
  return sha256Base64url(secret);
}

export async function getHaipLoginStatus(
  env: Env,
  ref: HaipLoginRef,
  now: number = Date.now()
): Promise<{
  status: HaipLoginStatus;
  flow: HaipLoginFlow;
  expiresAt: number;
  errorCode?: string;
} | null> {
  if (!isValidTenantIdentifier(ref.tenantId)) throw new Error('invalid_tenant_id');
  const store = await storeFor(env, ref.requestId, ref.tenantId);
  if (!store) return null;
  return store.getHaipLoginStatusRpc({
    id: ref.requestId,
    tenantId: ref.tenantId,
    bindingHash: await bindingHashOf(ref.bindingSecret),
    now,
  });
}

/** The verified result, handed over once to the browser that started the request. */
export async function consumeHaipLoginResult(
  env: Env,
  ref: HaipLoginRef & { responseCode?: string },
  now: number = Date.now()
): Promise<HaipLoginResult | null> {
  if (!isValidTenantIdentifier(ref.tenantId)) throw new Error('invalid_tenant_id');
  if (ref.responseCode !== undefined && !RESPONSE_CODE.test(ref.responseCode)) return null;
  const store = await storeFor(env, ref.requestId, ref.tenantId);
  if (!store) return null;
  const result = await store.consumeHaipLoginResultRpc({
    id: ref.requestId,
    tenantId: ref.tenantId,
    bindingHash: await bindingHashOf(ref.bindingSecret),
    ...(ref.responseCode ? { responseCodeHash: await sha256Base64url(ref.responseCode) } : {}),
    now,
  });
  if (!result) return null;
  // The presentation was verified up to two minutes ago: the credential must still stand now.
  const credential = await findAdminCredentialStatus(env, ref.tenantId, result.credentialId);
  if (!credential || credential.status !== 'active' || credential.userId !== result.adminUserId) {
    return null;
  }
  return result;
}
