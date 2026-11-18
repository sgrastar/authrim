import { describe, expect, it } from 'vitest';
import { parseSPMetadata } from '../providers';
import {
  approveSAMLProviderTrust,
  hasApprovedSAMLProviderTrust,
  providerTrustConfigurationDigest,
} from '../provider-trust';

const config = () =>
  parseSPMetadata(
    `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="urn:test:sp"><SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.test/acs" index="0" /></SPSSODescriptor></EntityDescriptor>`
  );

describe('SAML trust approval', () => {
  it('requires a server approval matching the current local configuration', async () => {
    const current = config();
    expect(await hasApprovedSAMLProviderTrust(current)).toBe(false);
    await approveSAMLProviderTrust(current);
    expect(await hasApprovedSAMLProviderTrust(current)).toBe(true);
    current.identityMapping = { fieldMappingSetId: 'changed-without-approval' };
    expect(await hasApprovedSAMLProviderTrust(current)).toBe(false);
    await approveSAMLProviderTrust(current);
    expect(await hasApprovedSAMLProviderTrust(current)).toBe(true);
  });

  it('ignores re-verification clocks but binds certificates and trust context', async () => {
    const current = config();
    current.aggregateImport = {
      aggregateEntityId: current.entityId,
      importedAt: 100,
      federationTrustProfileId: 'source-a',
      verification: {
        status: 'verified',
        policy: 'strict',
        verifiedAt: 100,
        certificateFingerprintSha256: 'certificate-a',
        trustContextSnapshotHash: 'context-a',
      },
    };
    await approveSAMLProviderTrust(current);
    const before = await providerTrustConfigurationDigest(current);
    current.aggregateImport.importedAt = 200;
    current.aggregateImport.verification.verifiedAt = 200;
    current.aggregateImport.verification.signedElementId = 'new-snapshot-signature-id';
    current.aggregateImport.verification.warnings = ['New diagnostic'];
    expect(await providerTrustConfigurationDigest(current)).toBe(before);
    expect(await hasApprovedSAMLProviderTrust(current)).toBe(true);
    current.aggregateImport.verification.certificateFingerprintSha256 = 'certificate-b';
    expect(await hasApprovedSAMLProviderTrust(current)).toBe(false);
    current.aggregateImport.verification.certificateFingerprintSha256 = 'certificate-a';
    current.aggregateImport.verification.trustContextSnapshotHash = 'context-b';
    expect(await hasApprovedSAMLProviderTrust(current)).toBe(false);
  });
});
