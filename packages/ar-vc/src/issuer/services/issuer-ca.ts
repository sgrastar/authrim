/**
 * The Authrim issuing CA, as used by the credential issuer (design D-B of
 * `20261122-authrim-admin-vc-haip-issuance-and-login.md`).
 *
 * HAIP 1.0 asks for the issuer certificate and its chain in the `x5c` header of every SD-JWT VC
 * and Token Status List. This module gives the VC signing key of a tenant a leaf certificate,
 * issued by the Authrim issuing CA for the tenant's issuer host, and registers it with the
 * tenant's KeyManager (which validates it again against the same profile before using it).
 *
 * It is off unless the CA is configured, and it never fails an issuance: when no certificate can
 * be had the credential is signed without `x5c`, exactly as before.
 */

import type { JWK } from 'jose';
import {
  base64ToBytes,
  buildCertificate,
  bytesToBase64,
  createLogger,
  isCertificateHostName,
  parseCertificate,
  verifyCertificateSignature,
  type ParsedCertificate,
} from '@authrim/ar-lib-core';

const log = createLogger().module('VC-ISSUER-CA');

const DAY_MS = 86_400_000;
/** A leaf lives this long unless the issuing CA ends sooner. */
const DEFAULT_LEAF_LIFETIME_DAYS = 400;
/** Certificates are renewed this long before they end, or a third of their life if that is less. */
const RENEW_BEFORE_MAX_MS = 30 * DAY_MS;
/** After a failure the same key and host are not retried for this long. */
const FAILURE_BACKOFF_MS = 60_000;
/** The issuing CA must outlive a new leaf by at least this much. */
const MIN_LEAF_LIFETIME_MS = 7 * DAY_MS;
/** A renewal that would not extend the chain by at least this much is pointless. */
const MIN_USEFUL_EXTENSION_MS = DAY_MS;
const MAX_REMEMBERED_FAILURES = 500;

export interface IssuerCaEnv {
  /** PKCS#8 PEM of the issuing CA's ECDSA P-256 private key (a Worker secret). */
  VC_ISSUING_CA_PRIVATE_KEY_PEM?: string;
  /** Base64 DER of the issuing CA certificate. */
  VC_ISSUING_CA_CERTIFICATE?: string;
  /** Comma-separated SHA-256 fingerprints of the issuing CA certificates Authrim trusts. */
  VC_X5C_ISSUING_CA_SHA256?: string;
  /** Leaf lifetime in days, default 400. */
  VC_X5C_LEAF_LIFETIME_DAYS?: string;
  /**
   * Optional comma-separated issuer hosts that may receive a certificate: exact names, or
   * `*.example.com` for any host below a domain. When set, no other host gets one. When unset,
   * every host that reaches this Worker (which the operator routes) does.
   */
  VC_X5C_ALLOWED_ISSUER_HOSTS?: string;
}

/** The two KeyManager RPCs this module needs. */
export interface VcCertificateKeyManager {
  getVcSigningCertificateStateRpc(): Promise<{
    kid: string;
    publicJWK: JWK;
    issuerHost: string | null;
    caSha256: string | null;
    chainNotAfter: number | null;
  }>;
  setVcIssuerKeyCertificateChainRpc(input: {
    kid: string;
    chain: string[];
    issuerHost: string;
  }): Promise<unknown>;
}

export type EnsureCertificateResult = 'disabled' | 'current' | 'issued' | 'failed';

interface LoadedCa {
  signingKey: CryptoKey;
  certificate: ParsedCertificate;
  certificateBase64: string;
  sha256: string;
  publicJwk: JWK;
}

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/u, '')
    .replace(/-----END PRIVATE KEY-----/u, '')
    .replace(/\s+/gu, '');
  return base64ToBytes(body);
}

/** The host of a credential issuer identifier: an https URL or `did:web:<host>`. */
function issuerHost(issuer: string): string | null {
  if (issuer.startsWith('did:web:')) return issuer.slice('did:web:'.length).toLowerCase();
  try {
    const url = new URL(issuer);
    return url.protocol === 'https:' ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

type CaLoad = { ca: LoadedCa } | { error: string } | null;

/** The last CA read, valid only for the very same settings (compared in full, not by size). */
let loaded: {
  pem: string;
  certificate: string;
  trusted: string;
  at: number;
  result: CaLoad;
} | null = null;
const CA_CACHE_MS = 5 * 60_000;
const CA_ERROR_CACHE_MS = 60_000;

/** Reads and checks the configured issuing CA. null: not configured. */
async function loadIssuingCa(env: IssuerCaEnv, now: number): Promise<CaLoad> {
  const pem = env.VC_ISSUING_CA_PRIVATE_KEY_PEM?.trim();
  const certificate = env.VC_ISSUING_CA_CERTIFICATE?.trim();
  const trusted = env.VC_X5C_ISSUING_CA_SHA256?.trim();
  if (!pem || !certificate || !trusted) return null;

  if (
    loaded &&
    loaded.pem === pem &&
    loaded.certificate === certificate &&
    loaded.trusted === trusted &&
    now - loaded.at < ('error' in (loaded.result ?? {}) ? CA_ERROR_CACHE_MS : CA_CACHE_MS)
  ) {
    return loaded.result;
  }
  const result = await checkIssuingCa(pem, certificate, trusted, now);
  loaded = { pem, certificate, trusted, at: now, result };
  return result;
}

async function checkIssuingCa(
  pem: string,
  certificateBase64: string,
  trustedList: string,
  now: number
): Promise<CaLoad> {
  try {
    const der = base64ToBytes(certificateBase64.replace(/\s+/gu, ''));
    const certificate = parseCertificate(der);
    if (!certificate.isCA || !certificate.keyCertSign) return { error: 'issuing_ca_not_a_ca' };
    if (certificate.pathLength !== 0) return { error: 'issuing_ca_path_length' };
    if (now < certificate.notBefore.getTime() || now > certificate.notAfter.getTime()) {
      return { error: 'issuing_ca_not_valid_now' };
    }
    const sha256 = await sha256Hex(der);
    const trusted = trustedList.split(',').map((entry) => entry.trim().toLowerCase());
    if (!trusted.includes(sha256)) return { error: 'issuing_ca_not_trusted' };

    const signingKey = await crypto.subtle.importKey(
      'pkcs8',
      pemToDer(pem),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    // The private key must be the one the certificate certifies: sign, then verify with the
    // certificate. Anything else would issue leaves the CA certificate cannot verify.
    const probe = crypto.getRandomValues(new Uint8Array(32));
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, probe)
    );
    const verifyKey = await crypto.subtle.importKey(
      'raw',
      certificate.publicPoint,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    if (
      !(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, signature, probe))
    ) {
      return { error: 'issuing_ca_key_mismatch' };
    }
    const point = certificate.publicPoint;
    return {
      ca: {
        signingKey,
        certificate,
        certificateBase64: bytesToBase64(der),
        sha256,
        publicJwk: {
          kty: 'EC',
          crv: 'P-256',
          x: base64Url(point.slice(1, 33)),
          y: base64Url(point.slice(33, 65)),
        },
      },
    };
  } catch {
    return { error: 'issuing_ca_unreadable' };
  }
}

const failedUntil = new Map<string, number>();

/** Test hook: forget everything this module remembered. */
export function resetIssuerCaState(): void {
  loaded = null;
  failedUntil.clear();
}

function rememberFailure(key: string, now: number): void {
  if (failedUntil.size >= MAX_REMEMBERED_FAILURES) {
    for (const [entry, until] of failedUntil) if (until <= now) failedUntil.delete(entry);
    if (failedUntil.size >= MAX_REMEMBERED_FAILURES) failedUntil.clear();
  }
  failedUntil.set(key, now + FAILURE_BACKOFF_MS);
}

/** Whether `host` may receive a certificate under the optional allowlist. */
function hostAllowed(host: string, list: string | undefined): boolean {
  const entries = (list ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return true;
  return entries.some((entry) =>
    entry.startsWith('*.')
      ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1
      : host === entry
  );
}

/**
 * Makes sure the tenant's active VC signing key has a certificate chain for `issuerUrl`'s host,
 * issuing one when it has none, it is for another host or CA, it is about to end, or it would end
 * before the credential about to be signed (`requiredUntil`, epoch ms). Never throws: the result
 * says what happened and the caller signs either way. KeyManager is asked every time, so a key
 * that was rotated or a chain that was replaced is seen at once; nothing is shared between
 * requests except the checked CA and a short back-off after a failure for the same key and host.
 *
 * @param cacheKey identifies the tenant for the back-off
 */
export async function ensureVcSigningCertificate(
  env: IssuerCaEnv,
  keyManager: VcCertificateKeyManager,
  issuerUrl: string,
  cacheKey: string,
  now: number = Date.now(),
  requiredUntil?: number
): Promise<EnsureCertificateResult> {
  let backoffKey = `${cacheKey}|`;
  const fail = (reason: string): EnsureCertificateResult => {
    rememberFailure(backoffKey, now);
    log.warn('No issuer certificate for the VC signing key', { reason });
    return 'failed';
  };
  try {
    const loadedCa = await loadIssuingCa(env, now);
    if (loadedCa === null) return 'disabled';
    const host = issuerHost(issuerUrl);
    backoffKey = `${cacheKey}|${host ?? ''}`;
    const waiting = failedUntil.get(backoffKey);
    if (waiting !== undefined && now < waiting) return 'failed';
    if ('error' in loadedCa) return fail(loadedCa.error);
    const { ca } = loadedCa;

    // The leaf repeats the host as its commonName, which X.520 limits to 64 characters.
    if (!host || !isCertificateHostName(host) || host.length > 64)
      return fail('invalid_issuer_host');
    if (!hostAllowed(host, env.VC_X5C_ALLOWED_ISSUER_HOSTS)) return fail('issuer_host_not_allowed');

    const state = await keyManager.getVcSigningCertificateStateRpc();
    backoffKey = `${cacheKey}|${host}|${state.kid}`;
    const keyWaiting = failedUntil.get(backoffKey);
    if (keyWaiting !== undefined && now < keyWaiting) return 'failed';

    const configuredDays = Number(env.VC_X5C_LEAF_LIFETIME_DAYS);
    const lifetimeMs =
      (Number.isFinite(configuredDays) && configuredDays >= 8 && configuredDays <= 825
        ? configuredDays
        : DEFAULT_LEAF_LIFETIME_DAYS) * DAY_MS;
    const renewBefore = Math.min(RENEW_BEFORE_MAX_MS, lifetimeMs / 3);
    // The longest chain a new leaf could give: never past the issuing CA.
    const bestNotAfter = Math.min(now + lifetimeMs, ca.certificate.notAfter.getTime() - DAY_MS);

    const have = state.chainNotAfter;
    const live = have !== null && have > now && state.caSha256 === ca.sha256;
    // A key's certificate is for the first host it signed for. Another host (a second name of the
    // same tenant) must not replace it on every alternate request; that host is signed without
    // `x5c` until the key's certificate ends or the CA changes.
    if (live && state.issuerHost !== host) return 'current';
    const sameChain = live && state.issuerHost === host;
    if (sameChain && have !== null) {
      const covers = requiredUntil === undefined || have >= requiredUntil;
      if (!covers) {
        // The credential outlives the leaf: a new leaf helps only if it reaches that far.
        if (requiredUntil === undefined || bestNotAfter < requiredUntil || bestNotAfter <= have) {
          return 'current';
        }
      } else if (have - now > renewBefore) {
        return 'current';
      } else if (bestNotAfter <= have + MIN_USEFUL_EXTENSION_MS) {
        // Due for renewal but the issuing CA is what is short: a new leaf runs no longer.
        return 'current';
      }
    }
    if (bestNotAfter - now < MIN_LEAF_LIFETIME_MS) return fail('issuing_ca_expiring');

    const leaf = await buildCertificate(
      {
        subject: { commonName: host },
        issuerNameDer: ca.certificate.subjectName,
        subjectPublicKey: state.publicJWK,
        issuerPublicKey: ca.publicJwk,
        notBefore: new Date(now - 5 * 60_000),
        notAfter: new Date(bestNotAfter),
        dnsNames: [host],
        isCA: false,
      },
      async (tbs) =>
        new Uint8Array(
          await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ca.signingKey, tbs)
        )
    );
    // A leaf the CA certificate cannot verify must never be registered.
    if (!(await verifyCertificateSignature(parseCertificate(leaf), ca.certificate.publicPoint))) {
      return fail('issued_leaf_does_not_verify');
    }

    await keyManager.setVcIssuerKeyCertificateChainRpc({
      kid: state.kid,
      chain: [bytesToBase64(leaf), ca.certificateBase64],
      issuerHost: host,
    });
    failedUntil.delete(backoffKey);
    log.info('Issued the issuer certificate of the VC signing key', {
      kid: state.kid,
      host,
      validDays: Math.floor((bestNotAfter - now) / DAY_MS),
    });
    return 'issued';
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'unknown');
  }
}
