import type { Row, Scalar } from './covering-array';

export interface FingerprintableCase {
  id: string;
  dimensions: Record<string, Scalar>;
}

/**
 * Canonical semantic fingerprint of a case. Sorting dimension names keeps the fingerprint
 * stable regardless of object key insertion order, so cases differing only in labels collapse.
 */
export function semanticFingerprint(dimensions: Record<string, Scalar>): string {
  return Object.keys(dimensions)
    .sort()
    .map((key) => `${key}=${dimensions[key] === null ? 'null' : String(dimensions[key])}`)
    .join('|');
}

export function deriveCaseId(suitePrefix: string, index: number): string {
  return `${suitePrefix}-${String(index).padStart(3, '0')}`;
}

export interface DuplicateReport {
  fingerprint: string;
  ids: string[];
}

export function findDuplicateFingerprints(cases: FingerprintableCase[]): DuplicateReport[] {
  const byFingerprint = new Map<string, string[]>();
  for (const entry of cases) {
    const fingerprint = semanticFingerprint(entry.dimensions);
    const ids = byFingerprint.get(fingerprint) ?? [];
    ids.push(entry.id);
    byFingerprint.set(fingerprint, ids);
  }
  return Array.from(byFingerprint.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([fingerprint, ids]) => ({ fingerprint, ids }))
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

export function findDuplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  return duplicates;
}

export function rowToDimensions(dimensionOrder: string[], row: Row): Record<string, Scalar> {
  const result: Record<string, Scalar> = {};
  for (const dimension of dimensionOrder) {
    result[dimension] = row[dimension];
  }
  return result;
}
