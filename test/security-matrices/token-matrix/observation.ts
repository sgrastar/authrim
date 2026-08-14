/**
 * Token Matrix observation oracle.
 *
 * Every production request is normalized into a `TokenObservation` and checked with
 * `checkObservation`, a pure field-by-field comparator that returns the list of
 * mismatching field names. The per-row tests assert an empty list; the oracle-sensitivity
 * meta tests corrupt one domain of a REAL production observation and assert that the SAME
 * comparator rejects it. Values that must never be printed (tokens, codes, JTIs) are
 * compared internally as booleans only.
 */

export interface TokenObservation {
  status: number;
  error: string | null;
  cacheControl: string | null;
  pragma: string | null;
  /** The consume RPC was reached by this request. */
  codeConsumed: boolean;
  /** Durable used flag after the request (undefined when the record is gone). */
  codeUsed: boolean | undefined;
  /** registerIssuedTokensRpc calls observed. */
  registrationCount: number;
  /** createFamilyRpc calls observed. */
  familyCount: number;
  /** Tenant embedded in the family-call target (null when no family call). */
  familyTenant: string | null;
  /** JTIs appended to the revocation store during the request. */
  revocationCount: number;
  /** Any store access targeting a tenant other than the request tenant. */
  foreignTenantAccess: boolean;
  /** Secret material observed on non-delivery surfaces. */
  secretLeak: boolean;
  // Token claim oracles (booleans only, never the values themselves).
  kidMatchesFixedKey: boolean;
  atHashMatchesAccessToken: boolean;
  refreshTokenTtlMatchesConfig: boolean;
  accessJtiRegistered: boolean;
  refreshJtiRegistered: boolean;
  cnfJktMatchesProof: boolean;
  scopePresent: boolean;
  authTimePresent: boolean;
  noncePresent: boolean;
}

export function emptyObservation(): TokenObservation {
  return {
    status: 0,
    error: null,
    cacheControl: null,
    pragma: null,
    codeConsumed: false,
    codeUsed: undefined,
    registrationCount: 0,
    familyCount: 0,
    familyTenant: null,
    revocationCount: 0,
    foreignTenantAccess: false,
    secretLeak: false,
    kidMatchesFixedKey: false,
    atHashMatchesAccessToken: false,
    refreshTokenTtlMatchesConfig: false,
    accessJtiRegistered: false,
    refreshJtiRegistered: false,
    cnfJktMatchesProof: false,
    scopePresent: false,
    authTimePresent: false,
    noncePresent: false,
  };
}

const COMPARABLE_FIELDS: Array<keyof TokenObservation> = [
  'status',
  'error',
  'cacheControl',
  'pragma',
  'codeConsumed',
  'codeUsed',
  'registrationCount',
  'familyCount',
  'familyTenant',
  'revocationCount',
  'foreignTenantAccess',
  'secretLeak',
  'kidMatchesFixedKey',
  'atHashMatchesAccessToken',
  'refreshTokenTtlMatchesConfig',
  'accessJtiRegistered',
  'refreshJtiRegistered',
  'cnfJktMatchesProof',
  'scopePresent',
  'authTimePresent',
  'noncePresent',
];

/**
 * Pure observation comparator. Returns the names of every field that differs; an empty
 * array means the observation matches the expectation. The per-row tests and the
 * oracle-sensitivity meta tests use exactly this function.
 */
export function checkObservation(
  observation: TokenObservation,
  expected: TokenObservation
): string[] {
  const mismatches: string[] = [];
  for (const field of COMPARABLE_FIELDS) {
    if (observation[field] !== expected[field]) mismatches.push(field);
  }
  return mismatches;
}

export function assertObservation(observation: TokenObservation, expected: TokenObservation): void {
  const mismatches = checkObservation(observation, expected);
  expect(mismatches, `observation mismatches: ${mismatches.join(', ')}`).toEqual([]);
}

/**
 * Corrupt exactly one observation domain. Used by the oracle-sensitivity meta tests to
 * prove the comparator rejects locally broken observations derived from REAL production
 * runs.
 */
export function corruptObservationDomain(
  observation: TokenObservation,
  domain: string
): TokenObservation {
  const corrupted = { ...observation };
  switch (domain) {
    case 'status':
      corrupted.status = corrupted.status === 400 ? 200 : 400;
      break;
    case 'error':
      corrupted.error = corrupted.error === null ? 'invalid_grant' : `${corrupted.error}-mutated`;
      break;
    case 'cache-control':
      corrupted.cacheControl = corrupted.cacheControl === 'no-store' ? 'max-age=60' : 'no-store';
      break;
    case 'pragma':
      corrupted.pragma = corrupted.pragma === 'no-cache' ? 'public' : 'no-cache';
      break;
    case 'code-consumed':
      corrupted.codeConsumed = !corrupted.codeConsumed;
      break;
    case 'code-used':
      corrupted.codeUsed = !corrupted.codeUsed;
      break;
    case 'registration':
      corrupted.registrationCount += 1;
      break;
    case 'family-count':
      corrupted.familyCount += 1;
      break;
    case 'family-tenant':
      corrupted.familyTenant = corrupted.familyTenant === 'default' ? 'tenant-a' : 'default';
      break;
    case 'revocation':
      corrupted.revocationCount += 1;
      break;
    case 'foreign-tenant':
      corrupted.foreignTenantAccess = !corrupted.foreignTenantAccess;
      break;
    case 'secret-leak':
      corrupted.secretLeak = !corrupted.secretLeak;
      break;
    case 'kid':
      corrupted.kidMatchesFixedKey = !corrupted.kidMatchesFixedKey;
      break;
    case 'at-hash':
      corrupted.atHashMatchesAccessToken = !corrupted.atHashMatchesAccessToken;
      break;
    case 'refresh-ttl':
      corrupted.refreshTokenTtlMatchesConfig = !corrupted.refreshTokenTtlMatchesConfig;
      break;
    case 'jti-registration':
      corrupted.accessJtiRegistered = !corrupted.accessJtiRegistered;
      corrupted.refreshJtiRegistered = !corrupted.refreshJtiRegistered;
      break;
    case 'cnf':
      corrupted.cnfJktMatchesProof = !corrupted.cnfJktMatchesProof;
      break;
    case 'scope':
      corrupted.scopePresent = !corrupted.scopePresent;
      break;
    case 'auth-time':
      corrupted.authTimePresent = !corrupted.authTimePresent;
      break;
    case 'nonce':
      corrupted.noncePresent = !corrupted.noncePresent;
      break;
    default:
      throw new Error(`Unknown observation domain: ${domain}`);
  }
  return corrupted;
}

export const OBSERVATION_DOMAINS: string[] = [
  'status',
  'error',
  'cache-control',
  'pragma',
  'code-consumed',
  'code-used',
  'registration',
  'family-count',
  'family-tenant',
  'revocation',
  'foreign-tenant',
  'secret-leak',
  'kid',
  'at-hash',
  'refresh-ttl',
  'jti-registration',
  'cnf',
  'scope',
  'auth-time',
  'nonce',
];
