import type { SAMLAttributeReleaseConfig, SAMLAttributeSubject } from '../attributes';
import { cloneSAMLAttributeReleasePolicyFromPreset } from '../attribute-presets';

export const enterpriseSaaSSubjectFixture: SAMLAttributeSubject = {
  id: 'user-456',
  email: 'employee@example.com',
  name: 'Employee Example',
  customClaims: {
    givenName: 'Employee',
    surname: 'Example',
    groups: ['finance', 'workspace-admins'],
  },
};

export const enterpriseSaaSAttributeReleaseConfigFixture: SAMLAttributeReleaseConfig = {
  attributeMapping: {},
  attributeReleasePolicy: cloneSAMLAttributeReleasePolicyFromPreset('enterprise_saas.v1'),
};

export const researchFederationSubjectFixture: SAMLAttributeSubject = {
  id: 'user-789',
  email: 'researcher@example.edu',
  name: 'Researcher Example',
  customClaims: {
    eduPersonPrincipalName: 'researcher@example.edu',
    eduPersonScopedAffiliation: ['faculty@example.edu', 'member@example.edu'],
    eduPersonEntitlement: ['urn:mace:example.edu:entitlement:research-platform'],
    eduPersonUniqueId: 'researcher-789@example.edu',
  },
};

export const researchFederationAttributeReleaseConfigFixture: SAMLAttributeReleaseConfig = {
  attributeMapping: {},
  attributeReleasePolicy: cloneSAMLAttributeReleasePolicyFromPreset('research_federation.v1'),
};
