/**
 * WebAuthn-style authenticator data as App Attest produces it (attestation: full; assertion: first
 * 37 bytes + optional extensions).
 */

import { readUint32, type Bytes } from './bytes';
import { CborError, decodeCborPrefix, type CborValue } from './cbor';

export interface AssertionAuthData {
  rpIdHash: Bytes;
  flags: number;
  counter: number;
  extensions: Map<string | number, CborValue> | null;
}

export interface AttestationAuthData extends AssertionAuthData {
  aaguid: Bytes;
  credentialId: Bytes;
  /** Uncompressed point from the COSE key. */
  publicPoint: Bytes;
}

function asMap(value: CborValue): Map<string | number, CborValue> | null {
  return value instanceof Map ? value : null;
}

function readExtensions(bytes: Bytes, offset: number): Map<string | number, CborValue> | null {
  if (offset === bytes.length) return null;
  const { value, length } = decodeCborPrefix(bytes.slice(offset));
  if (offset + length !== bytes.length) throw new CborError('authdata_trailing_bytes');
  const map = asMap(value);
  if (!map) throw new CborError('authdata_extensions_not_map');
  return map;
}

export function parseAssertionAuthData(bytes: Bytes): AssertionAuthData | null {
  if (bytes.length < 37) return null;
  try {
    return {
      rpIdHash: bytes.slice(0, 32),
      flags: bytes[32],
      counter: readUint32(bytes, 33),
      extensions: readExtensions(bytes, 37),
    };
  } catch {
    return null;
  }
}

export function parseAttestationAuthData(bytes: Bytes): AttestationAuthData | null {
  if (bytes.length < 55) return null;
  try {
    const credentialIdLength = (bytes[53] << 8) | bytes[54];
    if (credentialIdLength !== 32 || bytes.length < 55 + credentialIdLength) return null;
    const keyStart = 55 + credentialIdLength;
    const { value: cose, length } = decodeCborPrefix(bytes.slice(keyStart));
    const key = asMap(cose);
    const x = key?.get(-2);
    const y = key?.get(-3);
    if (
      !key ||
      key.get(1) !== 2 || // kty EC2
      key.get(3) !== -7 || // alg ES256
      key.get(-1) !== 1 || // crv P-256
      !(x instanceof Uint8Array) ||
      !(y instanceof Uint8Array) ||
      x.length !== 32 ||
      y.length !== 32
    ) {
      return null;
    }
    const publicPoint = new Uint8Array(65);
    publicPoint[0] = 4;
    publicPoint.set(x, 1);
    publicPoint.set(y, 33);
    return {
      rpIdHash: bytes.slice(0, 32),
      flags: bytes[32],
      counter: readUint32(bytes, 33),
      aaguid: bytes.slice(37, 53),
      credentialId: bytes.slice(55, keyStart),
      publicPoint,
      extensions: readExtensions(bytes, keyStart + length),
    };
  } catch {
    return null;
  }
}
