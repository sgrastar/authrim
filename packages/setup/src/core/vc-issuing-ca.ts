/**
 * The Authrim certificate authority behind the HAIP `x5c` header of SD-JWT VCs and Token Status
 * Lists (design D-B of `docs/verifiable-credentials/20261122-authrim-admin-vc-haip-issuance-and-login.md`).
 *
 * Two levels, both ECDSA P-256:
 * - the **root CA** (long lived) is the trust anchor wallets and verifiers are configured with.
 *   Its private key signs one thing, the issuing CA certificate, and should live offline.
 * - the **issuing CA** (a few years) signs the leaf certificates of the tenants' VC signing keys.
 *   Its private key and certificate are what the credential issuer Worker needs.
 *
 * Nothing here reaches the network. The Worker side is `packages/ar-vc/src/issuer/services/issuer-ca.ts`.
 */

import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createPublicKey,
  webcrypto,
} from 'node:crypto';
import {
  base64ToBytes,
  buildCertificate,
  bytesToBase64,
  parseCertificate,
  verifyCertificateSignature,
} from '@authrim/ar-lib-core/vc/x509-certificate';

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export const DEFAULT_ROOT_CA_YEARS = 20;
export const DEFAULT_ISSUING_CA_YEARS = 5;

type Jwk = { kty: string; crv: string; x: string; y: string };

export interface VcCaOptions {
  /** Environment name, shown in the certificate names (e.g. `prod`). */
  environment: string;
  /** The `organization` attribute of both certificates. */
  organization?: string;
  /** Use this root instead of creating one (issuing CA renewal). */
  root?: { privateKeyPem: string; certificateDer: Uint8Array };
  rootYears?: number;
  issuingYears?: number;
  /** For tests. */
  now?: Date;
}

export interface VcCaMaterial {
  /** PEM certificate of the root CA: publish it, it is what wallets and verifiers trust. */
  rootCertificatePem: string;
  rootCertificateSha256: string;
  /** PKCS#8 PEM of the root key. Only when a root was created; keep it offline. */
  rootPrivateKeyPem?: string;
  /** PKCS#8 PEM of the issuing CA key: a Worker secret of the credential issuer. */
  issuingPrivateKeyPem: string;
  /** Base64 DER of the issuing CA certificate. */
  issuingCertificateBase64: string;
  /** Lower-case hex SHA-256 of the issuing CA certificate DER. */
  issuingCertificateSha256: string;
  issuingNotAfter: Date;
  rootNotAfter: Date;
}

function toPem(label: string, der: Uint8Array): string {
  const body =
    bytesToBase64(der)
      .match(/.{1,64}/gu)
      ?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function pemToDer(pem: string, label: string): Uint8Array {
  const body = pem
    .replace(`-----BEGIN ${label}-----`, '')
    .replace(`-----END ${label}-----`, '')
    .replace(/\s+/gu, '');
  if (!body) throw new Error('vc_ca_pem_empty');
  return base64ToBytes(body);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function generateKeyPair(): Promise<{ privateKey: CryptoKey; publicJwk: Jwk }> {
  const pair = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('vc_ca_key_export');
  return {
    privateKey: pair.privateKey,
    publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
  };
}

async function exportPkcs8Pem(key: CryptoKey): Promise<string> {
  return toPem('PRIVATE KEY', new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', key)));
}

const signer = (key: CryptoKey) => async (tbs: Uint8Array) =>
  new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, tbs));

function publicJwkOfPoint(point: Uint8Array): Jwk {
  const url = (bytes: Uint8Array): string =>
    bytesToBase64(bytes).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  return { kty: 'EC', crv: 'P-256', x: url(point.slice(1, 33)), y: url(point.slice(33, 65)) };
}

/** Creates the CA material. With `root` the existing root signs a new issuing CA. */
export async function generateVcCa(options: VcCaOptions): Promise<VcCaMaterial> {
  const now = options.now ?? new Date();
  const organization = options.organization?.trim() || 'Authrim';
  const environment = options.environment.trim();
  if (!environment || environment.length > 32) throw new Error('vc_ca_environment_invalid');
  const rootYears = options.rootYears ?? DEFAULT_ROOT_CA_YEARS;
  const issuingYears = options.issuingYears ?? DEFAULT_ISSUING_CA_YEARS;
  if (!(rootYears >= 1 && rootYears <= 30) || !(issuingYears >= 1 && issuingYears <= 10)) {
    throw new Error('vc_ca_lifetime_invalid');
  }
  const notBefore = new Date(now.getTime() - 5 * 60_000);

  let rootCertificateDer: Uint8Array;
  let rootSigningKey: CryptoKey;
  let rootPublicJwk: Jwk;
  let rootPrivateKeyPem: string | undefined;
  if (options.root) {
    rootCertificateDer = options.root.certificateDer;
    const parsed = parseCertificate(rootCertificateDer);
    if (!parsed.isCA || !parsed.keyCertSign) throw new Error('vc_ca_root_not_a_ca');
    // The issuing CA is one level below the root, so the root must allow a subordinate CA.
    if (parsed.pathLength !== undefined && parsed.pathLength < 1) {
      throw new Error('vc_ca_root_path_length');
    }
    if (now.getTime() < parsed.notBefore.getTime() || now.getTime() > parsed.notAfter.getTime()) {
      throw new Error('vc_ca_root_not_valid_now');
    }
    rootSigningKey = await webcrypto.subtle.importKey(
      'pkcs8',
      pemToDer(options.root.privateKeyPem, 'PRIVATE KEY'),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    rootPublicJwk = publicJwkOfPoint(parsed.publicPoint);
    // The key must be the one the certificate certifies.
    const probe = webcrypto.getRandomValues(new Uint8Array(32));
    const signature = new Uint8Array(
      await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, rootSigningKey, probe)
    );
    const verifyKey = await webcrypto.subtle.importKey(
      'raw',
      parsed.publicPoint,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    if (
      !(await webcrypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        verifyKey,
        signature,
        probe
      ))
    ) {
      throw new Error('vc_ca_root_key_mismatch');
    }
  } else {
    const root = await generateKeyPair();
    const name = { commonName: `Authrim Root CA (${environment})`, organization };
    rootCertificateDer = await buildCertificate(
      {
        subject: name,
        issuer: name,
        subjectPublicKey: root.publicJwk,
        issuerPublicKey: root.publicJwk,
        notBefore,
        notAfter: new Date(now.getTime() + rootYears * YEAR_MS),
        isCA: true,
        // One level below: the issuing CA, which in turn may only sign leaves (pathLen 0).
        pathLength: 1,
      },
      signer(root.privateKey)
    );
    rootSigningKey = root.privateKey;
    rootPublicJwk = root.publicJwk;
    rootPrivateKeyPem = await exportPkcs8Pem(root.privateKey);
  }
  const rootParsed = parseCertificate(rootCertificateDer);

  const issuing = await generateKeyPair();
  // The issuing CA cannot outlive the root.
  const issuingNotAfter = new Date(
    Math.min(now.getTime() + issuingYears * YEAR_MS, rootParsed.notAfter.getTime() - 24 * 3_600_000)
  );
  if (issuingNotAfter.getTime() <= now.getTime() + 30 * 24 * 3_600_000) {
    throw new Error('vc_ca_root_expires_too_soon');
  }
  const issuingCertificateDer = await buildCertificate(
    {
      subject: { commonName: `Authrim Issuing CA (${environment})`, organization },
      issuerNameDer: rootParsed.subjectName,
      subjectPublicKey: issuing.publicJwk,
      issuerPublicKey: rootPublicJwk,
      ...(rootParsed.subjectKeyIdentifier
        ? { issuerKeyIdentifier: rootParsed.subjectKeyIdentifier }
        : {}),
      notBefore,
      notAfter: issuingNotAfter,
      isCA: true,
      pathLength: 0,
    },
    signer(rootSigningKey)
  );
  // Never hand out a CA certificate the root certificate cannot verify.
  if (
    !(await verifyCertificateSignature(
      parseCertificate(issuingCertificateDer),
      rootParsed.publicPoint
    ))
  ) {
    throw new Error('vc_ca_issuing_certificate_unverifiable');
  }

  return {
    rootCertificatePem: toPem('CERTIFICATE', rootCertificateDer),
    rootCertificateSha256: sha256Hex(rootCertificateDer),
    ...(rootPrivateKeyPem ? { rootPrivateKeyPem } : {}),
    issuingPrivateKeyPem: await exportPkcs8Pem(issuing.privateKey),
    issuingCertificateBase64: bytesToBase64(issuingCertificateDer),
    issuingCertificateSha256: sha256Hex(issuingCertificateDer),
    issuingNotAfter,
    rootNotAfter: rootParsed.notAfter,
  };
}

/** Reads a PEM certificate into DER. */
export function certificatePemToDer(pem: string): Uint8Array {
  return pemToDer(pem, 'CERTIFICATE');
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MAX_TRUSTED_FINGERPRINTS = 8;

/**
 * The fingerprint allowlist after adding a new issuing CA: the new one first, the previous ones
 * kept, so chains issued under an old issuing CA stay trusted until their keys are re-certified.
 * Nothing is dropped silently: when the list would exceed its limit the caller must retire
 * entries on purpose.
 */
export function mergeIssuingCaFingerprints(newest: string, previous: string | undefined): string {
  if (!SHA256_HEX.test(newest)) throw new Error('vc_ca_fingerprint_invalid');
  const kept = [
    ...new Set(
      (previous ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => SHA256_HEX.test(entry) && entry !== newest)
    ),
  ];
  if (kept.length + 1 > MAX_TRUSTED_FINGERPRINTS) throw new Error('vc_ca_too_many_fingerprints');
  return [newest, ...kept].join(',');
}

/**
 * The three files deploy uploads for the CA must belong together: the private key is the
 * certificate's, and the certificate's fingerprint is on the trusted list. Throws a stable code
 * so a half-finished update is caught at deploy, not at the first credential.
 */
export function assertVcCaFilesConsistent(input: {
  privateKeyPem?: string;
  certificateBase64?: string;
  fingerprints?: string;
}): void {
  const present = [input.privateKeyPem, input.certificateBase64, input.fingerprints].map((value) =>
    Boolean(value?.trim())
  );
  if (present.every((value) => !value)) return;
  if (present.some((value) => !value)) throw new Error('vc_ca_files_incomplete');
  try {
    const certificate = new X509Certificate(
      Buffer.from((input.certificateBase64 ?? '').trim(), 'base64')
    );
    const fromKey = createPublicKey(createPrivateKey(input.privateKeyPem ?? '')).export({
      type: 'spki',
      format: 'der',
    });
    const fromCertificate = certificate.publicKey.export({ type: 'spki', format: 'der' });
    if (!Buffer.from(fromKey).equals(Buffer.from(fromCertificate))) {
      throw new Error('vc_ca_files_key_mismatch');
    }
    const listed = (input.fingerprints ?? '').split(',').map((entry) => entry.trim().toLowerCase());
    if (!listed.includes(sha256Hex(new Uint8Array(certificate.raw)))) {
      throw new Error('vc_ca_files_fingerprint_not_listed');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('vc_ca_files_')) throw error;
    throw new Error('vc_ca_files_unreadable');
  }
}
