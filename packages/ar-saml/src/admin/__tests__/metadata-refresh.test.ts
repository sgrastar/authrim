import { describe, expect, it } from 'vitest';
import {
  analyzeSAMLMetadata,
  buildSAMLMetadataDiffSummary,
  buildSAMLMetadataRefreshStatus,
  isSAMLMetadataRefreshDue,
  markSAMLMetadataRefreshFailure,
  markSAMLMetadataRefreshSuccess,
  normalizeSAMLMetadataRefreshPolicy,
} from '../metadata-refresh';

describe('SAML metadata refresh analysis', () => {
  const baseMetadata = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  entityID="https://sp.example.test/saml"
  validUntil="2030-01-01T00:00:00Z">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>BASECERT</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://sp.example.test/saml/acs"
      index="0"
      isDefault="true" />
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;

  const changedMetadata = baseMetadata
    .replace('2030-01-01T00:00:00Z', '2030-02-01T00:00:00Z')
    .replace('BASECERT', 'NEXTCERT')
    .replace(
      '</md:SPSSODescriptor>',
      `<md:SingleLogoutService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
      Location="https://sp.example.test/saml/slo" />
  </md:SPSSODescriptor>`
    );

  it('extracts metadata hash and critical fields', () => {
    const analysis = analyzeSAMLMetadata(baseMetadata);

    expect(analysis.hash).toMatch(/^[a-z0-9]+$/);
    expect(analysis.criticalFields).toEqual({
      entityId: 'https://sp.example.test/saml',
      validUntil: '2030-01-01T00:00:00Z',
      certificates: ['BASECERT'],
      endpoints: [
        {
          type: 'acs',
          binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
          location: 'https://sp.example.test/saml/acs',
          index: 0,
        },
      ],
    });
  });

  it('builds diff summary for certificate, endpoint, and validUntil changes', () => {
    const previous = analyzeSAMLMetadata(baseMetadata);
    const current = analyzeSAMLMetadata(changedMetadata);

    const diff = buildSAMLMetadataDiffSummary(previous, current, Date.UTC(2029, 0, 1));

    expect(diff).toMatchObject({
      changed: true,
      previousHash: previous.hash,
      currentHash: current.hash,
      entityIdChanged: false,
      validUntilChanged: true,
      certificatesAdded: ['NEXTCERT'],
      certificatesRemoved: ['BASECERT'],
      validUntil: '2030-02-01T00:00:00Z',
      expired: false,
    });
    expect(diff.endpointsAdded).toEqual([
      {
        type: 'slo',
        binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
        location: 'https://sp.example.test/saml/slo',
      },
    ]);
    expect(diff.endpointsRemoved).toEqual([]);
    expect(diff.expiresInSeconds).toBeGreaterThan(0);
  });

  it('stores previous and current critical fields in refresh status', () => {
    const previous = analyzeSAMLMetadata(baseMetadata);
    const current = analyzeSAMLMetadata(changedMetadata);
    const status = buildSAMLMetadataRefreshStatus(previous, current, Date.UTC(2029, 0, 1));

    expect(status.previousHash).toBe(previous.hash);
    expect(status.currentHash).toBe(current.hash);
    expect(status.previous).toEqual(previous.criticalFields);
    expect(status.current).toEqual(current.criticalFields);
    expect(status.lastChangedAt).toBe(Date.UTC(2029, 0, 1));
  });

  it('marks expired metadata in diff summary without needing job infrastructure', () => {
    const expired = analyzeSAMLMetadata(
      baseMetadata.replace('2030-01-01T00:00:00Z', '2020-01-01T00:00:00Z')
    );

    const diff = buildSAMLMetadataDiffSummary(undefined, expired, Date.UTC(2029, 0, 1));

    expect(diff.expired).toBe(true);
    expect(diff.expiresInSeconds).toBeLessThan(0);
  });

  it('defaults URL-backed metadata to six-hour automatic polling', () => {
    expect(
      isSAMLMetadataRefreshDue(undefined, 'https://metadata.example.test/idp.xml', 1_000)
    ).toBe(true);
    const policy = normalizeSAMLMetadataRefreshPolicy(
      undefined,
      'https://metadata.example.test/idp.xml',
      1_000
    );

    expect(policy).toMatchObject({
      mode: 'automatic',
      intervalSeconds: 21_600,
      nextRefreshAt: 21_601_000,
      consecutiveFailures: 0,
      sourceState: 'healthy',
    });
    expect(
      isSAMLMetadataRefreshDue(policy, 'https://metadata.example.test/idp.xml', 21_601_000)
    ).toBe(true);
  });

  it('keeps manual sources out of scheduled polling while allowing a successful manual refresh', () => {
    const policy = normalizeSAMLMetadataRefreshPolicy(
      { mode: 'manual', intervalSeconds: 3_600 },
      'https://metadata.example.test/sp.xml',
      5_000
    );

    expect(
      isSAMLMetadataRefreshDue(policy, 'https://metadata.example.test/sp.xml', 99_999_999)
    ).toBe(false);
    expect(
      markSAMLMetadataRefreshSuccess(policy, 'https://metadata.example.test/sp.xml', 10_000)
    ).toMatchObject({
      mode: 'manual',
      lastAttemptAt: 10_000,
      lastSuccessAt: 10_000,
      consecutiveFailures: 0,
      sourceState: 'healthy',
    });
  });

  it('uses bounded exponential retry and preserves the last successful timestamp', () => {
    const first = markSAMLMetadataRefreshFailure(
      {
        mode: 'automatic',
        intervalSeconds: 21_600,
        lastSuccessAt: 1_000,
      },
      'https://metadata.example.test/federation.xml',
      'metadata_http_503',
      'error',
      10_000
    );

    expect(first).toMatchObject({
      lastSuccessAt: 1_000,
      lastAttemptAt: 10_000,
      consecutiveFailures: 1,
      nextRefreshAt: 910_000,
      lastErrorCode: 'metadata_http_503',
    });
  });

  it('drops HTTP validators when the metadata source URL changes', () => {
    const policy = normalizeSAMLMetadataRefreshPolicy(
      {
        mode: 'automatic',
        intervalSeconds: 21_600,
        etag: '"source-a"',
        lastModified: 'Mon, 01 Sep 2026 00:00:00 GMT',
        validatorSourceUrl: 'https://metadata.example.test/source-a.xml',
        acceptedValidUntil: '2030-01-01T00:00:00Z',
      },
      'https://metadata.example.test/source-b.xml',
      1_000
    );

    expect(policy).toMatchObject({ mode: 'automatic', intervalSeconds: 21_600 });
    expect(policy.etag).toBeUndefined();
    expect(policy.lastModified).toBeUndefined();
    expect(policy.validatorSourceUrl).toBeUndefined();
    expect(policy.acceptedValidUntil).toBeUndefined();
  });
});
