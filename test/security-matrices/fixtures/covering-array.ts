export type Scalar = string | number | boolean | null;
export type DimValues = Record<string, readonly Scalar[]>;
export type Row = Record<string, Scalar>;
export type Constraint = (row: Row) => boolean;

export interface CoveringArrayOptions {
  dimensionOrder: string[];
  values: DimValues;
  constraints: Constraint[];
  selectedTriples?: Array<[string, string, string]>;
}

function stringify(value: Scalar): string {
  if (value === null) return 'null';
  return String(value);
}

export function pairKey(
  dimension: string,
  value: Scalar,
  other: string,
  otherValue: Scalar
): string {
  return `${dimension}=${stringify(value)}|${other}=${stringify(otherValue)}`;
}

export function tripleKey(
  a: string,
  av: Scalar,
  b: string,
  bv: Scalar,
  c: string,
  cv: Scalar
): string {
  return `${a}=${stringify(av)}|${b}=${stringify(bv)}|${c}=${stringify(cv)}`;
}

export function isLegal(constraints: Constraint[], row: Row): boolean {
  return constraints.every((constraint) => constraint(row));
}

function makeRow(dimensionOrder: string[], values: Scalar[]): Row {
  const row: Row = {};
  for (let index = 0; index < dimensionOrder.length; index += 1) {
    row[dimensionOrder[index]] = values[index];
  }
  return row;
}

function enumerateAllRows(
  dimensionOrder: string[],
  values: DimValues,
  constraints: Constraint[]
): Row[] {
  const domains = dimensionOrder.map((dimension) => [...values[dimension]]);
  const rows: Row[] = [];
  const current: Scalar[] = [];
  function walk(depth: number): void {
    if (depth === domains.length) {
      const candidate = makeRow(dimensionOrder, [...current]);
      if (isLegal(constraints, candidate)) rows.push(candidate);
      return;
    }
    for (const value of domains[depth]) {
      current.push(value);
      walk(depth + 1);
      current.pop();
    }
  }
  walk(0);
  return rows;
}

function keyOf(row: Row, dimensionOrder: string[]): string {
  return dimensionOrder.map((dimension) => `${dimension}=${stringify(row[dimension])}`).join('|');
}

function sortKeys(keys: Iterable<string>): string[] {
  return Array.from(keys).sort();
}

export function requiredPairKeys(options: CoveringArrayOptions): string[] {
  const rows = enumerateAllRows(options.dimensionOrder, options.values, options.constraints);
  const found = new Set<string>();
  for (const row of rows) {
    for (let left = 0; left < options.dimensionOrder.length - 1; left += 1) {
      for (let right = left + 1; right < options.dimensionOrder.length; right += 1) {
        found.add(
          pairKey(
            options.dimensionOrder[left],
            row[options.dimensionOrder[left]],
            options.dimensionOrder[right],
            row[options.dimensionOrder[right]]
          )
        );
      }
    }
  }
  return sortKeys(found);
}

export function requiredTripleKeys(options: CoveringArrayOptions): string[] {
  const rows = enumerateAllRows(options.dimensionOrder, options.values, options.constraints);
  const found = new Set<string>();
  for (const row of rows) {
    for (const [a, b, c] of options.selectedTriples ?? []) {
      found.add(tripleKey(a, row[a], b, row[b], c, row[c]));
    }
  }
  return sortKeys(found);
}

/**
 * Deterministic greedy covering array. The generator enumerates all legal rows in
 * dimension order and repeatedly selects the row that covers the most uncovered
 * required pairs and selected triples, breaking ties by canonical row key.
 */
export function generateCoveringArray(options: CoveringArrayOptions): Row[] {
  const candidates = enumerateAllRows(options.dimensionOrder, options.values, options.constraints);
  const uncoveredPairs = new Set(requiredPairKeys(options));
  const uncoveredTriples = new Set(requiredTripleKeys(options));
  const selected: Row[] = [];

  const coveredKeys = (row: Row): { pairs: string[]; triples: string[] } => {
    const pairs: string[] = [];
    for (let left = 0; left < options.dimensionOrder.length - 1; left += 1) {
      for (let right = left + 1; right < options.dimensionOrder.length; right += 1) {
        pairs.push(
          pairKey(
            options.dimensionOrder[left],
            row[options.dimensionOrder[left]],
            options.dimensionOrder[right],
            row[options.dimensionOrder[right]]
          )
        );
      }
    }
    const triples: string[] = [];
    for (const [a, b, c] of options.selectedTriples ?? []) {
      triples.push(tripleKey(a, row[a], b, row[b], c, row[c]));
    }
    return { pairs, triples };
  };

  let progressed = true;
  while (
    (uncoveredPairs.size > 0 || uncoveredTriples.size > 0) &&
    progressed &&
    candidates.length > 0
  ) {
    progressed = false;
    let best: Row | null = null;
    let bestScore = -1;
    let bestKey = '';
    for (const candidate of candidates) {
      const { pairs, triples } = coveredKeys(candidate);
      const score =
        pairs.filter((key) => uncoveredPairs.has(key)).length +
        triples.filter((key) => uncoveredTriples.has(key)).length;
      const key = keyOf(candidate, options.dimensionOrder);
      if (score > bestScore || (score === bestScore && (best === null || key < bestKey))) {
        best = candidate;
        bestScore = score;
        bestKey = key;
      }
    }
    if (best && bestScore > 0) {
      const { pairs, triples } = coveredKeys(best);
      for (const key of pairs) uncoveredPairs.delete(key);
      for (const key of triples) uncoveredTriples.delete(key);
      selected.push(best);
      progressed = true;
    }
  }

  // Deterministically append any uncovered legal rows so the returned array is stable
  // even when the greedy pass cannot cover a degenerate requirement.
  for (const candidate of candidates) {
    const { pairs, triples } = coveredKeys(candidate);
    if (
      pairs.some((key) => uncoveredPairs.has(key)) ||
      triples.some((key) => uncoveredTriples.has(key))
    ) {
      for (const key of pairs) uncoveredPairs.delete(key);
      for (const key of triples) uncoveredTriples.delete(key);
      selected.push(candidate);
    }
  }

  return selected;
}

export function rowKey(row: Row, dimensionOrder: string[]): string {
  return keyOf(row, dimensionOrder);
}

export function enumerateLegalRows(options: CoveringArrayOptions): Row[] {
  return enumerateAllRows(options.dimensionOrder, options.values, options.constraints);
}
