import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { buildCertificate, bytesToBase64 } from '@authrim/ar-lib-core';
import { sha256Base64url } from '../../admin/admin-vp-protocol';
import type { HaipLoginRequest } from '../haip-login-protocol';

export const ISSUER = 'https://idp.example.com';
export const HOST = 'idp.example.com';
export const VCT = 'https://authrim.com/credentials/admin/v1';
export const NOW = 1_800_000_000;
export const NOW_MS = NOW * 1000;

export interface Pair {
  privateKey: CryptoKey;
  publicJwk: JWK;
}
export async function pair(): Promise<Pair> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
}
export const signer = (key: CryptoKey) => async (tbs: Uint8Array) =>
  new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, tbs));
export async function sha256Hex(der: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', der))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export interface Fixture {
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

export async function buildFixture(): Promise<Fixture> {
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
  return {
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
}

export const DISCLOSURE = 'WyJzYWx0IiwiZW1haWwiLCJhZG1pbkBleGFtcGxlLmNvbSJd';

export async function makePresentation(
  fx: Fixture,
  options: {
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
    x5c?: string[] | null;
    kb?: Record<string, unknown> | null;
    kbHeader?: Record<string, unknown>;
    disclosures?: string[];
    request: HaipLoginRequest;
  }
): Promise<string> {
  const request = options.request;
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
