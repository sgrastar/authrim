/**
 * HAIP login service: input rules, the stored request, response outcomes and the result hand-over,
 * with the protocol, the stores and the key manager faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../types';

const h = vi.hoisted(() => ({
  isConfiguredShard: vi.fn(),
  storeById: vi.fn(),
  newStore: vi.fn(),
  findCredential: vi.fn(),
  findStatus: vi.fn(),
  buildPayload: vi.fn(),
  decrypt: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('../../../utils/configured-shard', () => ({ isConfiguredShard: h.isConfiguredShard }));
vi.mock('../../../utils/vp-request-sharding', () => ({
  getVPRequestStoreById: h.storeById,
  getVPRequestStoreForNewRequest: h.newStore,
}));
vi.mock('../../admin/admin-vp-service', () => ({
  adminCredentialVct: () => 'vct-admin',
  findAdminCredential: h.findCredential,
  findAdminCredentialStatus: h.findStatus,
}));
vi.mock('../haip-login-protocol', () => ({
  HAIP_LOGIN_REQUEST_TTL_SECONDS: 300,
  buildHaipLoginRequestPayload: h.buildPayload,
  decryptHaipLoginResponse: h.decrypt,
  verifyHaipLoginPresentation: h.verify,
}));

import {
  acceptHaipLoginResponse,
  consumeHaipLoginResult,
  createHaipLoginRequest,
  getHaipLoginRequestObject,
  getHaipLoginStatus,
  trustedIssuingCaSha256,
} from '../haip-login-service';
import { sha256Base64url } from '../../admin/admin-vp-protocol';

const NOW = 1_800_000_000_000;
const ISSUER = 'https://acme.example.com';
const SECRET = 'S'.repeat(40);
const CA_A = 'a'.repeat(64);
const CA_B = 'b'.repeat(64);

let store: Record<string, ReturnType<typeof vi.fn>>;
let km: {
  getHaipLoginVerifierRpc: ReturnType<typeof vi.fn>;
  signHaipLoginRequestRpc: ReturnType<typeof vi.fn>;
  getVcIssuerJwksRpc: ReturnType<typeof vi.fn>;
};
let idFromName: ReturnType<typeof vi.fn<(name: string) => string>>;
let env: Record<string, unknown>;

const b64 = (value: unknown) =>
  btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwe = (header: unknown) => `${b64(header)}.k.iv.ct.tag`;

beforeEach(() => {
  vi.resetAllMocks();
  store = {
    createHaipLoginRequestRpc: vi.fn().mockResolvedValue(undefined),
    getHaipLoginRequestObjectRpc: vi.fn().mockResolvedValue('request.object'),
    reserveHaipLoginResponseRpc: vi.fn(),
    completeHaipLoginResponseRpc: vi.fn().mockResolvedValue(true),
    failHaipLoginResponseRpc: vi.fn().mockResolvedValue(true),
    releaseHaipLoginResponseRpc: vi.fn().mockResolvedValue(true),
    getHaipLoginStatusRpc: vi.fn(),
    consumeHaipLoginResultRpc: vi.fn(),
  };
  km = {
    getHaipLoginVerifierRpc: vi.fn().mockResolvedValue({
      clientId: 'verifier-id',
      issuingCaAki: 'aki-1',
      issuerHost: 'acme.example.com',
      chainNotAfter: NOW + 1000,
    }),
    signHaipLoginRequestRpc: vi.fn().mockResolvedValue({ token: 'signed.request.object' }),
    getVcIssuerJwksRpc: vi.fn().mockResolvedValue({ keys: [{ kid: 'k' }] }),
  };
  idFromName = vi.fn((name: string) => `id:${name}`);
  env = { KEY_MANAGER: { idFromName, get: () => km }, VC_X5C_ISSUING_CA_SHA256: CA_A };
  h.isConfiguredShard.mockResolvedValue(true);
  h.storeById.mockReturnValue({ stub: store, resolution: 'r' });
  h.newStore.mockResolvedValue({ stub: store, requestId: 'g1:apac:1:vp_1' });
  h.buildPayload.mockReturnValue({ payload: true });
});
afterEach(() => {
  vi.useRealTimers();
});

const create = (input: Record<string, unknown> = {}) =>
  createHaipLoginRequest(
    env as unknown as Env,
    {
      tenantId: 'acme',
      credentialIssuer: ISSUER,
      flow: 'cross_device',
      bindingSecret: SECRET,
      ...input,
    } as never,
    NOW
  );

describe('trustedIssuingCaSha256', () => {
  it('keeps the valid fingerprints, trimmed and lower-cased', () => {
    const list = (value: string | undefined) =>
      trustedIssuingCaSha256({ VC_X5C_ISSUING_CA_SHA256: value } as unknown as Env);
    expect(
      list(` ${CA_A.toUpperCase()} , ${CA_B},short,${'g'.repeat(64)},${'a'.repeat(65)}`)
    ).toEqual([CA_A, CA_B]);
    expect(list(undefined)).toEqual([]);
    expect(list('')).toEqual([]);
  });
});

describe('createHaipLoginRequest: input', () => {
  it('refuses an invalid tenant, a binding secret of the wrong size and an unknown flow', async () => {
    await expect(create({ tenantId: 'Bad Tenant!' })).rejects.toThrow('invalid_tenant_id');
    for (const bindingSecret of ['S'.repeat(31), 'S'.repeat(257), 5, undefined]) {
      await expect(create({ bindingSecret })).rejects.toThrow('invalid_binding');
    }
    await expect(create({ flow: 'qr' })).rejects.toThrow('invalid_flow');
    await expect(create({ bindingSecret: 'S'.repeat(32) })).resolves.toBeDefined();
    await expect(create({ bindingSecret: 'S'.repeat(256) })).resolves.toBeDefined();
  });

  it.each([
    'http://acme.example.com',
    'https://acme.example.com:8443',
    'https://user@acme.example.com',
    'https://user:pw@acme.example.com',
    'https://acme.example.com/path',
    'https://acme.example.com?x=1',
    'https://acme.example.com#frag',
  ])('refuses the issuer %s', async (credentialIssuer) => {
    await expect(create({ credentialIssuer })).rejects.toThrow('invalid_credential_issuer');
  });

  it('accepts a bare host with or without a trailing slash and uses its origin', async () => {
    await create({ credentialIssuer: `${ISSUER}/` });
    expect(store.createHaipLoginRequestRpc.mock.calls[0][0].credentialIssuer).toBe(ISSUER);
  });

  it('lets a same-device login return to the issuer origin or the trusted console only', async () => {
    const same = (redirectUri: string) => create({ flow: 'same_device', redirectUri });
    await expect(same(`${ISSUER}/cb`)).resolves.toBeDefined();
    await expect(same('https://evil.example/cb')).rejects.toThrow('invalid_redirect_uri');
    await expect(same('https://console.example.com/cb')).rejects.toThrow('invalid_redirect_uri');
    env.ADMIN_UI_URL = 'https://console.example.com/app';
    await expect(same('https://console.example.com/cb')).resolves.toBeDefined();
    for (const configured of [
      'http://console.example.com',
      'https://u:p@console.example.com',
      'not a url',
    ]) {
      env.ADMIN_UI_URL = configured;
      await expect(same('https://console.example.com/cb')).rejects.toThrow('invalid_redirect_uri');
    }
  });

  it('is unavailable without a verifier chain for the host of the issuer', async () => {
    km.getHaipLoginVerifierRpc.mockResolvedValue(null);
    await expect(create()).rejects.toThrow('haip_login_unavailable');
    km.getHaipLoginVerifierRpc.mockResolvedValue({
      clientId: 'c',
      issuingCaAki: 'a',
      issuerHost: 'other.example.com',
      chainNotAfter: 1,
    });
    await expect(create()).rejects.toThrow('haip_login_unavailable');
    expect(store.createHaipLoginRequestRpc).not.toHaveBeenCalled();
  });
});

describe('createHaipLoginRequest: the request', () => {
  it('signs the payload and stores the request with the binding hash and the private key', async () => {
    const result = await create();
    expect(idFromName).toHaveBeenCalledWith('acme-v3');
    expect(h.newStore).toHaveBeenCalledWith(
      env,
      'acme',
      'haip-login',
      expect.stringMatching(/^[0-9a-f-]{36}$/)
    );
    const payloadInput = h.buildPayload.mock.calls[0][0];
    expect(payloadInput).toMatchObject({
      clientId: 'verifier-id',
      responseUri: `${ISSUER}/vp/login/response`,
      now: NOW / 1000,
      vct: 'vct-admin',
      issuingCaAki: 'aki-1',
    });
    expect(payloadInput.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payloadInput.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payloadInput.nonce).not.toBe(payloadInput.state);
    expect(payloadInput.encryptionKey).toEqual({
      kty: 'EC',
      crv: 'P-256',
      x: expect.any(String),
      y: expect.any(String),
      kid: 'g1:apac:1:vp_1',
      use: 'enc',
      alg: 'ECDH-ES',
    });
    expect(km.signHaipLoginRequestRpc).toHaveBeenCalledWith({ payload: true });
    const stored = store.createHaipLoginRequestRpc.mock.calls[0][0];
    expect(stored).toMatchObject({
      id: 'g1:apac:1:vp_1',
      tenantId: 'acme',
      flow: 'cross_device',
      bindingHash: await sha256Base64url(SECRET),
      clientId: 'verifier-id',
      credentialIssuer: ISSUER,
      nonce: payloadInput.nonce,
      state: payloadInput.state,
      requestObject: 'signed.request.object',
      createdAt: NOW,
      expiresAt: NOW + 300_000,
    });
    expect('redirectUri' in stored).toBe(false);
    const privateJwk = JSON.parse(stored.encryptionJwk) as Record<string, string>;
    expect(privateJwk).toMatchObject({ kty: 'EC', crv: 'P-256', kid: 'g1:apac:1:vp_1' });
    expect(privateJwk.d).toBeDefined();
    expect(privateJwk.x).toBe(payloadInput.encryptionKey.x);
    const requestUri = `${ISSUER}/vp/login/request/${encodeURIComponent('g1:apac:1:vp_1')}`;
    const link = (scheme: string) =>
      `${scheme}?client_id=verifier-id&request_uri=${encodeURIComponent(requestUri)}&request_uri_method=get`;
    expect(result).toEqual({
      requestId: 'g1:apac:1:vp_1',
      expiresAt: NOW + 300_000,
      qr: link('openid4vp://'),
      deepLink: link('haip-vp://'),
    });
  });

  it('stores the redirect of a same-device login and nothing for a cross-device one', async () => {
    await create({ flow: 'same_device', redirectUri: `${ISSUER}/cb` });
    expect(store.createHaipLoginRequestRpc.mock.calls[0][0]).toMatchObject({
      flow: 'same_device',
      redirectUri: `${ISSUER}/cb`,
    });
  });

  it('names the issuing CA in the query only while a single CA is trusted', async () => {
    await create();
    expect(h.buildPayload.mock.calls[0][0].issuingCaAki).toBe('aki-1');
    env.VC_X5C_ISSUING_CA_SHA256 = `${CA_A},${CA_B}`;
    await create();
    expect('issuingCaAki' in h.buildPayload.mock.calls[1][0]).toBe(false);
    env.VC_X5C_ISSUING_CA_SHA256 = `${CA_A},${CA_A.toUpperCase()}`;
    await create();
    expect(h.buildPayload.mock.calls[2][0].issuingCaAki).toBe('aki-1');
    env.VC_X5C_ISSUING_CA_SHA256 = undefined;
    await create();
    expect(h.buildPayload.mock.calls[3][0].issuingCaAki).toBe('aki-1');
  });
});

describe('request objects', () => {
  it('serves the object only through a configured shard', async () => {
    expect(await getHaipLoginRequestObject(env as unknown as Env, 'acme', 'req-1', NOW)).toBe(
      'request.object'
    );
    expect(store.getHaipLoginRequestObjectRpc).toHaveBeenCalledWith({
      id: 'req-1',
      tenantId: 'acme',
      now: NOW,
    });
    expect(h.storeById).toHaveBeenCalledWith(env, 'req-1', 'acme');
    expect(h.isConfiguredShard).toHaveBeenCalledWith(env, 'acme', 'r');
    h.isConfiguredShard.mockResolvedValue(false);
    expect(await getHaipLoginRequestObject(env as unknown as Env, 'acme', 'req-1', NOW)).toBeNull();
    h.isConfiguredShard.mockResolvedValue(true);
    h.storeById.mockImplementation(() => {
      throw new Error('bad id');
    });
    expect(await getHaipLoginRequestObject(env as unknown as Env, 'acme', 'req-1', NOW)).toBeNull();
  });
});

describe('acceptHaipLoginResponse', () => {
  const request = (overrides: Record<string, unknown> = {}) => ({
    id: 'req-1',
    tenantId: 'acme',
    flow: 'cross_device',
    clientId: 'verifier-id',
    credentialIssuer: ISSUER,
    nonce: 'n',
    state: 's',
    encryptionJwk: '{"jwk":1}',
    status: 'processing',
    createdAt: NOW,
    expiresAt: NOW + 1000,
    ...overrides,
  });
  const reserved = (overrides: Record<string, unknown> = {}) =>
    store.reserveHaipLoginResponseRpc.mockResolvedValue({
      reserved: true,
      reservationId: 'res-1',
      request: request(overrides),
    });
  const response = jwe({ alg: 'ECDH-ES', enc: 'A256GCM', kid: 'req-1' });
  const accept = (value = response) =>
    acceptHaipLoginResponse(env as unknown as Env, 'acme', value, NOW);
  const verified = { ok: true, adminUserId: 'admin-1', holderJkt: 'jkt-1', credentialId: 'cred-1' };

  beforeEach(() => {
    reserved();
    h.decrypt.mockResolvedValue({ vp: true });
    h.verify.mockResolvedValue(verified);
  });

  it.each([
    ['not a JWE', 'garbage'],
    ['no kid', jwe({ alg: 'ECDH-ES' })],
    ['an empty kid', jwe({ kid: '' })],
    ['a numeric kid', jwe({ kid: 5 })],
    ['a kid that is too long', jwe({ kid: 'k'.repeat(257) })],
  ])('does not know a response with %s', async (_name, value) => {
    expect(await accept(value)).toEqual({ kind: 'unknown' });
    expect(store.reserveHaipLoginResponseRpc).not.toHaveBeenCalled();
  });

  it('accepts a kid of the longest allowed size', async () => {
    reserved();
    await accept(jwe({ kid: 'k'.repeat(256) }));
    expect(store.reserveHaipLoginResponseRpc).toHaveBeenCalledTimes(1);
  });

  it('does not know a response whose shard is unreachable', async () => {
    h.isConfiguredShard.mockResolvedValue(false);
    expect(await accept()).toEqual({ kind: 'unknown' });
  });

  it('reserves with the fingerprint of the request id and the response', async () => {
    await accept();
    expect(store.reserveHaipLoginResponseRpc).toHaveBeenCalledWith({
      id: 'req-1',
      tenantId: 'acme',
      responseFingerprint: await sha256Base64url(`req-1\u0000${response}`),
      now: NOW,
    });
  });

  it.each([
    ['not_found', { kind: 'unknown' }],
    ['expired', { kind: 'unknown' }],
    ['replayed', { kind: 'replayed' }],
    ['unavailable', { kind: 'unavailable' }],
  ])('maps the reservation refusal %s', async (reason, outcome) => {
    store.reserveHaipLoginResponseRpc.mockResolvedValue({ reserved: false, reason });
    expect(await accept()).toEqual(outcome);
    expect(h.decrypt).not.toHaveBeenCalled();
  });

  it('decrypts with the request key, state and kid, then verifies against the request', async () => {
    await accept();
    expect(h.decrypt).toHaveBeenCalledWith(response, '{"jwk":1}', {
      state: 's',
      encryptionKid: 'req-1',
    });
    const [vp, context, vct, deps, seconds] = h.verify.mock.calls[0];
    expect(vp).toEqual({ vp: true });
    expect(context).toEqual({
      tenantId: 'acme',
      credentialIssuer: ISSUER,
      clientId: 'verifier-id',
      nonce: 'n',
      state: 's',
      encryptionKid: 'req-1',
    });
    expect(vct).toBe('vct-admin');
    expect(seconds).toBe(NOW / 1000);
    expect(deps.trustedIssuingCaSha256).toEqual([CA_A]);
    expect(await deps.issuerKeys()).toEqual([{ kid: 'k' }]);
    await deps.findCredential('list-1', 4);
    expect(h.findCredential).toHaveBeenCalledWith(env, 'acme', 'list-1', 4);
  });

  it('fails a response that cannot be decrypted, naming a state mismatch apart', async () => {
    h.decrypt.mockRejectedValue(Object.assign(new Error('x'), { code: 'state_mismatch' }));
    expect(await accept()).toEqual({ kind: 'refused', error: 'state_mismatch' });
    h.decrypt.mockRejectedValue(Object.assign(new Error('x'), { code: 'other' }));
    expect(await accept()).toEqual({ kind: 'refused', error: 'invalid_response' });
    expect(store.failHaipLoginResponseRpc).toHaveBeenLastCalledWith({
      id: 'req-1',
      tenantId: 'acme',
      reservationId: 'res-1',
      errorCode: 'invalid_response',
    });
    expect(h.verify).not.toHaveBeenCalled();
  });

  it('fails a presentation that does not verify, with the protocol error', async () => {
    h.verify.mockResolvedValue({ ok: false, error: 'credential_revoked' });
    expect(await accept()).toEqual({ kind: 'refused', error: 'credential_revoked' });
    expect(store.failHaipLoginResponseRpc).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'credential_revoked' })
    );
    expect(store.completeHaipLoginResponseRpc).not.toHaveBeenCalled();
  });

  it('completes a cross-device login without a response code', async () => {
    expect(await accept()).toEqual({ kind: 'verified' });
    expect(store.completeHaipLoginResponseRpc).toHaveBeenCalledWith({
      id: 'req-1',
      tenantId: 'acme',
      reservationId: 'res-1',
      adminUserId: 'admin-1',
      holderJkt: 'jkt-1',
      credentialId: 'cred-1',
      now: NOW,
    });
  });

  it('hands a same-device login a response code in the redirect and stores only its hash', async () => {
    reserved({ flow: 'same_device', redirectUri: 'https://acme.example.com/cb' });
    const outcome = await accept();
    if (outcome.kind !== 'verified' || !outcome.redirectUri) throw new Error('not verified');
    const url = new URL(outcome.redirectUri);
    expect(url.origin + url.pathname).toBe('https://acme.example.com/cb');
    expect(url.searchParams.get('request_id')).toBe('req-1');
    const code = url.searchParams.get('response_code') ?? '';
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.completeHaipLoginResponseRpc.mock.calls[0][0].responseCodeHash).toBe(
      await sha256Base64url(code)
    );
  });

  it('is unavailable when the completion is lost', async () => {
    store.completeHaipLoginResponseRpc.mockResolvedValue(false);
    expect(await accept()).toEqual({ kind: 'unavailable' });
  });

  it('gives the request back and rethrows when verification crashes, even if the release fails', async () => {
    h.verify.mockRejectedValue(new Error('jwks down'));
    store.releaseHaipLoginResponseRpc.mockRejectedValue(new Error('gone'));
    await expect(accept()).rejects.toThrow('jwks down');
    expect(store.releaseHaipLoginResponseRpc).toHaveBeenCalledWith({
      id: 'req-1',
      tenantId: 'acme',
      reservationId: 'res-1',
      now: NOW,
    });
  });
});

describe('status and result hand-over', () => {
  const ref = (extra: Record<string, unknown> = {}) => ({
    tenantId: 'acme',
    requestId: 'req-1',
    bindingSecret: SECRET,
    ...extra,
  });
  const E = () => env as unknown as Env;

  it('reads the status for the binding hash of the secret', async () => {
    store.getHaipLoginStatusRpc.mockResolvedValue({ status: 'pending' });
    expect(await getHaipLoginStatus(E(), ref(), NOW)).toEqual({ status: 'pending' });
    expect(store.getHaipLoginStatusRpc).toHaveBeenCalledWith({
      id: 'req-1',
      tenantId: 'acme',
      bindingHash: await sha256Base64url(SECRET),
      now: NOW,
    });
    await expect(getHaipLoginStatus(E(), ref({ tenantId: 'Bad Tenant!' }), NOW)).rejects.toThrow(
      'invalid_tenant_id'
    );
    await expect(getHaipLoginStatus(E(), ref({ bindingSecret: 'short' }), NOW)).rejects.toThrow(
      'invalid_binding'
    );
    h.isConfiguredShard.mockResolvedValue(false);
    expect(await getHaipLoginStatus(E(), ref(), NOW)).toBeNull();
  });

  const result = {
    adminUserId: 'admin-1',
    holderJkt: 'jkt',
    credentialId: 'cred-1',
    verifiedAt: NOW,
  };
  const code = 'C'.repeat(43);

  it('hands the result over when the credential still stands for the same administrator', async () => {
    store.consumeHaipLoginResultRpc.mockResolvedValue(result);
    h.findStatus.mockResolvedValue({ status: 'active', userId: 'admin-1' });
    expect(await consumeHaipLoginResult(E(), ref({ responseCode: code }), NOW)).toEqual(result);
    expect(store.consumeHaipLoginResultRpc).toHaveBeenCalledWith({
      id: 'req-1',
      tenantId: 'acme',
      bindingHash: await sha256Base64url(SECRET),
      responseCodeHash: await sha256Base64url(code),
      now: NOW,
    });
    expect(h.findStatus).toHaveBeenCalledWith(env, 'acme', 'cred-1');
    store.consumeHaipLoginResultRpc.mockClear();
    await consumeHaipLoginResult(E(), ref(), NOW);
    expect('responseCodeHash' in store.consumeHaipLoginResultRpc.mock.calls[0][0]).toBe(false);
  });

  it('withholds the result for a credential that is gone, inactive or another administrator’s', async () => {
    store.consumeHaipLoginResultRpc.mockResolvedValue(result);
    for (const status of [
      null,
      { status: 'revoked', userId: 'admin-1' },
      { status: 'active', userId: 'someone-else' },
    ]) {
      h.findStatus.mockResolvedValue(status);
      expect(await consumeHaipLoginResult(E(), ref(), NOW)).toBeNull();
    }
    store.consumeHaipLoginResultRpc.mockResolvedValue(null);
    expect(await consumeHaipLoginResult(E(), ref(), NOW)).toBeNull();
  });

  it('refuses a malformed response code and a foreign tenant before reading anything', async () => {
    for (const responseCode of ['C'.repeat(42), `${code}x`, `x${code}`, '', 'C'.repeat(42) + '+']) {
      expect(await consumeHaipLoginResult(E(), ref({ responseCode }), NOW)).toBeNull();
    }
    await expect(
      consumeHaipLoginResult(E(), ref({ tenantId: 'Bad Tenant!' }), NOW)
    ).rejects.toThrow('invalid_tenant_id');
    expect(store.consumeHaipLoginResultRpc).not.toHaveBeenCalled();
    h.isConfiguredShard.mockResolvedValue(false);
    expect(await consumeHaipLoginResult(E(), ref(), NOW)).toBeNull();
  });
});
