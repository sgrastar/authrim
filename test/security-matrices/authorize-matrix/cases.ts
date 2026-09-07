import { generateCoveringArray, type Row, type Scalar } from '../fixtures/covering-array';
import { deriveCaseId, semanticFingerprint } from '../fixtures/case-fingerprint';

export interface AuthorizeCase {
  id: string;
  title: string;
  dimensions: Record<string, Scalar>;
  requestSource: 'direct' | 'par' | 'jar';
  clientType: 'public' | 'confidential' | 'unknown';
  redirectValid: 'registered' | 'unregistered' | 'malformed';
  responseType: 'code' | 'unsupported' | 'missing';
  fingerprint: string;
  mutationIds: string[];
}

const DIMENSION_ORDER = ['requestSource', 'clientType', 'redirectValid', 'responseType'] as const;
const SUITE_PREFIX = 'authz';

const VALUES: Record<string, readonly Scalar[]> = {
  requestSource: ['direct', 'par', 'jar'],
  clientType: ['public', 'confidential', 'unknown'],
  redirectValid: ['registered', 'unregistered', 'malformed'],
  responseType: ['code', 'unsupported', 'missing'],
};

const CONSTRAINTS = [
  (row: Row): boolean => {
    if (row.requestSource === 'jar' && row.clientType === 'unknown') {
      return false;
    }
    if (row.requestSource === 'par' && row.responseType === 'missing') {
      return false;
    }
    return true;
  },
];

function mutationFor(row: AuthorizeCase): string[] {
  if (row.redirectValid !== 'registered') {
    return ['authorize:redirect-error-to-unvalidated-uri'];
  }
  if (row.requestSource === 'par') {
    return ['authorize:consume-par-while-displaying-login-ui'];
  }
  if (row.clientType === 'unknown') {
    return ['authorize:redirect-error-to-unvalidated-uri'];
  }
  return ['authorize:prompt-none-enters-interactive-ui'];
}

export function buildAuthorizeCaseTable(): AuthorizeCase[] {
  const rows = generateCoveringArray({
    dimensionOrder: [...DIMENSION_ORDER],
    values: VALUES,
    constraints: CONSTRAINTS,
    selectedTriples: [['requestSource', 'clientType', 'redirectValid']],
  });
  return rows.map((row, index) => {
    const id = deriveCaseId(SUITE_PREFIX, index + 1);
    return {
      id,
      title: `source=${row.requestSource}, client=${row.clientType}, redirect=${row.redirectValid}, response=${row.responseType}`,
      dimensions: { ...row },
      requestSource: row.requestSource as AuthorizeCase['requestSource'],
      clientType: row.clientType as AuthorizeCase['clientType'],
      redirectValid: row.redirectValid as AuthorizeCase['redirectValid'],
      responseType: row.responseType as AuthorizeCase['responseType'],
      fingerprint: semanticFingerprint(row as Record<string, Scalar>),
      mutationIds: mutationFor(row as unknown as AuthorizeCase),
    };
  });
}

export const AUTHORIZE_CASE_TABLE = buildAuthorizeCaseTable();

export function authorizeDimensionValues(): Record<string, readonly Scalar[]> {
  return VALUES;
}

export function authorizeDimensionOrder(): readonly string[] {
  return [...DIMENSION_ORDER];
}

export function authorizeLegalPairKeys(): string[] {
  const pairs = new Set<string>();
  const combos = (dim: string): readonly Scalar[] => VALUES[dim];
  for (let left = 0; left < DIMENSION_ORDER.length - 1; left += 1) {
    for (let right = left + 1; right < DIMENSION_ORDER.length; right += 1) {
      const a = DIMENSION_ORDER[left];
      const b = DIMENSION_ORDER[right];
      for (const av of combos(a)) {
        for (const bv of combos(b)) {
          const row: Row = { [a]: av, [b]: bv };
          if (isPairLegal(a, av, b, bv)) {
            pairs.add(`${a}=${av}|${b}=${bv}`);
          }
        }
      }
    }
  }
  return Array.from(pairs).sort();
}

function isPairLegal(a: string, av: Scalar, b: string, bv: Scalar): boolean {
  const combos = (dim: string): readonly Scalar[] => VALUES[dim];
  for (const c of combos(remainingDim(a, b))) {
    const row: Row = { [a]: av, [b]: bv, [remainingDim(a, b)]: c };
    return CONSTRAINTS.every((constraint) => constraint(row));
  }
  return true;
}

function remainingDim(a: string, b: string): string {
  return DIMENSION_ORDER.find((dim) => dim !== a && dim !== b) as string;
}
