export type SAMLInteropArea =
  | 'metadata-import'
  | 'nameid'
  | 'attributes'
  | 'signing'
  | 'encryption'
  | 'binding'
  | 'rollover';

export type SAMLInteropStatus = 'covered' | 'planned' | 'manual';

export interface SAMLInteropMatrixEntry {
  id: string;
  profile: 'academic_publisher' | 'enterprise_saas' | 'research_federation' | 'generic';
  area: SAMLInteropArea;
  status: SAMLInteropStatus;
  ciTest?: string;
  notes?: string;
}

export const SAML_INTEROPERABILITY_MATRIX: SAMLInteropMatrixEntry[] = [
  {
    id: 'publisher-sp-metadata-strict',
    profile: 'academic_publisher',
    area: 'metadata-import',
    status: 'covered',
    ciTest: 'metadata-interoperability.test.ts',
    notes: 'SP metadata with signed AuthnRequests, WantAssertionsSigned, POST ACS, SLO.',
  },
  {
    id: 'publisher-sp-metadata-legacy',
    profile: 'academic_publisher',
    area: 'metadata-import',
    status: 'covered',
    ciTest: 'metadata-interoperability.test.ts',
    notes: 'SP metadata without signing certificate and without signed AuthnRequest requirement.',
  },
  {
    id: 'publisher-sp-requested-attributes',
    profile: 'academic_publisher',
    area: 'metadata-import',
    status: 'covered',
    ciTest: 'metadata-interoperability.test.ts',
    notes:
      'SP AttributeConsumingService and RequestedAttribute hints produce release policy suggestions.',
  },
  {
    id: 'research-sp-metadata-multiple-acs',
    profile: 'research_federation',
    area: 'metadata-import',
    status: 'covered',
    ciTest: 'metadata-interoperability.test.ts',
    notes: 'Multiple ACS bindings with POST default selection.',
  },
  {
    id: 'persistent-pairwise-nameid',
    profile: 'academic_publisher',
    area: 'nameid',
    status: 'covered',
    ciTest: 'subject.test.ts',
  },
  {
    id: 'transient-state-nameid',
    profile: 'research_federation',
    area: 'nameid',
    status: 'covered',
    ciTest: 'subject.test.ts',
  },
  {
    id: 'academic-publisher-attribute-release',
    profile: 'academic_publisher',
    area: 'attributes',
    status: 'covered',
    ciTest: 'academic-publisher-preset.test.ts',
  },
  {
    id: 'response-and-assertion-signing-policy',
    profile: 'generic',
    area: 'signing',
    status: 'covered',
    ciTest: 'signing.test.ts',
  },
  {
    id: 'authn-request-signature-policy',
    profile: 'generic',
    area: 'signing',
    status: 'covered',
    ciTest: 'authn-request-signature.test.ts',
  },
  {
    id: 'xml-encryption-modern-default',
    profile: 'generic',
    area: 'encryption',
    status: 'covered',
    ciTest: 'encryption.test.ts',
    notes:
      'Default XML Encryption uses RSA-OAEP with SHA-256/MGF1-SHA256 and AES-256-GCM.',
  },
  {
    id: 'xml-encryption-legacy-explicit-opt-in',
    profile: 'generic',
    area: 'encryption',
    status: 'covered',
    ciTest: 'encryption.test.ts',
    notes:
      'RSA-OAEP SHA-1 and AES-256-CBC are allowed only when the SP explicitly opts into the legacy encryption policy.',
  },
  {
    id: 'xml-encryption-legacy-implicit-deny',
    profile: 'generic',
    area: 'encryption',
    status: 'covered',
    ciTest: 'encryption.test.ts',
    notes:
      'Legacy XML Encryption algorithms fail closed unless the SP has per-provider legacy opt-in.',
  },
  {
    id: 'metadata-active-next-backup-certificates',
    profile: 'generic',
    area: 'rollover',
    status: 'covered',
    ciTest: 'saml-signing-keys.test.ts, metadata.test.ts, metadata-interoperability.test.ts',
    notes: 'Resolver, publication policy, and generated IdP/SP metadata publication are covered.',
  },
  {
    id: 'authrim-metadata-export-roundtrip',
    profile: 'generic',
    area: 'metadata-import',
    status: 'covered',
    ciTest: 'metadata-interoperability.test.ts',
    notes: 'Authrim-generated IdP/SP metadata exports can be parsed back into provider configs.',
  },
  {
    id: 'real-publisher-metadata-private-fixtures',
    profile: 'academic_publisher',
    area: 'metadata-import',
    status: 'manual',
    notes: 'Private metadata fixtures are stored under private/fixtures and not committed.',
  },
];
