import type { SAMLAttributeReleaseConfig, SAMLAttributeSubject } from '../attributes';
import { cloneSAMLAttributeReleasePolicyFromPreset } from '../attribute-presets';

export const academicPublisherSubjectFixture: SAMLAttributeSubject = {
  id: 'user-123',
  email: 'reader@example.edu',
  name: 'Reader Example',
  customClaims: {
    eduPersonScopedAffiliation: ['member@example.edu', 'staff@example.edu'],
    eduPersonEntitlement: ['urn:mace:dir:entitlement:common-lib-terms'],
  },
};

export const academicPublisherAttributeReleaseConfigFixture: SAMLAttributeReleaseConfig = {
  attributeMapping: {},
  attributeReleasePolicy: cloneSAMLAttributeReleasePolicyFromPreset('academic_publisher.v1'),
};
