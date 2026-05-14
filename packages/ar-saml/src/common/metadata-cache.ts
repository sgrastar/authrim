import { fnv1a32 } from '@authrim/ar-lib-core';

export type SAMLMetadataRole = 'idp' | 'sp';

export const SAML_METADATA_CACHE_MAX_AGE_SECONDS = 24 * 60 * 60;
export const SAML_METADATA_CACHE_DURATION = 'PT24H';

export function buildStableSAMLMetadataDescriptorId(
  role: SAMLMetadataRole,
  entityId: string
): string {
  const hash = fnv1a32(`${role}:${entityId}`).toString(36);
  return `_authrim_saml_${role}_${hash}`;
}

export function buildSAMLMetadataResponseHeaders(
  metadataXml: string,
  filename = 'authrim-saml-metadata.xml'
): Record<string, string> {
  return {
    'Content-Type': 'application/samlmetadata+xml',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': `public, max-age=${SAML_METADATA_CACHE_MAX_AGE_SECONDS}`,
    ETag: buildWeakSAMLMetadataETag(metadataXml),
    'X-Content-Type-Options': 'nosniff',
  };
}

export function buildSAMLMetadataResponse(
  metadataXml: string,
  requestIfNoneMatch?: string | null,
  filename?: string
): Response {
  const headers = buildSAMLMetadataResponseHeaders(metadataXml, filename);
  const etag = headers.ETag;

  if (typeof etag === 'string' && doesIfNoneMatchCurrentETag(requestIfNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers,
    });
  }

  return new Response(metadataXml, { headers });
}

function buildWeakSAMLMetadataETag(metadataXml: string): string {
  return `W/"saml-metadata-${fnv1a32(metadataXml).toString(36)}"`;
}

function doesIfNoneMatchCurrentETag(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }

  return ifNoneMatch
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === '*' || value === etag);
}
