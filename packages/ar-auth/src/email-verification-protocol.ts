import { safeFetchJson, validateExternalUrl, type SafeFetchOptions } from '@authrim/ar-lib-core';
import { base64url, compactVerify, decodeJwt, decodeProtectedHeader, importJWK } from 'jose';
import type { JWK, JWTPayload, ProtectedHeaderParameters } from 'jose';

const ALLOWED_ALGORITHMS = new Set(['EdDSA', 'ES256', 'RS256'] as const);
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DNS_TXT_TYPE = 16;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_FETCH_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 64 * 1024;
const MAX_JWKS_KEYS = 32;
const MAX_IAT_AGE_SECONDS = 5 * 60;
const MAX_IAT_FUTURE_SECONDS = 60;

type AllowedAlgorithm = 'EdDSA' | 'ES256' | 'RS256';

export type EmailVerificationProtocolFailureReason =
  | 'invalid_presentation'
  | 'issuer_discovery_failed'
  | 'issuer_metadata_failed'
  | 'invalid_signature'
  | 'invalid_claims'
  | 'token_not_current';

export type EmailVerificationProtocolResult =
  | { verified: true; issuer: string }
  | { verified: false; reason: EmailVerificationProtocolFailureReason };

export type EmailVerificationProtocolResolveDnsTxt = (
  recordName: string
) => Promise<readonly string[]>;

export type EmailVerificationProtocolFetchJson = (
  url: string,
  options?: SafeFetchOptions
) => Promise<unknown>;

export interface VerifyEmailVerificationProtocolOptions {
  presentationToken: string;
  expectedEmail: string;
  expectedNonce: string;
  expectedAudience: string;
  nowSeconds?: number;
  resolveDnsTxt?: EmailVerificationProtocolResolveDnsTxt;
  fetchJson?: EmailVerificationProtocolFetchJson;
}

interface ParsedPresentation {
  issuerJwt: string;
  disclosures: string[];
  sdJwt: string;
  keyBindingJwt: string;
}

interface ParsedJwt {
  algorithm: AllowedAlgorithm;
  header: ProtectedHeaderParameters;
  payload: JWTPayload;
}

interface IssuerMetadata {
  jwksUrl: URL;
}

interface TemporalValidation {
  valid: boolean;
  current: boolean;
}

const failure = (
  reason: EmailVerificationProtocolFailureReason
): EmailVerificationProtocolResult => ({ verified: false, reason });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function normalizeDnsName(value: string): string {
  return value.replace(/\.$/u, '').toLowerCase();
}

function parseDomainName(value: string): string | null {
  if (
    value.length === 0 ||
    value.length > 253 ||
    value.startsWith('.') ||
    value.endsWith('.') ||
    /[\s/:?#@[\]\\]/u.test(value)
  ) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(`https://${value}/`);
  } catch {
    return null;
  }

  if (
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  const labels = hostname.split('.');
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/u.test(label) ||
        label.startsWith('-') ||
        label.endsWith('-')
    )
  ) {
    return null;
  }
  return hostname;
}

function getEmailDomain(email: string): string | null {
  if (email.length === 0 || email.length > 254 || email.trim() !== email) {
    return null;
  }

  const atIndex = email.indexOf('@');
  if (
    atIndex <= 0 ||
    atIndex !== email.lastIndexOf('@') ||
    atIndex > 64 ||
    /[\u0000-\u0020\u007f]/u.test(email)
  ) {
    return null;
  }

  return parseDomainName(email.slice(atIndex + 1));
}

function normalizeExpectedAudience(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null;
  }
  return url.origin;
}

function validateProgrammerInputs(options: VerifyEmailVerificationProtocolOptions): {
  emailDomain: string;
  audience: string;
  now: number;
} {
  const emailDomain = getEmailDomain(options.expectedEmail);
  if (!emailDomain) {
    throw new TypeError('expectedEmail must be a valid mailbox with a DNS domain');
  }

  if (
    typeof options.expectedNonce !== 'string' ||
    options.expectedNonce.length === 0 ||
    options.expectedNonce.length > 1024
  ) {
    throw new TypeError('expectedNonce must be a non-empty string');
  }

  const audience = normalizeExpectedAudience(options.expectedAudience);
  if (!audience) {
    throw new TypeError('expectedAudience must be an HTTPS origin');
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('nowSeconds must be a non-negative safe integer');
  }

  return { emailDomain, audience, now };
}

function isCompactJwt(value: string): boolean {
  const segments = value.split('.');
  return (
    segments.length === 3 &&
    segments.every((segment) => segment.length > 0 && /^[A-Za-z0-9_-]+$/u.test(segment))
  );
}

function parsePresentation(value: unknown): ParsedPresentation | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TOKEN_LENGTH ||
    /[^A-Za-z0-9._~-]/u.test(value)
  ) {
    return null;
  }

  const segments = value.split('~');
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
    return null;
  }

  const issuerJwt = segments[0];
  const keyBindingJwt = segments[segments.length - 1];
  const disclosures = segments.slice(1, -1);
  if (
    !isCompactJwt(issuerJwt) ||
    !isCompactJwt(keyBindingJwt) ||
    disclosures.some((disclosure) => !/^[A-Za-z0-9_-]+$/u.test(disclosure))
  ) {
    return null;
  }

  return {
    issuerJwt,
    disclosures,
    sdJwt: `${segments.slice(0, -1).join('~')}~`,
    keyBindingJwt,
  };
}

function parseJwt(value: string, expectedType: 'evt+jwt' | 'kb+jwt'): ParsedJwt | null {
  try {
    const header = decodeProtectedHeader(value);
    const payload = decodeJwt(value);
    if (
      header.typ !== expectedType ||
      typeof header.alg !== 'string' ||
      !ALLOWED_ALGORITHMS.has(header.alg as AllowedAlgorithm) ||
      header.crit !== undefined ||
      (header.kid !== undefined && (typeof header.kid !== 'string' || header.kid.length === 0))
    ) {
      return null;
    }
    return {
      algorithm: header.alg as AllowedAlgorithm,
      header,
      payload,
    };
  } catch {
    return null;
  }
}

function validateTemporalClaims(payload: JWTPayload, now: number): TemporalValidation {
  const issuedAt = payload.iat;
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt)) {
    return { valid: false, current: false };
  }
  if (issuedAt < now - MAX_IAT_AGE_SECONDS || issuedAt > now + MAX_IAT_FUTURE_SECONDS) {
    return { valid: true, current: false };
  }

  if (payload.exp !== undefined) {
    if (!Number.isSafeInteger(payload.exp)) {
      return { valid: false, current: false };
    }
    if (payload.exp <= now) {
      return { valid: true, current: false };
    }
    if (payload.exp < issuedAt) {
      return { valid: false, current: false };
    }
  }

  if (payload.nbf !== undefined) {
    if (!Number.isSafeInteger(payload.nbf)) {
      return { valid: false, current: false };
    }
    if (payload.nbf > now) {
      return { valid: true, current: false };
    }
  }

  return { valid: true, current: true };
}

function parseHttpsExternalUrl(value: unknown): URL | null {
  if (typeof value !== 'string') {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    validateExternalUrl(url.toString(), { requireHttps: true, allowLocalhost: false })
  ) {
    return null;
  }
  return url;
}

function isIssuerHostOrSubdomain(hostname: string, issuerHostname: string): boolean {
  return hostname === issuerHostname || hostname.endsWith(`.${issuerHostname}`);
}

function parseIssuerMetadata(value: unknown, issuerOrigin: URL): IssuerMetadata | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.issuer !== undefined && value.issuer !== issuerOrigin.origin) {
    return null;
  }

  const jwksUrl = parseHttpsExternalUrl(value.jwks_uri);
  if (!jwksUrl) {
    return null;
  }

  if (value.issuance_endpoint !== undefined) {
    const issuanceUrl = parseHttpsExternalUrl(value.issuance_endpoint);
    if (!issuanceUrl || !isIssuerHostOrSubdomain(issuanceUrl.hostname, issuerOrigin.hostname)) {
      return null;
    }
  }

  return { jwksUrl };
}

function parseJwks(value: unknown): JWK[] | null {
  if (!isRecord(value) || !Array.isArray(value.keys)) {
    return null;
  }
  if (value.keys.length === 0 || value.keys.length > MAX_JWKS_KEYS) {
    return null;
  }

  const keys: JWK[] = [];
  for (const key of value.keys) {
    if (!isRecord(key)) {
      return null;
    }
    keys.push(key as JWK);
  }
  return keys;
}

function isJwkCompatible(jwk: JWK, algorithm: AllowedAlgorithm, kid?: string): boolean {
  if (
    (kid !== undefined && jwk.kid !== kid) ||
    (jwk.alg !== undefined && jwk.alg !== algorithm) ||
    (jwk.use !== undefined && jwk.use !== 'sig') ||
    (jwk.key_ops !== undefined && !jwk.key_ops.includes('verify')) ||
    hasOwn(jwk, 'd')
  ) {
    return false;
  }

  if (algorithm === 'EdDSA') {
    return jwk.kty === 'OKP' && jwk.crv === 'Ed25519';
  }
  if (algorithm === 'ES256') {
    return jwk.kty === 'EC' && jwk.crv === 'P-256';
  }
  return jwk.kty === 'RSA';
}

async function verifyWithJwk(jwt: string, jwk: JWK, algorithm: AllowedAlgorithm): Promise<boolean> {
  try {
    const key = await importJWK(jwk, algorithm);
    await compactVerify(jwt, key, { algorithms: [algorithm] });
    return true;
  } catch {
    return false;
  }
}

async function verifyWithJwks(jwt: string, parsed: ParsedJwt, jwks: JWK[]): Promise<boolean> {
  const kid = parsed.header.kid;
  const jwksHasKeyIds = jwks.some((jwk) => typeof jwk.kid === 'string' && jwk.kid.length > 0);
  const candidates = kid && jwksHasKeyIds ? jwks.filter((jwk) => jwk.kid === kid) : jwks;
  for (const jwk of candidates) {
    if (
      isJwkCompatible(jwk, parsed.algorithm, kid && jwksHasKeyIds ? kid : undefined) &&
      (await verifyWithJwk(jwt, jwk, parsed.algorithm))
    ) {
      return true;
    }
  }
  return false;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64url.encode(new Uint8Array(digest));
}

async function resolveDisclosedClaims(
  payload: JWTPayload,
  encodedDisclosures: string[]
): Promise<Map<string, unknown> | null> {
  if (payload._sd_alg !== undefined && payload._sd_alg !== 'sha-256') {
    return null;
  }

  const signedDigests = payload._sd;
  if (signedDigests !== undefined) {
    if (
      !Array.isArray(signedDigests) ||
      signedDigests.some(
        (digest) => typeof digest !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(digest)
      ) ||
      new Set(signedDigests).size !== signedDigests.length
    ) {
      return null;
    }
  }

  if (encodedDisclosures.length > 0 && !signedDigests) {
    return null;
  }

  const allowedDigests = new Set(signedDigests ?? []);
  const usedDigests = new Set<string>();
  const claims = new Map<string, unknown>();

  for (const encoded of encodedDisclosures) {
    let disclosure: unknown;
    try {
      const bytes = base64url.decode(encoded);
      disclosure = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
      );
    } catch {
      return null;
    }

    if (
      !Array.isArray(disclosure) ||
      disclosure.length !== 3 ||
      typeof disclosure[0] !== 'string' ||
      disclosure[0].length === 0 ||
      typeof disclosure[1] !== 'string' ||
      disclosure[1].length === 0 ||
      disclosure[1] === '_sd' ||
      disclosure[1] === '...'
    ) {
      return null;
    }

    const digest = await sha256Base64Url(encoded);
    const claimName = disclosure[1];
    if (
      !allowedDigests.has(digest) ||
      usedDigests.has(digest) ||
      claims.has(claimName) ||
      hasOwn(payload, claimName)
    ) {
      return null;
    }
    usedDigests.add(digest);
    claims.set(claimName, disclosure[2]);
  }

  return claims;
}

function getClaim(
  payload: JWTPayload,
  disclosedClaims: Map<string, unknown>,
  name: string
): unknown {
  return disclosedClaims.has(name) ? disclosedClaims.get(name) : payload[name];
}

function emailsMatch(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftCode = left.charCodeAt(index);
    const rightCode = right.charCodeAt(index);
    const foldedLeft = leftCode >= 65 && leftCode <= 90 ? leftCode + 32 : leftCode;
    const foldedRight = rightCode >= 65 && rightCode <= 90 ? rightCode + 32 : rightCode;
    if (foldedLeft !== foldedRight) {
      return false;
    }
  }
  return true;
}

function parseDnsTxtPresentation(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  let index = 0;
  let result = '';
  let chunks = 0;
  while (index < value.length) {
    while (index < value.length && /\s/u.test(value[index])) {
      index += 1;
    }
    if (index >= value.length) {
      break;
    }
    if (value[index] !== '"') {
      return null;
    }
    index += 1;
    chunks += 1;

    let closed = false;
    while (index < value.length) {
      const character = value[index];
      index += 1;
      if (character === '"') {
        closed = true;
        break;
      }
      if (character !== '\\') {
        result += character;
        continue;
      }
      if (index >= value.length) {
        return null;
      }

      const decimalEscape = value.slice(index, index + 3);
      if (/^\d{3}$/u.test(decimalEscape)) {
        const code = Number.parseInt(decimalEscape, 10);
        if (code > 255) {
          return null;
        }
        result += String.fromCharCode(code);
        index += 3;
      } else {
        result += value[index];
        index += 1;
      }
    }

    if (!closed) {
      return null;
    }
  }

  return chunks > 0 ? result : null;
}

async function queryDnsTxtRecords(
  recordName: string,
  fetchJson: EmailVerificationProtocolFetchJson
): Promise<string[]> {
  const url = new URL(DOH_ENDPOINT);
  url.searchParams.set('name', recordName);
  url.searchParams.set('type', 'TXT');
  url.searchParams.set('do', 'true');

  const response = await fetchJson(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/dns-json' },
    redirect: 'error',
    requireHttps: true,
    allowLocalhost: false,
    timeoutMs: FETCH_TIMEOUT_MS,
    maxResponseSize: MAX_FETCH_BYTES,
  });

  if (
    !isRecord(response) ||
    response.Status !== 0 ||
    response.TC !== false ||
    !Array.isArray(response.Question) ||
    response.Question.length !== 1
  ) {
    throw new Error('Invalid DNS response');
  }

  const question = response.Question[0];
  if (
    !isRecord(question) ||
    question.type !== DNS_TXT_TYPE ||
    typeof question.name !== 'string' ||
    normalizeDnsName(question.name) !== normalizeDnsName(recordName)
  ) {
    throw new Error('Invalid DNS question');
  }

  if (response.Answer === undefined) {
    return [];
  }
  if (!Array.isArray(response.Answer)) {
    throw new Error('Invalid DNS answer');
  }

  const records: string[] = [];
  for (const answer of response.Answer) {
    if (
      !isRecord(answer) ||
      typeof answer.name !== 'string' ||
      typeof answer.type !== 'number' ||
      typeof answer.data !== 'string'
    ) {
      throw new Error('Invalid DNS resource record');
    }
    if (
      answer.type !== DNS_TXT_TYPE ||
      normalizeDnsName(answer.name) !== normalizeDnsName(recordName)
    ) {
      continue;
    }

    const parsed = parseDnsTxtPresentation(answer.data);
    if (parsed === null) {
      throw new Error('Invalid DNS TXT presentation');
    }
    records.push(parsed);
  }
  return records;
}

function parseIssuerRecord(records: readonly string[]): URL | null {
  if (records.length !== 1 || typeof records[0] !== 'string') {
    return null;
  }
  const record = records[0];
  if (!record.startsWith('iss=')) {
    return null;
  }

  const hostname = parseDomainName(record.slice('iss='.length));
  if (!hostname) {
    return null;
  }
  return new URL(`https://${hostname}`);
}

const fetchOptions: SafeFetchOptions = {
  method: 'GET',
  headers: { Accept: 'application/json' },
  redirect: 'error',
  requireHttps: true,
  allowLocalhost: false,
  timeoutMs: FETCH_TIMEOUT_MS,
  maxResponseSize: MAX_FETCH_BYTES,
};

async function verifyInternal(
  options: VerifyEmailVerificationProtocolOptions,
  emailDomain: string,
  audience: string,
  now: number
): Promise<EmailVerificationProtocolResult> {
  const presentation = parsePresentation(options.presentationToken);
  if (!presentation) {
    return failure('invalid_presentation');
  }

  const issuerToken = parseJwt(presentation.issuerJwt, 'evt+jwt');
  const keyBindingToken = parseJwt(presentation.keyBindingJwt, 'kb+jwt');
  if (!issuerToken || !keyBindingToken) {
    return failure('invalid_presentation');
  }

  const fetchJson: EmailVerificationProtocolFetchJson = options.fetchJson ?? safeFetchJson;
  let records: readonly string[];
  try {
    records = options.resolveDnsTxt
      ? await options.resolveDnsTxt(`_email-verification.${emailDomain}`)
      : await queryDnsTxtRecords(`_email-verification.${emailDomain}`, fetchJson);
  } catch {
    return failure('issuer_discovery_failed');
  }

  const issuerOrigin = parseIssuerRecord(records);
  if (!issuerOrigin) {
    return failure('issuer_discovery_failed');
  }
  if (issuerToken.payload.iss !== issuerOrigin.origin) {
    return failure('invalid_claims');
  }

  const metadataUrl = new URL('/.well-known/email-verification', issuerOrigin);
  let metadata: IssuerMetadata;
  try {
    const metadataDocument = await fetchJson(metadataUrl.toString(), fetchOptions);
    const parsedMetadata = parseIssuerMetadata(metadataDocument, issuerOrigin);
    if (!parsedMetadata) {
      return failure('issuer_metadata_failed');
    }
    metadata = parsedMetadata;
  } catch {
    return failure('issuer_metadata_failed');
  }

  let jwks: JWK[];
  try {
    const jwksDocument = await fetchJson(metadata.jwksUrl.toString(), fetchOptions);
    const parsedJwks = parseJwks(jwksDocument);
    if (!parsedJwks) {
      return failure('issuer_metadata_failed');
    }
    jwks = parsedJwks;
  } catch {
    return failure('issuer_metadata_failed');
  }

  if (!(await verifyWithJwks(presentation.issuerJwt, issuerToken, jwks))) {
    return failure('invalid_signature');
  }

  const issuerTime = validateTemporalClaims(issuerToken.payload, now);
  if (!issuerTime.valid) {
    return failure('invalid_claims');
  }
  if (!issuerTime.current) {
    return failure('token_not_current');
  }

  const disclosedClaims = await resolveDisclosedClaims(
    issuerToken.payload,
    presentation.disclosures
  );
  if (!disclosedClaims) {
    return failure('invalid_presentation');
  }

  const email = getClaim(issuerToken.payload, disclosedClaims, 'email');
  const emailVerified = getClaim(issuerToken.payload, disclosedClaims, 'email_verified');
  if (
    typeof email !== 'string' ||
    !emailsMatch(email, options.expectedEmail) ||
    emailVerified !== true
  ) {
    return failure('invalid_claims');
  }

  const confirmation = issuerToken.payload.cnf;
  if (!isRecord(confirmation) || !isRecord(confirmation.jwk)) {
    return failure('invalid_claims');
  }
  const holderJwk = confirmation.jwk as JWK;
  if (
    !isJwkCompatible(holderJwk, keyBindingToken.algorithm) ||
    !(await verifyWithJwk(presentation.keyBindingJwt, holderJwk, keyBindingToken.algorithm))
  ) {
    return failure('invalid_signature');
  }

  const keyBindingTime = validateTemporalClaims(keyBindingToken.payload, now);
  if (!keyBindingTime.valid) {
    return failure('invalid_claims');
  }
  if (!keyBindingTime.current) {
    return failure('token_not_current');
  }

  const expectedSdHash = await sha256Base64Url(presentation.sdJwt);
  if (
    keyBindingToken.payload.aud !== audience ||
    keyBindingToken.payload.nonce !== options.expectedNonce ||
    keyBindingToken.payload.sd_hash !== expectedSdHash
  ) {
    return failure('invalid_claims');
  }

  return { verified: true, issuer: issuerOrigin.origin };
}

/**
 * Verify an Email Verification Protocol SD-JWT+KB presentation.
 *
 * Invalid presentations and provider/network failures are deliberately returned as coarse
 * failure reasons so callers can silently continue with their normal email OTP fallback.
 */
export async function verifyEmailVerificationProtocol(
  options: VerifyEmailVerificationProtocolOptions
): Promise<EmailVerificationProtocolResult> {
  const { emailDomain, audience, now } = validateProgrammerInputs(options);
  try {
    return await verifyInternal(options, emailDomain, audience, now);
  } catch {
    return failure('invalid_presentation');
  }
}
