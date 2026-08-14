import { describe, expect, it } from 'vitest';
import { adaptCsvPreview } from '../../adapters/csv';
import { adaptOidcClaimsPreview } from '../../adapters/oidc';
import { adaptSamlAttributesPreview } from '../../adapters/saml';
import { adaptScimUserPreview } from '../../adapters/scim';
import { TEST_CATALOG, edge, fieldRef } from '../../test-support';

const emailEdge = edge(fieldRef('csv', 'email', 'field.csv.email'), {
  side: 'canonical',
  namespace: 'authrim.profile',
  path: 'email',
  catalogEntryId: 'field.canonical.email',
});

describe('preview adapters', () => {
  it('converts CSV preview records and reports missing columns', () => {
    const result = adaptCsvPreview({
      row: { email: 'user@example.test' },
      columnToPath: { email: 'email' },
      requiredColumns: ['employeeNumber'],
      catalog: TEST_CATALOG,
      edges: [emailEdge],
    });

    expect(result.status).toBe('partial');
    expect(result.reasons[0]?.code).toBe('adapter.missing_column');
    expect(result.input?.sourceValues[0]?.metadata).toEqual({
      sourceType: 'csv',
      columnName: 'email',
      csvHeaderName: 'email',
    });
  });

  it('converts SCIM, SAML, and OIDC preview shapes', () => {
    expect(
      adaptScimUserPreview({
        user: {
          userName: 'user@example.test',
          active: true,
          emails: [{ value: 'primary@example.test', primary: true }],
          'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
            employeeNumber: 'E-001',
            costCenter: 'CC-42',
          },
        },
        catalog: TEST_CATALOG,
        edges: [emailEdge],
      }).input?.sourceValues.map((item) => item.sourceRef.namespace)
    ).toContain('scim.attribute');

    const scimValues = adaptScimUserPreview({
      user: {
        emails: [{ value: 'primary@example.test', primary: true }],
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
          employeeNumber: 'E-001',
          costCenter: 'CC-42',
        },
      },
      catalog: TEST_CATALOG,
      edges: [emailEdge],
    }).input?.sourceValues;
    expect(scimValues?.find((item) => item.sourceRef.path === 'emails.value')?.value).toBe(
      'primary@example.test'
    );
    expect(
      scimValues?.find((item) => item.sourceRef.path === 'enterprise.employeeNumber')?.value
    ).toBe('E-001');
    expect(scimValues?.find((item) => item.sourceRef.path === 'enterprise.costCenter')?.value).toBe(
      'CC-42'
    );

    expect(
      adaptSamlAttributesPreview({
        attributes: [{ name: 'mail', values: ['user@example.test'] }],
        catalog: TEST_CATALOG,
        edges: [emailEdge],
      }).input?.sourceValues[0]?.metadata?.samlAttributeName
    ).toBe('mail');

    expect(
      adaptOidcClaimsPreview({
        claims: { email: { essential: true } },
        catalog: TEST_CATALOG,
        edges: [emailEdge],
      }).input?.sourceValues[0]?.metadata?.oidcClaimName
    ).toBe('email');
  });
});
