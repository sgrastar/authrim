export type TotpAlgorithm = 'SHA1' | 'SHA256';

export interface TotpProfile {
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  window: number;
}

export interface TotpVerificationResult {
  valid: boolean;
  timeStep: number | null;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_SECRET_BYTES = 20;

export const TOTP_COMPATIBLE_PROFILE: TotpProfile = {
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
  window: 1,
};

export const TOTP_STRONG_PROFILE: TotpProfile = {
  algorithm: 'SHA256',
  digits: 8,
  period: 30,
  window: 1,
};

function assertTotpProfile(profile: TotpProfile): TotpProfile {
  if (profile.algorithm !== 'SHA1' && profile.algorithm !== 'SHA256') {
    throw new Error('Unsupported TOTP algorithm');
  }
  if (!Number.isInteger(profile.digits) || (profile.digits !== 6 && profile.digits !== 8)) {
    throw new Error('Unsupported TOTP digit count');
  }
  if (!Number.isInteger(profile.period) || profile.period < 15 || profile.period > 300) {
    throw new Error('Unsupported TOTP period');
  }
  if (!Number.isInteger(profile.window) || profile.window < 0 || profile.window > 2) {
    throw new Error('Unsupported TOTP verification window');
  }
  return profile;
}

export function normalizeTotpPreset(value: unknown): 'compatible' | 'strong' {
  return value === 'strong' ? 'strong' : 'compatible';
}

export function profileForTotpPreset(value: unknown): TotpProfile {
  return normalizeTotpPreset(value) === 'strong'
    ? { ...TOTP_STRONG_PROFILE }
    : { ...TOTP_COMPATIBLE_PROFILE };
}

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function decodeBase32(value: string): Uint8Array {
  const normalized = value.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error('Invalid base32 TOTP secret');
    }
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(bytes);
}

export function generateTotpSecret(byteLength = DEFAULT_SECRET_BYTES): string {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 64) {
    throw new Error('Invalid TOTP secret byte length');
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase32(bytes);
}

function counterToBytes(counter: number): Uint8Array {
  const bytes = new Uint8Array(8);
  let value = Math.floor(counter);
  for (let i = 7; i >= 0; i -= 1) {
    bytes[i] = value & 255;
    value = Math.floor(value / 256);
  }
  return bytes;
}

async function hmacDigest(
  algorithm: TotpAlgorithm,
  secret: Uint8Array,
  counter: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: algorithm === 'SHA256' ? 'SHA-256' : 'SHA-1' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, counterToBytes(counter));
  return new Uint8Array(signature);
}

function truncateHotp(digest: Uint8Array, digits: number): string {
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, '0');
}

export function getTotpTimeStep(nowMs: number, periodSeconds: number): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error('Invalid TOTP timestamp');
  }
  if (!Number.isInteger(periodSeconds) || periodSeconds <= 0) {
    throw new Error('Invalid TOTP period');
  }
  return Math.floor(Math.floor(nowMs / 1000) / periodSeconds);
}

export async function generateTotpCode(
  secretBase32: string,
  profile: TotpProfile,
  timeStep: number
): Promise<string> {
  const normalizedProfile = assertTotpProfile(profile);
  if (!Number.isInteger(timeStep) || timeStep < 0) {
    throw new Error('Invalid TOTP time step');
  }
  const secret = decodeBase32(secretBase32);
  const digest = await hmacDigest(normalizedProfile.algorithm, secret, timeStep);
  return truncateHotp(digest, normalizedProfile.digits);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function verifyTotpCode(input: {
  code: string;
  secretBase32: string;
  profile: TotpProfile;
  nowMs?: number;
  lastUsedTimeStep?: number | null;
}): Promise<TotpVerificationResult> {
  const profile = assertTotpProfile(input.profile);
  const normalizedCode = input.code.replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${profile.digits}}$`).test(normalizedCode)) {
    return { valid: false, timeStep: null };
  }

  const currentStep = getTotpTimeStep(input.nowMs ?? Date.now(), profile.period);
  for (let offset = -profile.window; offset <= profile.window; offset += 1) {
    const timeStep = currentStep + offset;
    if (timeStep < 0 || timeStep <= (input.lastUsedTimeStep ?? -1)) {
      continue;
    }
    const expected = await generateTotpCode(input.secretBase32, profile, timeStep);
    if (timingSafeEqual(normalizedCode, expected)) {
      return { valid: true, timeStep };
    }
  }

  return { valid: false, timeStep: null };
}

export function buildOtpAuthUri(input: {
  issuer: string;
  accountName: string;
  secretBase32: string;
  profile: TotpProfile;
}): string {
  const profile = assertTotpProfile(input.profile);
  const issuer = input.issuer.trim() || 'Authrim';
  const accountName = input.accountName.trim() || 'user';
  const label = `${issuer}:${accountName}`;
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer,
    algorithm: profile.algorithm,
    digits: String(profile.digits),
    period: String(profile.period),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
