import { BINARY_COVERAGE_GOLDEN, DIRECTED_STATE_GRAPH_GOLDEN } from './coverage-golden';

export type Scalar = string | number | boolean | null;
export type Row = Record<string, Scalar>;
export type Constraint = (row: Row) => boolean;

export interface CoverageSpec {
  dimensionOrder: string[];
  values: Record<string, readonly Scalar[]>;
  constraints: Constraint[];
  constraintLabel?: string;
  selectedTriples?: Array<[string, string, string]>;
}

function stringify(value: Scalar): string {
  if (value === null) return 'null';
  return String(value);
}

export function semanticFingerprint(row: Row, dimensionOrder: string[]): string {
  return dimensionOrder.map((dimension) => `${dimension}=${stringify(row[dimension])}`).join('|');
}

function tupleKey(dimensions: string[], row: Row): string {
  return dimensions.map((dimension) => `${dimension}=${stringify(row[dimension])}`).join('|');
}

export function enumerateLegalAssignments(spec: CoverageSpec): Row[] {
  const domains = spec.dimensionOrder.map((dimension) => [...spec.values[dimension]]);
  const rows: Row[] = [];
  const current: Scalar[] = [];
  const walk = (depth: number): void => {
    if (depth === domains.length) {
      const row: Row = {};
      spec.dimensionOrder.forEach((dimension, index) => {
        row[dimension] = current[index];
      });
      if (spec.constraints.every((constraint) => constraint(row))) {
        rows.push(row);
      }
      return;
    }
    for (const value of domains[depth]) {
      current.push(value);
      walk(depth + 1);
      current.pop();
    }
  };
  walk(0);
  return rows;
}

function pairCombinations(dimensionOrder: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let left = 0; left < dimensionOrder.length - 1; left += 1) {
    for (let right = left + 1; right < dimensionOrder.length; right += 1) {
      pairs.push([dimensionOrder[left], dimensionOrder[right]]);
    }
  }
  return pairs;
}

export function requiredPairKeys(spec: CoverageSpec): string[] {
  const assignments = enumerateLegalAssignments(spec);
  const found = new Set<string>();
  for (const assignment of assignments) {
    for (const [a, b] of pairCombinations(spec.dimensionOrder)) {
      found.add(tupleKey([a, b], assignment));
    }
  }
  return Array.from(found).sort();
}

export function requiredTripleKeys(spec: CoverageSpec): string[] {
  const assignments = enumerateLegalAssignments(spec);
  const found = new Set<string>();
  for (const assignment of assignments) {
    for (const triple of spec.selectedTriples ?? []) {
      found.add(tupleKey(triple, assignment));
    }
  }
  return Array.from(found).sort();
}

export interface CoverageDiagnostics {
  illegalRows: string[];
  duplicateRows: string[];
  missingPairs: string[];
  missingTriples: string[];
}

export function verifyCoverage(spec: CoverageSpec, rows: Row[]): CoverageDiagnostics {
  const illegalRows: string[] = [];
  const duplicateRows: string[] = [];
  const seen = new Set<string>();
  const coveredPairs = new Set<string>();
  const coveredTriples = new Set<string>();
  const requiredPairs = new Set(requiredPairKeys(spec));
  const requiredTriples = new Set(requiredTripleKeys(spec));

  rows.forEach((row, index) => {
    const fingerprint = semanticFingerprint(row, spec.dimensionOrder);
    if (seen.has(fingerprint)) {
      duplicateRows.push(
        `row[${index}]: duplicate of row[${rows.findIndex((r) => semanticFingerprint(r, spec.dimensionOrder) === fingerprint)}]`
      );
    }
    seen.add(fingerprint);
    if (!spec.constraints.every((constraint) => constraint(row))) {
      illegalRows.push(`row[${index}]: violates ${spec.constraintLabel ?? 'constraint'}`);
    }
    for (const [a, b] of pairCombinations(spec.dimensionOrder)) {
      coveredPairs.add(tupleKey([a, b], row));
    }
    for (const triple of spec.selectedTriples ?? []) {
      coveredTriples.add(tupleKey(triple, row));
    }
  });

  const missingPairs = Array.from(requiredPairs)
    .filter((key) => !coveredPairs.has(key))
    .sort();
  const missingTriples = Array.from(requiredTriples)
    .filter((key) => !coveredTriples.has(key))
    .sort();

  return { illegalRows, duplicateRows, missingPairs, missingTriples };
}

/**
 * Independent small-domain brute-force check for the golden binary domain.
 * Intentionally does not share tuple-enumeration code with the generator.
 */
export function bruteForceBinaryCoverageCounts(
  dimensionOrder: readonly string[],
  values: Record<string, readonly Scalar[]>,
  constraint?: Constraint
): { assignments: number; pairs: number; triples: number } {
  const spec: CoverageSpec = {
    dimensionOrder: [...dimensionOrder],
    values,
    constraints: constraint ? [constraint] : [],
    selectedTriples: [['A', 'B', 'C']],
  };
  const assignments = enumerateLegalAssignments(spec);
  const pairKeys = requiredPairKeys(spec);
  const tripleKeys = requiredTripleKeys(spec);
  return { assignments: assignments.length, pairs: pairKeys.length, triples: tripleKeys.length };
}

export function runBinaryGoldenChecks(): string[] {
  const issues: string[] = [];
  const golden = BINARY_COVERAGE_GOLDEN;
  const values: Record<string, readonly Scalar[]> = {
    A: [...golden.values.A],
    B: [...golden.values.B],
    C: [...golden.values.C],
  };

  const unconstrained = bruteForceBinaryCoverageCounts([...golden.dimensionOrder], values);
  if (unconstrained.assignments !== golden.unconstrainedAssignments.length) {
    issues.push(`unconstrained assignment count mismatch: ${unconstrained.assignments}`);
  }
  if (unconstrained.pairs !== golden.unconstrainedPairKeys.length) {
    issues.push(`unconstrained pair count mismatch: ${unconstrained.pairs}`);
  }
  if (unconstrained.triples !== golden.unconstrainedTripleKeys.length) {
    issues.push(`unconstrained triple count mismatch: ${unconstrained.triples}`);
  }

  const constrained: Constraint = (row) => !(row.A === 1 && row.B === 1);
  const constrainedCounts = bruteForceBinaryCoverageCounts(
    [...golden.dimensionOrder],
    values,
    constrained
  );
  if (constrainedCounts.assignments !== golden.constrainedAssignments.length) {
    issues.push(`constrained assignment count mismatch: ${constrainedCounts.assignments}`);
  }
  if (constrainedCounts.pairs !== golden.constrainedPairKeys.length) {
    issues.push(`constrained pair count mismatch: ${constrainedCounts.pairs}`);
  }
  if (constrainedCounts.triples !== golden.constrainedTripleKeys.length) {
    issues.push(`constrained triple count mismatch: ${constrainedCounts.triples}`);
  }
  return issues;
}
