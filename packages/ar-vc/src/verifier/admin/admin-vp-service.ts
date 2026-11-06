/**
 * Administrator presentations: the operations behind the internal RPC (Management) and the two
 * public wallet endpoints (`GET /vp/admin/request/:id`, `POST /vp/admin/response`).
 */

import { exportJWK, generateKeyPair, type JWK, type JWTPayload } from 'jose';
import {
  ADMIN_CREDENTIAL_CONFIGURATION_ID,
  ensureDatabaseAdapter,
  isValidTenantIdentifier,
  resolveTenantMetadataContext,
  type AdminPresentationRef,
  type AdminPresentationResult,
  type AdminPresentationStatus,
  type CreateAdminPresentationInput,
  type CreateAdminPresentationResult,
  type Env as CoreEnv,
} from '@authrim/ar-lib-core';
import type { Env } from '../../types';
import { getCredentialConfiguration } from '../../issuer/credential-configurations';
import { isConfiguredShard } from '../../utils/configured-shard';
import {
  getVPRequestStoreById,
  getVPRequestStoreForNewRequest,
} from '../../utils/vp-request-sharding';
import {
  ADMIN_VP_DC_API_PROTOCOL,
  ADMIN_VP_REQUEST_TTL_SECONDS,
  decryptDcApiAnswer,
  adminVPClientId,
  adminVPQrValue,
  adminVPRequestUri,
  base64url,
  buildAdminVPRequestPayload,
  encodeTransactionData,
  generateMatchCode,
  sha256Base64url,
  verifyAdminPresentation,
  type AdminCredentialRecord,
} from './admin-vp-protocol';
import type {
  AdminVPMode,
  AdminVPRequest,
  AdminVPRequestInput,
  AdminVPResult,
  AdminVPStatus,
  ReserveAdminVPResult,
} from './admin-vp-request-store';

/** The Durable Object methods used here (VPRequestStoreV2). */
interface AdminVPStoreStub {
  createAdminRequestRpc(input: AdminVPRequestInput): Promise<void>;
  getAdminRequestObjectRpc(input: {
    id: string;
    tenantId: string;
    now: number;
  }): Promise<string | null>;
  reserveAdminResponseRpc(input: {
    id: string;
    tenantId: string;
    responseFingerprint: string;
    now: number;
    mode?: AdminVPMode;
  }): Promise<ReserveAdminVPResult>;
  completeAdminResponseRpc(input: {
    id: string;
    tenantId: string;
    reservationId: string;
    holderJkt: string;
    credentialId: string;
    now: number;
  }): Promise<boolean>;
  failAdminResponseRpc(input: {
    id: string;
    tenantId: string;
    reservationId: string;
    errorCode: string;
  }): Promise<boolean>;
  releaseAdminResponseRpc(input: {
    id: string;
    tenantId: string;
    reservationId: string;
    now: number;
  }): Promise<boolean>;
  getAdminStatusRpc(input: {
    id: string;
    tenantId: string;
    adminUserId: string;
    sessionId: string;
    now: number;
  }): Promise<{ status: AdminVPStatus; expiresAt: number; errorCode?: string } | null>;
  consumeAdminResultRpc(input: {
    id: string;
    tenantId: string;
    adminUserId: string;
    sessionId: string;
    now: number;
  }): Promise<AdminVPResult | null>;
}

interface KeyManagerStub {
  signAdminVPRequestRpc(payload: JWTPayload): Promise<{ token: string }>;
  getVcIssuerJwksRpc(): Promise<{ keys: JWK[] }>;
}

const IDENTIFIER = /^[A-Za-z0-9_.:@-]{1,256}$/u;
const JKT = /^[A-Za-z0-9_-]{43}$/u;

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new Error(`invalid_${field}`);
  }
  return value;
}

export function adminCredentialVct(): string {
  const configuration = getCredentialConfiguration(ADMIN_CREDENTIAL_CONFIGURATION_ID);
  if (!configuration) throw new Error('admin_credential_configuration_missing');
  return configuration.vct;
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

function keyManager(env: Env, tenantId: string): KeyManagerStub {
  return env.KEY_MANAGER.get(
    env.KEY_MANAGER.idFromName(`${tenantId}-v3`)
  ) as unknown as KeyManagerStub;
}

/** The store of an existing request, or null for a forged or unconfigured shard. */
async function storeFor(env: Env, requestId: string, tenantId: string) {
  let located: ReturnType<typeof getVPRequestStoreById>;
  try {
    located = getVPRequestStoreById(env, requestId, tenantId);
  } catch {
    return null;
  }
  if (!(await isConfiguredShard(env, tenantId, located.resolution))) return null;
  return located.stub as unknown as AdminVPStoreStub;
}

export async function createAdminPresentationRequest(
  env: Env,
  input: CreateAdminPresentationInput,
  now: number = Date.now()
): Promise<CreateAdminPresentationResult> {
  if (!isValidTenantIdentifier(input.tenantId)) throw new Error('invalid_tenant_id');
  const adminUserId = identifier(input.adminUserId, 'admin_user_id');
  const sessionId = identifier(input.sessionId, 'session_id');
  if (input.purpose !== 'step_up' && input.purpose !== 'enroll') {
    throw new Error('invalid_purpose');
  }
  if (
    !Array.isArray(input.holderJkts) ||
    input.holderJkts.length > 32 ||
    input.holderJkts.some((jkt) => typeof jkt !== 'string' || !JKT.test(jkt))
  ) {
    throw new Error('invalid_holder_jkts');
  }
  if (input.purpose === 'step_up' && input.holderJkts.length === 0) {
    throw new Error('no_registered_holder_key');
  }
  if (
    input.walletMode !== undefined &&
    (input.walletMode !== 'recovery' || input.purpose !== 'enroll')
  ) {
    throw new Error('invalid_wallet_mode');
  }
  const credentialIssuer = canonicalIssuer(input.credentialIssuer);
  const tenantLabel =
    typeof input.tenantLabel === 'string' && input.tenantLabel.trim()
      ? input.tenantLabel.trim()
      : input.tenantId;

  const { stub, requestId } = await getVPRequestStoreForNewRequest(
    env,
    input.tenantId,
    adminUserId,
    crypto.randomUUID()
  );
  const nowSeconds = Math.floor(now / 1000);
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const mode = input.mode ?? 'direct_post';
  if (mode !== 'direct_post' && mode !== 'dc_api') throw new Error('invalid_mode');
  // The Digital Credentials API binds the answer to the console origin and encrypts it to a key
  // of this request only; a QR code needs the number the admin types instead.
  const matchCode = mode === 'direct_post' ? generateMatchCode() : '';
  let expectedOrigin: string | undefined;
  let encryption: { publicJwk: JWK; privateJwk: string } | undefined;
  if (mode === 'dc_api') {
    expectedOrigin = httpsOrigin(input.origin);
    const pair = await generateKeyPair('ECDH-ES', { crv: 'P-256', extractable: true });
    const kid = base64url(crypto.getRandomValues(new Uint8Array(12)));
    const publicJwk = await exportJWK(pair.publicKey);
    encryption = {
      publicJwk: {
        kty: 'EC',
        crv: 'P-256',
        x: publicJwk.x,
        y: publicJwk.y,
        kid,
        use: 'enc',
        alg: 'ECDH-ES',
      },
      privateJwk: JSON.stringify({ ...(await exportJWK(pair.privateKey)), kid }),
    };
  }
  const transactionData = encodeTransactionData({
    purpose: input.purpose,
    tenant: tenantLabel,
    requestedAt: nowSeconds,
    matchCodeRequired: mode === 'direct_post',
    ...(input.purpose === 'enroll' && input.walletMode === 'recovery'
      ? { mode: 'recovery' as const }
      : {}),
  });
  const payload = buildAdminVPRequestPayload({
    credentialIssuer,
    vct: adminCredentialVct(),
    nonce,
    transactionData,
    now: nowSeconds,
    transport:
      mode === 'direct_post'
        ? { mode, state: requestId }
        : { mode, expectedOrigin: expectedOrigin!, encryptionKey: encryption!.publicJwk },
  });
  const { token: requestObject } = await keyManager(env, input.tenantId).signAdminVPRequestRpc(
    payload
  );
  const expiresAt = (nowSeconds + ADMIN_VP_REQUEST_TTL_SECONDS) * 1000;
  const clientId = adminVPClientId(credentialIssuer);

  await (stub as unknown as AdminVPStoreStub).createAdminRequestRpc({
    id: requestId,
    tenantId: input.tenantId,
    adminUserId,
    sessionId,
    purpose: input.purpose,
    holderJkts: [...new Set(input.holderJkts)],
    nonce,
    matchCode,
    clientId,
    credentialIssuer,
    transactionData,
    requestObject,
    context: input.context ?? {},
    mode,
    ...(expectedOrigin ? { expectedOrigin } : {}),
    ...(encryption ? { encryptionJwk: encryption.privateJwk } : {}),
    createdAt: now,
    expiresAt,
  });

  if (mode === 'dc_api') {
    return {
      requestId,
      expiresAt,
      dcRequest: { protocol: ADMIN_VP_DC_API_PROTOCOL, data: { request: requestObject } },
    };
  }
  return {
    requestId,
    qr: adminVPQrValue(clientId, adminVPRequestUri(credentialIssuer, requestId)),
    matchCode,
    expiresAt,
  };
}

/** `https://host[:port]` as the console sent it; nothing else is a request origin. */
function httpsOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid_origin');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value) throw new Error('invalid_origin');
  return value;
}

function checkRef(ref: AdminPresentationRef): void {
  if (!isValidTenantIdentifier(ref.tenantId)) throw new Error('invalid_tenant_id');
  identifier(ref.adminUserId, 'admin_user_id');
  identifier(ref.sessionId, 'session_id');
}

export async function getAdminPresentationStatus(
  env: Env,
  ref: AdminPresentationRef,
  now: number = Date.now()
): Promise<{ status: AdminPresentationStatus; expiresAt: number; errorCode?: string } | null> {
  checkRef(ref);
  const store = await storeFor(env, ref.requestId, ref.tenantId);
  if (!store) return null;
  return store.getAdminStatusRpc({
    id: ref.requestId,
    tenantId: ref.tenantId,
    adminUserId: ref.adminUserId,
    sessionId: ref.sessionId,
    now,
  });
}

export async function consumeAdminPresentation(
  env: Env,
  ref: AdminPresentationRef,
  now: number = Date.now()
): Promise<AdminPresentationResult | null> {
  checkRef(ref);
  const store = await storeFor(env, ref.requestId, ref.tenantId);
  if (!store) return null;
  return store.consumeAdminResultRpc({
    id: ref.requestId,
    tenantId: ref.tenantId,
    adminUserId: ref.adminUserId,
    sessionId: ref.sessionId,
    now,
  });
}

/** The signed request object for a wallet, or null when it can no longer be answered. */
export async function getAdminRequestObject(
  env: Env,
  tenantId: string,
  requestId: string,
  now: number = Date.now()
): Promise<string | null> {
  const store = await storeFor(env, requestId, tenantId);
  if (!store) return null;
  return store.getAdminRequestObjectRpc({ id: requestId, tenantId, now });
}

/**
 * The answer the browser handed the console for a Digital Credentials API request, submitted by
 * Management for the admin session that asked for it. Verified like a wallet's direct_post, after
 * decryption with the request's ephemeral key; no match code (the browser bound it to the origin).
 */
export async function submitAdminPresentationResponse(
  env: Env,
  ref: AdminPresentationRef,
  data: unknown,
  now: number = Date.now()
): Promise<AdminResponseOutcome> {
  checkRef(ref);
  const store = await storeFor(env, ref.requestId, ref.tenantId);
  if (!store) return { kind: 'unknown' };
  // Only the session that asked may answer, and only while it can.
  const status = await store.getAdminStatusRpc({
    id: ref.requestId,
    tenantId: ref.tenantId,
    adminUserId: ref.adminUserId,
    sessionId: ref.sessionId,
    now,
  });
  if (!status) return { kind: 'unknown' };
  const serialized = JSON.stringify(data ?? null);
  if (serialized.length > 96 * 1024) return { kind: 'refused', error: 'invalid_vp_token' };
  return verifyReserved(
    env,
    store,
    ref.tenantId,
    ref.requestId,
    now,
    'dc_api',
    serialized,
    async (request) => decryptDcApiAnswer(data, request.encryptionJwk ?? '')
  );
}

export type AdminResponseOutcome =
  | { kind: 'verified' }
  | { kind: 'refused'; error: string }
  | { kind: 'unknown' }
  | { kind: 'replayed' }
  | { kind: 'unavailable' };

/** The admin credential row at a status list entry of the tenant's core database. */
async function findAdminCredential(
  env: Env,
  tenantId: string,
  listId: string,
  index: number
): Promise<AdminCredentialRecord | null> {
  const context = await resolveTenantMetadataContext(env as unknown as CoreEnv, tenantId);
  const adapter = ensureDatabaseAdapter(context.coreDb, 'vc-admin-presentation');
  const row = await adapter.queryOne<{
    public_id: string;
    user_id: string;
    credential_type: string;
    status: string;
    holder_binding: string | null;
  }>(
    `SELECT public_id, user_id, credential_type, status, holder_binding
       FROM issued_credentials
      WHERE tenant_id = ? AND status_list_id = ? AND status_list_index = ?`,
    [tenantId, listId, index]
  );
  if (!row) return null;
  let holderBinding: JWK | null = null;
  try {
    holderBinding = row.holder_binding ? (JSON.parse(row.holder_binding) as JWK) : null;
  } catch {
    holderBinding = null;
  }
  return {
    publicId: row.public_id,
    userId: row.user_id,
    credentialType: row.credential_type,
    status: row.status,
    holderBinding,
  };
}

/**
 * Accept one wallet response (`direct_post`). The request is reserved first, so a response is
 * verified at most once; a verification refusal fails the request for good, an infrastructure
 * error gives it back so the wallet can post again.
 */
export async function acceptAdminResponse(
  env: Env,
  tenantId: string,
  requestId: string,
  vpToken: string,
  now: number = Date.now()
): Promise<AdminResponseOutcome> {
  const store = await storeFor(env, requestId, tenantId);
  if (!store) return { kind: 'unknown' };
  return verifyReserved(
    env,
    store,
    tenantId,
    requestId,
    now,
    'direct_post',
    vpToken,
    async () => vpToken
  );
}

/**
 * Reserve the request for one answer (so it is verified at most once), read its vp_token,
 * verify it, and record the outcome. A refusal fails the request for good; an infrastructure
 * error gives it back so the answer can be sent again.
 */
async function verifyReserved(
  env: Env,
  store: AdminVPStoreStub,
  tenantId: string,
  requestId: string,
  now: number,
  mode: AdminVPMode,
  fingerprintInput: string,
  readVpToken: (request: AdminVPRequest) => Promise<unknown>
): Promise<AdminResponseOutcome> {
  const reservation = await store.reserveAdminResponseRpc({
    id: requestId,
    tenantId,
    responseFingerprint: await sha256Base64url(`${requestId}\u0000${fingerprintInput}`),
    now,
    mode,
  });
  if (!reservation.reserved) {
    if (reservation.reason === 'not_found' || reservation.reason === 'expired') {
      return { kind: 'unknown' };
    }
    return reservation.reason === 'replayed' ? { kind: 'replayed' } : { kind: 'unavailable' };
  }

  const { reservationId, request } = reservation;
  const fail = async (error: string): Promise<AdminResponseOutcome> => {
    await store.failAdminResponseRpc({ id: requestId, tenantId, reservationId, errorCode: error });
    return { kind: 'refused', error };
  };
  try {
    let vpToken: unknown;
    try {
      vpToken = await readVpToken(request);
    } catch {
      return await fail('invalid_vp_token');
    }
    const result = await verifyAdminPresentation(
      vpToken,
      request,
      adminCredentialVct(),
      {
        issuerKeys: async () => (await keyManager(env, tenantId).getVcIssuerJwksRpc()).keys,
        findCredential: (listId, index) => findAdminCredential(env, tenantId, listId, index),
      },
      Math.floor(now / 1000)
    );
    if (!result.ok) return await fail(result.error);
    const completed = await store.completeAdminResponseRpc({
      id: requestId,
      tenantId,
      reservationId,
      holderJkt: result.holderJkt,
      credentialId: result.credentialId,
      now,
    });
    return completed ? { kind: 'verified' } : { kind: 'unavailable' };
  } catch (error) {
    await store
      .releaseAdminResponseRpc({ id: requestId, tenantId, reservationId, now })
      .catch(() => false);
    throw error;
  }
}
