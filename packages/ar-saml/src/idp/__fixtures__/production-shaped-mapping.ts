/**
 * An SP and its Field Mapping Set as a deployed tenant holds them (shapes taken from an Admin UI
 * Flow Editor mapping set on the conformance environment, ids replaced): the SP names only the
 * set and its release policy, the set has the edges the editor saved (no catalog entry ids on the
 * destination side), and the runtime catalog is the compiled snapshot's, which is the tenant's
 * canonical fields and has no entry for the SAML attributes released to.
 */

export const OID_MAIL = 'urn:oid:0.9.2342.19200300.100.1.3';
export const OID_SURNAME = 'urn:oid:2.5.4.4';
export const OID_EDU_PERSON_ASSURANCE = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.11';
export const OID_ENTITLEMENT = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.7';

export const PRODUCTION_SP_ENTITY_ID = 'urn:example:sp:production-shaped';
export const PRODUCTION_DESTINATION_PROFILE_ID = 'destination_profile_00000000';

/** What the SP's `config` holds after the Admin API saved it. */
export function productionSpConfig(
  policies: Record<string, 'required' | 'optional' | 'hidden'> = {
    [OID_MAIL]: 'required',
    [OID_SURNAME]: 'optional',
    [OID_EDU_PERSON_ASSURANCE]: 'required',
    [OID_ENTITLEMENT]: 'optional',
  },
  overrides: Record<string, unknown> = {}
) {
  return {
    entityId: PRODUCTION_SP_ENTITY_ID,
    acsUrl: 'https://sp.example.test/acs',
    acsUrls: ['https://sp.example.test/acs'],
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    attributeMapping: {},
    signResponses: true,
    signAssertions: false,
    allowedBindings: ['post'],
    authnRequestSignaturePolicy: 'optional',
    attributeReleaseConsent: { enabled: false, mode: 'once' },
    identityMapping: {
      fieldMappingSetId: 'field_mapping_00000000',
      destinationFieldPolicies: policies,
    },
    ...overrides,
  };
}

/** The destination profile's schema (what the consent filter and the catalog entries come from). */
export const PRODUCTION_DESTINATION_SCHEMA = {
  destinationType: 'saml',
  attributes: [
    {
      name: OID_MAIL,
      label: 'mail',
      valueType: 'string',
      valueMultiplicity: 'single',
      classification: 'pii',
    },
    {
      name: OID_SURNAME,
      label: 'sn',
      valueType: 'string',
      valueMultiplicity: 'single',
      classification: 'pii',
    },
    {
      name: OID_EDU_PERSON_ASSURANCE,
      label: 'eduPersonAssurance',
      valueType: 'string',
      valueMultiplicity: 'multi',
      classification: 'public',
    },
    {
      name: OID_ENTITLEMENT,
      label: 'eduPersonEntitlement',
      valueType: 'string',
      valueMultiplicity: 'multi',
      classification: 'internal',
    },
  ],
};

function edge(
  id: string,
  source: { path: string; catalogEntryId: string; label: string },
  target: { path: string; label: string }
) {
  return {
    id,
    sourceRef: {
      side: 'source' as const,
      namespace: 'authrim.profile',
      path: source.path,
      catalogEntryId: source.catalogEntryId,
      valueType: 'String',
    },
    targetRef: {
      side: 'destination' as const,
      namespace: 'saml.attribute',
      path: target.path,
      valueType: 'String',
    },
    edgeKind: 'direct',
  };
}

/** The edges of the active version: email to mail, the assurance values to eduPersonAssurance. */
export const PRODUCTION_EDGES = [
  edge(
    'mapping_edge_mail',
    { path: 'email', catalogEntryId: 'field.canonical.email', label: 'Email' },
    { path: OID_MAIL, label: 'mail' }
  ),
  edge(
    'mapping_edge_surname',
    { path: 'family_name', catalogEntryId: 'field.canonical.family_name', label: 'Last Name' },
    { path: OID_SURNAME, label: 'sn' }
  ),
  edge(
    'mapping_edge_assurance',
    {
      path: 'edu_person_assurance',
      catalogEntryId: 'system.identity.edu_person_assurance',
      label: 'Assurance Values (eduPersonAssurance)',
    },
    { path: OID_EDU_PERSON_ASSURANCE, label: 'eduPersonAssurance' }
  ),
];

/**
 * The default canonical catalog a deployed environment stores (setup seeds it under namespace
 * `authrim.canonical`, stable ids `field.canonical.<key>`), as far as these tests need it.
 */
export function seededCanonicalEntries() {
  const entry = (path: string, classification: 'pii' | 'internal' | 'public') => ({
    id: `field.canonical.${path}`,
    namespace: 'authrim.canonical',
    path,
    valueType: 'string',
    cardinality: 'single' as const,
    classification,
    targetType: 'canonical' as const,
  });
  return [
    entry('email', 'pii'),
    entry('family_name', 'pii'),
    entry('name', 'pii'),
    entry('locale', 'public'),
    entry('lifecycle_state', 'internal'),
  ];
}

/**
 * The rules that bring a source profile's fields into the canonical ones: the Admin UI keeps them
 * in the same set when a destination is edited. Their sources are the source profile's fields
 * (no catalog entry of the canonical catalog), their targets canonical fields.
 */
export const PRODUCTION_INPUT_EDGES = [
  {
    id: 'mapping_edge_input_username',
    sourceRef: {
      side: 'source' as const,
      namespace: 'scim.attribute',
      path: 'userName',
      valueType: 'String',
    },
    targetRef: {
      side: 'destination' as const,
      namespace: 'authrim.profile',
      path: 'preferred_username',
      catalogEntryId: 'field.canonical.preferred_username',
      valueType: 'String',
    },
    edgeKind: 'direct',
  },
];

/**
 * A rule that brings a SAML attribute of another IdP in (a source: the same attribute the
 * destination releases, saved without a catalog entry id), and the validation that asks the
 * source profile for it. It is about the input side only.
 */
export const PRODUCTION_SAML_INPUT_EDGE = {
  id: 'mapping_edge_input_saml_mail',
  sourceRef: {
    side: 'source' as const,
    namespace: 'saml.attribute',
    path: OID_MAIL,
    valueType: 'String',
  },
  targetRef: {
    side: 'destination' as const,
    namespace: 'authrim.profile',
    path: 'email',
    valueType: 'String',
  },
  edgeKind: 'direct',
};
export const PRODUCTION_SAML_INPUT_REQUIRED_RULE = {
  id: 'validation_input_saml_mail',
  kind: 'required',
  targetRef: { side: 'source' as const, namespace: 'saml.attribute', path: OID_MAIL },
  defaultSeverity: 'critical',
};

/**
 * What `resolveRuntimeIdentityMappingBinding` returns for it. The snapshot names the catalog
 * version the control plane derives on the fly; the resolver gives it the stored default
 * canonical entries ('canonical'), or none when nothing is stored ('empty').
 */
export function productionBinding(
  options: {
    catalog?: 'canonical' | 'empty';
    withInputEdges?: boolean;
    validationRules?: unknown[];
  } = {}
) {
  return {
    id: 'activation_00000000',
    tenantId: 'tenant-a',
    fieldMappingSetId: 'field_mapping_00000000',
    fieldMappingVersionId: 'field_mapping_version_00000000',
    mappingSnapshotHash: 'snapshot-hash',
    catalog: {
      identity: {
        id: 'system_default_canonical_catalog_schema_v1',
        version: 'v1',
        contentHash: 'hash',
        compatibilityRange: '*',
      },
      entries: options.catalog === 'empty' ? [] : seededCanonicalEntries(),
    },
    edges:
      options.withInputEdges === false
        ? PRODUCTION_EDGES
        : [...PRODUCTION_INPUT_EDGES, ...PRODUCTION_EDGES],
    transforms: [],
    validationRules: options.validationRules ?? [],
    fieldMappingSet: { id: 'field_mapping_version_00000000', rules: [] },
    activationScope: {},
    destinationNamespace: undefined,
    sourceProfileId: undefined,
    destinationProfileId: PRODUCTION_DESTINATION_PROFILE_ID,
    destinationProfileIds: [PRODUCTION_DESTINATION_PROFILE_ID],
  };
}

/** The admin adapter the destination profile is read through. */
export function productionAdminAdapter(
  schema: Record<string, unknown> = PRODUCTION_DESTINATION_SCHEMA
) {
  return {
    query: async () => [],
    queryOne: async (sql: string) =>
      sql.includes('destination_profiles')
        ? {
            profile_id: PRODUCTION_DESTINATION_PROFILE_ID,
            destination_type: 'saml',
            version_id: 'destination_profile_version_00000000',
            schema_json: JSON.stringify(schema),
          }
        : null,
    execute: async () => ({ rowsAffected: 0 }),
  };
}

/**
 * A core adapter holding no destination-field consent selection, and the tenant's own field
 * schemas (rows of custom_claim_schemas) it is given.
 */
export function emptyCoreAdapter(schemas: Array<Record<string, unknown>> = []) {
  return {
    query: async (sql: string) => (sql.includes('custom_claim_schemas') ? schemas : []),
    queryOne: async () => null,
    execute: async () => ({ rowsAffected: 0 }),
  };
}
