/**
 * Admin IP allowlist matching: one rule for enforcing the allowlist, checking an address against
 * it, and judging whether a change would shut the caller out.
 */

/**
 * Whether `ip` is let in by one allowlist entry: the same text, or an address in a CIDR range of
 * its own family. This is the one rule the admin-auth middleware enforces, the check endpoint
 * answers with, and the lock-out guard of the allowlist routes judges by.
 */
export function adminIpMatchesRange(ip: string, range: string): boolean {
  // Exact match
  if (ip === range) {
    return true;
  }

  // CIDR match
  if (range.includes('/')) {
    return ipMatchesCidr(ip, range);
  }

  return false;
}

/**
 * Check if an IP matches an IPv4 or IPv6 CIDR range.
 */
function ipMatchesCidr(ip: string, cidr: string): boolean {
  const cidrParts = cidr.split('/');
  if (cidrParts.length !== 2 || !/^\d+$/.test(cidrParts[1])) {
    return false;
  }
  const [rangeIp, prefixLengthStr] = cidrParts;
  const prefixLength = Number(prefixLengthStr);

  // IPv4 handling
  if (!ip.includes(':') && !rangeIp.includes(':')) {
    const ipNum = ipv4ToNumber(ip);
    const rangeNum = ipv4ToNumber(rangeIp);

    if (ipNum === null || rangeNum === null || prefixLength < 0 || prefixLength > 32) {
      return false;
    }

    const mask = prefixLength === 0 ? 0 : (-1 << (32 - prefixLength)) >>> 0;
    return (ipNum & mask) === (rangeNum & mask);
  }

  // IPv6 handling. Parse both compressed and full notation and compare prefix bits.
  if (ip.includes(':') && rangeIp.includes(':')) {
    const ipNum = ipv6ToBigInt(ip);
    const rangeNum = ipv6ToBigInt(rangeIp);
    if (ipNum === null || rangeNum === null || prefixLength < 0 || prefixLength > 128) {
      return false;
    }
    const hostBits = BigInt(128 - prefixLength);
    return ipNum >> hostBits === rangeNum >> hostBits;
  }

  return false;
}

/**
 * Convert IPv4 address to 32-bit number
 */
function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }

  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const num = Number(part);
    if (num > 255) {
      return null;
    }
    result = (result << 8) | num;
  }

  return result >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  if (ip.includes('.') || ip.includes(':::') || (ip.match(/::/g) ?? []).length > 1) {
    return null;
  }

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
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) {
    return null;
  }

  let result = 0n;
  for (const group of groups) {
    result = (result << 16n) | BigInt(`0x${group}`);
  }
  return result;
}

/**
 * The client address of an admin request: the Cloudflare header, else the first address of the
 * forwarded list. Null when neither is present.
 */
export function getAdminRequestClientIp(
  header: (name: string) => string | undefined
): string | null {
  const direct = header('CF-Connecting-IP');
  if (direct) return direct;
  return header('X-Forwarded-For')?.split(',')[0]?.trim() || null;
}
