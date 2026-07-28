import { describe, expect, it } from 'vitest';
import type { FieldCatalogBundle } from '@authrim/ar-lib-field-mapping';
import {
  buildSAMLAttributesForSP,
  buildSAMLAttributesForSPWithDiagnostics,
  buildSAMLAttributesFromMapping,
  MissingRequiredSAMLAttributeError,
  SAMLIdentityMappingRuntimeError,
} from '../attributes';

describe('buildSAMLAttributesFromMapping', () => {
  it('maps current email/name/sub claims for backward compatibility', () => {
    const attributes = buildSAMLAttributesFromMapping(
      {
        id: 'user-123',
        email: 'user@example.com',
        name: 'Test User',
      },
      {
        email: 'urn:oid:0.9.2342.19200300.100.1.3',
        name: 'urn:oid:2.16.840.1.113730.3.1.241',
        sub: 'urn:oasis:names:tc:SAML:attribute:subject-id',
      }
    );

    expect(attributes).toEqual([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        values: ['user@example.com'],
      },
      {
        name: 'urn:oid:2.16.840.1.113730.3.1.241',
        values: ['Test User'],
      },
      {
        name: 'urn:oasis:names:tc:SAML:attribute:subject-id',
        values: ['user-123'],
      },
    ]);
  });

  it('can read future policy-backed claim namespaces without changing assertion code', () => {
    const attributes = buildSAMLAttributesFromMapping(
      {
        id: 'user-123',
        customClaims: {
          affiliation: ['member@example.edu', 'staff@example.edu'],
          entitlement: 'urn:mace:dir:entitlement:common-lib-terms',
        },
        attributes: {
          institutionCode: 'member-a',
        },
      },
      {
        'custom_claims.affiliation': 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
        'customClaims.entitlement': 'urn:oid:1.3.6.1.4.1.5923.1.1.1.7',
        'attributes.institutionCode': 'https://authrim.example/attr/member-institution',
      }
    );

    expect(attributes).toEqual([
      {
        name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
        values: ['member@example.edu', 'staff@example.edu'],
      },
      {
        name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.7',
        values: ['urn:mace:dir:entitlement:common-lib-terms'],
      },
      {
        name: 'https://authrim.example/attr/member-institution',
        values: ['member-a'],
      },
    ]);
  });

  it('skips unknown, empty, and object-valued claims', () => {
    const attributes = buildSAMLAttributesFromMapping(
      {
        id: 'user-123',
        email: '',
        customClaims: {
          objectValue: { nested: true },
          nullValue: null,
        },
      },
      {
        email: 'mail',
        name: 'displayName',
        'custom_claims.objectValue': 'objectValue',
        'custom_claims.nullValue': 'nullValue',
        'custom_claims.missing': 'missing',
      }
    );

    expect(attributes).toEqual([]);
  });

  it('normalizes number and boolean values to strings', () => {
    const attributes = buildSAMLAttributesFromMapping(
      {
        id: 'user-123',
        claims: {
          clearanceLevel: 3,
          betaEligible: false,
        },
      },
      {
        'claims.clearanceLevel': 'https://authrim.example/attr/clearance-level',
        'claims.betaEligible': 'https://authrim.example/attr/beta-eligible',
      }
    );

    expect(attributes).toEqual([
      {
        name: 'https://authrim.example/attr/clearance-level',
        values: ['3'],
      },
      {
        name: 'https://authrim.example/attr/beta-eligible',
        values: ['false'],
      },
    ]);
  });

  it('fails closed when only legacy attribute release policy is configured', () => {
    expect(() =>
      buildSAMLAttributesForSP(
        {
          id: 'user-123',
          email: 'user@example.com',
          name: 'Test User',
        },
        {
          attributeMapping: {
            email: 'legacy-mail',
          },
          attributeReleasePolicy: {
            attributes: [
              {
                name: 'urn:oid:0.9.2342.19200300.100.1.3',
                friendlyName: 'mail',
                source: 'claim',
                claim: 'email',
              },
            ],
          },
        }
      )
    ).toThrow(SAMLIdentityMappingRuntimeError);
  });

  it('does not use release policy value types without identity mapping', () => {
    expect(() =>
      buildSAMLAttributesForSP(
        {
          id: 'user-123',
          claims: {
            betaEligible: true,
          },
        },
        {
          attributeMapping: {},
          attributeReleasePolicy: {
            attributes: [
              {
                name: 'https://authrim.example/attr/beta-eligible',
                friendlyName: 'betaEligible',
                valueType: 'xs:boolean',
                source: 'claim',
                claim: 'claims.betaEligible',
              },
            ],
          },
        }
      )
    ).toThrow(SAMLIdentityMappingRuntimeError);
  });

  it('fails with identity mapping details when required policy attributes are configured alone', () => {
    let error: unknown;
    try {
      buildSAMLAttributesForSP(
        {
          id: 'user-123',
        },
        {
          attributeMapping: {},
          attributeReleasePolicy: {
            attributes: [
              {
                name: 'urn:oid:0.9.2342.19200300.100.1.3',
                friendlyName: 'mail',
                source: 'claim',
                claim: 'email',
                required: true,
              },
              {
                name: 'urn:oid:2.16.840.1.113730.3.1.241',
                friendlyName: 'displayName',
                source: 'claim',
                claim: 'name',
                required: true,
              },
            ],
          },
        }
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SAMLIdentityMappingRuntimeError);
    expect((error as SAMLIdentityMappingRuntimeError).reasons).toEqual([
      {
        category: 'policy',
        code: 'policy.missing_identity_mapping_binding',
        severity: 'critical',
      },
    ]);
  });

  it('does not report optional legacy policy attributes without identity mapping', () => {
    expect(() =>
      buildSAMLAttributesForSPWithDiagnostics(
        {
          id: 'user-123',
          email: 'user@example.com',
        },
        {
          attributeMapping: {},
          attributeReleasePolicy: {
            attributes: [
              {
                name: 'urn:oid:0.9.2342.19200300.100.1.3',
                friendlyName: 'mail',
                source: 'claim',
                claim: 'email',
              },
            ],
          },
        }
      )
    ).toThrow(SAMLIdentityMappingRuntimeError);
  });

  it('does not compute legacy policy attributes without identity mapping', () => {
    expect(() =>
      buildSAMLAttributesForSP(
        {
          id: 'user-123',
          customClaims: {
            affiliation: ['member', 'staff'],
            institutionScope: 'example.edu',
          },
        },
        {
          attributeMapping: {},
          attributeReleasePolicy: {
            attributes: [
              {
                name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
                friendlyName: 'eduPersonScopedAffiliation',
                source: 'computed',
                computed: 'eduPersonScopedAffiliation',
                claim: 'eduPersonScopedAffiliation',
              },
            ],
          },
        }
      )
    ).toThrow(SAMLIdentityMappingRuntimeError);
  });

  it('uses field mapping output before legacy SAML release paths', () => {
    const attributes = buildSAMLAttributesForSP(
      {
        id: 'user-123',
        email: 'user@example.edu',
      },
      {
        attributeMapping: {
          email: 'legacy-mail',
        },
        attributeReleasePolicy: {
          attributes: [
            {
              name: 'policy-mail',
              friendlyName: 'mail',
              source: 'claim',
              claim: 'email',
            },
          ],
        },
        identityMapping: {
          catalog: identityMappingSamlCatalog(),
          edges: [
            {
              id: 'edge.email.saml-mail',
              sourceRef: {
                side: 'source',
                namespace: 'authrim.profile',
                path: 'email',
                catalogEntryId: 'field.profile.email',
              },
              targetRef: {
                side: 'destination',
                namespace: 'saml.attribute',
                path: 'urn:oid:0.9.2342.19200300.100.1.3',
                catalogEntryId: 'field.saml.mail',
              },
            },
          ],
          attributeDescriptors: {
            'field.saml.mail': {
              friendlyName: 'mail',
              nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
              required: true,
            },
          },
        },
      }
    );

    expect(attributes).toEqual([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        friendlyName: 'mail',
        nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
        values: ['user@example.edu'],
      },
    ]);
  });

  it('treats missing required field mapping destinations as SAML release failures', () => {
    let error: unknown;
    try {
      buildSAMLAttributesForSP(
        {
          id: 'user-123',
        },
        {
          attributeMapping: {},
          identityMapping: {
            catalog: identityMappingSamlCatalog(),
            destinationFieldPolicies: {
              'urn:oid:0.9.2342.19200300.100.1.3': 'required',
            },
            edges: [
              {
                id: 'edge.email.saml-mail',
                sourceRef: {
                  side: 'source',
                  namespace: 'authrim.profile',
                  path: 'email',
                  catalogEntryId: 'field.profile.email',
                },
                targetRef: {
                  side: 'destination',
                  namespace: 'saml.attribute',
                  path: 'urn:oid:0.9.2342.19200300.100.1.3',
                  catalogEntryId: 'field.saml.mail',
                },
              },
            ],
          },
        }
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MissingRequiredSAMLAttributeError);
    expect((error as MissingRequiredSAMLAttributeError).missingAttributes).toEqual([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        source: 'identity_mapping',
        claim: 'urn:oid:0.9.2342.19200300.100.1.3',
      },
    ]);
  });

  it('omits optional mail attributes for users without an email address', () => {
    const result = buildSAMLAttributesForSPWithDiagnostics(
      {
        id: 'user-without-email',
      },
      {
        attributeMapping: {},
        identityMapping: {
          catalog: identityMappingSamlCatalog({ mailRequired: false }),
          edges: [
            {
              id: 'edge.email.saml-mail',
              sourceRef: {
                side: 'source',
                namespace: 'authrim.profile',
                path: 'email',
                catalogEntryId: 'field.profile.email',
              },
              targetRef: {
                side: 'destination',
                namespace: 'saml.attribute',
                path: 'urn:oid:0.9.2342.19200300.100.1.3',
                catalogEntryId: 'field.saml.mail',
              },
            },
          ],
        },
      }
    );

    expect(result).toEqual({
      attributes: [],
      optionalMissingAttributes: [],
    });
  });

  it('selects the SAML field mapping set binding by IdP role and SP entityID', () => {
    const catalog = identityMappingSamlCatalog({ mailRequired: false });
    const spSpecificConfig = {
      entityId: 'https://sp.example.edu/saml',
      attributeMapping: {},
      identityMapping: {
        defaultBinding: {
          id: 'tenant-default',
          role: 'idp' as const,
          catalog,
          edges: [
            identityMappingEdge(
              'field.profile.email',
              'authrim.profile',
              'email',
              'field.saml.mail',
              'urn:oid:0.9.2342.19200300.100.1.3'
            ),
          ],
          attributeDescriptors: {
            'field.saml.mail': {
              friendlyName: 'mail',
            },
          },
        },
        bindings: [
          {
            id: 'sp-specific',
            role: 'idp' as const,
            partnerEntityId: 'https://sp.example.edu/saml',
            fieldMappingSetId: 'policy-set-sp-example',
            fieldMappingVersionId: 'policy-version-1',
            catalog,
            edges: [
              identityMappingEdge(
                'field.profile.name',
                'authrim.profile',
                'name',
                'field.saml.displayName',
                'urn:oid:2.16.840.1.113730.3.1.241'
              ),
            ],
            attributeDescriptors: {
              'field.saml.displayName': {
                friendlyName: 'displayName',
              },
            },
          },
        ],
      },
    };

    expect(
      buildSAMLAttributesForSP(
        {
          id: 'user-123',
          email: 'user@example.edu',
          name: 'Specific User',
        },
        spSpecificConfig
      )
    ).toEqual([
      {
        name: 'urn:oid:2.16.840.1.113730.3.1.241',
        friendlyName: 'displayName',
        values: ['Specific User'],
      },
    ]);

    expect(
      buildSAMLAttributesForSP(
        {
          id: 'user-123',
          email: 'user@example.edu',
          name: 'Default User',
        },
        {
          ...spSpecificConfig,
          entityId: 'https://other-sp.example.edu/saml',
        }
      )
    ).toEqual([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        friendlyName: 'mail',
        values: ['user@example.edu'],
      },
    ]);
  });

  it('does not fall back to another SP-specific field mapping binding', () => {
    let error: unknown;
    try {
      buildSAMLAttributesForSP(
        {
          id: 'user-123',
          email: 'user@example.edu',
        },
        {
          entityId: 'https://other-sp.example.edu/saml',
          attributeMapping: {},
          identityMapping: {
            bindings: [
              {
                id: 'sp-specific',
                role: 'idp' as const,
                partnerEntityId: 'https://sp.example.edu/saml',
                catalog: identityMappingSamlCatalog({ mailRequired: false }),
                edges: [
                  identityMappingEdge(
                    'field.profile.email',
                    'authrim.profile',
                    'email',
                    'field.saml.mail',
                    'urn:oid:0.9.2342.19200300.100.1.3'
                  ),
                ],
              },
            ],
          },
        }
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SAMLIdentityMappingRuntimeError);
    expect((error as SAMLIdentityMappingRuntimeError).reasons).toEqual([
      {
        category: 'policy',
        code: 'policy.missing_identity_mapping_binding',
        severity: 'critical',
      },
    ]);
  });

  it('merges multiple field mapping outputs for the same SAML attribute', () => {
    const attributes = buildSAMLAttributesForSP(
      {
        id: 'user-123',
        email: 'user@example.edu',
        name: 'User Alias',
      },
      {
        entityId: 'https://sp.example.edu/saml',
        attributeMapping: {},
        identityMapping: {
          catalog: identityMappingSamlCatalog({ mailRequired: false }),
          edges: [
            identityMappingEdge(
              'field.profile.email',
              'authrim.profile',
              'email',
              'field.saml.mail',
              'urn:oid:0.9.2342.19200300.100.1.3'
            ),
            identityMappingEdge(
              'field.profile.name',
              'authrim.profile',
              'name',
              'field.saml.mail',
              'urn:oid:0.9.2342.19200300.100.1.3'
            ),
          ],
          attributeDescriptors: {
            'field.saml.mail': {
              friendlyName: 'mail',
            },
          },
        },
      }
    );

    expect(attributes).toEqual([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        friendlyName: 'mail',
        values: ['user@example.edu', 'User Alias'],
      },
    ]);
  });

  it('prefers a local IdP-specific field mapping binding over a global SP binding', () => {
    const catalog = identityMappingSamlCatalog({ mailRequired: false });

    expect(
      buildSAMLAttributesForSP(
        {
          id: 'user-123',
          email: 'global@example.edu',
          name: 'Local User',
        },
        {
          entityId: 'https://sp.example.edu/saml',
          localEntityId: 'https://idp-a.example.edu/saml/idp',
          attributeMapping: {},
          identityMapping: {
            bindings: [
              {
                id: 'global-sp-binding',
                role: 'idp' as const,
                partnerEntityId: 'https://sp.example.edu/saml',
                catalog,
                edges: [
                  identityMappingEdge(
                    'field.profile.email',
                    'authrim.profile',
                    'email',
                    'field.saml.mail',
                    'urn:oid:0.9.2342.19200300.100.1.3'
                  ),
                ],
                attributeDescriptors: {
                  'field.saml.mail': {
                    friendlyName: 'mail',
                  },
                },
              },
              {
                id: 'local-idp-sp-binding',
                role: 'idp' as const,
                localEntityId: 'https://idp-a.example.edu/saml/idp',
                partnerEntityId: 'https://sp.example.edu/saml',
                catalog,
                edges: [
                  identityMappingEdge(
                    'field.profile.name',
                    'authrim.profile',
                    'name',
                    'field.saml.displayName',
                    'urn:oid:2.16.840.1.113730.3.1.241'
                  ),
                ],
                attributeDescriptors: {
                  'field.saml.displayName': {
                    friendlyName: 'displayName',
                  },
                },
              },
            ],
          },
        }
      )
    ).toEqual([
      {
        name: 'urn:oid:2.16.840.1.113730.3.1.241',
        friendlyName: 'displayName',
        values: ['Local User'],
      },
    ]);
  });

  it('reads every supported identity-mapping source namespace without crossing data stores', () => {
    const cases = [
      ['authrim.profile', 'email', 'profile@example.test'],
      ['authrim.claim', 'name', 'Profile Name'],
      ['oidc.claim', 'email', 'profile@example.test'],
      ['authrim.claims', 'department', 'engineering'],
      ['claims', 'department', 'engineering'],
      ['authrim.custom_claims', 'entitlement', 'licensed'],
      ['custom_claims', 'entitlement', 'licensed'],
      ['authrim.custom_fields', 'employeeNumber', 42],
      ['custom_fields', 'employeeNumber', 42],
      ['authrim.attributes', 'groups', ['admin', 'editor']],
      ['attributes', 'groups', ['admin', 'editor']],
      ['authrim.system', 'uid', 'user-123'],
      ['authrim.system', 'email', 'profile@example.test'],
      ['vendor.extension', 'name', 'Profile Name'],
    ] as const;
    const entries: FieldCatalogBundle['entries'] = [];
    const edges = cases.map(([namespace, path], index) => {
      const sourceId = `source.${index}`;
      const destinationId = `destination.${index}`;
      entries.push(
        {
          id: sourceId,
          namespace,
          path,
          valueType: 'string',
          cardinality: 'multi',
          classification: 'internal',
          targetType: 'canonical',
        },
        {
          id: destinationId,
          namespace: 'saml.attribute',
          path: `urn:test:attribute:${index}`,
          valueType: 'string',
          cardinality: 'multi',
          classification: 'internal',
          targetType: 'destination-only',
        }
      );
      return identityMappingEdge(
        sourceId,
        namespace,
        path,
        destinationId,
        `urn:test:attribute:${index}`
      );
    });
    const attributes = buildSAMLAttributesForSP(
      {
        id: 'user-123',
        email: 'profile@example.test',
        name: 'Profile Name',
        claims: { department: 'engineering' },
        customClaims: { entitlement: 'licensed' },
        customFields: { employeeNumber: 42 },
        attributes: { groups: ['admin', 'editor'] },
      },
      {
        attributeMapping: {},
        identityMapping: {
          catalog: {
            identity: {
              id: 'namespace-matrix',
              version: '1',
              contentHash: 'namespace-matrix',
              compatibilityRange: '^0.3.0',
            },
            entries,
          },
          edges,
        },
      }
    );
    expect(attributes).toHaveLength(cases.length);
    expect(attributes[9]?.values).toEqual(['admin', 'editor']);
    expect(attributes[11]?.values).toEqual(['user-123']);
  });

  it.each([
    ['saml:persistent-nameid', 'saml:persistent-nameid'],
    [' XS:BOOLEAN ', 'xs:boolean'],
    ['xs:integer', 'xs:integer'],
    ['xs:datetime', 'xs:dateTime'],
    ['xs:anyuri', 'xs:anyURI'],
    ['xs:string', 'xs:string'],
    ['unsupported', undefined],
    ['', undefined],
  ] as const)('normalizes mapped SAML value type %s', (configured, expected) => {
    const catalog = identityMappingSamlCatalog({ mailRequired: false });
    catalog.entries.find((entry) => entry.id === 'field.saml.mail')!.valueType =
      configured as never;
    const attributes = buildSAMLAttributesForSP(
      { id: 'user-123', email: 'user@example.test' },
      {
        attributeMapping: {},
        identityMapping: {
          catalog,
          edges: [
            identityMappingEdge(
              'field.profile.email',
              'authrim.profile',
              'email',
              'field.saml.mail',
              'urn:oid:0.9.2342.19200300.100.1.3'
            ),
          ],
        },
      }
    );
    expect(attributes[0]?.valueType).toBe(expected);
  });

  it('uses the SP destination field policy instead of destination profile required flags', () => {
    const catalog = identityMappingSamlCatalog();
    expect(() =>
      buildSAMLAttributesForSP(
        { id: 'user-123' },
        {
          attributeMapping: {},
          identityMapping: {
            catalog,
            edges: [
              identityMappingEdge(
                'field.profile.email',
                'authrim.profile',
                'email',
                'field.saml.mail',
                'urn:oid:0.9.2342.19200300.100.1.3'
              ),
            ],
            attributeDescriptors: {
              'urn:oid:0.9.2342.19200300.100.1.3': { name: 'mail', required: true },
              'saml.attribute:urn:oid:0.9.2342.19200300.100.1.3': {
                name: 'mail',
                required: true,
              },
            },
            destinationFieldPolicies: { mail: 'required' },
          },
        }
      )
    ).toThrow(MissingRequiredSAMLAttributeError);
  });

  it('does not emit attributes hidden by the SP destination field policy', () => {
    const result = buildSAMLAttributesForSP(
      { id: 'user-123', email: 'user@example.edu' },
      {
        attributeMapping: {},
        identityMapping: {
          catalog: identityMappingSamlCatalog(),
          edges: [
            identityMappingEdge(
              'field.profile.email',
              'authrim.profile',
              'email',
              'field.saml.mail',
              'urn:oid:0.9.2342.19200300.100.1.3'
            ),
          ],
          destinationFieldPolicies: {
            'urn:oid:0.9.2342.19200300.100.1.3': 'hidden',
          },
        },
      }
    );

    expect(result).toEqual([]);
  });
});

function identityMappingSamlCatalog(options: { mailRequired?: boolean } = {}): FieldCatalogBundle {
  return {
    identity: {
      id: 'authrim.identity-mapping.saml.test',
      version: '2026-06-06',
      contentHash: 'identity-mapping-saml-test',
      compatibilityRange: '^0.3.0',
    },
    entries: [
      {
        id: 'field.profile.email',
        namespace: 'authrim.profile',
        path: 'email',
        valueType: 'string',
        cardinality: 'single',
        classification: 'pii',
        targetType: 'canonical',
      },
      {
        id: 'field.profile.name',
        namespace: 'authrim.profile',
        path: 'name',
        valueType: 'string',
        cardinality: 'single',
        classification: 'pii',
        targetType: 'canonical',
      },
      {
        id: 'field.saml.mail',
        namespace: 'saml.attribute',
        path: 'urn:oid:0.9.2342.19200300.100.1.3',
        valueType: 'string',
        cardinality: 'single',
        classification: 'pii',
        targetType: 'destination-only',
        required: options.mailRequired ?? true,
      },
      {
        id: 'field.saml.displayName',
        namespace: 'saml.attribute',
        path: 'urn:oid:2.16.840.1.113730.3.1.241',
        valueType: 'string',
        cardinality: 'single',
        classification: 'pii',
        targetType: 'destination-only',
      },
    ],
  };
}

function identityMappingEdge(
  sourceCatalogEntryId: string,
  sourceNamespace: string,
  sourcePath: string,
  targetCatalogEntryId: string,
  targetPath: string
) {
  return {
    id: `edge.${sourceCatalogEntryId}.${targetCatalogEntryId}`,
    sourceRef: {
      side: 'source' as const,
      namespace: sourceNamespace,
      path: sourcePath,
      catalogEntryId: sourceCatalogEntryId,
    },
    targetRef: {
      side: 'destination' as const,
      namespace: 'saml.attribute',
      path: targetPath,
      catalogEntryId: targetCatalogEntryId,
    },
  };
}
