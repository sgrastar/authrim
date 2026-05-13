import { describe, expect, it } from 'vitest';
import {
  buildSAMLAttributesForSP,
  buildSAMLAttributesForSPWithDiagnostics,
  buildSAMLAttributesFromMapping,
  MissingRequiredSAMLAttributeError,
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
});
