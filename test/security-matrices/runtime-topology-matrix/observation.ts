/**
 * Runtime-topology observation oracle.
 *
 * Every production run is normalized into an observation and checked with
 * `checkObservation`, a pure field-by-field comparator that returns the list of
 * mismatching field names. The per-row tests assert an empty list; the
 * oracle-sensitivity meta tests corrupt one domain of a REAL production observation and
 * assert that the SAME comparator rejects it. No secret or signature value is ever
 * compared or printed; observation fields are booleans, numbers, nulls, or safe enums.
 */

export type RaRejectionLayer =
  | 'tenant-resolution'
  | 'metadata-context'
  | 'tenant-exists'
  | 'vanity-canonicalization'
  | 'binding-policy'
  | 'admin-header'
  | null;

export type RaRegistryStatus =
  | 'valid'
  | 'bad-signature'
  | 'missing'
  | 'quarantined'
  | 'not-configured'
  | 'not-reached'
  | null;

export type TenantContextState = 'matching' | 'foreign' | 'missing' | null;

export type CanonicalIssuerState =
  | 'tenant-canonical'
  | 'primary-naked'
  | 'active-vanity'
  | 'mismatched'
  | 'unavailable';

export interface RaObservation {
  status: number;
  error: string | null;
  errorDescription: string | null;
  locationHost: string | null;
  tenantId: string | null;
  issuerHost: string | null;
  rejectionLayer: RaRejectionLayer;
  registryStatus: RaRegistryStatus;
  tenantContextState: TenantContextState;
  canonicalIssuerState: CanonicalIssuerState;
  tenantAccessSet: string[];
  tenantExistsQuery: boolean;
  tenantExistsCacheWrite: boolean;
  vanityResolutionAttempted: boolean;
  vanityPrimaryQuery: boolean;
  settingsRead: boolean;
  registrySnapshotRead: boolean;
  securityEventWritten: boolean;
  foreignTenantAccess: boolean;
  secretLeak: boolean;
  /** The binding that actually received an operation (e.g. the tenant-exists query). */
  bindingOperation: string | null;
}

export function emptyRaObservation(): RaObservation {
  return {
    status: 0,
    error: null,
    errorDescription: null,
    locationHost: null,
    tenantId: null,
    issuerHost: null,
    rejectionLayer: null,
    registryStatus: null,
    tenantContextState: null,
    canonicalIssuerState: 'unavailable',
    tenantAccessSet: [],
    tenantExistsQuery: false,
    tenantExistsCacheWrite: false,
    vanityResolutionAttempted: false,
    vanityPrimaryQuery: false,
    settingsRead: false,
    registrySnapshotRead: false,
    securityEventWritten: false,
    foreignTenantAccess: false,
    secretLeak: false,
    bindingOperation: null,
  };
}

const RA_COMPARABLE_FIELDS: Array<keyof RaObservation> = [
  'status',
  'error',
  'errorDescription',
  'locationHost',
  'tenantId',
  'issuerHost',
  'rejectionLayer',
  'registryStatus',
  'tenantContextState',
  'canonicalIssuerState',
  'tenantAccessSet',
  'tenantExistsQuery',
  'tenantExistsCacheWrite',
  'vanityResolutionAttempted',
  'vanityPrimaryQuery',
  'settingsRead',
  'registrySnapshotRead',
  'securityEventWritten',
  'foreignTenantAccess',
  'secretLeak',
  'bindingOperation',
];

export type RbRejectionLayer =
  | 'generation'
  | 'snapshot'
  | 'registry-tenant'
  | 'signature'
  | 'route'
  | 'expiry'
  | 'provider'
  | 'binding'
  | 'binding-access'
  | null;

export interface RbObservation {
  outcome: 'resolved' | 'error';
  errorCode: string | null;
  rejectionLayer: RbRejectionLayer;
  bindingRef: string | null;
  generation: number | null;
  runtimeGeneration: number | null;
  dataRole: string | null;
  allocationScope: string | null;
  ownerTenantId: string | null;
  provider: string | null;
  cacheHit: boolean;
  securityEventWritten: boolean;
  foreignTenantAccess: boolean;
  secretLeak: boolean;
  tenantAccessSet: string[];
  /** The actual operation run on the selected binding after a successful resolution. */
  bindingOperation: string | null;
}

export function emptyRbObservation(): RbObservation {
  return {
    outcome: 'error',
    errorCode: null,
    rejectionLayer: null,
    bindingRef: null,
    generation: null,
    runtimeGeneration: null,
    dataRole: null,
    allocationScope: null,
    ownerTenantId: null,
    provider: null,
    cacheHit: false,
    securityEventWritten: false,
    foreignTenantAccess: false,
    secretLeak: false,
    tenantAccessSet: [],
    bindingOperation: null,
  };
}

const RB_COMPARABLE_FIELDS: Array<keyof RbObservation> = [
  'outcome',
  'errorCode',
  'rejectionLayer',
  'bindingRef',
  'generation',
  'runtimeGeneration',
  'dataRole',
  'allocationScope',
  'ownerTenantId',
  'provider',
  'cacheHit',
  'securityEventWritten',
  'foreignTenantAccess',
  'secretLeak',
  'tenantAccessSet',
  'bindingOperation',
];

export function checkRaObservation(observation: RaObservation, expected: RaObservation): string[] {
  const mismatches: string[] = [];
  for (const field of RA_COMPARABLE_FIELDS) {
    if (JSON.stringify(observation[field]) !== JSON.stringify(expected[field])) {
      mismatches.push(field);
    }
  }
  return mismatches;
}

export function checkRbObservation(observation: RbObservation, expected: RbObservation): string[] {
  const mismatches: string[] = [];
  for (const field of RB_COMPARABLE_FIELDS) {
    if (JSON.stringify(observation[field]) !== JSON.stringify(expected[field])) {
      mismatches.push(field);
    }
  }
  return mismatches;
}

/**
 * Corrupt exactly one R-A observation domain. Used by the oracle-sensitivity meta test to
 * prove the comparator rejects locally broken observations derived from REAL production
 * runs.
 */
export function corruptRaObservationDomain(
  observation: RaObservation,
  domain: string
): RaObservation {
  const corrupted = { ...observation };
  switch (domain) {
    case 'status':
      corrupted.status = corrupted.status === 200 ? 500 : 200;
      break;
    case 'error':
      corrupted.error = corrupted.error === null ? 'not_found' : `${corrupted.error}-mutated`;
      break;
    case 'error-description':
      corrupted.errorDescription =
        corrupted.errorDescription === null ? 'not_found' : `${corrupted.errorDescription}-mutated`;
      break;
    case 'location':
      corrupted.locationHost = corrupted.locationHost === null ? 'evil.example' : null;
      break;
    case 'tenant':
      corrupted.tenantId =
        corrupted.tenantId === 'alpha' ? 'beta' : corrupted.tenantId === 'beta' ? 'alpha' : 'alpha';
      break;
    case 'issuer':
      corrupted.issuerHost =
        corrupted.issuerHost === null ? 'evil.example' : `${corrupted.issuerHost}-mutated`;
      break;
    case 'rejection-layer':
      corrupted.rejectionLayer = corrupted.rejectionLayer === null ? 'binding-policy' : null;
      break;
    case 'registry-status':
      corrupted.registryStatus = corrupted.registryStatus === 'valid' ? 'bad-signature' : 'valid';
      break;
    case 'tenant-context':
      corrupted.tenantContextState =
        corrupted.tenantContextState === 'matching'
          ? 'foreign'
          : corrupted.tenantContextState === 'foreign'
            ? 'missing'
            : 'matching';
      break;
    case 'canonical-issuer':
      corrupted.canonicalIssuerState =
        corrupted.canonicalIssuerState === 'tenant-canonical'
          ? 'primary-naked'
          : corrupted.canonicalIssuerState === 'unavailable'
            ? 'active-vanity'
            : 'tenant-canonical';
      break;
    case 'tenant-access-set':
      corrupted.tenantAccessSet =
        corrupted.tenantAccessSet.length === 0
          ? ['alpha']
          : corrupted.tenantAccessSet.includes('beta')
            ? corrupted.tenantAccessSet.filter((tenant) => tenant !== 'beta')
            : [...corrupted.tenantAccessSet, 'beta'];
      break;
    case 'tenant-exists-query':
      corrupted.tenantExistsQuery = !corrupted.tenantExistsQuery;
      break;
    case 'tenant-exists-cache':
      corrupted.tenantExistsCacheWrite = !corrupted.tenantExistsCacheWrite;
      break;
    case 'vanity-resolution':
      corrupted.vanityResolutionAttempted = !corrupted.vanityResolutionAttempted;
      break;
    case 'vanity-primary':
      corrupted.vanityPrimaryQuery = !corrupted.vanityPrimaryQuery;
      break;
    case 'settings-read':
      corrupted.settingsRead = !corrupted.settingsRead;
      break;
    case 'registry-read':
      corrupted.registrySnapshotRead = !corrupted.registrySnapshotRead;
      break;
    case 'security-event':
      corrupted.securityEventWritten = !corrupted.securityEventWritten;
      break;
    case 'foreign-tenant':
      corrupted.foreignTenantAccess = !corrupted.foreignTenantAccess;
      break;
    case 'secret-leak':
      corrupted.secretLeak = !corrupted.secretLeak;
      break;
    case 'binding-operation':
      corrupted.bindingOperation = corrupted.bindingOperation === null ? 'd1:alpha:tenants' : null;
      break;
    default:
      throw new Error(`Unknown R-A observation domain: ${domain}`);
  }
  return corrupted;
}

export function corruptRbObservationDomain(
  observation: RbObservation,
  domain: string
): RbObservation {
  const corrupted = { ...observation };
  switch (domain) {
    case 'outcome':
      corrupted.outcome = corrupted.outcome === 'resolved' ? 'error' : 'resolved';
      break;
    case 'error-code':
      corrupted.errorCode =
        corrupted.errorCode === null ? 'missing_snapshot' : `${corrupted.errorCode}-mutated`;
      break;
    case 'rejection-layer':
      corrupted.rejectionLayer = corrupted.rejectionLayer === null ? 'binding' : null;
      break;
    case 'binding-ref':
      corrupted.bindingRef =
        corrupted.bindingRef === null ? 'DB' : `${corrupted.bindingRef}-mutated`;
      break;
    case 'generation':
      corrupted.generation = corrupted.generation === null ? 5 : corrupted.generation + 1;
      break;
    case 'runtime-generation':
      corrupted.runtimeGeneration =
        corrupted.runtimeGeneration === null ? 5 : corrupted.runtimeGeneration + 1;
      break;
    case 'data-role':
      corrupted.dataRole =
        corrupted.dataRole === 'tenant_pii' ? 'tenant_core/default' : 'tenant_pii';
      break;
    case 'allocation':
      corrupted.allocationScope =
        corrupted.allocationScope === null ? 'shared-pool' : 'tenant-exclusive';
      break;
    case 'owner':
      corrupted.ownerTenantId = corrupted.ownerTenantId === null ? 'alpha' : null;
      break;
    case 'provider':
      corrupted.provider = corrupted.provider === null ? 'd1' : 'unsupported';
      break;
    case 'cache-hit':
      corrupted.cacheHit = !corrupted.cacheHit;
      break;
    case 'security-event':
      corrupted.securityEventWritten = !corrupted.securityEventWritten;
      break;
    case 'foreign-tenant':
      corrupted.foreignTenantAccess = !corrupted.foreignTenantAccess;
      break;
    case 'secret-leak':
      corrupted.secretLeak = !corrupted.secretLeak;
      break;
    case 'tenant-access-set':
      corrupted.tenantAccessSet =
        corrupted.tenantAccessSet.length === 0
          ? ['beta']
          : corrupted.tenantAccessSet.includes('beta')
            ? corrupted.tenantAccessSet.filter((tenant) => tenant !== 'beta')
            : [...corrupted.tenantAccessSet, 'beta'];
      break;
    case 'binding-operation':
      corrupted.bindingOperation = corrupted.bindingOperation === null ? 'd1:alpha:SELECT 1' : null;
      break;
    default:
      throw new Error(`Unknown R-B observation domain: ${domain}`);
  }
  return corrupted;
}

export const RA_OBSERVATION_DOMAINS: string[] = [
  'status',
  'error',
  'error-description',
  'location',
  'tenant',
  'issuer',
  'rejection-layer',
  'registry-status',
  'tenant-context',
  'canonical-issuer',
  'tenant-access-set',
  'tenant-exists-query',
  'tenant-exists-cache',
  'vanity-resolution',
  'vanity-primary',
  'settings-read',
  'registry-read',
  'security-event',
  'foreign-tenant',
  'secret-leak',
  'binding-operation',
];

export const RB_OBSERVATION_DOMAINS: string[] = [
  'outcome',
  'error-code',
  'rejection-layer',
  'binding-ref',
  'generation',
  'runtime-generation',
  'data-role',
  'allocation',
  'owner',
  'provider',
  'cache-hit',
  'security-event',
  'foreign-tenant',
  'secret-leak',
  'tenant-access-set',
  'binding-operation',
];
