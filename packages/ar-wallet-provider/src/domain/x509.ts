/**
 * Minimal X.509 reader for the App Attest chain (ECDSA P-384 issuers, P-256 leaf) and for the
 * validity of the provider's own chain. Not a general certificate library: it reads exactly the
 * fields the verifiers need and refuses what it does not understand (non-minimal lengths, trailing
 * bytes, duplicate extensions). The existing `ar-lib-core` reader supports P-256 / SHA-256 only and
 * cannot verify Apple's chain, so this module is separate.
 */

import { equalBytes, type Bytes } from './bytes';

export class X509Error extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'X509Error';
  }
}

export interface Tlv {
  tag: number;
  /** Start of the whole TLV. */
  start: number;
  contentStart: number;
  end: number;
}

export function readTlv(der: Bytes, offset: number, limit = der.length): Tlv {
  if (offset + 2 > limit) throw new X509Error('der_truncated');
  const tag = der[offset];
  if ((tag & 0x1f) === 0x1f) throw new X509Error('der_high_tag');
  let length = der[offset + 1];
  let contentStart = offset + 2;
  if (length & 0x80) {
    const width = length & 0x7f;
    if (width === 0 || width > 3) throw new X509Error('der_bad_length');
    if (contentStart + width > limit) throw new X509Error('der_truncated');
    length = 0;
    for (let index = 0; index < width; index += 1)
      length = length * 256 + der[contentStart + index];
    if (length < 0x80 || (width > 1 && der[contentStart] === 0))
      throw new X509Error('der_non_minimal');
    contentStart += width;
  }
  const end = contentStart + length;
  if (end > limit) throw new X509Error('der_truncated');
  return { tag, start: offset, contentStart, end };
}

export function children(der: Bytes, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const item = readTlv(der, offset, parent.end);
    out.push(item);
    offset = item.end;
  }
  return out;
}

function expect(item: Tlv, tag: number): Tlv {
  if (item.tag !== tag) throw new X509Error('der_unexpected_tag');
  return item;
}

export function content(der: Bytes, item: Tlv): Bytes {
  return der.slice(item.contentStart, item.end);
}

function whole(der: Bytes, item: Tlv): Bytes {
  return der.slice(item.start, item.end);
}

export function decodeOid(bytes: Bytes): string {
  if (bytes.length === 0) throw new X509Error('der_bad_oid');
  const arcs: number[] = [];
  let value = 0;
  for (const byte of bytes) {
    value = value * 128 + (byte & 0x7f);
    if (byte & 0x80) continue;
    arcs.push(value);
    value = 0;
  }
  if (bytes[bytes.length - 1] & 0x80) throw new X509Error('der_bad_oid');
  const first = arcs[0] < 40 ? 0 : arcs[0] < 80 ? 1 : 2;
  return [first, arcs[0] - first * 40, ...arcs.slice(1)].join('.');
}

function parseTime(item: Tlv, der: Bytes): number {
  const text = new TextDecoder().decode(content(der, item));
  let match: RegExpMatchArray | null;
  let year: number;
  if (item.tag === 0x17) {
    match = text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/u);
    if (!match) throw new X509Error('der_bad_time');
    const yy = Number(match[1]);
    year = yy >= 50 ? 1900 + yy : 2000 + yy;
  } else if (item.tag === 0x18) {
    match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/u);
    if (!match) throw new X509Error('der_bad_time');
    year = Number(match[1]);
  } else {
    throw new X509Error('der_bad_time');
  }
  const parts = [
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  ];
  const ms = Date.UTC(year, parts[0] - 1, parts[1], parts[2], parts[3], parts[4]);
  // Date.UTC carries out-of-range components over (month 13 becomes January); require a round trip.
  const back = new Date(ms);
  if (
    Number.isNaN(ms) ||
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() + 1 !== parts[0] ||
    back.getUTCDate() !== parts[1] ||
    back.getUTCHours() !== parts[2] ||
    back.getUTCMinutes() !== parts[3] ||
    back.getUTCSeconds() !== parts[4]
  ) {
    throw new X509Error('der_bad_time');
  }
  return Math.floor(ms / 1000);
}

export const OID = {
  ecPublicKey: '1.2.840.10045.2.1',
  prime256v1: '1.2.840.10045.3.1.7',
  secp384r1: '1.3.132.0.34',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  ecdsaSha384: '1.2.840.10045.4.3.3',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extendedKeyUsage: '2.5.29.37',
  appleNonce: '1.2.840.113635.100.8.2',
  appleAclBlob: '1.2.840.113635.100.8.6',
} as const;

export type Curve = 'P-256' | 'P-384';
export type HashName = 'SHA-256' | 'SHA-384';

export interface ParsedCertificate {
  der: Bytes;
  tbs: Bytes;
  issuerName: Bytes;
  subjectName: Bytes;
  notBefore: number;
  notAfter: number;
  /** The certificate's own signature algorithm OID (outer and inner must agree). */
  signatureAlgorithm: string;
  /** DER ECDSA-Sig-Value. */
  signature: Bytes;
  spki: Bytes;
  curve: Curve;
  /** Uncompressed point (0x04 || X || Y). */
  publicPoint: Bytes;
  isCA: boolean;
  hasBasicConstraints: boolean;
  keyCertSign: boolean;
  /** True when a keyUsage extension is present. */
  hasKeyUsage: boolean;
  digitalSignature: boolean;
  hasExtendedKeyUsage: boolean;
  extensions: Map<string, { critical: boolean; value: Bytes }>;
}

export function parseCertificate(der: Bytes): ParsedCertificate {
  const cert = expect(readTlv(der, 0), 0x30);
  if (cert.end !== der.length) throw new X509Error('der_trailing_bytes');
  const [tbsItem, sigAlgItem, sigItem, ...rest] = children(der, cert);
  if (!tbsItem || !sigAlgItem || !sigItem || rest.length > 0) throw new X509Error('cert_shape');
  expect(tbsItem, 0x30);
  const sigAlgParts = children(der, expect(sigAlgItem, 0x30));
  // RFC 5758: the parameters of an ECDSA signature algorithm are absent.
  if (sigAlgParts.length !== 1) throw new X509Error('cert_algorithm_parameters');
  const signatureAlgorithm = decodeOid(content(der, expect(sigAlgParts[0], 0x06)));
  const sigBits = content(der, expect(sigItem, 0x03));
  if (sigBits.length < 2 || sigBits[0] !== 0) throw new X509Error('cert_signature');
  const signature = sigBits.slice(1);

  const fields = children(der, tbsItem);
  let index = 0;
  if (fields[index]?.tag === 0xa0) {
    const version = children(der, fields[index]);
    if (version.length !== 1 || expect(version[0], 0x02).end - version[0].contentStart !== 1) {
      throw new X509Error('cert_version');
    }
    index += 1;
  }
  const serial = expect(fields[index], 0x02);
  if (serial.end === serial.contentStart || (der[serial.contentStart] & 0x80) !== 0) {
    throw new X509Error('cert_serial');
  }
  index += 1;
  const innerAlg = children(der, expect(fields[index], 0x30));
  if (innerAlg.length !== 1) throw new X509Error('cert_algorithm_parameters');
  index += 1;
  if (decodeOid(content(der, expect(innerAlg[0], 0x06))) !== signatureAlgorithm) {
    throw new X509Error('cert_algorithm_mismatch');
  }
  const issuerItem = expect(fields[index], 0x30);
  index += 1;
  const validity = children(der, expect(fields[index], 0x30));
  index += 1;
  if (validity.length !== 2) throw new X509Error('cert_validity');
  const notBefore = parseTime(validity[0], der);
  const notAfter = parseTime(validity[1], der);
  const subjectItem = expect(fields[index], 0x30);
  index += 1;
  const spkiItem = expect(fields[index], 0x30);
  index += 1;

  const spkiParts = children(der, spkiItem);
  const algParts = children(der, expect(spkiParts[0], 0x30));
  if (decodeOid(content(der, expect(algParts[0], 0x06))) !== OID.ecPublicKey) {
    throw new X509Error('cert_key_type');
  }
  const curveOid = decodeOid(content(der, expect(algParts[1], 0x06)));
  const curve: Curve | null =
    curveOid === OID.prime256v1 ? 'P-256' : curveOid === OID.secp384r1 ? 'P-384' : null;
  if (!curve) throw new X509Error('cert_curve');
  const pointBits = content(der, expect(spkiParts[1], 0x03));
  const publicPoint = pointBits.slice(1);
  const expectedLength = curve === 'P-256' ? 65 : 97;
  if (pointBits[0] !== 0 || publicPoint.length !== expectedLength || publicPoint[0] !== 4) {
    throw new X509Error('cert_point');
  }

  const extensions = new Map<string, { critical: boolean; value: Bytes }>();
  let isCA = false;
  let hasBasicConstraints = false;
  let keyCertSign = false;
  let hasKeyUsage = false;
  let digitalSignature = false;
  let hasExtendedKeyUsage = false;
  // After the public key only the [3] extensions wrapper may follow (no unique ids), exactly once.
  const tail = fields.slice(index);
  if (tail.length > 1 || (tail.length === 1 && tail[0].tag !== 0xa3))
    throw new X509Error('cert_shape');
  if (tail.length === 1) {
    const wrapped = children(der, tail[0]);
    if (wrapped.length !== 1) throw new X509Error('cert_extensions');
    const list = expect(wrapped[0], 0x30);
    for (const ext of children(der, list)) {
      const parts = children(der, expect(ext, 0x30));
      const oid = decodeOid(content(der, expect(parts[0], 0x06)));
      let critical = false;
      let valueItem = parts[1];
      if (parts.length === 3) {
        expect(parts[1], 0x01);
        if (parts[1].end - parts[1].contentStart !== 1 || der[parts[1].contentStart] !== 0xff) {
          throw new X509Error('der_bad_boolean');
        }
        critical = true;
        valueItem = parts[2];
      } else if (parts.length !== 2) {
        throw new X509Error('cert_extension');
      }
      if (extensions.has(oid)) throw new X509Error('cert_duplicate_extension');
      const value = content(der, expect(valueItem, 0x04));
      extensions.set(oid, { critical, value });
      if (oid === OID.basicConstraints) {
        hasBasicConstraints = true;
        const seq = expect(readTlv(value, 0), 0x30);
        if (seq.end !== value.length) throw new X509Error('cert_basic_constraints');
        const items = children(value, seq);
        let at = 0;
        if (items[at]?.tag === 0x01) {
          const flag = items[at];
          if (flag.end - flag.contentStart !== 1) throw new X509Error('der_bad_boolean');
          const byte = value[flag.contentStart];
          if (byte !== 0 && byte !== 0xff) throw new X509Error('der_bad_boolean');
          isCA = byte === 0xff;
          at += 1;
        }
        if (items[at]?.tag === 0x02) {
          // pathLenConstraint: a non-negative, minimally encoded integer, and only for a CA.
          const length = items[at].end - items[at].contentStart;
          const first = value[items[at].contentStart];
          if (!isCA || length === 0 || (first & 0x80) !== 0 || (length > 1 && first === 0)) {
            throw new X509Error('cert_basic_constraints');
          }
          at += 1;
        }
        if (at !== items.length) throw new X509Error('cert_basic_constraints');
      } else if (oid === OID.keyUsage) {
        hasKeyUsage = true;
        const bit = readTlv(value, 0);
        if (bit.end !== value.length) throw new X509Error('cert_key_usage');
        const bits = content(value, expect(bit, 0x03));
        if (bits.length < 2 || bits[0] > 7) throw new X509Error('cert_key_usage');
        // Bits past the declared length must be zero (DER); otherwise a bit the encoder never meant
        // could be read.
        if ((bits[bits.length - 1] & ((1 << bits[0]) - 1)) !== 0)
          throw new X509Error('cert_key_usage');
        digitalSignature = (bits[1] & 0x80) !== 0;
        keyCertSign = (bits[1] & 0x04) !== 0;
      } else if (oid === OID.extendedKeyUsage) {
        hasExtendedKeyUsage = true;
      }
    }
  }
  return {
    der,
    tbs: whole(der, tbsItem),
    issuerName: whole(der, issuerItem),
    subjectName: whole(der, subjectItem),
    notBefore,
    notAfter,
    signatureAlgorithm,
    signature,
    spki: whole(der, spkiItem),
    curve,
    publicPoint,
    isCA,
    hasBasicConstraints,
    keyCertSign,
    hasKeyUsage,
    digitalSignature,
    hasExtendedKeyUsage,
    extensions,
  };
}

/**
 * DER ECDSA-Sig-Value to the raw r || s that WebCrypto verifies. Each INTEGER must be non-empty,
 * positive,
 * minimally encoded and at most `size` significant bytes; no copying loop depends on attacker
 * lengths.
 */
export function ecdsaDerToRaw(der: Bytes, size: number): Bytes {
  const seq = expect(readTlv(der, 0), 0x30);
  if (seq.end !== der.length) throw new X509Error('ecdsa_trailing');
  const parts = children(der, seq);
  if (parts.length !== 2) throw new X509Error('ecdsa_shape');
  const out = new Uint8Array(size * 2);
  [parts[0], parts[1]].forEach((part, slot) => {
    const item = expect(part, 0x02);
    let start = item.contentStart;
    const length = item.end - start;
    if (length === 0 || (der[start] & 0x80) !== 0) throw new X509Error('ecdsa_integer');
    if (length > 1 && der[start] === 0 && (der[start + 1] & 0x80) === 0) {
      throw new X509Error('ecdsa_integer');
    }
    if (der[start] === 0 && length > 1) start += 1;
    const significant = item.end - start;
    if (significant > size) throw new X509Error('ecdsa_length');
    out.set(der.subarray(start, item.end), slot * size + (size - significant));
  });
  return out;
}

/**
 * Verifies `child`'s signature with `issuer`'s key. The curve/hash combination is the caller's
 * allow-list.
 */
export async function verifyCertificateSignature(
  child: ParsedCertificate,
  issuer: ParsedCertificate,
  allowed: readonly { curve: Curve; hash: HashName }[]
): Promise<boolean> {
  const hash: HashName | null =
    child.signatureAlgorithm === OID.ecdsaSha256
      ? 'SHA-256'
      : child.signatureAlgorithm === OID.ecdsaSha384
        ? 'SHA-384'
        : null;
  if (!hash) return false;
  if (!allowed.some((entry) => entry.curve === issuer.curve && entry.hash === hash)) return false;
  if (!equalBytes(child.issuerName, issuer.subjectName)) return false;
  try {
    const size = issuer.curve === 'P-256' ? 32 : 48;
    const key = await crypto.subtle.importKey(
      'spki',
      issuer.spki,
      { name: 'ECDSA', namedCurve: issuer.curve },
      false,
      ['verify']
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash },
      key,
      ecdsaDerToRaw(child.signature, size),
      child.tbs
    );
  } catch {
    return false;
  }
}
