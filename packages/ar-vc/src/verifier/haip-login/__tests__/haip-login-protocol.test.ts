import { beforeAll, describe, expect, it } from 'vitest';
import {
  CompactEncrypt,
  calculateJwkThumbprint,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  importJWK,
  SignJWT,
  type JWK,
} from 'jose';
import { buildCertificate, bytesToBase64, haipLoginRequestShape } from '@authrim/ar-lib-core';
import {
  buildHaipLoginRequestPayload,
  decryptHaipLoginResponse,
  signHaipLoginRequestObject,
  verifyHaipLoginPresentation,
  x509HashClientId,
  type HaipLoginRequest,
  type HaipLoginVerifierDeps,
} from '../haip-login-protocol';
import { sha256Base64url } from '../../admin/admin-vp-protocol';
import type { AdminCredentialRecord } from '../../admin/admin-vp-protocol';

const ISSUER = 'https://idp.example.com';
const HOST = 'idp.example.com';
const VCT = 'https://authrim.com/credentials/admin/v1';
const NOW = 1_800_000_000;
const NOW_MS = NOW * 1000;

interface Pair {
  privateKey: CryptoKey;
  publicJwk: JWK;
}
async function pair(): Promise<Pair> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
}
const signer = (key: CryptoKey) => async (tbs: Uint8Array) =>
  new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, tbs));
async function sha256Hex(der: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', der))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

interface Fixture {
  vcKey: Pair;
  holder: Pair;
  holderJkt: string;
  chain: string[];
  caSha256: string;
  /** A chain for another key, signed by the same CA. */
  otherChain: string[];
  /** A chain under a CA nobody pinned. */
  strangerChain: string[];
  verifier: Pair;
  verifierChain: string[];
  verifierLeafDer: Uint8Array;
  encryption: Pair;
}
let fx: Fixture;

async function issue(
  caKey: Pair,
  subjectKey: JWK,
  host: string,
  notBefore = NOW_MS - 3600_000,
  caName = { commonName: 'Authrim Issuing CA (test)', organization: 'Authrim' }
) {
  const rootName = { commonName: 'Authrim Root CA (test)', organization: 'Authrim' };
  const root = await pair();
  const caDer = await buildCertificate(
    {
      subject: caName,
      issuer: rootName,
      subjectPublicKey: caKey.publicJwk,
      issuerPublicKey: root.publicJwk,
      notBefore: new Date(notBefore),
      notAfter: new Date(NOW_MS + 300 * 24 * 3600_000),
      isCA: true,
      pathLength: 0,
    },
    signer(root.privateKey)
  );
  return { caDer, rootName, root };
}

beforeAll(async () => {
  const ca = await pair();
  const vcKey = await pair();
  const other = await pair();
  const holder = await pair();
  const rootName = { commonName: 'Authrim Root CA (test)', organization: 'Authrim' };
  const root = await pair();
  const caName = { commonName: 'Authrim Issuing CA (test)', organization: 'Authrim' };
  const caDer = await buildCertificate(
    {
      subject: caName,
      issuer: rootName,
      subjectPublicKey: ca.publicJwk,
      issuerPublicKey: root.publicJwk,
      notBefore: new Date(NOW_MS - 3600_000),
      notAfter: new Date(NOW_MS + 300 * 24 * 3600_000),
      isCA: true,
      pathLength: 0,
    },
    signer(root.privateKey)
  );
  const leaf = async (key: JWK, host: string, signWith: Pair = ca, issuerName = caName) =>
    buildCertificate(
      {
        subject: { commonName: host },
        issuer: issuerName,
        subjectPublicKey: key,
        issuerPublicKey: signWith.publicJwk,
        notBefore: new Date(NOW_MS - 3600_000),
        notAfter: new Date(NOW_MS + 30 * 24 * 3600_000),
        dnsNames: [host],
        isCA: false,
      },
      signer(signWith.privateKey)
    );
  const stranger = await issue(await pair(), vcKey.publicJwk, HOST);
  const strangerCa = await pair();
  const strangerCaDer = await buildCertificate(
    {
      subject: { commonName: 'Other CA', organization: 'Other' },
      issuer: { commonName: 'Other Root', organization: 'Other' },
      subjectPublicKey: strangerCa.publicJwk,
      issuerPublicKey: root.publicJwk,
      notBefore: new Date(NOW_MS - 3600_000),
      notAfter: new Date(NOW_MS + 300 * 24 * 3600_000),
      isCA: true,
      pathLength: 0,
    },
    signer(root.privateKey)
  );
  void stranger;
  const verifier = await pair();
  const verifierLeaf = await leaf(verifier.publicJwk, HOST);
  fx = {
    vcKey,
    holder,
    holderJkt: await calculateJwkThumbprint(holder.publicJwk, 'sha256'),
    chain: [bytesToBase64(await leaf(vcKey.publicJwk, HOST)), bytesToBase64(caDer)],
    caSha256: await sha256Hex(caDer),
    otherChain: [bytesToBase64(await leaf(other.publicJwk, HOST)), bytesToBase64(caDer)],
    strangerChain: [
      bytesToBase64(
        await leaf(vcKey.publicJwk, HOST, strangerCa, {
          commonName: 'Other CA',
          organization: 'Other',
        })
      ),
      bytesToBase64(strangerCaDer),
    ],
    verifier,
    verifierChain: [bytesToBase64(verifierLeaf), bytesToBase64(caDer)],
    verifierLeafDer: verifierLeaf,
    encryption: await pair(),
  };
});

const DISCLOSURE = 'WyJzYWx0IiwiZW1haWwiLCJhZG1pbkBleGFtcGxlLmNvbSJd';

async function presentation(
  options: {
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
    x5c?: string[] | null;
    kb?: Record<string, unknown> | null;
    kbHeader?: Record<string, unknown>;
    disclosures?: string[];
    request?: HaipLoginRequest;
  } = {}
): Promise<string> {
  const request = options.request ?? baseRequest();
  const sdDigest = await sha256Base64url(DISCLOSURE);
  const issuerJwt = await new SignJWT({
    iss: ISSUER,
    iat: NOW - 60,
    exp: NOW + 86400,
    vct: VCT,
    sub: 'admin-1',
    tenant_id: 'tenant-1',
    _sd: [sdDigest],
    _sd_alg: 'sha-256',
    cnf: { jwk: fx.holder.publicJwk },
    status: { status_list: { idx: 7, uri: `${ISSUER}/vci/status-lists/list-1` } },
    ...options.claims,
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'dc+sd-jwt',
      kid: 'vc-key-1',
      ...(options.x5c === null ? {} : { x5c: options.x5c ?? fx.chain }),
      ...options.header,
    })
    .sign(fx.vcKey.privateKey);
  const disclosures = options.disclosures ?? [DISCLOSURE];
  const head = `${issuerJwt}~${disclosures.join('~')}${disclosures.length > 0 ? '~' : ''}`;
  if (options.kb === null) return head;
  const kbJwt = await new SignJWT({
    aud: request.clientId,
    nonce: request.nonce,
    iat: NOW - 5,
    sd_hash: await sha256Base64url(head),
    ...options.kb,
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'kb+jwt', ...options.kbHeader })
    .sign(fx.holder.privateKey);
  return `${head}${kbJwt}`;
}

function baseRequest(overrides: Partial<HaipLoginRequest> = {}): HaipLoginRequest {
  return {
    tenantId: 'tenant-1',
    credentialIssuer: ISSUER,
    clientId: 'x509_hash:placeholder',
    nonce: 'nonce-0123456789abcdef',
    state: 'state-abc',
    encryptionKid: 'enc-1',
    ...overrides,
  };
}

function deps(
  overrides: Partial<HaipLoginVerifierDeps> = {},
  record?: Partial<AdminCredentialRecord> | null
) {
  const found: AdminCredentialRecord | null =
    record === null
      ? null
      : {
          publicId: 'credential-1',
          userId: 'admin-1',
          credentialType: VCT,
          status: 'active',
          holderBinding: fx.holder.publicJwk,
          ...record,
        };
  return {
    issuerKeys: async () => [{ ...fx.vcKey.publicJwk, kid: 'vc-key-1', alg: 'ES256' }],
    findCredential: async () => found,
    trustedIssuingCaSha256: [fx.caSha256],
    ...overrides,
  } satisfies HaipLoginVerifierDeps;
}

const wrap = (value: string) => ({ admin: [value] });
const verify = async (
  token: string,
  overrides: Partial<HaipLoginVerifierDeps> = {},
  record?: Partial<AdminCredentialRecord> | null,
  request: HaipLoginRequest = baseRequest()
) => verifyHaipLoginPresentation(wrap(token), request, VCT, deps(overrides, record), NOW);

describe('the signed request object', () => {
  it('names the verifier by the hash of its leaf certificate and is signed with its key and chain', async () => {
    const clientId = await x509HashClientId(fx.verifierLeafDer);
    expect(clientId).toMatch(/^x509_hash:[A-Za-z0-9_-]{43}$/u);
    const encryptionKey = { ...fx.encryption.publicJwk, kid: 'enc-1' };
    const payload = buildHaipLoginRequestPayload({
      clientId,
      responseUri: `${ISSUER}/vp/login/response`,
      nonce: 'n-1',
      state: 's-1',
      now: NOW,
      vct: VCT,
      encryptionKey,
      issuingCaAki: 'AKIAKIAKI',
    });
    expect(payload).toMatchObject({
      aud: 'https://self-issued.me/v2',
      client_id: clientId,
      response_type: 'vp_token',
      response_mode: 'direct_post.jwt',
      response_uri: `${ISSUER}/vp/login/response`,
      nonce: 'n-1',
      state: 's-1',
      exp: NOW + 300,
    });
    expect(payload.client_metadata).toMatchObject({
      jwks: { keys: [encryptionKey] },
      encrypted_response_enc_values_supported: ['A128GCM', 'A256GCM'],
    });
    expect(payload.dcql_query).toMatchObject({
      credentials: [
        {
          id: 'admin',
          format: 'dc+sd-jwt',
          meta: { vct_values: [VCT] },
          trusted_authorities: [{ type: 'aki', values: ['AKIAKIAKI'] }],
        },
      ],
    });
    // What this builds is exactly what KeyManager is willing to sign (with a real-length nonce).
    expect(
      haipLoginRequestShape({ ...payload, nonce: 'n'.repeat(43), state: 's'.repeat(43) }, NOW)
    ).toMatchObject({ clientHash: clientId.slice('x509_hash:'.length) });
    const jwt = await signHaipLoginRequestObject(payload, fx.verifierChain, fx.verifier.privateKey);
    expect(decodeProtectedHeader(jwt)).toMatchObject({
      alg: 'ES256',
      typ: 'oauth-authz-req+jwt',
      x5c: fx.verifierChain,
    });
    // The wallet verifies it with the leaf key.
    await expect(
      jwtVerify(jwt, await importJWK(fx.verifier.publicJwk, 'ES256'))
    ).resolves.toBeDefined();
  });

  it('refuses another client identifier scheme, a key without kid and an empty chain', async () => {
    const base = {
      responseUri: `${ISSUER}/vp/login/response`,
      nonce: 'n',
      state: 's',
      now: NOW,
      vct: VCT,
      encryptionKey: { ...fx.encryption.publicJwk, kid: 'enc-1' },
    };
    expect(() =>
      buildHaipLoginRequestPayload({ ...base, clientId: 'decentralized_identifier:did:web:x' })
    ).toThrow('haip_login_client_id_scheme');
    expect(() =>
      buildHaipLoginRequestPayload({
        ...base,
        clientId: 'x509_hash:abc',
        encryptionKey: fx.encryption.publicJwk,
      })
    ).toThrow('haip_login_encryption_key_kid');
    await expect(signHaipLoginRequestObject({}, [], fx.verifier.privateKey)).rejects.toThrow(
      'haip_login_x5c_required'
    );
  });
});

describe('the encrypted response', () => {
  async function encrypt(
    payload: unknown,
    header: Record<string, unknown> = {},
    recipient: JWK = fx.encryption.publicJwk
  ): Promise<string> {
    return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: 'ECDH-ES', enc: 'A256GCM', kid: 'enc-1', ...header })
      .encrypt(await importJWK(recipient, 'ECDH-ES'));
  }
  const priv = async () =>
    JSON.stringify({
      ...(await exportJWK(fx.encryption.privateKey)),
    });

  it('decrypts a response for this request and returns the vp_token', async () => {
    const jwe = await encrypt({ vp_token: { admin: ['x'] }, state: 'state-abc' });
    expect(await decryptHaipLoginResponse(jwe, await priv(), baseRequest())).toEqual({
      admin: ['x'],
    });
    const small = await encrypt({ vp_token: 1, state: 'state-abc' }, { enc: 'A128GCM' });
    expect(await decryptHaipLoginResponse(small, await priv(), baseRequest())).toBe(1);
  });

  it('refuses another state, another key id, another algorithm and anything not a JWE', async () => {
    const refusals: Array<[unknown, string]> = [
      [await encrypt({ vp_token: {}, state: 'other' }), 'state_mismatch'],
      [await encrypt({ vp_token: {}, state: 'state-abc' }, { kid: 'enc-2' }), 'invalid_response'],
      [await encrypt({ vp_token: {}, state: 'state-abc' }, { enc: 'A192GCM' }), 'invalid_response'],
      [await encrypt({ state: 'state-abc' }), 'invalid_response'],
      ['not a jwe', 'invalid_response'],
      [undefined, 'invalid_response'],
      [{ response: 'x' }, 'invalid_response'],
    ];
    for (const [response, code] of refusals) {
      await expect(
        decryptHaipLoginResponse(response, await priv(), baseRequest())
      ).rejects.toMatchObject({
        code,
      });
    }
    // Encrypted to another key: cannot be opened.
    const other = await pair();
    const wrongKey = await encrypt({ vp_token: {}, state: 'state-abc' }, {}, other.publicJwk);
    await expect(
      decryptHaipLoginResponse(wrongKey, await priv(), baseRequest())
    ).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});

describe('verifyHaipLoginPresentation', () => {
  it('accepts the administrator credential of this tenant and names the administrator', async () => {
    expect(await verify(await presentation())).toEqual({
      ok: true,
      adminUserId: 'admin-1',
      holderJkt: fx.holderJkt,
      credentialId: 'credential-1',
    });
  });

  it('needs an x5c chain that certifies the signing key and ends at the pinned CA', async () => {
    for (const x5c of [null, [fx.chain[0]], fx.otherChain, fx.strangerChain] as const) {
      expect(await verify(await presentation({ x5c: x5c as string[] | null }))).toEqual({
        ok: false,
        error: 'untrusted_issuer_chain',
      });
    }
    expect(
      await verify(await presentation(), { trustedIssuingCaSha256: ['0'.repeat(64)] })
    ).toEqual({
      ok: false,
      error: 'untrusted_issuer_chain',
    });
    expect(await verify(await presentation(), { trustedIssuingCaSha256: [] })).toEqual({
      ok: false,
      error: 'untrusted_issuer_chain',
    });
  });

  it('refuses another tenant, another issuer, an expired credential and an unknown signing key', async () => {
    expect(await verify(await presentation({ claims: { tenant_id: 'tenant-2' } }))).toEqual({
      ok: false,
      error: 'wrong_tenant',
    });
    for (const claims of [
      { iss: 'https://other.example.com' },
      { exp: NOW - 1000 },
      { vct: 'x' },
    ]) {
      expect((await verify(await presentation({ claims }))).ok).toBe(false);
    }
    expect(await verify(await presentation(), { issuerKeys: async () => [] })).toEqual({
      ok: false,
      error: 'invalid_credential',
    });
    expect((await verify(await presentation({ header: { typ: 'JWT' } }))).ok).toBe(false);
  });

  it("refuses a revoked or unknown credential row and a row that is another administrator's", async () => {
    expect(await verify(await presentation(), {}, { status: 'revoked' })).toEqual({
      ok: false,
      error: 'credential_not_active',
    });
    expect(await verify(await presentation(), {}, null)).toEqual({
      ok: false,
      error: 'invalid_credential',
    });
    expect((await verify(await presentation(), {}, { userId: 'admin-2' })).ok).toBe(false);
    const stranger = await pair();
    expect((await verify(await presentation(), {}, { holderBinding: stranger.publicJwk })).ok).toBe(
      false
    );
  });

  it('refuses a presentation without a key binding, or with a wrong one', async () => {
    expect(await verify(await presentation({ kb: null }))).toEqual({
      ok: false,
      error: 'invalid_key_binding',
    });
    for (const kb of [
      { nonce: 'another' },
      { aud: 'x509_hash:other' },
      { sd_hash: 'wrong' },
      { iat: NOW - 3600 },
      { iat: NOW + 3600 },
    ]) {
      expect(await verify(await presentation({ kb })), JSON.stringify(kb)).toEqual({
        ok: false,
        error: 'invalid_key_binding',
      });
    }
    expect(await verify(await presentation({ kbHeader: { typ: 'JWT' } }))).toEqual({
      ok: false,
      error: 'invalid_key_binding',
    });
  });

  it('refuses a disclosure the issuer did not commit to and a malformed vp_token', async () => {
    expect(await verify(await presentation({ disclosures: ['Zm9yZ2Vk'] }))).toEqual({
      ok: false,
      error: 'invalid_credential',
    });
    for (const token of [
      undefined,
      null,
      'x',
      { admin: 'x' },
      { admin: ['a', 'b'] },
      { other: ['x'] },
    ]) {
      expect(await verifyHaipLoginPresentation(token, baseRequest(), VCT, deps(), NOW)).toEqual({
        ok: false,
        error: 'invalid_vp_token',
      });
    }
  });

  it('is bound to the request: another client identifier or nonce does not verify', async () => {
    const presented = await presentation();
    expect(
      await verify(presented, {}, undefined, baseRequest({ nonce: 'different-nonce-value' }))
    ).toEqual({
      ok: false,
      error: 'invalid_key_binding',
    });
    expect(
      await verify(presented, {}, undefined, baseRequest({ clientId: 'x509_hash:another' }))
    ).toEqual({ ok: false, error: 'invalid_key_binding' });
  });
});
