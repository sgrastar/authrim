import { SignJWT, type JWK } from 'jose';
import { buildCertificate, bytesToBase64 } from '../x509-certificate';
import {
  CLIENT_ATTESTATION_JWT_TYP,
  CLIENT_ATTESTATION_POP_JWT_TYP,
  type WalletAttestationAnchor,
} from '../wallet-attestation';

export interface TestKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export async function generateKey(): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JWK;
  return {
    privateKey: pair.privateKey,
    publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
  };
}

export const signer = (key: TestKey) => async (tbs: Uint8Array) =>
  new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, tbs));

export const NOW_MS = Date.parse('2026-11-23T00:00:00Z');
export const NOW = NOW_MS / 1000;
export const ISSUER = 'https://op.example.com';
export const CLIENT_ID = 'keyring-wallet';

export async function sha256Hex(der: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', der))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export interface Pki {
  anchor: WalletAttestationAnchor;
  caKey: TestKey;
  caCert: Uint8Array;
  leafKey: TestKey;
  leafCert: Uint8Array;
}

export async function makePki(
  options: {
    leafNotAfter?: number;
    leafIsCa?: boolean;
    leafExtra?: { oid: string; critical: boolean; value: Uint8Array }[];
  } = {}
): Promise<Pki> {
  const root = await generateKey();
  const caKey = await generateKey();
  const leafKey = await generateKey();
  const rootName = { commonName: 'Wallet Root', organization: 'Wallet Co' };
  const rootCert = await buildCertificate(
    {
      subject: rootName,
      issuer: rootName,
      subjectPublicKey: root.publicJwk,
      issuerPublicKey: root.publicJwk,
      notBefore: new Date(NOW_MS - 1000 * 3600_000),
      notAfter: new Date(NOW_MS + 100_000 * 3600_000),
      isCA: true,
      pathLength: 1,
    },
    signer(root)
  );
  const caCert = await buildCertificate(
    {
      subject: { commonName: 'Wallet Issuing CA', organization: 'Wallet Co' },
      issuer: rootName,
      subjectPublicKey: caKey.publicJwk,
      issuerPublicKey: root.publicJwk,
      notBefore: new Date(NOW_MS - 500 * 3600_000),
      notAfter: new Date(NOW_MS + 50_000 * 3600_000),
      isCA: true,
      pathLength: 0,
    },
    signer(root)
  );
  const leafCert = await buildCertificate(
    {
      subject: { commonName: 'wallet.example.com' },
      issuer: { commonName: 'Wallet Issuing CA', organization: 'Wallet Co' },
      subjectPublicKey: leafKey.publicJwk,
      issuerPublicKey: caKey.publicJwk,
      notBefore: new Date(NOW_MS - 3600_000),
      notAfter: new Date(options.leafNotAfter ?? NOW_MS + 24 * 3600_000),
      dnsNames: ['wallet.example.com'],
      isCA: false,
      extraExtensions: options.leafExtra,
    },
    signer(caKey)
  );
  return {
    anchor: {
      certificate: bytesToBase64(rootCert),
      sha256: await sha256Hex(rootCert),
      label: 'Wallet Co',
    },
    caKey,
    caCert,
    leafKey,
    leafCert,
  };
}

export async function attestationJwt(
  pki: Pki,
  instance: TestKey,
  overrides: {
    claims?: Record<string, unknown>;
    header?: Record<string, unknown>;
    x5c?: string[];
    signWith?: TestKey;
  } = {}
): Promise<string> {
  const claims = {
    iss: 'https://wallet-provider.example.com',
    sub: CLIENT_ID,
    iat: NOW,
    exp: NOW + 3600,
    cnf: { jwk: instance.publicJwk },
    ...overrides.claims,
  };
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: 'ES256',
      typ: CLIENT_ATTESTATION_JWT_TYP,
      x5c: overrides.x5c ?? [bytesToBase64(pki.leafCert), bytesToBase64(pki.caCert)],
      ...overrides.header,
    })
    .sign((overrides.signWith ?? pki.leafKey).privateKey);
}

export async function popJwt(
  instance: TestKey,
  overrides: { claims?: Record<string, unknown>; header?: Record<string, unknown> } = {}
): Promise<string> {
  return new SignJWT({
    iss: CLIENT_ID,
    aud: ISSUER,
    iat: NOW,
    jti: crypto.randomUUID(),
    ...overrides.claims,
  })
    .setProtectedHeader({ alg: 'ES256', typ: CLIENT_ATTESTATION_POP_JWT_TYP, ...overrides.header })
    .sign(instance.privateKey);
}
