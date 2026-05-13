import { describe, expect, it } from 'vitest';
import {
  analyzeSAMLMetadata,
  buildSAMLMetadataDiffSummary,
  buildSAMLMetadataRefreshStatus,
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
});
