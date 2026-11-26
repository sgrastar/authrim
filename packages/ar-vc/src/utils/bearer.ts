/** Authorization header helpers. */

/**
 * Extract the token of a Bearer Authorization header.
 * The scheme is case-insensitive (RFC 9110 section 11.1) and is followed by one or more spaces
 * (RFC 6750 section 2.1). Returns null for any other scheme or an empty or blank token.
 */
export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^bearer +(\S.*)$/i.exec(header);
  return match ? match[1] : null;
}
