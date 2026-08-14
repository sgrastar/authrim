import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptCsvPreview } from '../../adapters/csv';
import { adaptOidcClaimsPreview } from '../../adapters/oidc';
import { adaptSamlAttributesPreview } from '../../adapters/saml';
import { adaptScimUserPreview } from '../../adapters/scim';
import { dryRunMapping } from '../../core/dry-run';
import { resolveEffectiveFieldMappingSet } from '../../core/field-mapping-set';
import type { FieldMappingSet } from '../../core/types';
import { TEST_CATALOG, edge, fieldRef, validateStaticFixture } from '../../test-support';
import type { StaticFixtureKind } from '../../test-support';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '../../..');
const fixtureRoot = resolve(packageRoot, 'fixtures');

const fixtureNames: StaticFixtureKind[] = [
  'csv-user',
  'scim-user',
  'saml-attributes',
  'oidc-claims-request',
  'malformed-user',
  'regulated-user',
  'conflict-field-mapping-set',
];

const emailEdge = edge(fieldRef('csv', 'email', 'field.csv.email'), {
  side: 'canonical',
  namespace: 'authrim.profile',
  path: 'email',
  catalogEntryId: 'field.canonical.email',
});

describe('static fixtures', () => {
  it('keeps every PR1 static fixture shape valid', () => {
    for (const name of fixtureNames) {
      const fixture = readFixture(name);
      expect(validateStaticFixture(name, fixture).reasons).toEqual([]);
    }
  });

  it('runs CSV, regulated, and malformed fixtures through dry-run without raw value trace', () => {
    const csv = readFixture<Record<string, unknown>>('csv-user');
    const regulated = readFixture<Record<string, unknown>>('regulated-user');
    const malformed = readFixture<Record<string, unknown>>('malformed-user');

    const csvResult = dryRunMapping(
      adaptCsvPreview({
        row: csv,
        columnToPath: { email: 'email' },
        catalog: TEST_CATALOG,
        edges: [emailEdge],
      }).input!
    );
    const regulatedResult = dryRunMapping(
      adaptCsvPreview({
        row: regulated,
        columnToPath: { employeeNumber: 'employeeNumber' },
        catalog: TEST_CATALOG,
        edges: [
          edge(fieldRef('csv', 'employeeNumber', 'field.csv.employee_number'), {
            side: 'canonical',
            namespace: 'csv',
            path: 'employeeNumber',
            catalogEntryId: 'field.csv.employee_number',
          }),
        ],
      }).input!
    );
    const malformedResult = dryRunMapping(
      adaptCsvPreview({
        row: malformed,
        columnToPath: { email: 'email' },
        catalog: TEST_CATALOG,
        edges: [emailEdge],
      }).input!
    );

    expect(csvResult.status).toBe('success');
    expect(regulatedResult.redactedValueSummaries[0]?.classification).toBe('regulated');
    expect(malformedResult.reasons.map((item) => item.code)).toContain('validation.type_mismatch');
    expect(JSON.stringify([csvResult, regulatedResult, malformedResult])).not.toContain(
      'regulated@example.test'
    );
  });

  it('runs SCIM, SAML, and OIDC protocol fixtures through preview adapters', () => {
    const scim = adaptScimUserPreview({
      user: readFixture<Record<string, unknown>>('scim-user'),
      catalog: TEST_CATALOG,
      edges: [emailEdge],
    });
    const saml = adaptSamlAttributesPreview({
      attributes: readFixture('saml-attributes'),
      catalog: TEST_CATALOG,
      edges: [emailEdge],
    });
    const oidc = adaptOidcClaimsPreview({
      claims: readFixture<Record<string, unknown>>('oidc-claims-request'),
      catalog: TEST_CATALOG,
      edges: [emailEdge],
    });

    expect(
      scim.input?.sourceValues.some((item) => item.sourceRef.namespace === 'scim.attribute')
    ).toBe(true);
    expect(saml.input?.sourceValues[0]?.metadata?.samlAttributeName).toBe('mail');
    expect(oidc.input?.sourceValues[0]?.metadata?.oidcClaimName).toBe('email');
  });

  it('uses conflict fixture to explain discarded field mapping rules', () => {
    const fixture = readFixture<{ sets: FieldMappingSet[] }>('conflict-field-mapping-set');
    const result = resolveEffectiveFieldMappingSet({ sets: fixture.sets });

    expect(result.mergedSet.rules[0]?.id).toBe('deny.tenant.email');
    expect(result.discardedRuleSummary.map((item) => item.ruleId)).toEqual([
      'allow.platform.email',
    ]);
  });
});

function readFixture<T = unknown>(name: StaticFixtureKind): T {
  return JSON.parse(readFileSync(resolve(fixtureRoot, `${name}.json`), 'utf8')) as T;
}
