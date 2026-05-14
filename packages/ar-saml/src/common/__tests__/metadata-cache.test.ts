import { describe, expect, it } from 'vitest';
import {
  buildSAMLMetadataResponse,
  buildSAMLMetadataResponseHeaders,
  buildStableSAMLMetadataDescriptorId,
  SAML_METADATA_CACHE_DURATION,
  SAML_METADATA_CACHE_MAX_AGE_SECONDS,
} from '../metadata-cache';

describe('SAML metadata cache helpers', () => {
  const metadataXml = '<md:EntityDescriptor entityID="https://sp.example.com/saml" />';

  it('builds stable role-scoped descriptor IDs from entityID', () => {
    const idpId = buildStableSAMLMetadataDescriptorId('idp', 'https://auth.example.com/saml');
    const idpIdAgain = buildStableSAMLMetadataDescriptorId('idp', 'https://auth.example.com/saml');
    const spId = buildStableSAMLMetadataDescriptorId('sp', 'https://auth.example.com/saml');

    expect(idpId).toBe(idpIdAgain);
    expect(idpId).toMatch(/^_authrim_saml_idp_[a-z0-9]+$/);
    expect(spId).toMatch(/^_authrim_saml_sp_[a-z0-9]+$/);
    expect(spId).not.toBe(idpId);
  });

  it('returns stable metadata cache headers', () => {
    const headers = buildSAMLMetadataResponseHeaders(metadataXml);
    const headersAgain = buildSAMLMetadataResponseHeaders(metadataXml);

    expect(headers).toEqual({
      'Content-Type': 'application/samlmetadata+xml',
      'Content-Disposition': 'attachment; filename="authrim-saml-metadata.xml"',
      'Cache-Control': `public, max-age=${SAML_METADATA_CACHE_MAX_AGE_SECONDS}`,
      ETag: expect.stringMatching(/^W\/"saml-metadata-[a-z0-9]+"$/),
      'X-Content-Type-Options': 'nosniff',
    });
    expect(headers.ETag).toBe(headersAgain.ETag);
    expect(SAML_METADATA_CACHE_DURATION).toBe('PT24H');
  });

  it('allows metadata endpoints to provide role-specific download filenames', () => {
    const response = buildSAMLMetadataResponse(
      metadataXml,
      undefined,
      'authrim-saml-sp-metadata.xml'
    );

    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="authrim-saml-sp-metadata.xml"'
    );
  });

  it('returns 200 when If-None-Match is absent or stale', () => {
    const freshResponse = buildSAMLMetadataResponse(metadataXml);
    const staleResponse = buildSAMLMetadataResponse(metadataXml, 'W/"saml-metadata-stale"');

    expect(freshResponse.status).toBe(200);
    expect(staleResponse.status).toBe(200);
  });

  it('returns 304 when If-None-Match matches exact, list, or wildcard validators', () => {
    const etag = buildSAMLMetadataResponseHeaders(metadataXml).ETag;

    expect(buildSAMLMetadataResponse(metadataXml, etag).status).toBe(304);
    expect(buildSAMLMetadataResponse(metadataXml, `W/"saml-metadata-stale", ${etag}`).status).toBe(
      304
    );
    expect(buildSAMLMetadataResponse(metadataXml, '*').status).toBe(304);
  });
});
