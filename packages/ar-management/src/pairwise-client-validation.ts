import {
  createLogger,
  resolvePairwiseSector,
  safeFetchJson,
  validateExternalUrl,
  type OAuthErrorResponse,
} from '@authrim/ar-lib-core';

/**
 * Validate sector_identifier_uri content (OIDC Core 8.1)
 * Fetches the URI and verifies that all redirect_uris are included in the returned JSON array
 */
export async function validateSectorIdentifierContent(
  sectorUri: string,
  redirectUris: string[]
): Promise<{ valid: boolean; error?: OAuthErrorResponse }> {
  try {
    // SSRF protection: Validate URL before fetching
    const ssrfError = validateExternalUrl(sectorUri, {
      requireHttps: true,
      allowLocalhost: false,
      errorType: 'invalid_client_metadata',
      fieldName: 'sector_identifier_uri',
    });
    if (ssrfError) {
      return { valid: false, error: ssrfError };
    }

    const content = await safeFetchJson<unknown>(sectorUri, {
      headers: {
        Accept: 'application/json',
      },
      timeoutMs: 5000,
      maxResponseSize: 64 * 1024,
    });

    if (!Array.isArray(content)) {
      return {
        valid: false,
        error: {
          error: 'invalid_client_metadata',
          error_description: 'sector_identifier_uri must return a JSON array of redirect_uris',
        },
      };
    }

    // Verify all redirect_uris are included in the sector_identifier_uri content
    for (const uri of redirectUris) {
      if (!content.includes(uri)) {
        // SECURITY: Do not expose which redirect_uri failed to prevent enumeration
        return {
          valid: false,
          error: {
            error: 'invalid_client_metadata',
            error_description: 'One or more redirect_uris are not valid for sector_identifier_uri',
          },
        };
      }
    }

    return { valid: true };
  } catch (error) {
    const log = createLogger().module('DCR');
    log.error('sector_identifier_uri validation error', { sectorUri }, error as Error);
    return {
      valid: false,
      error: {
        error: 'invalid_client_metadata',
        error_description: 'Failed to validate sector_identifier_uri content',
      },
    };
  }
}

/**
 * The pairwise configuration of a client (OIDC Core 8.1), checked the same way wherever a client
 * is registered or changed (DCR, RFC 7592 update, Admin API create and update): `subject_type`
 * must be public or pairwise; a pairwise client's redirect URIs must share one host (the sector,
 * as the runtime takes it: the host name, never the port) unless a `sector_identifier_uri` names
 * the sector; and a `sector_identifier_uri` must be HTTPS and list every redirect URI. Returns
 * the error to answer with, or null.
 */
export async function validatePairwiseClientMetadata(input: {
  subjectType?: unknown;
  redirectUris: readonly string[];
  sectorIdentifierUri?: string | null;
  /** False when neither the redirect URIs nor the sector URI changed (no fetch needed). */
  checkSectorContent?: boolean;
}): Promise<OAuthErrorResponse | null> {
  const subjectType = input.subjectType ?? 'public';
  if (subjectType !== 'public' && subjectType !== 'pairwise') {
    return {
      error: 'invalid_client_metadata',
      error_description: 'subject_type must be one of: public, pairwise',
    };
  }
  if (input.sectorIdentifierUri && typeof input.sectorIdentifierUri !== 'string') {
    return {
      error: 'invalid_client_metadata',
      error_description: 'sector_identifier_uri must be a string',
    };
  }
  // Whatever the registration says, a pairwise client must have a sector the runtime can resolve
  // (the sector URI's host, else the one host its redirect URIs share): none means no sub.
  if (
    subjectType === 'pairwise' &&
    !resolvePairwiseSector({
      sectorIdentifierUri: input.sectorIdentifierUri,
      redirectUris: input.redirectUris,
    })
  ) {
    return {
      error: 'invalid_client_metadata',
      error_description: input.sectorIdentifierUri
        ? 'sector_identifier_uri must be a valid HTTPS URI'
        : 'sector_identifier_uri is required when using pairwise subject type with multiple redirect URIs from different hosts, or with none',
    };
  }
  if (input.sectorIdentifierUri && input.checkSectorContent !== false) {
    const checked = await validateSectorIdentifierContent(input.sectorIdentifierUri, [
      ...input.redirectUris,
    ]);
    if (!checked.valid) return checked.error ?? { error: 'invalid_client_metadata' };
  }
  return null;
}
