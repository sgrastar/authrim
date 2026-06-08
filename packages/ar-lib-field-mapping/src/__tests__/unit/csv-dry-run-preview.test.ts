import { describe, expect, it } from 'vitest';
import { previewCsvDryRun } from '../../previews/csv-dry-run';
import { createTestFingerprintProvider, edge, fieldRef, TEST_CATALOG } from '../../test-support';
import type { FieldRef } from '../../core/types';

const emailSource = fieldRef('csv', 'email', 'field.csv.email');
const emailTarget: FieldRef = {
  side: 'canonical',
  namespace: 'authrim.profile',
  path: 'email',
  catalogEntryId: 'field.canonical.email',
};

describe('previewCsvDryRun', () => {
  it('produces row-level dry-run results and canonical target preview without raw values', () => {
    const result = previewCsvDryRun({
      rows: [{ email: 'person@example.test', display_name: 'Private Name' }],
      columnToPath: { email: 'email' },
      catalog: TEST_CATALOG,
      edges: [edge(emailSource, emailTarget)],
      fingerprintProvider: createTestFingerprintProvider(),
    });

    expect(result.status).toBe('success');
    expect(result.summary).toMatchObject({
      totalRows: 1,
      successRows: 1,
      partialRows: 0,
      failedRows: 0,
    });
    expect(result.rowResults[0]?.canonicalTargetPreview).toEqual([
      {
        action: 'mapped',
        namespace: 'authrim.profile',
        path: 'email',
        catalogEntryId: 'field.canonical.email',
        edgeId: expect.any(String),
        transformStepId: null,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('person@example.test');
    expect(JSON.stringify(result)).not.toContain('Private Name');
  });

  it('reports missing required CSV columns as structured adapter errors', () => {
    const result = previewCsvDryRun({
      rows: [{ email: 'person@example.test' }],
      columnToPath: { email: 'email', employee_number: 'employeeNumber' },
      catalog: TEST_CATALOG,
      edges: [edge(emailSource, emailTarget)],
      requiredColumns: ['email', 'employee_number'],
    });

    expect(result.status).toBe('partial');
    expect(result.summary.adapterErrorRows).toBe(1);
    expect(result.rowResults[0]?.adapterReasons).toContainEqual({
      category: 'adapter',
      code: 'adapter.missing_column',
      severity: 'error',
    });
    expect(result.reasonCounts).toContainEqual({ code: 'adapter.missing_column', count: 1 });
  });

  it('returns deterministic header suggestions for mapped and unmapped columns', () => {
    const result = previewCsvDryRun({
      rows: [{ email: 'person@example.test', 'Employee Number': 'E-1' }],
      columnToPath: { email: 'email' },
      catalog: TEST_CATALOG,
      edges: [edge(emailSource, emailTarget)],
    });

    expect(result.headerSuggestions).toEqual([
      {
        columnName: 'email',
        mapped: true,
        suggestedPath: 'email',
        catalogEntryId: 'field.csv.email',
        classification: 'pii',
        valueType: 'string',
      },
      {
        columnName: 'Employee Number',
        mapped: false,
        suggestedPath: 'employeeNumber',
        catalogEntryId: 'field.csv.employee_number',
        classification: 'regulated',
        valueType: 'string',
      },
    ]);
  });

  it('caps preview rows without persisting or evaluating beyond maxRows', () => {
    const result = previewCsvDryRun({
      rows: [{ email: 'one@example.test' }, { email: 'two@example.test' }],
      columnToPath: { email: 'email' },
      catalog: TEST_CATALOG,
      edges: [edge(emailSource, emailTarget)],
      maxRows: 1,
    });

    expect(result.summary.totalRows).toBe(1);
    expect(result.rowResults).toHaveLength(1);
  });
});
