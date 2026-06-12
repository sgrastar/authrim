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

  it('uses attribute release policy when configured', () => {
    const attributes = buildSAMLAttributesForSP(
      {
        id: 'user-123',
        email: 'user@example.com',
        name: 'Test User',
        customClaims: {
          affiliation: ['member@example.edu', 'staff@example.edu'],
        },
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
              nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
              source: 'claim',
              claim: 'email',
            },
            {
              name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
              friendlyName: 'eduPersonScopedAffiliation',
              source: 'custom_claim',
              claim: 'affiliation',
            },
            {
              name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.7',
              friendlyName: 'eduPersonEntitlement',
              source: 'constant',
              value: ['urn:mace:dir:entitlement:common-lib-terms'],
            },
          ],
        },
      }
    );

    expect(attributes).toEqual([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        friendlyName: 'mail',
        nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
        values: ['user@example.com'],
      },
      {
        name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
        friendlyName: 'eduPersonScopedAffiliation',
        values: ['member@example.edu', 'staff@example.edu'],
      },
      {
        name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.7',
        friendlyName: 'eduPersonEntitlement',
        values: ['urn:mace:dir:entitlement:common-lib-terms'],
      },
    ]);
  });

  it('carries AttributeValue XML Schema type from release policy rules', () => {
    const attributes = buildSAMLAttributesForSP(
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
    );

    expect(attributes).toEqual([
      {
        name: 'https://authrim.example/attr/beta-eligible',
        friendlyName: 'betaEligible',
        valueType: 'xs:boolean',
        values: ['true'],
      },
    ]);
  });

  it('fails with structured details when required policy attributes are missing', () => {
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

    expect(error).toBeInstanceOf(MissingRequiredSAMLAttributeError);
    expect((error as MissingRequiredSAMLAttributeError).missingAttributes).toEqual([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        friendlyName: 'mail',
        source: 'claim',
        claim: 'email',
      },
      {
        name: 'urn:oid:2.16.840.1.113730.3.1.241',
        friendlyName: 'displayName',
        source: 'claim',
        claim: 'name',
      },
    ]);
  });

  it('reports optional missing policy attributes without failing', () => {
    const result = buildSAMLAttributesForSPWithDiagnostics(
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
            {
              name: 'urn:oid:2.16.840.1.113730.3.1.241',
              friendlyName: 'displayName',
              source: 'claim',
              claim: 'name',
            },
          ],
        },
      }
    );

    expect(result.attributes).toEqual([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        friendlyName: 'mail',
        values: ['user@example.com'],
      },
    ]);
    expect(result.optionalMissingAttributes).toEqual([
      {
        name: 'urn:oid:2.16.840.1.113730.3.1.241',
        friendlyName: 'displayName',
        source: 'claim',
        claim: 'name',
      },
    ]);
  });

  it('computes eduPersonScopedAffiliation when the direct custom claim is missing', () => {
    const attributes = buildSAMLAttributesForSP(
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
    );

    expect(attributes).toEqual([
      {
        name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
        friendlyName: 'eduPersonScopedAffiliation',
        values: ['member@example.edu', 'staff@example.edu'],
      },
    ]);
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

  it('builds eduPersonTargetedID from the current SP context without releasing the input UID', () => {
    const catalog = identityMappingSamlCatalog({
      mailRequired: false,
      targetedIdValueType: 'saml:persistent-nameid',
    });
    const uidToTargetedIdEdge = identityMappingEdge(
      'field.system.uid',
      'authrim.system',
      'uid',
      'field.saml.eduPersonTargetedID',
      'eduPersonTargetedID'
    );
    const config = {
      attributeMapping: {},
      tenantId: 'default',
      localEntityId: 'https://idp.example.edu/idp/shibboleth',
      entityId: 'https://sp-a.example.org/shibboleth-sp',
      identityMapping: {
        role: 'idp' as const,
        catalog,
        edges: [{ ...uidToTargetedIdEdge, edgeKind: 'transform_input' }],
        transforms: [
          {
            id: 'transform.eduPersonTargetedID',
            inputEdgeIds: [uidToTargetedIdEdge.id],
            operation: 'saml_edu_person_targeted_id' as const,
            outputTargetRef: uidToTargetedIdEdge.targetRef,
          },
        ],
        runtimeContext: {
          saml: {
            localEntityId: 'https://idp.example.edu/idp/shibboleth',
            partnerEntityId: 'https://sp-a.example.org/shibboleth-sp',
            eduPersonTargetedIdOpaque: 'opaque-for-sp-a',
          },
        },
      },
    };

    const attributes = buildSAMLAttributesForSP(
      {
        id: 'user-123',
        email: 'user@example.edu',
      },
      config
    );

    expect(attributes).toEqual([
      {
        name: 'eduPersonTargetedID',
        valueType: 'saml:persistent-nameid',
        values: [
          'https://idp.example.edu/idp/shibboleth!https://sp-a.example.org/shibboleth-sp!opaque-for-sp-a',
        ],
      },
    ]);
    expect(JSON.stringify(attributes)).not.toContain('user-123');
  });

  it('keeps one mapping set while changing eduPersonTargetedID per SP runtime context', () => {
    const catalog = identityMappingSamlCatalog({ mailRequired: false });
    const uidToTargetedIdEdge = identityMappingEdge(
      'field.system.uid',
      'authrim.system',
      'uid',
      'field.saml.eduPersonTargetedID',
      'eduPersonTargetedID'
    );
    const baseIdentityMapping = {
      role: 'idp' as const,
      catalog,
      edges: [{ ...uidToTargetedIdEdge, edgeKind: 'transform_input' }],
      transforms: [
        {
          id: 'transform.eduPersonTargetedID',
          inputEdgeIds: [uidToTargetedIdEdge.id],
          operation: 'saml_edu_person_targeted_id' as const,
          outputTargetRef: uidToTargetedIdEdge.targetRef,
        },
      ],
    };

    const releaseFor = (spEntityId: string, opaque: string) =>
      buildSAMLAttributesForSP(
        {
          id: 'user-123',
          email: 'user@example.edu',
        },
        {
          attributeMapping: {},
          localEntityId: 'https://idp.example.edu/idp/shibboleth',
          entityId: spEntityId,
          identityMapping: {
            ...baseIdentityMapping,
            runtimeContext: {
              saml: {
                localEntityId: 'https://idp.example.edu/idp/shibboleth',
                partnerEntityId: spEntityId,
                eduPersonTargetedIdOpaque: opaque,
              },
            },
          },
        }
      )[0]?.values[0];

    expect(releaseFor('https://sp-a.example.org/shibboleth-sp', 'opaque-a')).toBe(
      'https://idp.example.edu/idp/shibboleth!https://sp-a.example.org/shibboleth-sp!opaque-a'
    );
    expect(releaseFor('https://sp-b.example.org/shibboleth-sp', 'opaque-b')).toBe(
      'https://idp.example.edu/idp/shibboleth!https://sp-b.example.org/shibboleth-sp!opaque-b'
    );
  });

  it('selects an active tenant-scoped runtime binding when the SAML SP context includes tenantId', () => {
    const attributes = buildSAMLAttributesForSP(
      {
        id: 'user-123',
        email: 'user@example.edu',
      },
      {
        attributeMapping: {},
        tenantId: 'default',
        localEntityId: 'https://idp.example.edu/idp/shibboleth',
        entityId: 'https://sp.example.edu/shibboleth-sp',
        identityMapping: {
          id: 'mapping_activation_active',
          role: 'idp' as const,
          tenantId: 'default',
          localEntityId: 'https://idp.example.edu/idp/shibboleth',
          partnerEntityId: 'https://sp.example.edu/shibboleth-sp',
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
      }
    );

    expect(attributes).toMatchObject([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
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

  it('emits mapped SAML attributes when the runtime catalog has no destination entries', () => {
    const attributes = buildSAMLAttributesForSP(
      {
        id: 'user-123',
        email: 'user@example.edu',
      },
      {
        entityId: 'https://sp.example.edu/saml',
        attributeMapping: {},
        identityMapping: {
          catalog: {
            identity: {
              id: 'empty-runtime-catalog',
              version: 'v1',
              contentHash: 'empty',
              compatibilityRange: '^0.3.0',
            },
            entries: [],
          },
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
      }
    );

    expect(attributes).toEqual([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        friendlyName: 'mail',
        values: ['user@example.edu'],
      },
    ]);
  });
});

function identityMappingSamlCatalog(
  options: { mailRequired?: boolean; targetedIdValueType?: string } = {}
): FieldCatalogBundle {
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
        id: 'field.system.uid',
        namespace: 'authrim.system',
        path: 'uid',
        valueType: 'string',
        cardinality: 'single',
        classification: 'internal',
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
      {
        id: 'field.saml.eduPersonTargetedID',
        namespace: 'saml.attribute',
        path: 'eduPersonTargetedID',
        valueType: options.targetedIdValueType ?? 'string',
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
