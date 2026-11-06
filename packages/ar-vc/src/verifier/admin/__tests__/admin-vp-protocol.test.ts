import { beforeAll, describe, expect, it } from 'vitest';
import {
  calculateJwkThumbprint,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  CompactEncrypt,
} from 'jose';
import {
  ADMIN_VP_MATCH_CODE_CLAIM,
  adminVPClientId,
  adminVPQrValue,
  adminVPRequestUri,
  base64url,
  buildAdminVPRequestPayload,
  decryptDcApiAnswer,
  encodeTransactionData,
  generateMatchCode,
  sha256Base64url,
  verifyAdminPresentation,
  type AdminCredentialRecord,
  type AdminVPVerifierDeps,
} from '../admin-vp-protocol';
import type { AdminVPRequest } from '../admin-vp-request-store';

const ISSUER = 'https://idp.example.com';
const VCT = 'https://authrim.com/credentials/admin/v1';
const NOW = 1_800_000_000;
const encoder = new TextEncoder();

interface Keys {
  issuerPrivate: CryptoKey;
  issuerJwk: JWK;
  holderPrivate: CryptoKey;
  holderJwk: JWK;
  holderJkt: string;
}

let keys: Keys;

beforeAll(async () => {
  const issuer = await generateKeyPair('ES256', { extractable: true });
  const holder = await generateKeyPair('ES256', { extractable: true });
  const holderJwk = await exportJWK(holder.publicKey);
  keys = {
    issuerPrivate: issuer.privateKey,
    issuerJwk: { ...(await exportJWK(issuer.publicKey)), kid: 'vc-key-1', alg: 'ES256' },
    holderPrivate: holder.privateKey,
    holderJwk,
    holderJkt: await calculateJwkThumbprint(holderJwk, 'sha256'),
  };
});

function request(overrides: Partial<AdminVPRequest> = {}): AdminVPRequest {
  return {
    id: 'g1:apac:0:vp_req',
    tenantId: 'tenant-1',
    adminUserId: 'admin-1',
    sessionId: 'session-1',
    purpose: 'step_up',
    holderJkts: [keys.holderJkt],
    nonce: 'nonce-0123456789abcdef',
    matchCode: '42',
    mode: 'direct_post',
    clientId: adminVPClientId(ISSUER),
    credentialIssuer: ISSUER,
    transactionData: encodeTransactionData({
      purpose: 'step_up',
      tenant: 'Example',
      requestedAt: NOW,
      matchCodeRequired: true,
    }),
    status: 'processing',
    createdAt: NOW * 1000,
    expiresAt: (NOW + 300) * 1000,
    ...overrides,
  };
}

async function disclosure(name: string, value: unknown): Promise<string> {
  return base64url(encoder.encode(JSON.stringify(['salt-' + name, name, value])));
}

interface CredentialOptions {
  sub?: string;
  tenantId?: string;
  iss?: string;
  vct?: string;
  exp?: number;
  kid?: string;
  typ?: string;
  committed?: string[];
}

async function issuerJwt(options: CredentialOptions = {}): Promise<string> {
  return new SignJWT({
    vct: options.vct ?? VCT,
    sub: options.sub ?? 'admin-1',
    tenant_id: options.tenantId ?? 'tenant-1',
    _sd_alg: 'sha-256',
    _sd: options.committed ?? [],
    cnf: { jwk: keys.holderJwk },
    status: { status_list: { idx: 7, uri: `${ISSUER}/vci/status-lists/list-1` } },
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: options.typ ?? 'dc+sd-jwt',
      kid: options.kid ?? 'vc-key-1',
    })
    .setIssuer(options.iss ?? ISSUER)
    .setIssuedAt(NOW - 60)
    .setExpirationTime(options.exp ?? NOW + 86_400)
    .sign(keys.issuerPrivate);
}

interface KbOptions {
  aud?: string;
  nonce?: string;
  iat?: number;
  sdHash?: string;
  transactionDataHashes?: unknown;
  matchCode?: unknown;
  typ?: string;
}

/** `<issuer JWT>~<disclosures>~<KB-JWT>` with an RFC 9901 sd_hash (including the last `~`). */
async function presentation(
  req: AdminVPRequest,
  cred: CredentialOptions = {},
  kb: KbOptions = {},
  disclosures: string[] = []
): Promise<string> {
  const prefix = `${await issuerJwt(cred)}~${disclosures.map((d) => `${d}~`).join('')}`;
  const claims: Record<string, unknown> = {
    nonce: kb.nonce ?? req.nonce,
    sd_hash: kb.sdHash ?? (await sha256Base64url(prefix)),
    transaction_data_hashes: kb.transactionDataHashes ?? [
      await sha256Base64url(req.transactionData),
    ],
    transaction_data_hashes_alg: 'sha-256',
  };
  if (kb.matchCode !== null) claims[ADMIN_VP_MATCH_CODE_CLAIM] = kb.matchCode ?? req.matchCode;
  const kbJwt = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', typ: kb.typ ?? 'kb+jwt' })
    .setAudience(kb.aud ?? req.clientId)
    .setIssuedAt(kb.iat ?? NOW)
    .sign(keys.holderPrivate);
  return prefix + kbJwt;
}

const vpToken = (value: string) => JSON.stringify({ admin: [value] });

function deps(record: Partial<AdminCredentialRecord> | null = {}): AdminVPVerifierDeps {
  return {
    issuerKeys: async () => [keys.issuerJwk],
    findCredential: async (listId, index) =>
      record === null || listId !== 'list-1' || index !== 7
        ? null
        : {
            publicId: 'cred-1',
            userId: 'admin-1',
            credentialType: VCT,
            status: 'active',
            holderBinding: keys.holderJwk,
            ...record,
          },
  };
}

const verify = (token: string, req: AdminVPRequest, d = deps()) =>
  verifyAdminPresentation(token, req, VCT, d, NOW);

describe('request object', () => {
  it('builds a decentralized_identifier request for one admin credential', () => {
    const transactionData = encodeTransactionData({
      purpose: 'step_up',
      tenant: 'Example',
      requestedAt: NOW,
      matchCodeRequired: true,
    });
    const payload = buildAdminVPRequestPayload({
      credentialIssuer: ISSUER,
      vct: VCT,
      nonce: 'n'.repeat(43),
      transactionData,
      now: NOW,
      transport: { mode: 'direct_post', state: 'state-1' },
    });
    expect(payload).toMatchObject({
      client_id: 'decentralized_identifier:did:web:idp.example.com',
      response_type: 'vp_token',
      response_mode: 'direct_post',
      response_uri: 'https://idp.example.com/vp/admin/response',
      state: 'state-1',
      iat: NOW,
      exp: NOW + 300,
      transaction_data: [transactionData],
      dcql_query: {
        credentials: [{ id: 'admin', format: 'dc+sd-jwt', meta: { vct_values: [VCT] } }],
      },
    });
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(transactionData.replace(/-/g, '+').replace(/_/g, '/')), (ch) =>
          ch.charCodeAt(0)
        )
      )
    ) as Record<string, unknown>;
    expect(decoded).toMatchObject({
      type: 'authrim_admin_step_up',
      credential_ids: ['admin'],
      purpose: 'step_up',
      tenant: 'Example',
    });
    // The match code is never part of what the wallet receives.
    expect(JSON.stringify(payload)).not.toContain('match');
  });

  it('puts client_id and request_uri in the openid4vp QR value', () => {
    const qr = adminVPQrValue(adminVPClientId(ISSUER), adminVPRequestUri(ISSUER, 'g1:a:0:vp_x'));
    expect(qr).toBe(
      'openid4vp://?client_id=decentralized_identifier%3Adid%3Aweb%3Aidp.example.com' +
        '&request_uri=https%3A%2F%2Fidp.example.com%2Fvp%2Fadmin%2Frequest%2Fg1%253Aa%253A0%253Avp_x'
    );
  });

  it('refuses an issuer that did:web cannot name', () => {
    expect(() => adminVPClientId('http://idp.example.com')).toThrow();
    expect(() => adminVPClientId('https://idp.example.com:8443')).toThrow();
  });

  it('draws two-digit match codes', () => {
    for (let i = 0; i < 200; i++) expect(generateMatchCode()).toMatch(/^\d{2}$/);
  });
});

describe('Digital Credentials API mode', () => {
  it('builds an origin-bound request answered encrypted, with no response_uri', async () => {
    const pair = await generateKeyPair('ECDH-ES', { crv: 'P-256', extractable: true });
    const encryptionKey = { ...(await exportJWK(pair.publicKey)), use: 'enc', alg: 'ECDH-ES' };
    const payload = buildAdminVPRequestPayload({
      credentialIssuer: ISSUER,
      vct: VCT,
      nonce: 'n'.repeat(43),
      transactionData: 'td',
      now: NOW,
      transport: { mode: 'dc_api', expectedOrigin: 'https://console.example.com', encryptionKey },
    });
    expect(payload).toMatchObject({
      client_id: 'decentralized_identifier:did:web:idp.example.com',
      response_mode: 'dc_api.jwt',
      expected_origins: ['https://console.example.com'],
      client_metadata: {
        jwks: { keys: [encryptionKey] },
        encrypted_response_enc_values_supported: ['A128GCM', 'A256GCM'],
      },
    });
    expect(payload).not.toHaveProperty('response_uri');
    expect(payload).not.toHaveProperty('state');
  });

  async function encryptedAnswer(vpToken: unknown, enc = 'A128GCM') {
    const pair = await generateKeyPair('ECDH-ES', { crv: 'P-256', extractable: true });
    const response = await new CompactEncrypt(
      new TextEncoder().encode(JSON.stringify({ vp_token: vpToken }))
    )
      .setProtectedHeader({ alg: 'ECDH-ES', enc })
      .encrypt(pair.publicKey);
    return { data: { response }, privateJwk: JSON.stringify(await exportJWK(pair.privateKey)) };
  }

  it('decrypts the answer with the request key and verifies it without a match code', async () => {
    const req = request({
      mode: 'dc_api',
      matchCode: '',
      expectedOrigin: 'https://console.example.com',
    });
    const presentationText = await presentation(
      req,
      {},
      { matchCode: null, aud: 'origin:https://console.example.com' }
    );
    const { data, privateJwk } = await encryptedAnswer({ admin: [presentationText] });
    const vpToken = await decryptDcApiAnswer(data, privateJwk);
    await expect(verify(vpToken as string, req)).resolves.toMatchObject({ ok: true });
  });

  it('binds the answer to the console origin, not the client_id (Appendix A.4)', async () => {
    const req = request({
      mode: 'dc_api',
      matchCode: '',
      expectedOrigin: 'https://console.example.com',
    });
    for (const aud of [
      req.clientId,
      'origin:https://evil.example',
      'https://console.example.com',
    ]) {
      const text = await presentation(req, {}, { matchCode: null, aud });
      await expect(verify(vpToken(text), req)).resolves.toMatchObject({
        ok: false,
        error: 'invalid_key_binding',
      });
    }
    // A DC API request without its origin accepts nothing.
    const { expectedOrigin: _omit, ...withoutOrigin } = req;
    const text = await presentation(req, {}, { matchCode: null, aud: req.clientId });
    await expect(verify(vpToken(text), withoutOrigin)).resolves.toMatchObject({
      ok: false,
      error: 'invalid_key_binding',
    });
  });

  it('asks the wallet for the match code only over QR', () => {
    const decode = (value: string) =>
      JSON.parse(new TextDecoder().decode(Buffer.from(value, 'base64url'))) as Record<
        string,
        unknown
      >;
    const qr = encodeTransactionData({
      purpose: 'step_up',
      tenant: 'Example',
      requestedAt: NOW,
      matchCodeRequired: true,
    });
    const dc = encodeTransactionData({
      purpose: 'step_up',
      tenant: 'Example',
      requestedAt: NOW,
      matchCodeRequired: false,
    });
    expect(decode(qr).match_code_required).toBe(true);
    expect(decode(dc).match_code_required).toBe(false);
  });

  it('refuses an answer that is not encrypted to the request key, or not as asked', async () => {
    const { data } = await encryptedAnswer({ admin: ['x'] });
    const other = JSON.stringify(
      await exportJWK(
        (await generateKeyPair('ECDH-ES', { crv: 'P-256', extractable: true })).privateKey
      )
    );
    await expect(decryptDcApiAnswer(data, other)).rejects.toThrow('invalid_vp_token');
    const wrongEnc = await encryptedAnswer({ admin: ['x'] }, 'A192GCM');
    await expect(decryptDcApiAnswer(wrongEnc.data, wrongEnc.privateJwk)).rejects.toThrow(
      'invalid_vp_token'
    );
    await expect(decryptDcApiAnswer({ vp_token: {} }, other)).rejects.toThrow('invalid_vp_token');
    await expect(decryptDcApiAnswer(null, other)).rejects.toThrow('invalid_vp_token');
  });

  it('still requires the match code of a QR request', async () => {
    const req = request();
    await expect(
      verify(vpToken(await presentation(req, {}, { matchCode: null })), req)
    ).resolves.toEqual({ ok: false, error: 'match_code_mismatch' });
  });
});

describe('verifyAdminPresentation', () => {
  it('accepts the registered holder key of the admin credential, with the right code', async () => {
    const req = request();
    await expect(verify(vpToken(await presentation(req)), req)).resolves.toEqual({
      ok: true,
      holderJkt: keys.holderJkt,
      credentialId: 'cred-1',
    });
  });

  it('accepts committed disclosures and refuses ones the issuer did not sign', async () => {
    const req = request();
    const email = await disclosure('email', 'admin@example.com');
    const committed = [await sha256Base64url(email)];
    await expect(
      verify(vpToken(await presentation(req, { committed }, {}, [email])), req)
    ).resolves.toMatchObject({ ok: true });
    const forged = await disclosure('email', 'other@example.com');
    await expect(
      verify(vpToken(await presentation(req, { committed }, {}, [forged])), req)
    ).resolves.toEqual({ ok: false, error: 'invalid_credential' });
    await expect(
      verify(vpToken(await presentation(req, { committed }, {}, [email, email])), req)
    ).resolves.toEqual({ ok: false, error: 'invalid_credential' });
  });

  it('refuses a wrong or missing match code', async () => {
    const req = request();
    await expect(
      verify(vpToken(await presentation(req, {}, { matchCode: '41' })), req)
    ).resolves.toEqual({ ok: false, error: 'match_code_mismatch' });
    await expect(
      verify(vpToken(await presentation(req, {}, { matchCode: 42 })), req)
    ).resolves.toEqual({ ok: false, error: 'match_code_mismatch' });
    await expect(
      verify(vpToken(await presentation(req, {}, { matchCode: null })), req)
    ).resolves.toEqual({ ok: false, error: 'match_code_mismatch' });
  });

  it('refuses a key binding for another request', async () => {
    const req = request();
    for (const kb of [
      { nonce: 'another-nonce-000000' },
      { aud: 'decentralized_identifier:did:web:evil.example' },
      { iat: NOW - 3_600 },
      { iat: NOW + 3_600 },
      { typ: 'JWT' },
    ]) {
      await expect(verify(vpToken(await presentation(req, {}, kb)), req)).resolves.toEqual({
        ok: false,
        error: 'invalid_key_binding',
      });
    }
  });

  it('computes sd_hash over the presentation including the last tilde (RFC 9901)', async () => {
    const req = request();
    const prefixWithoutTilde = (await issuerJwt()).toString();
    await expect(
      verify(
        vpToken(await presentation(req, {}, { sdHash: await sha256Base64url(prefixWithoutTilde) })),
        req
      )
    ).resolves.toEqual({ ok: false, error: 'invalid_key_binding' });
  });

  it('refuses a key binding over other transaction data', async () => {
    const req = request();
    for (const transactionDataHashes of [
      [await sha256Base64url('other')],
      [],
      'not-an-array',
      [await sha256Base64url(req.transactionData), await sha256Base64url('x')],
    ]) {
      await expect(
        verify(vpToken(await presentation(req, {}, { transactionDataHashes })), req)
      ).resolves.toEqual({ ok: false, error: 'transaction_data_mismatch' });
    }
  });

  it('refuses a key binding signed by another key', async () => {
    const req = request();
    const other = await generateKeyPair('ES256');
    const token = await presentation(req);
    const parts = token.split('~');
    const kbClaims = decodeJwt(parts[parts.length - 1]);
    const resigned = await new SignJWT(kbClaims)
      .setProtectedHeader(decodeProtectedHeader(parts[parts.length - 1]) as { alg: string })
      .sign(other.privateKey);
    parts[parts.length - 1] = resigned;
    await expect(verify(vpToken(parts.join('~')), req)).resolves.toEqual({
      ok: false,
      error: 'invalid_key_binding',
    });
  });

  it('refuses a credential of another admin or tenant', async () => {
    const req = request();
    await expect(
      verify(vpToken(await presentation(req, { sub: 'admin-2' })), req)
    ).resolves.toEqual({ ok: false, error: 'wrong_admin' });
    await expect(
      verify(vpToken(await presentation(req, { tenantId: 'tenant-2' })), req)
    ).resolves.toEqual({ ok: false, error: 'wrong_admin' });
  });

  it('refuses credentials it did not issue, or not as the admin credential', async () => {
    const req = request();
    for (const cred of [
      { iss: 'https://evil.example' },
      { vct: 'https://authrim.com/credentials/identity/v1' },
      { kid: 'unknown-key' },
      { typ: 'JWT' },
      { exp: NOW - 3_600 },
    ]) {
      await expect(verify(vpToken(await presentation(req, cred)), req)).resolves.toEqual({
        ok: false,
        error: 'invalid_credential',
      });
    }
  });

  it('reads the state from the credential row, not a cache', async () => {
    const req = request();
    const token = vpToken(await presentation(req));
    await expect(verify(token, req, deps({ status: 'revoked' }))).resolves.toEqual({
      ok: false,
      error: 'credential_not_active',
    });
    await expect(verify(token, req, deps({ status: 'suspended' }))).resolves.toEqual({
      ok: false,
      error: 'credential_not_active',
    });
    await expect(verify(token, req, deps(null))).resolves.toEqual({
      ok: false,
      error: 'invalid_credential',
    });
    await expect(verify(token, req, deps({ userId: 'admin-2' }))).resolves.toEqual({
      ok: false,
      error: 'invalid_credential',
    });
  });

  it('refuses a credential whose row holds another holder key', async () => {
    const req = request();
    const other = await exportJWK(
      (await generateKeyPair('ES256', { extractable: true })).publicKey
    );
    await expect(
      verify(vpToken(await presentation(req)), req, deps({ holderBinding: other }))
    ).resolves.toEqual({ ok: false, error: 'invalid_credential' });
  });

  it('checks the holder key against the registered second factors', async () => {
    const stepUp = request({ holderJkts: ['A'.repeat(43)] });
    await expect(verify(vpToken(await presentation(stepUp)), stepUp)).resolves.toEqual({
      ok: false,
      error: 'holder_key_not_registered',
    });
    const enroll = request({ purpose: 'enroll' });
    await expect(verify(vpToken(await presentation(enroll)), enroll)).resolves.toEqual({
      ok: false,
      error: 'holder_key_already_registered',
    });
    const fresh = request({ purpose: 'enroll', holderJkts: [] });
    await expect(verify(vpToken(await presentation(fresh)), fresh)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('accepts only one presentation under the admin query id', async () => {
    const req = request();
    const value = await presentation(req);
    for (const token of [
      value,
      JSON.stringify({ other: [value] }),
      JSON.stringify({ admin: value }),
      JSON.stringify({ admin: [value, value] }),
      JSON.stringify({ admin: [value], extra: [value] }),
      JSON.stringify([value]),
      'x'.repeat(40_000),
      undefined,
    ]) {
      await expect(verify(token as string, req)).resolves.toEqual({
        ok: false,
        error: 'invalid_vp_token',
      });
    }
  });

  it('refuses a presentation without key binding', async () => {
    const req = request();
    await expect(verify(vpToken(`${await issuerJwt()}~`), req)).resolves.toEqual({
      ok: false,
      error: 'invalid_vp_token',
    });
  });

  it('lets errors of its dependencies through for the caller to release the request', async () => {
    const req = request();
    const failing: AdminVPVerifierDeps = {
      issuerKeys: async () => {
        throw new Error('key manager down');
      },
      findCredential: async () => null,
    };
    await expect(verify(vpToken(await presentation(req)), req, failing)).rejects.toThrow(
      'key manager down'
    );
  });
});
