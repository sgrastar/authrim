import { describe, expect, it } from 'vitest';
import {
  TA_CASE_TABLE,
  TB_CASE_TABLE,
  EXPECTED_TA_CASE_COUNT,
  EXPECTED_TB_CASE_COUNT,
} from './cases';
import { findDuplicateIds } from '../fixtures/case-fingerprint';
import { runBinaryGoldenChecks } from '../fixtures/coverage-verifier';
import type { Row, Scalar } from '../fixtures/covering-array';

// =============================================================================
// Independently declared independent coverage checker.
//
// The dimension values, the selected triples, and the legality predicates below are
// literal copies of the production contracts, re-derived independently of the
// generator's constraint functions. The expected legal tuple counts are fixed literals
// (verified against production reachability, not recomputed from cases.ts).
// =============================================================================

const TA_ORDER = ['registeredMethod', 'presented', 'client', 'codeState', 'requestTenant'] as const;
const TA_VALUES: Record<string, readonly Scalar[]> = {
  registeredMethod: [
    'none',
    'client_secret_basic',
    'client_secret_post',
    'client_secret_jwt',
    'private_key_jwt',
  ],
  presented: ['none', 'basic', 'post', 'jwt', 'malformed', 'conflicting'],
  client: ['public', 'confidential', 'unknown', 'wrong-tenant'],
  codeState: [
    'fresh',
    'consumed',
    'replayed',
    'expired',
    'malformed',
    'wrong-client',
    'wrong-tenant',
  ],
  requestTenant: ['matching', 'foreign'],
};
const TA_TRIPLES: Array<[string, string, string]> = [['registeredMethod', 'presented', 'client']];

function independentTaAuthSuccess(
  registeredMethod: Scalar,
  presented: Scalar,
  client: Scalar
): boolean {
  if (client === 'unknown' || client === 'wrong-tenant') return false;
  if (presented === 'malformed' || presented === 'conflicting') return false;
  if (registeredMethod === 'none') return presented === 'none' && client === 'public';
  if (registeredMethod === 'client_secret_basic')
    return presented === 'basic' && client === 'confidential';
  if (registeredMethod === 'client_secret_post')
    return presented === 'post' && client === 'confidential';
  if (registeredMethod === 'client_secret_jwt') return false;
  if (registeredMethod === 'private_key_jwt') {
    return presented === 'jwt' && client === 'confidential';
  }
  return false;
}

function independentTaRowLegal(row: Row): boolean {
  const coherent =
    row.client === 'public'
      ? row.registeredMethod === 'none'
      : row.client === 'confidential'
        ? row.registeredMethod !== 'none'
        : true;
  if (!coherent) return false;
  const authSuccess = independentTaAuthSuccess(row.registeredMethod, row.presented, row.client);
  if (!authSuccess) return row.codeState === 'fresh' && row.requestTenant === 'matching';
  return true;
}

const TB_ORDER = [
  'codeBinding',
  'pkce',
  'redirect',
  'resource',
  'dpop',
  'downstream',
  'replayState',
  'jtiState',
] as const;
const TB_VALUES: Record<string, readonly Scalar[]> = {
  codeBinding: ['none', 'pkce', 'dpop', 'pkce+dpop'],
  pkce: ['valid', 'missing', 'mismatched', 'malformed'],
  redirect: ['exact', 'omitted', 'mismatched', 'malformed'],
  resource: ['omitted-default', 'exact', 'changed', 'conflict', 'disallowed'],
  dpop: ['absent', 'valid', 'different-key', 'malformed', 'replayed'],
  downstream: ['success', 'signing', 'family', 'registration', 'revocation'],
  replayState: ['fresh', 'used'],
  jtiState: ['none', 'access', 'access+refresh'],
};
const TB_TRIPLES: Array<[string, string, string]> = [
  ['codeBinding', 'pkce', 'dpop'],
  ['redirect', 'resource', 'replayState'],
];

function independentTbBindingValid(row: Row): boolean {
  const codeBinding = String(row.codeBinding);
  const pkceOk = codeBinding.includes('pkce') ? row.pkce === 'valid' : true;
  const dpopOk = codeBinding.includes('dpop')
    ? row.dpop === 'valid'
    : row.dpop !== 'malformed' && row.dpop !== 'replayed';
  const redirectOk = row.redirect === 'exact';
  const resourceOk = row.resource === 'omitted-default' || row.resource === 'exact';
  return pkceOk && dpopOk && redirectOk && resourceOk;
}

function independentTbRowLegal(row: Row): boolean {
  const downstream = String(row.downstream);
  let legal = true;
  if (downstream === 'signing' || downstream === 'family' || downstream === 'registration') {
    legal = legal && row.replayState === 'fresh' && independentTbBindingValid(row);
  }
  if (downstream === 'revocation') {
    legal =
      legal &&
      row.replayState === 'used' &&
      row.jtiState !== 'none' &&
      independentTbBindingValid(row);
  }
  if (row.jtiState !== 'none') {
    legal = legal && row.replayState === 'used';
  }
  return legal;
}

function isLegal(
  partial: Row,
  order: readonly string[],
  values: Record<string, readonly Scalar[]>,
  predicate: (row: Row) => boolean,
  ...fixed: string[]
): boolean {
  const free = order.filter((dimension) => !fixed.includes(dimension));
  function walk(depth: number): boolean {
    if (depth === free.length) return predicate(partial);
    const dimension = free[depth];
    for (const value of values[dimension]) {
      const previous = partial[dimension];
      partial[dimension] = value;
      if (walk(depth + 1)) {
        partial[dimension] = previous;
        return true;
      }
      partial[dimension] = previous;
    }
    return false;
  }
  return walk(0);
}

function legalPairCount(
  order: readonly string[],
  values: Record<string, readonly Scalar[]>,
  predicate: (row: Row) => boolean
): number {
  let count = 0;
  for (let left = 0; left < order.length - 1; left += 1) {
    for (let right = left + 1; right < order.length; right += 1) {
      const a = order[left];
      const b = order[right];
      for (const av of values[a]) {
        for (const bv of values[b]) {
          if (isLegal({ [a]: av, [b]: bv }, order, values, predicate, a, b)) count += 1;
        }
      }
    }
  }
  return count;
}

function legalTripleCount(
  order: readonly string[],
  values: Record<string, readonly Scalar[]>,
  predicate: (row: Row) => boolean,
  triples: Array<[string, string, string]>
): number {
  let count = 0;
  for (const [a, b, c] of triples) {
    for (const av of values[a]) {
      for (const bv of values[b]) {
        for (const cv of values[c]) {
          if (isLegal({ [a]: av, [b]: bv, [c]: cv }, order, values, predicate, a, b, c)) count += 1;
        }
      }
    }
  }
  return count;
}

function missingPairs(
  table: Array<{ dimensions: Row }>,
  order: readonly string[],
  values: Record<string, readonly Scalar[]>,
  predicate: (row: Row) => boolean
): string[] {
  const covered = new Set<string>();
  for (const entry of table) {
    for (let left = 0; left < order.length - 1; left += 1) {
      for (let right = left + 1; right < order.length; right += 1) {
        const a = order[left];
        const b = order[right];
        covered.add(`${a}=${entry.dimensions[a]}|${b}=${entry.dimensions[b]}`);
      }
    }
  }
  const missing: string[] = [];
  for (let left = 0; left < order.length - 1; left += 1) {
    for (let right = left + 1; right < order.length; right += 1) {
      const a = order[left];
      const b = order[right];
      for (const av of values[a]) {
        for (const bv of values[b]) {
          if (!isLegal({ [a]: av, [b]: bv }, order, values, predicate, a, b)) continue;
          const key = `${a}=${av}|${b}=${bv}`;
          if (!covered.has(key)) missing.push(key);
        }
      }
    }
  }
  return missing;
}

function missingTriples(
  table: Array<{ dimensions: Row }>,
  order: readonly string[],
  values: Record<string, readonly Scalar[]>,
  predicate: (row: Row) => boolean,
  triples: Array<[string, string, string]>
): string[] {
  const covered = new Set<string>();
  for (const entry of table) {
    for (const [a, b, c] of triples) {
      covered.add(
        `${a}=${entry.dimensions[a]}|${b}=${entry.dimensions[b]}|${c}=${entry.dimensions[c]}`
      );
    }
  }
  const missing: string[] = [];
  for (const [a, b, c] of triples) {
    for (const av of values[a]) {
      for (const bv of values[b]) {
        for (const cv of values[c]) {
          if (!isLegal({ [a]: av, [b]: bv, [c]: cv }, order, values, predicate, a, b, c)) continue;
          const key = `${a}=${av}|${b}=${bv}|${c}=${cv}`;
          if (!covered.has(key)) missing.push(key);
        }
      }
    }
  }
  return missing;
}

describe('token-matrix meta', () => {
  it('reproduces the reviewer binary coverage golden counts independently', () => {
    expect.hasAssertions();
    const issues = runBinaryGoldenChecks();
    expect(issues).toEqual([]);
  });

  it('assigns unique case ids and unique semantic fingerprints across T-A and T-B', () => {
    expect.hasAssertions();
    const ids = [...TA_CASE_TABLE, ...TB_CASE_TABLE].map((entry) => entry.id);
    expect(findDuplicateIds(ids)).toEqual([]);
    const fingerprints = [...TA_CASE_TABLE, ...TB_CASE_TABLE].map((entry) => entry.fingerprint);
    expect(findDuplicateIds(fingerprints)).toEqual([]);
  });

  it('pins the expected covering-array case counts', () => {
    expect.hasAssertions();
    expect(TA_CASE_TABLE.length).toBe(EXPECTED_TA_CASE_COUNT);
    expect(TB_CASE_TABLE.length).toBe(EXPECTED_TB_CASE_COUNT);
  });

  it('independent checker: T-A legal pair count is the fixed literal 183', () => {
    expect.hasAssertions();
    expect(legalPairCount(TA_ORDER, TA_VALUES, independentTaRowLegal)).toBe(183);
  });

  it('independent checker: T-A selected triple count is the fixed literal 90', () => {
    expect.hasAssertions();
    expect(legalTripleCount(TA_ORDER, TA_VALUES, independentTaRowLegal, TA_TRIPLES)).toBe(90);
  });

  it('independent checker: T-B legal pair count is the fixed literal 399', () => {
    expect.hasAssertions();
    expect(legalPairCount(TB_ORDER, TB_VALUES, independentTbRowLegal)).toBe(399);
  });

  it('independent checker: T-B selected triple count is the fixed literal 120', () => {
    expect.hasAssertions();
    expect(legalTripleCount(TB_ORDER, TB_VALUES, independentTbRowLegal, TB_TRIPLES)).toBe(120);
  });

  it('T-A covers every legal pair and selected triple of the independent checker', () => {
    expect.hasAssertions();
    expect(missingPairs(TA_CASE_TABLE, TA_ORDER, TA_VALUES, independentTaRowLegal)).toEqual([]);
    expect(
      missingTriples(TA_CASE_TABLE, TA_ORDER, TA_VALUES, independentTaRowLegal, TA_TRIPLES)
    ).toEqual([]);
  });

  it('T-B covers every legal pair and selected triple of the independent checker', () => {
    expect.hasAssertions();
    expect(missingPairs(TB_CASE_TABLE, TB_ORDER, TB_VALUES, independentTbRowLegal)).toEqual([]);
    expect(
      missingTriples(TB_CASE_TABLE, TB_ORDER, TB_VALUES, independentTbRowLegal, TB_TRIPLES)
    ).toEqual([]);
  });

  it('independent checker: every legal (codeState, authResult, requestTenant) combination is observed', () => {
    expect.hasAssertions();
    const observed = new Set<string>();
    for (const entry of TA_CASE_TABLE) {
      const authResult = independentTaAuthSuccess(
        entry.dimensions.registeredMethod,
        entry.dimensions.presented,
        entry.dimensions.client
      )
        ? 'success'
        : 'invalid_client';
      observed.add(
        `codeState=${entry.dimensions.codeState}|authResult=${authResult}|requestTenant=${entry.dimensions.requestTenant}`
      );
    }
    const expected = new Set<string>();
    for (const codeState of TA_VALUES.codeState) {
      for (const requestTenant of TA_VALUES.requestTenant) {
        expected.add(`codeState=${codeState}|authResult=success|requestTenant=${requestTenant}`);
      }
    }
    expected.add('codeState=fresh|authResult=invalid_client|requestTenant=matching');
    const missing = Array.from(expected).filter((key) => !observed.has(key));
    expect(missing).toEqual([]);
  });

  it('independent checker: every legal (replayState, jtiState, revocationOutcome) combination is observed', () => {
    expect.hasAssertions();
    function independentRevocationOutcome(row: Row): string {
      if (row.downstream === 'registration') return 'access+refresh';
      if (row.downstream === 'revocation') return 'none';
      if (row.replayState === 'used' && independentTbBindingValid(row)) return String(row.jtiState);
      return 'none';
    }
    const observed = new Set<string>();
    for (const entry of TB_CASE_TABLE) {
      observed.add(
        `replayState=${entry.dimensions.replayState}|jtiState=${entry.dimensions.jtiState}|revocationOutcome=${independentRevocationOutcome(entry.dimensions)}`
      );
    }
    const expected = new Set<string>();
    for (const replayState of TB_VALUES.replayState) {
      for (const jtiState of TB_VALUES.jtiState) {
        const partial: Row = { replayState, jtiState };
        if (
          !isLegal(partial, TB_ORDER, TB_VALUES, independentTbRowLegal, 'replayState', 'jtiState')
        )
          continue;
        const derived = new Set<string>();
        for (const downstream of TB_VALUES.downstream) {
          for (const codeBinding of TB_VALUES.codeBinding) {
            for (const pkce of TB_VALUES.pkce) {
              for (const redirect of TB_VALUES.redirect) {
                for (const resource of TB_VALUES.resource) {
                  for (const dpop of TB_VALUES.dpop) {
                    const full: Row = {
                      ...partial,
                      downstream,
                      codeBinding,
                      pkce,
                      redirect,
                      resource,
                      dpop,
                    };
                    if (!independentTbRowLegal(full)) continue;
                    derived.add(independentRevocationOutcome(full));
                  }
                }
              }
            }
          }
        }
        for (const revocationOutcome of derived) {
          expected.add(
            `replayState=${replayState}|jtiState=${jtiState}|revocationOutcome=${revocationOutcome}`
          );
        }
      }
    }
    const missing = Array.from(expected).filter((key) => !observed.has(key));
    expect(missing).toEqual([]);
  });

  it('rejects a faulty T-A matrix that drops a legal triple while pairs remain covered', () => {
    expect.hasAssertions();
    const [a, b, c] = TA_TRIPLES[0];
    const victim: Record<string, Scalar> = { [a]: 'none', [b]: 'malformed', [c]: 'public' };
    const dropped = TA_CASE_TABLE.filter((entry) => {
      for (const dimension of [a, b, c]) {
        if (entry.dimensions[dimension] !== victim[dimension]) return true;
      }
      return false;
    });
    const missing = missingTriples(dropped, TA_ORDER, TA_VALUES, independentTaRowLegal, TA_TRIPLES);
    expect(missing).toContain('registeredMethod=none|presented=malformed|client=public');
  });

  it('rejects a faulty T-B matrix that drops a legal triple while pairs remain covered', () => {
    expect.hasAssertions();
    const [a, b, c] = TB_TRIPLES[0];
    const victim: Record<string, Scalar> = { [a]: 'pkce', [b]: 'valid', [c]: 'absent' };
    const dropped = TB_CASE_TABLE.filter((entry) => {
      for (const dimension of [a, b, c]) {
        if (entry.dimensions[dimension] !== victim[dimension]) return true;
      }
      return false;
    });
    const missing = missingTriples(dropped, TB_ORDER, TB_VALUES, independentTbRowLegal, TB_TRIPLES);
    expect(missing).toContain('codeBinding=pkce|pkce=valid|dpop=absent');
  });

  it('detects a wrong constraint that hides a legal pair (independent checker is self-consistent)', () => {
    expect.hasAssertions();
    // A bogus constraint forbidding private_key_jwt assertions would hide the legal pair
    // (registeredMethod=private_key_jwt, presented=jwt), which only success rows can
    // cover. Simulate the wrongly-constrained matrix by removing every row carrying that
    // pair; the independent checker must still require it and flag the matrix.
    const bogusFilter = (entry: { dimensions: Row }): boolean => {
      const d = entry.dimensions;
      return !(d.registeredMethod === 'private_key_jwt' && d.presented === 'jwt');
    };
    const wronglyConstrained = TA_CASE_TABLE.filter(bogusFilter);
    const missing = missingPairs(wronglyConstrained, TA_ORDER, TA_VALUES, independentTaRowLegal);
    expect(missing).toContain('registeredMethod=private_key_jwt|presented=jwt');
  });

  it('detects a wrong constraint that hides a legal pair in T-B (independent checker is self-consistent)', () => {
    expect.hasAssertions();
    // A bogus constraint forbidding (codeBinding=none, dpop=absent) would hide the
    // success-without-DPoP pair; simulate it and expect the independent checker to flag
    // the missing pairs.
    const bogusFilter = (entry: { dimensions: Row }): boolean => {
      const d = entry.dimensions;
      return !(d.codeBinding === 'none' && d.dpop === 'absent');
    };
    const wronglyConstrained = TB_CASE_TABLE.filter(bogusFilter);
    const missing = missingPairs(wronglyConstrained, TB_ORDER, TB_VALUES, independentTbRowLegal);
    expect(missing.length).toBeGreaterThan(0);
  });
});
