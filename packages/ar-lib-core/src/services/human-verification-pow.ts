/**
 * The lite Login UI's human verification: a proof of work in the ALTCHA v1 format.
 *
 * Issuing: the server picks a secret number in [0, maxnumber], and signs
 * `challenge = SHA-256(salt + number)` with HMAC-SHA-256 under the current key. The browser finds
 * the number by trying every value (ALTCHA's widget, or the lite UI's own solver) and sends back
 * base64(JSON {algorithm, challenge, number, salt, signature}).
 *
 * The salt carries what the proof is for, and nothing else:
 *   `<24 hex>?expires=<unix s>&action=<login|signup|reauth>&tenant=<32 hex>&rev=<policy revision>&kid=<key>&`
 * - The trailing `&` fixes where the salt ends and the number begins (as altcha-lib v1 does), so
 *   digits cannot move between them.
 * - A salt is accepted only when it is exactly the canonical string rebuilt from its parsed
 *   parts: a reordered, repeated, extra, missing or differently encoded parameter is refused in
 *   one comparison.
 * - `tenant` is a SHA-256 prefix of the tenant ID, `rev` the tenant's lite policy revision when
 *   the proof was issued (a proof from before a policy change is refused), `kid` the key that
 *   signed it (an unknown key is refused).
 *
 * Verifying never trusts the payload's own claims: the action, tenant, revision and the largest
 * number come from the server; the expiry is required and bounded; inputs have length limits; the
 * signature is compared in constant time. A verified proof is identified by its salt (one salt
 * has one signed answer), so the caller records it as used until it expires.
 */

import type { HumanVerificationFlow } from './human-verification-policy';

export const POW_ALGORITHM = 'SHA-256';
/** Provisional until measured on low-end devices (plan: PR8). */
export const POW_DEFAULT_MAX_NUMBER = 25_000;
export const POW_DEFAULT_TTL_SECONDS = 600;
export const POW_MAX_NUMBER_LIMIT = 10_000_000;
export const POW_MAX_TTL_SECONDS = 3600;
/** Clock difference tolerated between the issuing and the verifying Worker. */
const CLOCK_SKEW_SECONDS = 30;
const MAX_PAYLOAD_LENGTH = 2048;
const MAX_SALT_LENGTH = 256;
const KEY_BYTES = 32;
const MAX_KEYS = 8;
const KID = /^[1-9][0-9]{0,8}$/u;
const HEX24 = /^[0-9a-f]{24}$/u;
const HEX32 = /^[0-9a-f]{32}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const REVISION = /^[A-Za-z0-9-]{1,64}$/u;
const ACTIONS: ReadonlySet<string> = new Set(['login', 'signup', 'reauth']);

export interface PowChallenge {
  algorithm: typeof POW_ALGORITHM;
  challenge: string;
  maxnumber: number;
  salt: string;
  signature: string;
}

export interface PowKeyring {
  currentKid: string;
  keys: ReadonlyMap<string, Uint8Array>;
}

/** What a proof is for; always decided by the server. */
export interface PowBinding {
  tenantId: string;
  action: HumanVerificationFlow;
  policyRevision: string;
}

export type PowRefusal =
  | 'malformed'
  | 'algorithm'
  | 'salt'
  | 'expired'
  | 'binding'
  | 'unknown_key'
  | 'number'
  | 'challenge'
  | 'signature';

export type PowVerification =
  | { ok: true; usedId: string; expiresAt: number }
  | { ok: false; reason: PowRefusal };

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function hmacHex(key: Uint8Array, value: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return toHex(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Parses `HUMAN_VERIFICATION_POW_HMAC_KEYRING`: `{"current": <kid>, "keys": {"<kid>": "<base64url
 * of exactly 32 bytes>", ...}}`. Throws `pow_keyring_invalid`. Rotate in two deploys: add the new
 * key, then make it current; keep the old one for at least the challenge TTL after that.
 */
export function parsePowKeyring(value: string): PowKeyring {
  const invalid = () => new Error('pow_keyring_invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'current' && key !== 'keys')) throw invalid();
  const current = record.current;
  const currentKid = typeof current === 'number' ? String(current) : current;
  const entries =
    record.keys && typeof record.keys === 'object' && !Array.isArray(record.keys)
      ? Object.entries(record.keys as Record<string, unknown>)
      : [];
  if (typeof currentKid !== 'string' || entries.length < 1 || entries.length > MAX_KEYS) {
    throw invalid();
  }
  const keys = new Map<string, Uint8Array>();
  for (const [kid, secret] of entries) {
    const bytes = typeof secret === 'string' ? decodeBase64Url(secret) : null;
    if (!KID.test(kid) || !bytes || bytes.byteLength !== KEY_BYTES) throw invalid();
    keys.set(kid, bytes);
  }
  if (!keys.has(currentKid)) throw invalid();
  return { currentKid, keys };
}

/** The keyring from the environment, or null when the secret is not configured. */
export function loadPowKeyringFromEnv(env: {
  HUMAN_VERIFICATION_POW_HMAC_KEYRING?: string;
}): PowKeyring | null {
  const value = env.HUMAN_VERIFICATION_POW_HMAC_KEYRING;
  return typeof value === 'string' && value.trim() !== '' ? parsePowKeyring(value) : null;
}

async function tenantTag(tenantId: string): Promise<string> {
  return (await sha256Hex(`authrim-pow-tenant:${tenantId}`)).slice(0, 32);
}

interface SaltParts {
  random: string;
  expires: number;
  action: string;
  tenant: string;
  rev: string;
  kid: string;
}

function buildSalt(parts: SaltParts): string {
  return `${parts.random}?expires=${parts.expires}&action=${parts.action}&tenant=${parts.tenant}&rev=${parts.rev}&kid=${parts.kid}&`;
}

/** Parses a salt into its parts, or null when it is not exactly in the canonical form. */
function parseSalt(salt: string): SaltParts | null {
  if (salt.length > MAX_SALT_LENGTH || !salt.endsWith('&')) return null;
  const question = salt.indexOf('?');
  if (question < 0) return null;
  const random = salt.slice(0, question);
  const pairs = salt.slice(question + 1, -1).split('&');
  const values = new Map<string, string>();
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    if (equals <= 0) return null;
    const name = pair.slice(0, equals);
    if (values.has(name)) return null;
    values.set(name, pair.slice(equals + 1));
  }
  const expiresText = values.get('expires') ?? '';
  if (!/^[1-9][0-9]{0,11}$/u.test(expiresText)) return null;
  const parts: SaltParts = {
    random,
    expires: Number(expiresText),
    action: values.get('action') ?? '',
    tenant: values.get('tenant') ?? '',
    rev: values.get('rev') ?? '',
    kid: values.get('kid') ?? '',
  };
  if (
    !HEX24.test(parts.random) ||
    !ACTIONS.has(parts.action) ||
    !HEX32.test(parts.tenant) ||
    !REVISION.test(parts.rev) ||
    !KID.test(parts.kid) ||
    values.size !== 5 ||
    buildSalt(parts) !== salt
  ) {
    return null;
  }
  return parts;
}

function boundedMaxNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > POW_MAX_NUMBER_LIMIT) {
    throw new Error('pow_max_number_invalid');
  }
  return value;
}

function boundedTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 30 || value > POW_MAX_TTL_SECONDS) {
    throw new Error('pow_ttl_invalid');
  }
  return value;
}

/** Issues a challenge bound to `binding`. */
export async function createPowChallenge(
  keyring: PowKeyring,
  binding: PowBinding,
  options: { maxNumber: number; ttlSeconds: number; nowSeconds?: number }
): Promise<PowChallenge> {
  const maxNumber = boundedMaxNumber(options.maxNumber);
  const ttl = boundedTtl(options.ttlSeconds);
  if (!ACTIONS.has(binding.action) || !REVISION.test(binding.policyRevision)) {
    throw new Error('pow_binding_invalid');
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const random = toHex(crypto.getRandomValues(new Uint8Array(12)));
  const salt = buildSalt({
    random,
    expires: now + ttl,
    action: binding.action,
    tenant: await tenantTag(binding.tenantId),
    rev: binding.policyRevision,
    kid: keyring.currentKid,
  });
  // A uniform secret number in [0, maxNumber] (rejection sampling avoids a modulo bias).
  const range = maxNumber + 1;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  let draw: number;
  do {
    draw = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (draw >= limit);
  const number = draw % range;
  const challenge = await sha256Hex(`${salt}${number}`);
  const key = keyring.keys.get(keyring.currentKid);
  if (!key) throw new Error('pow_keyring_invalid');
  return {
    algorithm: POW_ALGORITHM,
    challenge,
    maxnumber: maxNumber,
    salt,
    signature: await hmacHex(key, challenge),
  };
}

function decodePayload(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > MAX_PAYLOAD_LENGTH) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(payload)) return null;
  try {
    const parsed = JSON.parse(atob(payload)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const SOLUTION_KEYS = ['algorithm', 'challenge', 'number', 'salt', 'signature'];

/**
 * Verifies a solution (base64 of the ALTCHA v1 JSON) for `expected`. Does not record its use: on
 * `ok`, the caller claims `usedId` until `expiresAt` (epoch seconds), and refuses a second claim.
 */
export async function verifyPowSolution(
  keyring: PowKeyring,
  payload: unknown,
  expected: PowBinding & { maxNumber: number; nowSeconds?: number }
): Promise<PowVerification> {
  const solution = decodePayload(payload);
  if (!solution) return { ok: false, reason: 'malformed' };
  const keys = Object.keys(solution);
  if (keys.length !== SOLUTION_KEYS.length || !SOLUTION_KEYS.every((key) => keys.includes(key))) {
    return { ok: false, reason: 'malformed' };
  }
  const { algorithm, challenge, number, salt, signature } = solution;
  if (algorithm !== POW_ALGORITHM) return { ok: false, reason: 'algorithm' };
  if (typeof salt !== 'string' || typeof challenge !== 'string' || typeof signature !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  if (!HEX64.test(challenge) || !HEX64.test(signature)) return { ok: false, reason: 'malformed' };
  const parts = parseSalt(salt);
  if (!parts) return { ok: false, reason: 'salt' };

  const now = expected.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (parts.expires <= now || parts.expires > now + POW_MAX_TTL_SECONDS + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'expired' };
  }
  if (
    parts.action !== expected.action ||
    parts.rev !== expected.policyRevision ||
    parts.tenant !== (await tenantTag(expected.tenantId))
  ) {
    return { ok: false, reason: 'binding' };
  }
  const key = keyring.keys.get(parts.kid);
  if (!key) return { ok: false, reason: 'unknown_key' };
  const maxNumber = boundedMaxNumber(expected.maxNumber);
  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number < 0 ||
    number > maxNumber
  ) {
    return { ok: false, reason: 'number' };
  }
  if (!constantTimeEqual(await sha256Hex(`${salt}${number}`), challenge)) {
    return { ok: false, reason: 'challenge' };
  }
  if (!constantTimeEqual(await hmacHex(key, challenge), signature)) {
    return { ok: false, reason: 'signature' };
  }
  return { ok: true, usedId: `pow:${await sha256Hex(salt)}`, expiresAt: parts.expires };
}
