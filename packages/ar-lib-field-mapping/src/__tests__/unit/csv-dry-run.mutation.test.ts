import { describe, expect, it } from 'vitest';
import { previewCsvDryRun } from '../../previews/csv-dry-run';
import { edge, fieldRef, TEST_CATALOG } from '../../test-support';
import type { FieldRef, ValidationRule } from '../../core/types';

const emailSource = fieldRef('csv', 'email');
const emailTarget: FieldRef = {
  side: 'canonical',
  namespace: 'authrim.profile',
  path: 'email',
  catalogEntryId: 'field.canonical.email',
};
const emailEdge = edge(emailSource, emailTarget);

const requiredEmail: ValidationRule = {
  id: 'required.email',
  kind: 'required',
  targetRef: { side: 'source', namespace: 'csv', path: 'email' },
};
const enumEmail: ValidationRule = {
  id: 'enum.email',
  kind: 'enum',
  targetRef: { side: 'source', namespace: 'csv', path: 'email' },
  parameters: { allowedValues: ['a@example.test', ''] },
};

function preview(
  rows: Array<Record<string, unknown>>,
  extra: Partial<Parameters<typeof previewCsvDryRun>[0]> = {}
) {
  return previewCsvDryRun({
    rows,
    columnToPath: { email: 'email' },
    catalog: TEST_CATALOG,
    edges: [emailEdge],
    ...extra,
  });
}

describe('previewCsvDryRun aggregation', () => {
  const rows = [
    { email: 'zzz', phone: '1' },
    { email: 'a@example.test' },
    { email: '', phone: '1' },
    { email: 'a@example.test', phone: '1' },
  ];
  const result = preview(rows, {
    requiredColumns: ['phone'],
    validationRules: [requiredEmail, enumEmail],
  });

  it('classifies every row from its adapter and dry-run outcome', () => {
    expect(result.rowResults.map((row) => row.rowIndex)).toEqual([0, 1, 2, 3]);
    expect(result.rowResults.map((row) => row.adapterStatus)).toEqual([
      'success',
      'partial',
      'success',
      'success',
    ]);
    expect(result.rowResults.map((row) => row.dryRun?.status)).toEqual([
      'partial',
      'success',
      'failed',
      'success',
    ]);
    expect(result.rowResults.map((row) => row.status)).toEqual([
      'partial',
      'partial',
      'failed',
      'success',
    ]);
  });

  it('summarizes row outcomes', () => {
    expect(result.status).toBe('failed');
    expect(result.summary).toEqual({
      totalRows: 4,
      successRows: 1,
      partialRows: 2,
      failedRows: 1,
      adapterErrorRows: 1,
      dryRunErrorRows: 2,
    });
  });

  it('counts adapter and dry-run reasons by code in code order', () => {
    expect(result.reasonCounts).toEqual([
      { code: 'adapter.missing_column', count: 1 },
      { code: 'validation.required_missing', count: 1 },
      { code: 'validation.value_not_allowed', count: 1 },
    ]);
  });

  it('adds up repeated reasons across rows and sources', () => {
    const repeated = preview([{ email: '' }, { email: '' }, { phone: 'x' }], {
      requiredColumns: ['email', 'phone'],
      validationRules: [requiredEmail],
    });
    expect(repeated.reasonCounts).toEqual([
      { code: 'adapter.missing_column', count: 3 },
      { code: 'validation.required_missing', count: 3 },
    ]);
  });

  it('reports partial for partial rows only and success for clean rows', () => {
    const partialOnly = preview([{ email: 'zzz' }], { validationRules: [enumEmail] });
    expect(partialOnly.status).toBe('partial');
    expect(partialOnly.summary).toMatchObject({ partialRows: 1, failedRows: 0, successRows: 0 });
    const clean = preview([{ email: 'a@example.test' }], { validationRules: [enumEmail] });
    expect(clean.status).toBe('success');
    expect(clean.summary).toEqual({
      totalRows: 1,
      successRows: 1,
      partialRows: 0,
      failedRows: 0,
      adapterErrorRows: 0,
      dryRunErrorRows: 0,
    });
    expect(clean.reasonCounts).toEqual([]);
  });

  it('reports an empty preview as successful', () => {
    const empty = preview([]);
    expect(empty.status).toBe('success');
    expect(empty.summary.totalRows).toBe(0);
    expect(empty.rowResults).toEqual([]);
  });

  it('defaults to one hundred preview rows', () => {
    const many = preview(Array.from({ length: 101 }, () => ({ email: 'a@example.test' })));
    expect(many.summary.totalRows).toBe(100);
    expect(many.rowResults).toHaveLength(100);
    const limited = preview(
      Array.from({ length: 5 }, () => ({ email: 'a@example.test' })),
      { maxRows: 5 }
    );
    expect(limited.summary.totalRows).toBe(5);
  });
});

describe('previewCsvDryRun canonical target preview', () => {
  it('lists the canonical targets that were mapped', () => {
    const result = preview([{ email: 'a@example.test' }]);
    expect(result.rowResults[0]?.canonicalTargetPreview).toEqual([
      {
        action: 'mapped',
        namespace: 'authrim.profile',
        path: 'email',
        catalogEntryId: 'field.canonical.email',
        edgeId: emailEdge.id,
        transformStepId: null,
      },
    ]);
  });

  it('keeps the dry-run result of the row without raw values', () => {
    const result = preview([{ email: 'private@example.test' }]);
    expect(result.rowResults[0]?.dryRun?.summary).toMatchObject({ inputCount: 1, mappedCount: 1 });
    expect(JSON.stringify(result)).not.toContain('private@example.test');
  });
});

describe('previewCsvDryRun header suggestions', () => {
  const suggestions = (
    columnToPath: Record<string, string>,
    rows: Array<Record<string, unknown>> = []
  ) => preview(rows, { columnToPath }).headerSuggestions;

  it('sorts every known column name, mapped or only seen in rows', () => {
    const result = suggestions({ zeta: 'zeta', alpha: 'alpha' }, [
      { mid: 1 },
      { beta: 2, zeta: 3 },
    ]);
    expect(result.map((item) => item.columnName)).toEqual(['alpha', 'beta', 'mid', 'zeta']);
    expect(result.map((item) => item.mapped)).toEqual([true, false, false, true]);
  });

  it('uses the configured path and looks it up in the catalog', () => {
    expect(suggestions({ 'E-mail': 'email' })).toEqual([
      {
        columnName: 'E-mail',
        mapped: true,
        suggestedPath: 'email',
        catalogEntryId: 'field.csv.email',
        classification: 'pii',
        valueType: 'string',
      },
    ]);
  });

  it('reports no catalog data for unknown paths', () => {
    expect(suggestions({ other: 'unknownPath' })).toEqual([
      {
        columnName: 'other',
        mapped: true,
        suggestedPath: 'unknownPath',
        catalogEntryId: null,
        classification: null,
        valueType: null,
      },
    ]);
  });

  it.each([
    ['Employee Number', 'employeeNumber'],
    ['  employee_number ', 'employeeNumber'],
    ['EMPLOYEE-NUMBER', 'employeeNumber'],
    ['first.name.x', 'firstNameX'],
    ['a1  b2', 'a1B2'],
    ['USER', 'user'],
    ['x', 'x'],
    ['---', '---'],
    ['  --  ', '--'],
  ])('suggests the path for unmapped column %j', (columnName, path) => {
    const result = preview([{ [columnName]: 'v' }], { columnToPath: {} }).headerSuggestions;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ columnName, mapped: false, suggestedPath: path });
  });

  it('prefers the configured path for mapped columns over a derived one', () => {
    const [mapped] = suggestions({ 'Employee Number': 'email' });
    expect(mapped?.suggestedPath).toBe('email');
    expect(mapped?.catalogEntryId).toBe('field.csv.email');
  });
});
