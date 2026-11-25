/**
 * `ProviderSigner` from Worker secrets (design section 7). One secret per purpose holds
 * `{"privateKeyPkcs8": "<base64>", "chain": ["<leaf>", "<intermediate>"]}`, replaced as a pair.
 * The signer checks that the key belongs to the leaf, that the chain has no extended key usage and
 * is valid now, and refuses (instead of signing) when anything is off.
 */

import type {
  KeyAttestationSigningClaims,
  ProviderSigner,
  ProviderSignResult,
  WalletAttestationSigningClaims,
} from '@authrim/ar-lib-core';
import {
  chainLimit,
  finishJws,
  keyAttestationSigningInput,
  walletAttestationSigningInput,
  type SigningInput,
} from '../domain/attestation-jwt';
import {
  equalBytes,
  fromBase64,
  fromBase64Url,
  sha256,
  toHex,
  utf8,
  type Bytes,
} from '../domain/bytes';
import {
  OID,
  parseCertificate,
  verifyCertificateSignature,
  type ParsedCertificate,
} from '../domain/x509';

interface Loaded {
  key: CryptoKey;
  chain: Bytes[];
  notAfter: number;
}

type LoadResult = { ok: true; loaded: Loaded } | { ok: false; code: string };

async function load(
  secret: string | undefined,
  pin: string | undefined,
  now: number
): Promise<LoadResult> {
  const bad = (code: string): LoadResult => ({ ok: false, code });
  if (!secret || !pin) return bad('signer_not_configured');
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    return bad('signer_secret_invalid');
  }
  const record = parsed as { privateKeyPkcs8?: unknown; chain?: unknown };
  if (typeof record.privateKeyPkcs8 !== 'string' || !Array.isArray(record.chain)) {
    return bad('signer_secret_invalid');
  }
  const pkcs8 = fromBase64(record.privateKeyPkcs8);
  const chain = record.chain.map((entry) => (typeof entry === 'string' ? fromBase64(entry) : null));
  if (!pkcs8 || chain.length !== 2 || chain.some((der) => der === null)) {
    return bad('signer_secret_invalid');
  }
  const ders = chain as Bytes[];
  let certs: ParsedCertificate[];
  try {
    certs = ders.map((der) => parseCertificate(der));
  } catch {
    return bad('signer_chain_invalid');
  }
  const [leaf, intermediate] = certs;
  if (
    leaf.isCA ||
    !intermediate.isCA ||
    certs.some((cert) => cert.hasExtendedKeyUsage || now < cert.notBefore || now > cert.notAfter) ||
    leaf.curve !== 'P-256' ||
    (leaf.hasKeyUsage && !leaf.digitalSignature)
  ) {
    return bad('signer_chain_invalid');
  }
  // The chain must end at the configured intermediate and really be signed by it (design 7).
  if (toHex(await sha256(ders[1])) !== pin.toLowerCase()) return bad('signer_chain_untrusted');
  const critical = certs.flatMap((cert) => [...cert.extensions].filter(([, e]) => e.critical));
  if (
    critical.some(([oid]) => oid !== OID.basicConstraints && oid !== OID.keyUsage) ||
    (intermediate.hasKeyUsage && !intermediate.keyCertSign) ||
    !(await verifyCertificateSignature(leaf, intermediate, [{ curve: 'P-256', hash: 'SHA-256' }]))
  ) {
    return bad('signer_chain_invalid');
  }
  try {
    const extractable = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign']
    );
    const jwk = (await crypto.subtle.exportKey('jwk', extractable)) as { x?: string; y?: string };
    const point = new Uint8Array([
      4,
      ...(fromBase64Url(jwk.x ?? '') ?? []),
      ...(fromBase64Url(jwk.y ?? '') ?? []),
    ]);
    if (!equalBytes(point, leaf.publicPoint)) return bad('signer_key_mismatch');
    const key = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    const notAfter = chainLimit(ders);
    return notAfter === null
      ? bad('signer_chain_invalid')
      : { ok: true, loaded: { key, chain: ders, notAfter } };
  } catch {
    return bad('signer_secret_invalid');
  }
}

export function createSecretSigner(input: {
  walletSecret: string | undefined;
  keySecret: string | undefined;
  /** SHA-256 hex of the intermediate each purpose must chain to (public configuration). */
  walletIntermediateSha256: string | undefined;
  keyIntermediateSha256: string | undefined;
  now: () => number;
}): ProviderSigner {
  const cache = new Map<string, Loaded>();
  async function loadCached(
    secret: string | undefined,
    pin: string | undefined,
    now: number
  ): Promise<LoadResult> {
    const id = secret && pin ? `${pin}:${secret}` : undefined;
    const cached = id ? cache.get(id) : undefined;
    if (id && cached && now <= cached.notAfter) return { ok: true, loaded: cached };
    const result = await load(secret, pin, now);
    if (id && result.ok) cache.set(id, result.loaded);
    return result;
  }

  async function sign(
    secret: string | undefined,
    pin: string | undefined,
    build: (chain: Bytes[]) => SigningInput
  ): Promise<ProviderSignResult> {
    const result = await loadCached(secret, pin, input.now());
    if (!result.ok) return { refused: true, code: result.code };
    let signing: SigningInput;
    try {
      signing = build(result.loaded.chain);
    } catch {
      return { refused: true, code: 'claims_invalid' };
    }
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        result.loaded.key,
        utf8(signing.signingInput)
      )
    );
    const jwt = finishJws(signing.signingInput, raw);
    return jwt ? { jwt } : { refused: true, code: 'jwt_too_large' };
  }

  return {
    signWalletAttestation: (claims: WalletAttestationSigningClaims) =>
      sign(input.walletSecret, input.walletIntermediateSha256, (chain) =>
        walletAttestationSigningInput(chain, claims)
      ),
    signKeyAttestation: (claims: KeyAttestationSigningClaims) =>
      sign(input.keySecret, input.keyIntermediateSha256, (chain) =>
        keyAttestationSigningInput(chain, claims)
      ),
    async health() {
      const now = input.now();
      const [wallet, key] = await Promise.all([
        loadCached(input.walletSecret, input.walletIntermediateSha256, now),
        loadCached(input.keySecret, input.keyIntermediateSha256, now),
      ]);
      return {
        chainNotAfter: {
          wallet: wallet.ok ? wallet.loaded.notAfter : 0,
          key: key.ok ? key.loaded.notAfter : 0,
        },
      };
    },
  };
}
