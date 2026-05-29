import { describe, expect, it } from 'vitest';
import { parseCsvSourceProfile } from '../../source-profiles/csv';

describe('parseCsvSourceProfile', () => {
  it('infers CSV source profile columns without returning raw sampled values', () => {
    const result = parseCsvSourceProfile(
      'Email,EmployeeId,TaxId,DisplayName\nalice@example.test,100,123-45-6789,Alice\nbob@example.test,101,987-65-4321,Bob'
    );

    expect(result.parser.delimiter).toBe(',');
    expect(result.parser.headerMode).toBe('first_row');
    expect(result.summary.columnCount).toBe(4);
    expect(result.summary.piiCandidateCount).toBeGreaterThanOrEqual(1);
    expect(result.summary.regulatedCandidateCount).toBe(1);
    expect(result.columns[0]).toMatchObject({
      headerName: 'Email',
      valueType: 'email',
      candidates: { classification: 'pii', required: true },
      classification: 'internal',
      required: false,
    });
    expect(result.columns[2]).toMatchObject({
      headerName: 'TaxId',
      candidates: { classification: 'regulated' },
    });
    expect(JSON.stringify(result)).not.toContain('alice@example.test');
    expect(JSON.stringify(result)).not.toContain('123-45-6789');
  });

  it('supports manual parser options and bounded sampling', () => {
    const result = parseCsvSourceProfile('name;active\nAlice;true\nBob;false\nCarol;true', {
      delimiter: ';',
      maxRows: 2,
    });

    expect(result.parser.delimiter).toBe(';');
    expect(result.parser.sampledRows).toBe(2);
    expect(result.parser.truncatedRows).toBe(true);
    expect(result.columns.find((column) => column.headerName === 'active')).toMatchObject({
      valueType: 'boolean',
      candidates: { valueType: 'boolean' },
    });
  });

  it('falls back to generated column names when the CSV has no header row', () => {
    const result = parseCsvSourceProfile('Alice,alice@example.test\nBob,bob@example.test', {
      headerMode: 'none',
    });

    expect(result.parser.headerMode).toBe('none');
    expect(result.columns.map((column) => column.headerName)).toEqual(['column_1', 'column_2']);
    expect(result.columns[1]?.valueType).toBe('email');
  });
});
