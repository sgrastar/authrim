/**
 * Apple App Attest assertion verification. The challenge is checked by the caller; this module
 * checks
 * the signature, the App ID hash, the counter against the stored one, and the build info. The
 * caller
 * commits the counter atomically afterwards.
 */

import { concat, equalBytes, fromBase64, fromHex, sha256, utf8, type Bytes } from './bytes';
import { decodeCbor } from './cbor';
import { parseAssertionAuthData } from './auth-data';
import {
  ASSERTION_BUNDLE_VERSION_KEY,
  ASSERTION_CATEGORY_KEY,
  buildAllowed,
  readBuildInfo,
  type BuildInfo,
} from './app-attest-extensions';
import type { AppAttestPolicy } from './app-attest-policy';
import { ecdsaDerToRaw } from './x509';

export type AssertionFailure =
  | 'malformed_input'
  | 'cbor_invalid'
  | 'format_invalid'
  | 'app_id_mismatch'
  | 'signature_invalid'
  | 'counter_not_greater'
  | 'extensions_invalid'
  | 'build_not_allowed';

export type AssertionResult =
  | { ok: true; counter: number; build: BuildInfo }
  | { ok: false; reason: AssertionFailure };

export interface VerifyAssertionInput {
  /** Base64 CBOR assertion. */
  assertion: string;
  /** The exact client data string the wallet signed (rebuilt by the caller from the request). */
  clientData: string;
  /** Stored public key as an uncompressed point. */
  publicPoint: Bytes;
  storedCounter: number;
  /** SHA-256 hex of the App ID recorded at registration. */
  appIdHash: string;
}

export async function verifyAssertion(
  input: VerifyAssertionInput,
  policy: AppAttestPolicy
): Promise<AssertionResult> {
  const fail = (reason: AssertionFailure): AssertionResult => ({ ok: false, reason });
  if (input.assertion.length > 5464 || input.clientData.length > 2048)
    return fail('malformed_input');
  const bytes = fromBase64(input.assertion);
  if (!bytes || bytes.length > 4096 || input.publicPoint.length !== 65)
    return fail('malformed_input');
  let decoded;
  try {
    decoded = decodeCbor(bytes);
  } catch {
    return fail('cbor_invalid');
  }
  const signature = decoded instanceof Map ? decoded.get('signature') : undefined;
  const authenticatorData = decoded instanceof Map ? decoded.get('authenticatorData') : undefined;
  if (!(signature instanceof Uint8Array) || !(authenticatorData instanceof Uint8Array)) {
    return fail('format_invalid');
  }
  const data = parseAssertionAuthData(authenticatorData);
  if (!data) return fail('format_invalid');

  // nonce = SHA256(authenticatorData || SHA256(clientData)); the signature is ES256 over `nonce`
  const clientDataHash = await sha256(utf8(input.clientData));
  const nonce = await sha256(concat(authenticatorData, clientDataHash));
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      input.publicPoint,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      ecdsaDerToRaw(signature, 32),
      nonce
    );
    if (!valid) return fail('signature_invalid');
  } catch {
    return fail('signature_invalid');
  }

  const expectedAppId = fromHex(input.appIdHash);
  if (!expectedAppId || !equalBytes(data.rpIdHash, expectedAppId)) return fail('app_id_mismatch');
  if (!(data.counter > input.storedCounter)) return fail('counter_not_greater');

  const build = readBuildInfo(
    data.extensions,
    { category: ASSERTION_CATEGORY_KEY, bundleVersion: ASSERTION_BUNDLE_VERSION_KEY },
    policy.categoryByteOrder
  );
  if (build === 'invalid') return fail('extensions_invalid');
  if (!buildAllowed(build, policy)) return fail('build_not_allowed');
  return { ok: true, counter: data.counter, build };
}
