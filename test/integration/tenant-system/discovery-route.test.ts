import { describe, expect, it } from 'vitest';
import { loadMatrixCsv } from './fixtures/matrix-loader';

interface EntryRouteMatrixRow {
  case_id: string;
  route_family: string;
  host_topology: string;
  required_profiles: string;
  expect: string;
}

describe('tenant-system discovery route matrix', () => {
  const rows = loadMatrixCsv<EntryRouteMatrixRow>('tenant-system-entry-route-matrix.csv');

  it.each(rows)('$case_id has route coverage metadata', (row) => {
    expect(row.route_family).toBeTruthy();
    expect(row.host_topology).toBeTruthy();
    expect(row.required_profiles.match(/P\d{2}/g)?.length ?? 0).toBeGreaterThan(0);
  });
});
