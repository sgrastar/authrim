/**
 * Apple App Attest attestation verification ("Validating apps that connect to your server").
 *
 * Pure: the clock, the policy and the pinned Apple root are inputs; there is no I/O. The caller
 * (registration) owns the challenge check and the atomic commit. Any failure returns a stable
 * reason
 * code for the log; the HTTP layer answers every reason with the same `invalid_attestation`.
 */

import {
  concat,
  equalBytes,
  fromBase64,
  sha256,
  toBase64,
  toBase64Url,
  toHex,
  utf8,
  type Bytes,
} from './bytes';
import { decodeCbor, type CborValue } from './cbor';
import { parseAttestationAuthData } from './auth-data';
import {
  BUNDLE_VERSION_KEY,
  CATEGORY_KEY,
  buildAllowed,
  readBuildInfo,
  type BuildInfo,
} from './app-attest-extensions';
import {
  DEFAULT_CRED_CERT_SIGNATURE,
  DEFAULT_INTERMEDIATE_SIGNATURE,
  type AppAttestEnvironment,
  type AppAttestPolicy,
} from './app-attest-policy';
import {
  OID,
  children,
  content,
  parseCertificate,
  readTlv,
  verifyCertificateSignature,
  type ParsedCertificate,
} from './x509';

export type AttestationFailure =
  | 'malformed_input'
  | 'cbor_invalid'
  | 'format_invalid'
  | 'chain_invalid'
  | 'chain_untrusted'
  | 'nonce_mismatch'
  | 'key_id_mismatch'
  | 'app_id_mismatch'
  | 'counter_not_zero'
  | 'environment_not_allowed'
  | 'credential_id_mismatch'
  | 'cose_key_mismatch'
  | 'extensions_invalid'
  | 'build_not_allowed';

export interface VerifiedAttestation {
  keyId: string;
  publicKeyJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  environment: AppAttestEnvironment;
  appIdHash: string;
  build: BuildInfo;
  receipt: string;
  attestationSha256: string;
  challengeSha256: string;
}

export type AttestationResult =
  | { ok: true; attestation: VerifiedAttestation }
  | { ok: false; reason: AttestationFailure };

const AAGUID_DEVELOPMENT = utf8('appattestdevelop');
const AAGUID_PRODUCTION = concat(utf8('appattest'), new Uint8Array(7));

/**
 * Critical extensions the chain may carry; anything else critical is refused (tune with real
 * chains).
 */
const KNOWN_CRITICAL = new Set<string>([OID.basicConstraints, OID.keyUsage]);

/**
 * The nonce extension value is `SEQUENCE { [1] EXPLICIT { OCTET STRING } }` (Apple's
 * documentation: "a
 * DER-encoded ASN.1 sequence ... the single octet string"). A bare OCTET STRING is also accepted;
 * anything
 * else, or more than one octet string, is refused.
 */
function readNonceExtension(value: Bytes): Bytes | null {
  try {
    const outer = readTlv(value, 0);
    if (outer.end !== value.length) return null;
    if (outer.tag === 0x04) return content(value, outer);
    if (outer.tag !== 0x30) return null;
    const parts = children(value, outer);
    if (parts.length !== 1) return null;
    const inner = parts[0];
    if (inner.tag === 0x04) return content(value, inner);
    if (inner.tag !== 0xa1) return null;
    const wrapped = children(value, inner);
    return wrapped.length === 1 && wrapped[0].tag === 0x04 ? content(value, wrapped[0]) : null;
  } catch {
    return null;
  }
}

function mapOf(value: CborValue): Map<string | number, CborValue> | null {
  return value instanceof Map ? value : null;
}

export interface VerifyAttestationInput {
  /** Base64 key id as the client sent it (standard base64 of 32 bytes). */
  keyId: string;
  challenge: string;
  /** Base64 CBOR attestation object. */
  attestationObject: string;
  /** Epoch seconds. */
  now: number;
}

export async function verifyAttestation(
  input: VerifyAttestationInput,
  policy: AppAttestPolicy
): Promise<AttestationResult> {
  const fail = (reason: AttestationFailure): AttestationResult => ({ ok: false, reason });

  // Size limits come before any decoding: 44 characters (32 bytes), 21848 (16 KiB), a challenge of
  // 512 at most.
  if (
    input.keyId.length !== 44 ||
    input.attestationObject.length > 21848 ||
    input.challenge.length > 512 ||
    !Number.isSafeInteger(input.now)
  ) {
    return fail('malformed_input');
  }
  const keyIdBytes = fromBase64(input.keyId);
  const objectBytes = fromBase64(input.attestationObject);
  if (!keyIdBytes || keyIdBytes.length !== 32 || !objectBytes || objectBytes.length > 16 * 1024) {
    return fail('malformed_input');
  }
  if (input.challenge.length === 0) return fail('malformed_input');

  let decoded: CborValue;
  try {
    decoded = decodeCbor(objectBytes);
  } catch {
    return fail('cbor_invalid');
  }
  const root = mapOf(decoded);
  const attStmt = root ? mapOf(root.get('attStmt') ?? 0) : null;
  const x5c = attStmt?.get('x5c');
  const receipt = attStmt?.get('receipt');
  const authData = root?.get('authData');
  if (
    !root ||
    root.get('fmt') !== 'apple-appattest' ||
    !attStmt ||
    !Array.isArray(x5c) ||
    x5c.length !== 2 ||
    !x5c.every((entry): entry is Bytes => entry instanceof Uint8Array) ||
    !(receipt instanceof Uint8Array) ||
    !(authData instanceof Uint8Array)
  ) {
    return fail('format_invalid');
  }

  // 1. chain: credCert <- intermediate <- pinned Apple root
  let credCert: ParsedCertificate;
  let intermediate: ParsedCertificate;
  let appleRoot: ParsedCertificate;
  try {
    credCert = parseCertificate(x5c[0]);
    intermediate = parseCertificate(x5c[1]);
    appleRoot = parseCertificate(policy.appleRootDer);
  } catch {
    return fail('chain_invalid');
  }
  if (toHex(await sha256(policy.appleRootDer)) !== policy.appleRootSha256.toLowerCase()) {
    return fail('chain_untrusted');
  }
  for (const cert of [credCert, intermediate, appleRoot]) {
    if (input.now < cert.notBefore || input.now > cert.notAfter) return fail('chain_invalid');
    for (const [oid, ext] of cert.extensions) {
      if (ext.critical && !KNOWN_CRITICAL.has(oid)) return fail('chain_invalid');
    }
  }
  if (
    credCert.isCA ||
    !intermediate.isCA ||
    (intermediate.hasBasicConstraints && !intermediate.keyCertSign)
  ) {
    return fail('chain_invalid');
  }
  if (credCert.curve !== 'P-256') return fail('chain_invalid');
  // A leaf that states its key usage must allow digital signatures (the attested key signs
  // assertions).
  if (credCert.hasKeyUsage && !credCert.digitalSignature) return fail('chain_invalid');
  if (
    !(await verifyCertificateSignature(
      credCert,
      intermediate,
      policy.credCertSignature ?? DEFAULT_CRED_CERT_SIGNATURE
    )) ||
    !(await verifyCertificateSignature(
      intermediate,
      appleRoot,
      policy.intermediateSignature ?? DEFAULT_INTERMEDIATE_SIGNATURE
    ))
  ) {
    return fail('chain_untrusted');
  }

  // 2-4. nonce = SHA256(authData || SHA256(challenge)) must equal the credCert extension
  const challengeHash = await sha256(utf8(input.challenge));
  const nonce = await sha256(concat(authData, challengeHash));
  const nonceExt = credCert.extensions.get(OID.appleNonce);
  const extensionNonce = nonceExt ? readNonceExtension(nonceExt.value) : null;
  if (!extensionNonce || !equalBytes(extensionNonce, nonce)) return fail('nonce_mismatch');

  // 5. key id = SHA256(public key, X9.62 uncompressed)
  if (!equalBytes(await sha256(credCert.publicPoint), keyIdBytes)) return fail('key_id_mismatch');

  const data = parseAttestationAuthData(authData);
  if (!data) return fail('format_invalid');

  // 6. App ID hash
  let appIdHash: Bytes | null = null;
  for (const appId of policy.appIds) {
    const candidate = await sha256(utf8(appId));
    if (equalBytes(candidate, data.rpIdHash)) {
      appIdHash = candidate;
      break;
    }
  }
  if (!appIdHash) return fail('app_id_mismatch');

  // 7. counter, 8. aaguid, 9. credential id, COSE key = credCert key
  if (data.counter !== 0) return fail('counter_not_zero');
  const environment: AppAttestEnvironment | null = equalBytes(data.aaguid, AAGUID_DEVELOPMENT)
    ? 'development'
    : equalBytes(data.aaguid, AAGUID_PRODUCTION)
      ? 'production'
      : null;
  if (!environment || !policy.environments.includes(environment))
    return fail('environment_not_allowed');
  if (!equalBytes(data.credentialId, keyIdBytes)) return fail('credential_id_mismatch');
  if (!equalBytes(data.publicPoint, credCert.publicPoint)) return fail('cose_key_mismatch');

  // 10. Apple extensions and the build policy
  const build = readBuildInfo(
    data.extensions,
    { category: CATEGORY_KEY, bundleVersion: BUNDLE_VERSION_KEY },
    policy.categoryByteOrder
  );
  if (build === 'invalid') return fail('extensions_invalid');
  if (!buildAllowed(build, policy)) return fail('build_not_allowed');

  return {
    ok: true,
    attestation: {
      keyId: input.keyId,
      publicKeyJwk: {
        kty: 'EC',
        crv: 'P-256',
        x: toBase64Url(data.publicPoint.slice(1, 33)),
        y: toBase64Url(data.publicPoint.slice(33, 65)),
      },
      environment,
      appIdHash: toHex(appIdHash),
      build,
      receipt: toBase64(receipt),
      attestationSha256: toHex(await sha256(objectBytes)),
      challengeSha256: toHex(challengeHash),
    },
  };
}
