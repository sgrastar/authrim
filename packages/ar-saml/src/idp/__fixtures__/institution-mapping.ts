/**
 * A mapping for an SP that is given the scoped attributes and, when the mapping chooses them, the
 * institution attributes, in the shape a deployed tenant has it (see production-shaped-mapping.ts).
 * The scoped values come from the person's own custom claims, which is how they reach an assertion.
 */
import {
  OID_MAIL,
  productionBinding,
  productionSpConfig,
  PRODUCTION_EDGES,
  PRODUCTION_DESTINATION_SCHEMA,
} from './production-shaped-mapping';

export const OID_EPSA = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9';
export const OID_EPPN = 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6';
export const OID_SCHAC_HOME_ORGANIZATION = 'urn:oid:1.3.6.1.4.1.25178.1.2.9';
export const OID_ORGANIZATION_NAME = 'urn:oid:2.5.4.10';

export const destination = (path: string) => ({
  side: 'destination' as const,
  namespace: 'saml.attribute',
  path,
  valueType: 'String',
});

export const customClaimEdge = (id: string, claim: string, target: string) => ({
  id,
  sourceRef: { side: 'source' as const, namespace: 'authrim.custom_claims', path: claim },
  targetRef: destination(target),
  edgeKind: 'direct',
});

const systemEdge = (id: string, path: string, catalogEntryId: string, target: string) => ({
  id,
  sourceRef: { side: 'source' as const, namespace: 'authrim.profile', path, catalogEntryId },
  targetRef: destination(target),
  edgeKind: 'direct',
});

export const EDGE_EPSA = customClaimEdge('edge_epsa', 'eduPersonScopedAffiliation', OID_EPSA);
export const EDGE_EPPN = customClaimEdge('edge_eppn', 'eduPersonPrincipalName', OID_EPPN);
export const EDGE_SCHAC_HOME_ORGANIZATION = systemEdge(
  'edge_schac_home',
  'schac_home_organization',
  'system.identity.schac_home_organization',
  OID_SCHAC_HOME_ORGANIZATION
);
export const EDGE_ORGANIZATION_NAME = systemEdge(
  'edge_organization_name',
  'organization_name',
  'system.identity.organization_name',
  OID_ORGANIZATION_NAME
);

const customClaimEntry = (claim: string) => ({
  id: `field.custom.${claim}`,
  namespace: 'authrim.custom_claims',
  path: claim,
  valueType: 'string',
  cardinality: 'multi' as const,
  classification: 'internal' as const,
  targetType: 'custom' as const,
});

/** The destination profile: mail and the four attributes this fixture can release. */
export const INSTITUTION_DESTINATION_SCHEMA = {
  ...PRODUCTION_DESTINATION_SCHEMA,
  attributes: [
    PRODUCTION_DESTINATION_SCHEMA.attributes.find((attribute) => attribute.name === OID_MAIL)!,
    ...[
      [OID_EPSA, 'eduPersonScopedAffiliation', 'multi'],
      [OID_EPPN, 'eduPersonPrincipalName', 'single'],
      [OID_SCHAC_HOME_ORGANIZATION, 'schacHomeOrganization', 'single'],
      [OID_ORGANIZATION_NAME, 'o', 'single'],
    ].map(([name, label, valueMultiplicity]) => ({
      name,
      label,
      valueType: 'string',
      valueMultiplicity,
      classification: 'pii',
    })),
  ],
};

/** The active mapping version: mail, then the edges chosen. */
export function institutionBinding(edges: readonly object[]) {
  const binding = productionBinding({ withInputEdges: false });
  return {
    ...binding,
    catalog: {
      ...binding.catalog,
      entries: [
        ...binding.catalog.entries,
        customClaimEntry('eduPersonScopedAffiliation'),
        customClaimEntry('eduPersonPrincipalName'),
      ],
    },
    edges: [PRODUCTION_EDGES[0], ...edges],
  };
}

/**
 * A core adapter that holds the person's selection of every attribute of the destination profile
 * (an optional attribute reaches the SP only when the person selected it).
 */
export function institutionCoreAdapter() {
  const selected = [
    OID_MAIL,
    OID_EPSA,
    OID_EPPN,
    OID_SCHAC_HOME_ORGANIZATION,
    OID_ORGANIZATION_NAME,
  ];
  return {
    query: async () => [],
    queryOne: async (sql: string) =>
      sql.includes('consent_records')
        ? {
            id: 'consent-selection',
            released_attributes_json: JSON.stringify(selected),
            evidence_json: '{}',
            created_at: 1,
          }
        : null,
    execute: async () => ({ rowsAffected: 0 }),
  };
}

/** The SP: every attribute optional unless named in `required`. */
export function institutionSpConfig(required: readonly string[] = [OID_MAIL]) {
  const names = [OID_MAIL, OID_EPSA, OID_EPPN, OID_SCHAC_HOME_ORGANIZATION, OID_ORGANIZATION_NAME];
  return productionSpConfig(
    Object.fromEntries(
      names.map((name) => [name, required.includes(name) ? 'required' : 'optional'])
    ) as Record<string, 'required' | 'optional'>
  );
}
