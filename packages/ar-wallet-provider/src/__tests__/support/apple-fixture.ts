/**
 * Builds an Apple-shaped App Attest fixture from scratch: a P-384 root and intermediate, a P-256
 * credCert signed by the intermediate with SHA-256 (as Apple's published sample), the nonce extension,
 * and the CBOR attestation and assertion objects. The device spike replaces this with real vectors.
 */

import { exportRaw, exportSpki, genPair } from './keys';
import {
  bits,
  bool,
  cat,
  cbor,
  derEcdsa,
  enc,
  int,
  octet,
  oid,
  seq,
  tlv,
  utcTime,
  type B,
  type CV,
} from './der';

const sha = async (b: B): Promise<B> => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const hex = (b: B): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
export const b64 = (b: B): string => btoa(String.fromCharCode(...b));

interface Pair {
  priv: CryptoKey;
  spki: B;
  point: B;
}
async function genKey(curve: 'P-256' | 'P-384'): Promise<Pair> {
  const kp = await genPair(curve);
  const spki = await exportSpki(kp.publicKey);
  const point = await exportRaw(kp.publicKey);
  return { priv: kp.privateKey, spki, point };
}

const NAME = (cn: string): B => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, enc(cn)))));
export const ALG = (hash: 'SHA-256' | 'SHA-384', withNull = false): B =>
  seq(
    oid(hash === 'SHA-256' ? '1.2.840.10045.4.3.2' : '1.2.840.10045.4.3.3'),
    ...(withNull ? [tlv(0x05)] : [])
  );
export const ext = (o: string, critical: boolean, value: B): B =>
  seq(oid(o), ...(critical ? [bool(true)] : []), octet(value));

export interface CertSpec {
  subjectCn: string;
  issuerCn: string;
  subjectSpki: B;
  issuerKey: CryptoKey;
  issuerCurve: 'P-256' | 'P-384';
  hash: 'SHA-256' | 'SHA-384';
  notBefore: number;
  notAfter: number;
  ca: boolean;
  extra?: B[];
  /** Overrides the inner signature algorithm OID (for the mismatch test). */
  innerHash?: 'SHA-256' | 'SHA-384';
  /** keyUsage digitalSignature only (no keyCertSign) even for a CA. */
  keyUsageSignOnly?: boolean;
  noBasicConstraints?: boolean;
  /** Raw keyUsage first byte and unused-bit count, overriding the default. */
  keyUsage?: { byte: number; unused: number };
  /** Extra raw element appended to the TBS after the extensions. */
  extraTbs?: B;
  innerAlgParams?: boolean;
  outerAlgParams?: boolean;
}

export async function makeCert(spec: CertSpec): Promise<B> {
  const exts = [
    ...(spec.noBasicConstraints
      ? []
      : [ext('2.5.29.19', true, seq(...(spec.ca ? [bool(true)] : [])))]),
    ext(
      '2.5.29.15',
      true,
      spec.keyUsage
        ? bits(Uint8Array.of(spec.keyUsage.byte), spec.keyUsage.unused)
        : bits(
            Uint8Array.of(spec.ca && !spec.keyUsageSignOnly ? 0x04 : 0x80),
            spec.ca && !spec.keyUsageSignOnly ? 2 : 7
          )
    ),
    ...(spec.extra ?? []),
  ];
  const tbs = seq(
    tlv(0xa0, int(2)),
    int(1),
    ALG(spec.innerHash ?? spec.hash, spec.innerAlgParams),
    NAME(spec.issuerCn),
    seq(utcTime(spec.notBefore), utcTime(spec.notAfter)),
    NAME(spec.subjectCn),
    spec.subjectSpki,
    tlv(0xa3, seq(...exts)),
    ...(spec.extraTbs ? [spec.extraTbs] : [])
  );
  const size = spec.issuerCurve === 'P-256' ? 32 : 48;
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: spec.hash }, spec.issuerKey, tbs)
  );
  if (raw.length !== size * 2) throw new Error('unexpected signature size');
  return seq(tbs, ALG(spec.hash, spec.outerAlgParams), bits(derEcdsa(raw)));
}

function nonceDer(shape: AttestOptions['nonceShape'], nonce: B): B {
  switch (shape) {
    case 'bare':
      return octet(nonce);
    case 'double':
      return seq(tlv(0xa1, octet(nonce)), octet(nonce));
    case 'nested':
      return seq(seq(tlv(0xa1, seq(tlv(0xa1, octet(nonce))))));
    case 'garbage':
      return Uint8Array.of(0x05, 0x00);
    default:
      return seq(tlv(0xa1, octet(nonce)));
  }
}

export interface AppleWorld {
  rootDer: B;
  rootSha256: string;
  intermediateDer: B;
  intermediate: Pair;
  now: number;
}

export async function makeAppleWorld(
  now: number,
  o: { intermediateCa?: boolean; intermediateKeyUsage?: 'sign' } = {}
): Promise<AppleWorld> {
  const root = await genKey('P-384');
  const inter = await genKey('P-384');
  const year = 365 * 86400;
  const rootDer = await makeCert({
    subjectCn: 'Fake Apple App Attestation Root',
    issuerCn: 'Fake Apple App Attestation Root',
    subjectSpki: root.spki,
    issuerKey: root.priv,
    issuerCurve: 'P-384',
    hash: 'SHA-384',
    notBefore: now - year,
    notAfter: now + 10 * year,
    ca: true,
  });
  const intermediateDer = await makeCert({
    subjectCn: 'Fake Apple App Attestation CA 1',
    issuerCn: 'Fake Apple App Attestation Root',
    subjectSpki: inter.spki,
    issuerKey: root.priv,
    issuerCurve: 'P-384',
    hash: 'SHA-384',
    notBefore: now - year,
    notAfter: now + 5 * year,
    ca: o.intermediateCa ?? true,
    keyUsageSignOnly: o.intermediateKeyUsage === 'sign',
  });
  return {
    rootDer,
    rootSha256: hex(await sha(rootDer)),
    intermediateDer,
    intermediate: inter,
    now,
  };
}

export interface AttestOptions {
  appId?: string;
  challenge?: string;
  aaguid?: 'development' | 'production' | B;
  counter?: number;
  extensions?: Map<string, CV>;
  credentialId?: 'ok' | B;
  nonceOverride?: B;
  fmt?: string;
  credHash?: 'SHA-256' | 'SHA-384';
  credNotAfterOffset?: number;
  credInnerHash?: 'SHA-256' | 'SHA-384';
  extraCredExtensions?: B[];
  coseXOverride?: B;
  keyIdOverride?: B;
  omitNonce?: boolean;
  credCa?: boolean;
  credKeyUsage?: { byte: number; unused: number };
  credCurve?: 'P-256' | 'P-384';
  nonceShape?: 'bare' | 'double' | 'nested' | 'garbage';
  x5cMode?: 'single' | 'triple' | 'swapped';
}

export interface DeviceFixture {
  keyId: string;
  keyIdBytes: B;
  point: B;
  priv: CryptoKey;
  attestationObject: string;
  challenge: string;
  appId: string;
}

export async function makeAttestation(
  world: AppleWorld,
  opts: AttestOptions = {}
): Promise<DeviceFixture> {
  const appId = opts.appId ?? 'TEAM123456.com.authrim.keyring';
  const challenge = opts.challenge ?? 'registration-challenge-0001';
  const device = await genKey(opts.credCurve ?? 'P-256');
  const keyIdBytes = opts.keyIdOverride ?? (await sha(device.point));
  const aaguid =
    opts.aaguid instanceof Uint8Array
      ? opts.aaguid
      : opts.aaguid === 'production'
        ? cat(enc('appattest'), new Uint8Array(7))
        : enc('appattestdevelop');
  const counter = opts.counter ?? 0;
  const cose = new Map<string | number, CV>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, opts.coseXOverride ?? device.point.slice(1, 33)],
    [-3, device.point.slice(33, 65)],
  ]);
  const credId =
    opts.credentialId === 'ok' || opts.credentialId === undefined ? keyIdBytes : opts.credentialId;
  const authData = cat(
    await sha(enc(appId)),
    Uint8Array.of(0x40),
    Uint8Array.of(
      (counter >>> 24) & 0xff,
      (counter >>> 16) & 0xff,
      (counter >>> 8) & 0xff,
      counter & 0xff
    ),
    aaguid,
    Uint8Array.of(0, credId.length),
    credId,
    cbor(cose),
    ...(opts.extensions ? [cbor(opts.extensions)] : [])
  );
  const nonce = opts.nonceOverride ?? (await sha(cat(authData, await sha(enc(challenge)))));
  const now = world.now;
  const credCertDer = await makeCert({
    subjectCn: 'Fake credCert',
    issuerCn: 'Fake Apple App Attestation CA 1',
    subjectSpki: device.spki,
    issuerKey: world.intermediate.priv,
    issuerCurve: 'P-384',
    hash: opts.credHash ?? 'SHA-256',
    innerHash: opts.credInnerHash,
    notBefore: now - 3600,
    notAfter: now + (opts.credNotAfterOffset ?? 3 * 86400),
    ca: opts.credCa ?? false,
    keyUsage: opts.credKeyUsage,
    extra: [
      ...(opts.omitNonce
        ? []
        : [ext('1.2.840.113635.100.8.2', false, nonceDer(opts.nonceShape, nonce))]),
      ...(opts.extraCredExtensions ?? []),
    ],
  });
  const object = cbor(
    new Map<string, CV>([
      ['fmt', opts.fmt ?? 'apple-appattest'],
      [
        'attStmt',
        new Map<string, CV>([
          [
            'x5c',
            opts.x5cMode === 'single'
              ? [credCertDer]
              : opts.x5cMode === 'triple'
                ? [credCertDer, world.intermediateDer, world.rootDer]
                : opts.x5cMode === 'swapped'
                  ? [world.intermediateDer, credCertDer]
                  : [credCertDer, world.intermediateDer],
          ],
          ['receipt', enc('receipt-bytes')],
        ]),
      ],
      ['authData', authData],
    ])
  );
  return {
    keyId: b64(keyIdBytes),
    keyIdBytes,
    point: device.point,
    priv: device.priv,
    attestationObject: b64(object),
    challenge,
    appId,
  };
}

/** An assertion as the device produces it: CBOR { signature, authenticatorData }. */
export async function makeAssertion(
  device: DeviceFixture,
  clientData: string,
  opts: {
    counter: number;
    appId?: string;
    extensions?: Map<string, CV>;
    signWith?: CryptoKey;
    tamper?: boolean;
  } = { counter: 1 }
): Promise<string> {
  const appId = opts.appId ?? device.appId;
  const c = opts.counter;
  const authData = cat(
    await sha(enc(appId)),
    Uint8Array.of(0x40),
    Uint8Array.of((c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff),
    ...(opts.extensions ? [cbor(opts.extensions)] : [])
  );
  const nonce = await sha(cat(authData, await sha(enc(clientData))));
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      opts.signWith ?? device.priv,
      nonce
    )
  );
  if (opts.tamper) raw[5] ^= 1;
  return b64(
    cbor(
      new Map<string, CV>([
        ['signature', derEcdsa(raw)],
        ['authenticatorData', authData],
      ])
    )
  );
}
