/**
 * Pairwise Subject Identifier Utilities
 * OIDC Core 8.1: Pairwise Identifier Algorithm
 * https://openid.net/specs/openid-connect-core-1_0.html#PairwiseAlg
 */

/**
 * Generates a pairwise subject identifier for a user and client
 *
 * OIDC Core 8.1: A pairwise subject identifier is computed using a
 * sector identifier and a local account ID. This prevents clients from
 * correlating users across different RPs.
 *
 * @param localAccountId - The user's internal identifier (e.g., database ID)
 * @param sectorIdentifier - The sector identifier (usually the client's host)
 * @param salt - A secret salt for additional security
 * @returns Base64url-encoded SHA-256 hash as the pairwise subject identifier
 */
export async function generatePairwiseSubject(
  localAccountId: string,
  sectorIdentifier: string,
  salt: string
): Promise<string> {
  // OIDC Core 8.1: sub = SHA-256(sector_identifier || local_account_id || salt)
  // The || denotes concatenation
  const data = `${sectorIdentifier}${localAccountId}${salt}`;

  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);

  // Hash with SHA-256
  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);

  // Convert to base64url encoding (URL-safe base64 without padding)
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const base64 = btoa(String.fromCharCode(...hashArray));
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]/g, '');

  return base64url;
}

/**
 * Extracts the sector identifier from a redirect URI
 *
 * OIDC Core 8.1: The sector identifier is the host component of the
 * redirect_uri. When multiple redirect URIs are registered, they must
 * all have the same host, or a sector_identifier_uri must be provided.
 *
 * @param redirectUri - The client's redirect URI
 * @returns The sector identifier (host)
 */
export function extractSectorIdentifier(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    return url.host; // Returns hostname:port
  } catch {
    throw new Error('Invalid redirect_uri');
  }
}

/**
 * Validates that all redirect URIs have the same sector identifier
 *
 * @param redirectUris - Array of redirect URIs
 * @returns true if all URIs have the same sector, false otherwise
 */
export function validateSectorIdentifierConsistency(redirectUris: string[]): boolean {
  if (redirectUris.length === 0) {
    return false;
  }

  if (redirectUris.length === 1) {
    return true;
  }

  try {
    const sectorIdentifiers = redirectUris.map((uri) => extractSectorIdentifier(uri));
    const firstSector = sectorIdentifiers[0];

    return sectorIdentifiers.every((sector) => sector === firstSector);
  } catch {
    return false;
  }
}

/**
 * Determines the effective sector identifier for a client
 *
 * OIDC Core 8.1: If sector_identifier_uri is provided, use the host from that.
 * Otherwise, use the host from the redirect_uri.
 *
 * @param redirectUris - Client's registered redirect URIs
 * @param sectorIdentifierUri - Optional sector identifier URI
 * @returns The sector identifier to use for pairwise subject generation
 */
export function determineEffectiveSectorIdentifier(
  redirectUris: string[],
  sectorIdentifierUri?: string
): string {
  // If sector_identifier_uri is provided, use its host
  if (sectorIdentifierUri) {
    return extractSectorIdentifier(sectorIdentifierUri);
  }

  // Otherwise, use the host from redirect_uri
  // If multiple redirect URIs, they must have the same host (validated separately)
  if (redirectUris.length === 0) {
    throw new Error('No redirect URIs registered');
  }

  return extractSectorIdentifier(redirectUris[0]);
}

/**
 * Generates the subject identifier based on the client's subject type
 *
 * @param localAccountId - The user's internal identifier
 * @param subjectType - 'public' or 'pairwise'
 * @param sectorIdentifier - The sector identifier (required for pairwise)
 * @param salt - Secret salt (required for pairwise)
 * @returns The subject identifier to use in tokens
 */
export async function generateSubjectIdentifier(
  localAccountId: string,
  subjectType: 'public' | 'pairwise',
  sectorIdentifier?: string,
  salt?: string
): Promise<string> {
  if (subjectType === 'public') {
    // For public subject type, return the local account ID directly
    return localAccountId;
  }

  // For pairwise subject type, generate pairwise identifier
  if (!sectorIdentifier) {
    throw new Error('Sector identifier is required for pairwise subject type');
  }

  if (!salt) {
    throw new Error('Salt is required for pairwise subject type');
  }

  return await generatePairwiseSubject(localAccountId, sectorIdentifier, salt);
}
