const INVITATION_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const INVITATION_CODE_LENGTH = 16;
const MAX_IP_RANGE_INPUT_LENGTH = 128;

export const MAX_ADMIN_INVITATION_IP_RANGES = 5;

export type AdminInvitationIpRangeValidation =
  | { valid: true; normalized: string; version: 4 | 6 }
  | { valid: false; error: string };

type ParsedIp = { version: 4 | 6; value: bigint; bits: 32 | 128 };

export function generateAdminInvitationCode(): string {
  const random = crypto.getRandomValues(new Uint8Array(INVITATION_CODE_LENGTH));
  const characters = Array.from(
    random,
    (value) => INVITATION_CODE_ALPHABET[value % INVITATION_CODE_ALPHABET.length]
  );
  return characters.join('').replace(/(.{4})(?=.)/g, '$1-');
}

export function normalizeAdminInvitationCode(value: string): string {
  return value.toUpperCase().replace(/[\s-]+/g, '');
}

export async function hashAdminInvitationCode(value: string): Promise<string> {
  const normalized = normalizeAdminInvitationCode(value);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isAdminInvitationCodeFormatValid(value: string): boolean {
  const normalized = normalizeAdminInvitationCode(value);
  return (
    normalized.length === INVITATION_CODE_LENGTH &&
    Array.from(normalized).every((character) => INVITATION_CODE_ALPHABET.includes(character))
  );
}

export function validateAdminInvitationIpRange(rawRange: string): AdminInvitationIpRangeValidation {
  const normalized = rawRange.trim().replace(/\s+/g, '');
  if (!normalized) {
    return { valid: false, error: 'IP range must not be empty' };
  }

  const rangeParts = normalized.split('-');
  if (rangeParts.length === 2) {
    const start = parseIp(rangeParts[0]);
    const end = parseIp(rangeParts[1]);
    if (!start || !end || start.version !== end.version) {
      return { valid: false, error: 'IP range endpoints must be valid addresses of the same type' };
    }
    if (start.value > end.value) {
      return { valid: false, error: 'IP range start must not be greater than its end' };
    }
    return { valid: true, normalized, version: start.version };
  }
  if (rangeParts.length > 2) {
    return { valid: false, error: 'Invalid IP range' };
  }

  const cidrParts = normalized.split('/');
  if (cidrParts.length === 2) {
    const address = parseIp(cidrParts[0]);
    if (!address || !/^\d+$/.test(cidrParts[1])) {
      return { valid: false, error: 'Invalid CIDR range' };
    }
    const prefix = Number(cidrParts[1]);
    if (prefix < 0 || prefix > address.bits) {
      return { valid: false, error: `CIDR prefix must be between 0 and ${address.bits}` };
    }
    return { valid: true, normalized, version: address.version };
  }
  if (cidrParts.length > 2) {
    return { valid: false, error: 'Invalid CIDR range' };
  }

  const address = parseIp(normalized);
  if (!address) {
    return { valid: false, error: 'Invalid IP address' };
  }
  return { valid: true, normalized, version: address.version };
}

export function normalizeAdminInvitationIpRanges(rawRanges: unknown): {
  valid: boolean;
  ranges: string[];
  error?: string;
} {
  if (!Array.isArray(rawRanges)) {
    return { valid: false, ranges: [], error: 'allowed_ip_ranges must be an array' };
  }
  if (rawRanges.length > MAX_ADMIN_INVITATION_IP_RANGES) {
    return {
      valid: false,
      ranges: [],
      error: `At most ${MAX_ADMIN_INVITATION_IP_RANGES} IP ranges may be configured`,
    };
  }

  const ranges: string[] = [];
  for (const value of rawRanges) {
    if (typeof value !== 'string') {
      return { valid: false, ranges: [], error: 'Every IP range must be a string' };
    }
    if (value.length > MAX_IP_RANGE_INPUT_LENGTH) {
      return { valid: false, ranges: [], error: 'IP range is too long' };
    }
    const validation = validateAdminInvitationIpRange(value);
    if (!validation.valid) {
      return { valid: false, ranges: [], error: validation.error };
    }
    if (!ranges.includes(validation.normalized)) {
      ranges.push(validation.normalized);
    }
  }

  return { valid: true, ranges };
}

export function adminInvitationIpMatches(clientIp: string, configuredRange: string): boolean {
  const client = parseIp(clientIp.trim());
  if (!client) return false;

  const normalizedRange = configuredRange.trim().replace(/\s+/g, '');
  const rangeParts = normalizedRange.split('-');
  if (rangeParts.length === 2) {
    const start = parseIp(rangeParts[0]);
    const end = parseIp(rangeParts[1]);
    return (
      !!start &&
      !!end &&
      start.version === client.version &&
      end.version === client.version &&
      client.value >= start.value &&
      client.value <= end.value
    );
  }

  const cidrParts = normalizedRange.split('/');
  if (cidrParts.length === 2) {
    const network = parseIp(cidrParts[0]);
    const prefix = /^\d+$/.test(cidrParts[1]) ? Number(cidrParts[1]) : -1;
    if (!network || network.version !== client.version || prefix < 0 || prefix > network.bits) {
      return false;
    }
    const hostBits = BigInt(network.bits - prefix);
    return client.value >> hostBits === network.value >> hostBits;
  }

  const exact = parseIp(normalizedRange);
  return !!exact && exact.version === client.version && exact.value === client.value;
}

export function isAdminInvitationIpAllowed(clientIp: string, ranges: string[]): boolean {
  return ranges.some((range) => adminInvitationIpMatches(clientIp, range));
}

export function getAdminInvitationClientIp(headers: Headers): string | null {
  const cloudflareIp = headers.get('cf-connecting-ip')?.trim();
  if (cloudflareIp) return cloudflareIp;
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}

function parseIp(value: string): ParsedIp | null {
  if (value.includes(':')) {
    const parsed = parseIpv6(value);
    return parsed === null ? null : { version: 6, value: parsed, bits: 128 };
  }
  const parsed = parseIpv4(value);
  return parsed === null ? null : { version: 4, value: parsed, bits: 32 };
}

function parseIpv4(value: string): bigint | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith('0'))) return null;
    const number = Number(part);
    if (number < 0 || number > 255) return null;
    result = (result << 8n) | BigInt(number);
  }
  return result;
}

function parseIpv6(value: string): bigint | null {
  const ip = value.toLowerCase();
  if (ip.includes('.') || ip.includes(':::') || (ip.match(/::/g) ?? []).length > 1) return null;

  const compressed = ip.includes('::');
  const [leftText, rightText = ''] = compressed ? ip.split('::') : [ip, ''];
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  if ((!compressed && left.length !== 8) || (compressed && left.length + right.length >= 8)) {
    return null;
  }

  const groups = compressed
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }

  let result = 0n;
  for (const group of groups) {
    result = (result << 16n) | BigInt(`0x${group}`);
  }
  return result;
}
