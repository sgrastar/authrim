/**
 * The login by a HAIP presentation, start to finish through the service: the request object the
 * wallet fetches, the encrypted answer it posts, and the one-time result the sign-in takes. Real
 * crypto and a real SQLite table; the key manager, the credential row and the sharding are fakes.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactEncrypt, decodeJwt, importJWK, SignJWT, type JWK } from 'jose';
import { createSqliteState } from '../../../issuer/durable-objects/__tests__/sqlite-storage';
import { HaipLoginRequestTable } from '../haip-login-request-store';
import {
  HOST,
  ISSUER,
  NOW_MS,
  VCT,
  buildFixture,
  makePresentation,
  type Fixture,
} from './haip-login-fixtures';

const mocks = vi.hoisted(() => ({
  findAdminCredential: vi.fn(),
  findAdminCredentialStatus: vi.fn(),
  table: undefined as unknown as { current: unknown },
}));

vi.mock('../../../utils/configured-shard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/configured-shard')>()),
  isConfiguredShard: vi.fn(async () => true),
}));
vi.mock('../../admin/admin-vp-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../admin/admin-vp-service')>()),
  findAdminCredential: mocks.findAdminCredential,
  findAdminCredentialStatus: mocks.findAdminCredentialStatus,
}));
vi.mock('../../../utils/vp-request-sharding', () => {
  const stub = () => (mocks.table as unknown as { stub: unknown }).stub;
  return {
    getVPRequestStoreForNewRequest: vi.fn(async () => ({
      stub: stub(),
      requestId: 'g1:apac:0:vp_login-1',
    })),
    getVPRequestStoreById: vi.fn((_env: unknown, requestId: string) =>
      requestId === 'g1:apac:0:vp_login-1'
        ? { stub: stub(), resolution: {} }
        : (() => {
            throw new Error('bad id');
          })()
    ),
  };
});

import {
  acceptHaipLoginResponse,
  consumeHaipLoginResult,
  createHaipLoginRequest,
  getHaipLoginRequestObject,
  getHaipLoginStatus,
} from '../haip-login-service';
import type { Env } from '../../../types';

let fx: Fixture;
const SECRET = 's'.repeat(43);
const OTHER_SECRET = 'o'.repeat(43);
const REQUEST_ID = 'g1:apac:0:vp_login-1';

beforeAll(async () => {
  fx = await buildFixture();
});

/** A DO whose RPC surface is the real table over SQLite. */
function makeStore() {
  const { state } = createSqliteState();
  const table = new HaipLoginRequestTable(state.storage.sql);
  table.initialize();
  const stub = {
    createHaipLoginRequestRpc: async (input: never) => table.create(input),
    getHaipLoginRequestObjectRpc: async (i: { id: string; tenantId: string; now: number }) =>
      table.requestObject(i.id, i.tenantId, i.now),
    reserveHaipLoginResponseRpc: async (i: {
      id: string;
      tenantId: string;
      responseFingerprint: string;
      now: number;
    }) => table.reserve(i.id, i.tenantId, i.responseFingerprint, i.now),
    completeHaipLoginResponseRpc: async (i: {
      id: string;
      tenantId: string;
      reservationId: string;
      adminUserId: string;
      holderJkt: string;
      credentialId: string;
      responseCodeHash?: string;
      now: number;
    }) =>
      table.complete(
        i.id,
        i.tenantId,
        i.reservationId,
        {
          adminUserId: i.adminUserId,
          holderJkt: i.holderJkt,
          credentialId: i.credentialId,
          ...(i.responseCodeHash ? { responseCodeHash: i.responseCodeHash } : {}),
        },
        i.now
      ),
    failHaipLoginResponseRpc: async (i: {
      id: string;
      tenantId: string;
      reservationId: string;
      errorCode: string;
    }) => table.fail(i.id, i.tenantId, i.reservationId, i.errorCode),
    releaseHaipLoginResponseRpc: async (i: {
      id: string;
      tenantId: string;
      reservationId: string;
      now: number;
    }) => table.release(i.id, i.tenantId, i.reservationId, i.now),
    getHaipLoginStatusRpc: async (i: {
      id: string;
      tenantId: string;
      bindingHash: string;
      now: number;
    }) => table.status(i.id, i.tenantId, i.bindingHash, i.now),
    consumeHaipLoginResultRpc: async (i: {
      id: string;
      tenantId: string;
      bindingHash: string;
      responseCodeHash?: string;
      now: number;
    }) => table.consume(i.id, i.tenantId, i.bindingHash, i.responseCodeHash, i.now),
  };
  mocks.table = { stub } as never;
}

async function envFor(options: { verifier?: unknown } = {}) {
  const verifier =
    options.verifier === undefined
      ? {
          clientId: 'x509_hash:' + 'v'.repeat(43),
          issuingCaAki: 'AKI',
          issuerHost: HOST,
          chainNotAfter: NOW_MS + 86_400_000,
        }
      : options.verifier;
  const signed: string[] = [];
  const keyManager = {
    getHaipLoginVerifierRpc: vi.fn(async () => verifier),
    signHaipLoginRequestRpc: vi.fn(async (payload: Record<string, unknown>) => {
      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'ES256', typ: 'oauth-authz-req+jwt', x5c: fx.verifierChain })
        .sign(fx.verifier.privateKey);
      signed.push(token);
      return { token };
    }),
    getVcIssuerJwksRpc: vi.fn(async () => ({
      keys: [{ ...fx.vcKey.publicJwk, kid: 'vc-key-1', alg: 'ES256' }],
    })),
  };
  const env = {
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue({}),
      get: vi.fn().mockReturnValue(keyManager),
    },
    VC_X5C_ISSUING_CA_SHA256: fx.caSha256,
  } as unknown as Env;
  return { env, keyManager, signed };
}

/** What a wallet does: read the request object, build the presentation, encrypt it. */
async function walletAnswer(
  requestObject: string,
  overrides: { state?: string; kid?: string } = {}
) {
  const claims = decodeJwt(requestObject) as {
    client_id: string;
    nonce: string;
    state: string;
    client_metadata: { jwks: { keys: JWK[] } };
  };
  const encryptionKey = claims.client_metadata.jwks.keys[0];
  const token = await makePresentation(fx, {
    request: {
      tenantId: 'tenant-1',
      credentialIssuer: ISSUER,
      clientId: claims.client_id,
      nonce: claims.nonce,
      state: claims.state,
      encryptionKid: REQUEST_ID,
    },
  });
  return new CompactEncrypt(
    new TextEncoder().encode(
      JSON.stringify({ vp_token: { admin: [token] }, state: overrides.state ?? claims.state })
    )
  )
    .setProtectedHeader({ alg: 'ECDH-ES', enc: 'A256GCM', kid: overrides.kid ?? encryptionKey.kid })
    .encrypt(await importJWK(encryptionKey, 'ECDH-ES'));
}

const NOW = NOW_MS;

beforeEach(() => {
  makeStore();
  mocks.findAdminCredentialStatus.mockResolvedValue({ userId: 'admin-1', status: 'active' });
  mocks.findAdminCredential.mockResolvedValue({
    publicId: 'credential-1',
    userId: 'admin-1',
    credentialType: VCT,
    status: 'active',
    holderBinding: fx.holder.publicJwk,
  });
});

const start = (env: Env, extra: Record<string, unknown> = {}) =>
  createHaipLoginRequest(
    env,
    {
      tenantId: 'tenant-1',
      credentialIssuer: ISSUER,
      flow: 'cross_device',
      bindingSecret: SECRET,
      ...extra,
    } as never,
    NOW
  );

describe('starting a login', () => {
  it('signs a request for this verifier and gives the QR and the same-device link', async () => {
    const { env, keyManager } = await envFor();
    const started = await start(env);
    expect(started.requestId).toBe(REQUEST_ID);
    expect(started.expiresAt).toBe(NOW + 300_000);
    const requestUri = `${ISSUER}/vp/login/request/${encodeURIComponent(REQUEST_ID)}`;
    const clientId = encodeURIComponent('x509_hash:' + 'v'.repeat(43));
    expect(started.qr).toBe(
      `openid4vp://?client_id=${clientId}&request_uri=${encodeURIComponent(requestUri)}&request_uri_method=get`
    );
    expect(started.deepLink.startsWith('haip-vp://?client_id=')).toBe(true);
    const payload = keyManager.signHaipLoginRequestRpc.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      client_id: 'x509_hash:' + 'v'.repeat(43),
      response_uri: `${ISSUER}/vp/login/response`,
      response_mode: 'direct_post.jwt',
    });
    // The encryption key is named by the request id, which is how an answer finds its request.
    const metadata = payload.client_metadata as { jwks: { keys: Array<{ kid: string }> } };
    expect(metadata.jwks.keys[0].kid).toBe(REQUEST_ID);
    expect(await getHaipLoginRequestObject(env, 'tenant-1', REQUEST_ID, NOW + 1_000)).toBeTruthy();
    expect(await getHaipLoginRequestObject(env, 'tenant-2', REQUEST_ID, NOW + 1_000)).toBeNull();
    expect(await getHaipLoginRequestObject(env, 'tenant-1', 'other-id', NOW + 1_000)).toBeNull();
  });

  const authoritiesOf = (keyManager: {
    signHaipLoginRequestRpc: { mock: { calls: unknown[][] } };
  }) =>
    (
      (keyManager.signHaipLoginRequestRpc.mock.calls[0][0] as Record<string, unknown>)
        .dcql_query as { credentials: Array<{ trusted_authorities?: unknown }> }
    ).credentials[0].trusted_authorities;

  it('names the issuing CA in the query', async () => {
    const { env, keyManager } = await envFor();
    await start(env);
    expect(authoritiesOf(keyManager)).toEqual([{ type: 'aki', values: ['AKI'] }]);
  });

  it('names no CA in the query while two CAs are trusted (a rollover)', async () => {
    const { env, keyManager } = await envFor();
    (env as unknown as { VC_X5C_ISSUING_CA_SHA256: string }).VC_X5C_ISSUING_CA_SHA256 =
      `${fx.caSha256},${'a'.repeat(64)}`;
    await start(env);
    expect(authoritiesOf(keyManager)).toBeUndefined();
  });

  it('keeps naming the CA when the same CA is listed twice', async () => {
    const { env, keyManager } = await envFor();
    (env as unknown as { VC_X5C_ISSUING_CA_SHA256: string }).VC_X5C_ISSUING_CA_SHA256 =
      `${fx.caSha256},${fx.caSha256.toUpperCase()}`;
    await start(env);
    expect(authoritiesOf(keyManager)).toEqual([{ type: 'aki', values: ['AKI'] }]);
  });

  it('is not offered without a usable certificate chain for this host', async () => {
    for (const verifier of [
      null,
      {
        clientId: 'x509_hash:x',
        issuingCaAki: 'a',
        issuerHost: 'other.example.com',
        chainNotAfter: 1,
      },
    ]) {
      const { env } = await envFor({ verifier });
      await expect(start(env)).rejects.toThrow('haip_login_unavailable');
    }
  });

  it('refuses a bad tenant, issuer, flow, binding and a redirect to another origin', async () => {
    const { env } = await envFor();
    await expect(start(env, { tenantId: 'bad id!' })).rejects.toThrow();
    await expect(start(env, { credentialIssuer: 'https://idp.example.com/path' })).rejects.toThrow(
      'invalid_credential_issuer'
    );
    await expect(start(env, { flow: 'x' })).rejects.toThrow('invalid_flow');
    await expect(start(env, { bindingSecret: 'short' })).rejects.toThrow('invalid_binding');
    await expect(
      start(env, { flow: 'same_device', redirectUri: 'https://evil.example.com/cb' })
    ).rejects.toThrow('invalid_redirect_uri');
  });
});

describe('a cross-device login', () => {
  it('verifies the wallet answer and hands the administrator to the starting browser once', async () => {
    const { env, signed } = await envFor();
    await start(env);
    const answer = await walletAnswer(signed[0]);
    expect(await acceptHaipLoginResponse(env, 'tenant-1', answer, NOW + 1_000)).toEqual({
      kind: 'verified',
    });
    const ref = { tenantId: 'tenant-1', requestId: REQUEST_ID, bindingSecret: SECRET };
    expect(await getHaipLoginStatus(env, ref, NOW + 2_000)).toMatchObject({
      status: 'verified',
      flow: 'cross_device',
    });
    expect(
      await getHaipLoginStatus(env, { ...ref, bindingSecret: OTHER_SECRET }, NOW + 2_000)
    ).toBeNull();
    expect(
      await consumeHaipLoginResult(env, { ...ref, bindingSecret: OTHER_SECRET }, NOW + 2_000)
    ).toBeNull();
    expect(await consumeHaipLoginResult(env, ref, NOW + 2_000)).toMatchObject({
      adminUserId: 'admin-1',
      credentialId: 'credential-1',
    });
    expect(await consumeHaipLoginResult(env, ref, NOW + 3_000)).toBeNull();
  });

  it('gives no result when the credential was revoked after the presentation', async () => {
    const { env, signed } = await envFor();
    await start(env);
    await acceptHaipLoginResponse(env, 'tenant-1', await walletAnswer(signed[0]), NOW + 1_000);
    mocks.findAdminCredentialStatus.mockResolvedValue({ userId: 'admin-1', status: 'revoked' });
    const ref = { tenantId: 'tenant-1', requestId: REQUEST_ID, bindingSecret: SECRET };
    expect(await consumeHaipLoginResult(env, ref, NOW + 2_000)).toBeNull();
  });

  it('answers a replay and an answer for no request, and fails the request on a bad answer', async () => {
    const { env, signed } = await envFor();
    await start(env);
    const answer = await walletAnswer(signed[0]);
    expect(await acceptHaipLoginResponse(env, 'tenant-1', answer, NOW + 1_000)).toEqual({
      kind: 'verified',
    });
    expect(await acceptHaipLoginResponse(env, 'tenant-1', answer, NOW + 1_500)).toEqual({
      kind: 'replayed',
    });
    expect(await acceptHaipLoginResponse(env, 'tenant-1', 'not a jwe', NOW)).toEqual({
      kind: 'unknown',
    });
    const stranger = await walletAnswer(signed[0], { kid: 'g1:apac:0:vp_other' });
    expect(await acceptHaipLoginResponse(env, 'tenant-1', stranger, NOW)).toEqual({
      kind: 'unknown',
    });

    makeStore();
    await start(env);
    const wrongState = await walletAnswer(signed[1], { state: 'another-state' });
    expect(await acceptHaipLoginResponse(env, 'tenant-1', wrongState, NOW + 1_000)).toEqual({
      kind: 'refused',
      error: 'state_mismatch',
    });
    // The request is failed for good: even a right answer is not taken any more.
    expect(
      await acceptHaipLoginResponse(env, 'tenant-1', await walletAnswer(signed[1]), NOW + 2_000)
    ).toEqual({ kind: 'unavailable' });
    expect(
      await getHaipLoginStatus(
        env,
        { tenantId: 'tenant-1', requestId: REQUEST_ID, bindingSecret: SECRET },
        NOW + 3_000
      )
    ).toMatchObject({ status: 'failed', errorCode: 'state_mismatch' });
  });

  it('fails the request for a revoked credential and gives it back after an infrastructure error', async () => {
    const { env, signed } = await envFor();
    await start(env);
    mocks.findAdminCredential.mockRejectedValueOnce(new Error('database down'));
    await expect(
      acceptHaipLoginResponse(env, 'tenant-1', await walletAnswer(signed[0]), NOW + 1_000)
    ).rejects.toThrow('database down');
    // The request was released: the wallet can post again, and a revoked credential then fails it.
    mocks.findAdminCredential.mockResolvedValue({
      publicId: 'credential-1',
      userId: 'admin-1',
      credentialType: VCT,
      status: 'revoked',
      holderBinding: fx.holder.publicJwk,
    });
    expect(
      await acceptHaipLoginResponse(env, 'tenant-1', await walletAnswer(signed[0]), NOW + 2_000)
    ).toEqual({ kind: 'refused', error: 'credential_not_active' });
  });

  it('does not accept an issuer chain of a CA that is not pinned', async () => {
    const { env, signed } = await envFor();
    await start(env);
    (env as unknown as { VC_X5C_ISSUING_CA_SHA256: string }).VC_X5C_ISSUING_CA_SHA256 = '0'.repeat(
      64
    );
    expect(
      await acceptHaipLoginResponse(env, 'tenant-1', await walletAnswer(signed[0]), NOW + 1_000)
    ).toEqual({ kind: 'refused', error: 'untrusted_issuer_chain' });
  });
});

describe('a same-device login', () => {
  it('redirects the browser with a response code that, with its binding, takes the result', async () => {
    const { env, signed } = await envFor();
    await start(env, { flow: 'same_device', redirectUri: `${ISSUER}/login/wallet` });
    const outcome = await acceptHaipLoginResponse(
      env,
      'tenant-1',
      await walletAnswer(signed[0]),
      NOW + 1_000
    );
    expect(outcome.kind).toBe('verified');
    const redirect = new URL((outcome as { redirectUri: string }).redirectUri);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(`${ISSUER}/login/wallet`);
    expect(redirect.searchParams.get('request_id')).toBe(REQUEST_ID);
    const code = redirect.searchParams.get('response_code') as string;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const ref = { tenantId: 'tenant-1', requestId: REQUEST_ID, bindingSecret: SECRET };
    // Without the code, or in another browser, nothing comes out.
    expect(await consumeHaipLoginResult(env, ref, NOW + 2_000)).toBeNull();
    expect(
      await consumeHaipLoginResult(
        env,
        { ...ref, bindingSecret: OTHER_SECRET, responseCode: code },
        NOW + 2_000
      )
    ).toBeNull();
    expect(
      await consumeHaipLoginResult(env, { ...ref, responseCode: 'x' }, NOW + 2_000)
    ).toBeNull();
    expect(
      await consumeHaipLoginResult(env, { ...ref, responseCode: code }, NOW + 2_000)
    ).toMatchObject({
      adminUserId: 'admin-1',
    });
    expect(
      await consumeHaipLoginResult(env, { ...ref, responseCode: code }, NOW + 3_000)
    ).toBeNull();
  });
});
