/**
 * State-transition case tables and test-local decision tables.
 *
 * Matrices:
 * - R (refresh token family): absent → version 1 → version N → absent (expired/revoked/
 *   theft). Theft is observed as family deletion plus exactly one synchronous critical
 *   audit; there is no persistent compromised state.
 * - D (device flow): pending → approved → issued / denied → deleted / expiry. Split into
 *   D-S (store owner) and D-T (real token endpoint) surfaces.
 * - C (CIBA): poll/ping/push with nonce/acr propagation and the mark-token-issued
 *   reservation boundary. Split into C-S (store owner) and C-T (real token endpoint).
 * - Q (queue delivery): processAuditQueue / processDLQQueue /
 *   processLoggingDeliveryQueue per-message ack/retry semantics, one matrix per consumer.
 *
 * The independent coverage checker in meta.test.ts uses independently declared literals and
 * shares no dimension orders, values, constraints, selected triples, or decision
 * functions with this file.
 */
import {
  generateCoveringArray,
  type Constraint,
  type Row,
  type Scalar,
} from '../fixtures/covering-array';
import { deriveCaseId, semanticFingerprint } from '../fixtures/case-fingerprint';

// =============================================================================
// Matrix R: refresh token family
// =============================================================================

export const REFRESH_DIMENSION_ORDER = [
  'familyState',
  'operation',
  'versionRelation',
  'jtiRelation',
  'clientBinding',
  'tenantBinding',
  'scopeRelation',
  'storageOutcome',
  'instanceState',
  'sequence',
  'ttlState',
] as const;

export const REFRESH_VALUES: Record<string, readonly Scalar[]> = {
  familyState: ['absent', 'active', 'expired', 'deleted'],
  operation: [
    'create',
    'rotate',
    'validate',
    'revoke-family',
    'revoke-by-jti',
    'batch-revoke',
    'recreate',
  ],
  versionRelation: ['old', 'exact', 'future', 'missing-family'],
  jtiRelation: ['matching', 'mismatched', 'unknown'],
  clientBinding: ['matching', 'mismatched'],
  tenantBinding: ['matching', 'foreign'],
  scopeRelation: ['omitted', 'equal', 'subset', 'expanded'],
  storageOutcome: ['success', 'read-failure', 'write-failure', 'delete-failure'],
  instanceState: ['same', 'reconstructed'],
  sequence: ['first', 'repeated', 'replay'],
  ttlState: ['active', 'boundary', 'expired'],
};

export const REFRESH_CONSTRAINTS: Constraint[] = [
  // absent family ⇔ missing-family version relation; unknown JTI only when absent.
  (row) =>
    (String(row.familyState) === 'absent') === (String(row.versionRelation) === 'missing-family'),
  (row) => String(row.jtiRelation) !== 'unknown' || String(row.familyState) === 'absent',
  (row) => String(row.familyState) !== 'absent' || String(row.jtiRelation) === 'unknown',
  // create is the first creation; recreate happens only after deletion/expiry.
  (row) => String(row.operation) !== 'create' || String(row.familyState) === 'absent',
  (row) =>
    String(row.operation) !== 'recreate' ||
    String(row.familyState) === 'deleted' ||
    String(row.familyState) === 'expired',
  // Scope relations only apply to rotation.
  (row) => String(row.scopeRelation) === 'omitted' || String(row.operation) === 'rotate',
  // Sequence semantics: replay requires an old version; repeated requires a prior rotation.
  (row) => String(row.sequence) !== 'replay' || String(row.versionRelation) === 'old',
  (row) =>
    String(row.sequence) !== 'repeated' ||
    ['rotate', 'validate', 'revoke-family', 'revoke-by-jti', 'batch-revoke', 'recreate'].includes(
      String(row.operation)
    ),
  // A real prior rotation is only executable on an active family with an active TTL and
  // a clean storage path, so repeated/replay rows require that shape.
  (row) =>
    String(row.sequence) === 'first' ||
    (String(row.familyState) === 'active' &&
      String(row.ttlState) === 'active' &&
      String(row.storageOutcome) === 'success' &&
      String(row.clientBinding) === 'matching' &&
      String(row.tenantBinding) === 'matching'),
  // Reconstruction (a fresh DO instance over the same storage) is only observable after
  // a real first transition, so reconstructed rows must be repeated/replay.
  (row) => String(row.instanceState) === 'same' || String(row.sequence) !== 'first',
  // TTL states: an expired record has an expired TTL; a boundary TTL is treated as
  // expired by rotation (expires_at <= now).
  (row) => String(row.familyState) !== 'expired' || String(row.ttlState) === 'expired',
  (row) => String(row.ttlState) !== 'expired' || String(row.familyState) === 'expired',
  (row) => String(row.familyState) !== 'deleted' || String(row.ttlState) === 'active',
  (row) => String(row.familyState) !== 'absent' || String(row.ttlState) === 'active',
  // Read failures are only observable on a reconstructed instance (the same-instance
  // memory cache would serve the family) except for the list-based revoke operations.
  (row) =>
    String(row.storageOutcome) !== 'read-failure' ||
    String(row.instanceState) === 'reconstructed' ||
    String(row.operation) === 'revoke-by-jti' ||
    String(row.operation) === 'batch-revoke',
  // Write failures apply only to operations that persist.
  (row) =>
    String(row.storageOutcome) !== 'write-failure' ||
    String(row.operation) === 'create' ||
    String(row.operation) === 'recreate' ||
    String(row.operation) === 'rotate',
  // Delete failures apply only to operations that delete.
  (row) =>
    String(row.storageOutcome) !== 'delete-failure' ||
    String(row.operation) === 'rotate' ||
    String(row.operation) === 'revoke-family' ||
    String(row.operation) === 'revoke-by-jti' ||
    String(row.operation) === 'batch-revoke',
  // A delete failure on the list-based revokes is only observable when a matching family
  // actually exists.
  (row) =>
    String(row.storageOutcome) !== 'delete-failure' ||
    String(row.operation) !== 'batch-revoke' ||
    (String(row.jtiRelation) === 'matching' &&
      (String(row.familyState) === 'active' || String(row.familyState) === 'expired')),
  (row) =>
    String(row.storageOutcome) !== 'delete-failure' ||
    String(row.operation) !== 'revoke-by-jti' ||
    (String(row.jtiRelation) === 'matching' &&
      (String(row.familyState) === 'active' || String(row.familyState) === 'expired')),
  // A delete failure on revoke-family is only observable when a family exists.
  (row) =>
    String(row.storageOutcome) !== 'delete-failure' ||
    String(row.operation) !== 'revoke-family' ||
    String(row.familyState) === 'active' ||
    String(row.familyState) === 'expired',
  // A rotate on an expired/deleted family is reachable (not-found / expired paths) but
  // the version/JTI checks never run there; keep those combinations minimal via the
  // exact relation.
  (row) =>
    String(row.operation) !== 'rotate' ||
    String(row.familyState) === 'active' ||
    String(row.familyState) === 'expired' ||
    String(row.familyState) === 'deleted' ||
    String(row.versionRelation) === 'missing-family',
];

export const REFRESH_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['familyState', 'versionRelation', 'jtiRelation'],
  ['operation', 'clientBinding', 'tenantBinding'],
  ['operation', 'scopeRelation', 'versionRelation'],
  ['ttlState', 'instanceState', 'storageOutcome'],
  // revoke operation × JTI presence × repeated delivery
  ['operation', 'jtiRelation', 'sequence'],
  // The theft/scope mutation witnesses need a rotate row that actually reaches the
  // version/JTI/scope checks: rotate × version relation × matching tenant.
  ['operation', 'versionRelation', 'tenantBinding'],
];

export interface RefreshDecision {
  outcome: 'success' | 'error';
  errorCode: string | null;
  familyExists: boolean;
  familyVersion: number | null;
  valid: boolean | null;
  revoked: boolean | null;
  batchRevoked: number | null;
  batchNotFound: number | null;
  criticalAudits: number;
  postDrainAudits: number;
}

export function decideRefresh(row: Row): RefreshDecision {
  const op = String(row.operation);
  const familyState = String(row.familyState);
  const versionRelation = String(row.versionRelation);
  const jtiRelation = String(row.jtiRelation);
  const tenantBinding = String(row.tenantBinding);
  const clientBinding = String(row.clientBinding);
  const scopeRelation = String(row.scopeRelation);
  const storageOutcome = String(row.storageOutcome);
  const ttlState = String(row.ttlState);
  const sequence = String(row.sequence);
  // The family RECORD exists only for active/expired states; 'deleted' has no record
  // but the DO is tenant-pinned, and 'absent' has neither.
  const recordExists = familyState === 'active' || familyState === 'expired';
  // With a REAL prior rotation (repeated/replay) the family is at version 2 when the
  // matrix operation runs; a first call sees version 1.
  const baseVersion = sequence === 'first' ? 1 : 2;

  const base: RefreshDecision = {
    outcome: 'success',
    errorCode: null,
    familyExists: recordExists,
    familyVersion: recordExists ? baseVersion : null,
    valid: null,
    revoked: null,
    batchRevoked: null,
    batchNotFound: null,
    criticalAudits: 0,
    postDrainAudits: 0,
  };

  if (op === 'create' || op === 'recreate') {
    // The tenant pinning check precedes the durable write in production.
    if (tenantBinding === 'foreign' && familyState !== 'absent') {
      return { ...base, outcome: 'error', errorCode: 'invalid_request: Tenant mismatch' };
    }
    if (storageOutcome === 'write-failure') {
      return { ...base, outcome: 'error', errorCode: 'storage' };
    }
    return {
      ...base,
      familyExists: true,
      familyVersion: 1,
      postDrainAudits: 1, // created audit (async flush)
    };
  }

  if (op === 'validate') {
    if (storageOutcome === 'read-failure') {
      return { ...base, outcome: 'error', errorCode: 'storage', valid: false };
    }
    return {
      ...base,
      valid:
        recordExists &&
        ttlState === 'active' &&
        versionRelation === 'exact' &&
        clientBinding === 'matching',
    };
  }

  if (op === 'revoke-family') {
    if (storageOutcome === 'read-failure' || storageOutcome === 'delete-failure') {
      return { ...base, outcome: 'error', errorCode: 'storage' };
    }
    if (!recordExists) {
      // Already revoked or never existed: silent success, no audit.
      return { ...base, familyExists: false, familyVersion: null };
    }
    return { ...base, familyExists: false, familyVersion: null, criticalAudits: 1 };
  }

  if (op === 'revoke-by-jti') {
    if (storageOutcome === 'read-failure' || storageOutcome === 'delete-failure') {
      return { ...base, outcome: 'error', errorCode: 'storage', revoked: false };
    }
    if (jtiRelation !== 'matching' || !recordExists) {
      return { ...base, revoked: false, familyExists: recordExists };
    }
    return { ...base, revoked: true, familyExists: false, familyVersion: null, criticalAudits: 1 };
  }

  if (op === 'batch-revoke') {
    if (storageOutcome === 'read-failure' || storageOutcome === 'delete-failure') {
      return { ...base, outcome: 'error', errorCode: 'storage' };
    }
    if (jtiRelation === 'matching' && recordExists) {
      return {
        ...base,
        batchRevoked: 1,
        batchNotFound: 1,
        familyExists: false,
        familyVersion: null,
        postDrainAudits: 1, // batch family_revoked audit (async flush)
      };
    }
    return { ...base, batchRevoked: 0, batchNotFound: 2, familyExists: recordExists };
  }

  // rotate
  // A tenant mismatch is only reported when the DO is already pinned; an absent family
  // means the DO is fresh and simply pins the (foreign) tenant before reporting not found.
  if (tenantBinding === 'foreign' && familyState !== 'absent') {
    return { ...base, outcome: 'error', errorCode: 'invalid_request: Tenant mismatch' };
  }
  // loadFamily reads storage before the not-found check, so a read failure surfaces
  // first on a reconstructed instance.
  if (storageOutcome === 'read-failure') {
    return { ...base, outcome: 'error', errorCode: 'storage' };
  }
  if (!recordExists) {
    return {
      ...base,
      outcome: 'error',
      errorCode: 'invalid_grant: Token family not found',
      familyExists: false,
    };
  }
  if (clientBinding === 'mismatched') {
    return { ...base, outcome: 'error', errorCode: 'invalid_grant: Client ID mismatch' };
  }
  const deletesFamily =
    ttlState === 'boundary' ||
    ttlState === 'expired' ||
    versionRelation === 'old' ||
    jtiRelation === 'mismatched';
  if (storageOutcome === 'delete-failure' && deletesFamily) {
    // The family record could not be removed; the error surfaces and the family stays.
    return { ...base, outcome: 'error', errorCode: 'storage' };
  }
  if (ttlState === 'boundary' || ttlState === 'expired') {
    return {
      ...base,
      outcome: 'error',
      errorCode: 'invalid_grant: Refresh token expired',
      familyExists: false,
      familyVersion: null,
      postDrainAudits: 1, // expired audit (async flush)
    };
  }
  if (versionRelation === 'old') {
    return {
      ...base,
      outcome: 'error',
      errorCode: 'invalid_grant: Token theft detected. Family revoked.',
      familyExists: false,
      familyVersion: null,
      criticalAudits: 1, // synchronous theft audit
    };
  }
  if (versionRelation === 'future') {
    return { ...base, outcome: 'error', errorCode: 'invalid_grant: Version mismatch' };
  }
  if (jtiRelation === 'mismatched') {
    return {
      ...base,
      outcome: 'error',
      errorCode: 'invalid_grant: Token theft detected (JTI mismatch). Family revoked.',
      familyExists: false,
      familyVersion: null,
      criticalAudits: 1,
    };
  }
  if (scopeRelation === 'expanded') {
    return {
      ...base,
      outcome: 'error',
      errorCode: 'invalid_scope: Requested scope is not allowed',
    };
  }
  if (storageOutcome === 'write-failure') {
    // The durable write fails; the cached family stays at the previous version.
    return { ...base, outcome: 'error', errorCode: 'storage', familyVersion: baseVersion };
  }
  return {
    ...base,
    familyVersion: baseVersion + 1,
    postDrainAudits: 1, // rotated audit (async flush)
  };
}

// =============================================================================
// Matrix D-S: device flow store owner
// =============================================================================

export const DEVICE_STORE_DIMENSION_ORDER = [
  'state',
  'operation',
  'clientBinding',
  'tenantBinding',
  'expiry',
  'reservationResult',
] as const;

export const DEVICE_STORE_VALUES: Record<string, readonly Scalar[]> = {
  state: ['missing', 'pending', 'approved', 'denied', 'expired', 'issued'],
  operation: ['store', 'approve', 'deny', 'mark-issued', 'delete', 'alarm'],
  clientBinding: ['matching', 'not-applicable'],
  tenantBinding: ['matching', 'foreign'],
  expiry: ['active', 'boundary', 'expired'],
  reservationResult: ['not-applicable', 'already-issued'],
};

export const DEVICE_STORE_CONSTRAINTS: Constraint[] = [
  (row) => String(row.operation) !== 'store' || String(row.state) === 'missing',
  // approve/deny may target any existing record so the forbidden edges (approve on a
  // non-pending record, deny on a non-pending record) are executed against the real
  // store; a valid transition requires pending.
  (row) =>
    String(row.operation) !== 'approve' ||
    String(row.state) === 'pending' ||
    String(row.state) === 'denied' ||
    String(row.state) === 'approved' ||
    String(row.state) === 'issued',
  (row) =>
    String(row.operation) !== 'deny' ||
    String(row.state) === 'pending' ||
    String(row.state) === 'denied' ||
    String(row.state) === 'approved' ||
    String(row.state) === 'issued',
  (row) =>
    String(row.operation) !== 'mark-issued' ||
    String(row.state) === 'approved' ||
    String(row.state) === 'issued',
  (row) => String(row.operation) !== 'delete' || String(row.state) !== 'missing',
  (row) => String(row.operation) !== 'alarm' || String(row.state) !== 'missing',
  // Expiry semantics: an expired record has an expired TTL; boundary counts as expired.
  (row) => String(row.state) !== 'expired' || String(row.expiry) === 'expired',
  (row) => String(row.state) === 'expired' || String(row.expiry) !== 'expired',
  (row) =>
    String(row.state) === 'pending' ||
    String(row.state) === 'approved' ||
    String(row.expiry) === 'active',
  // denied and issued records are seeded through a transition that self-deletes on
  // boundary/expired expiry, so they require an active expiry.
  (row) => String(row.state) !== 'denied' || String(row.expiry) === 'active',
  (row) => String(row.state) !== 'issued' || String(row.expiry) === 'active',
  (row) => String(row.reservationResult) !== 'already-issued' || String(row.expiry) === 'active',
  // The store never checks the client binding; only the token surface observes it.
  (row) => String(row.clientBinding) === 'not-applicable',
  // already-issued is only observable through a second mark-issued call.
  (row) =>
    String(row.reservationResult) !== 'already-issued' || String(row.operation) === 'mark-issued',
];

export const DEVICE_STORE_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['state', 'operation', 'clientBinding'],
  ['state', 'operation', 'tenantBinding'],
  ['state', 'reservationResult', 'expiry'],
];

// =============================================================================
// Matrix D-T: device flow real token endpoint
// =============================================================================

export const DEVICE_TOKEN_DIMENSION_ORDER = [
  'state',
  'clientBinding',
  'tenantBinding',
  'pollingTiming',
  'attempt',
  'reservationResult',
  'expiry',
  'tokenOutcome',
] as const;

export const DEVICE_TOKEN_VALUES: Record<string, readonly Scalar[]> = {
  state: ['missing', 'pending', 'approved', 'denied', 'expired', 'issued'],
  clientBinding: ['matching', 'wrong'],
  tenantBinding: ['matching', 'foreign'],
  pollingTiming: ['first', 'too-early', 'eligible'],
  attempt: ['first', 'repeated'],
  reservationResult: ['success', 'already-issued', 'json-non2xx', 'malformed-body', 'empty-body'],
  expiry: ['active', 'boundary', 'expired'],
  tokenOutcome: [
    'issued',
    'pending',
    'slow-down',
    'access-denied',
    'expired',
    'invalid-grant',
    'client-mismatch',
  ],
};

export const DEVICE_TOKEN_CONSTRAINTS: Constraint[] = [
  // Expiry semantics.
  (row) => String(row.state) !== 'expired' || String(row.expiry) === 'expired',
  (row) => String(row.state) === 'expired' || String(row.expiry) !== 'expired',
  // Wrong client binding is only observable through the stub store (rows with a
  // non-success reservation or a pending state); the real store always holds the
  // registered client id.
  (row) =>
    String(row.clientBinding) !== 'wrong' ||
    String(row.reservationResult) !== 'success' ||
    String(row.state) === 'pending',
  // The token outcome is derived from the other dimensions.
  (row) => {
    const state = String(row.state);
    const clientBinding = String(row.clientBinding);
    const reservation = String(row.reservationResult);
    const polling = String(row.pollingTiming);
    const outcome = String(row.tokenOutcome);
    if (clientBinding === 'wrong') return outcome === 'client-mismatch';
    // The reservation only runs for an approved request; other states never reach it.
    if (state !== 'approved') {
      switch (state) {
        case 'missing':
          return outcome === 'expired';
        case 'pending':
          return outcome === (polling === 'too-early' ? 'slow-down' : 'pending');
        case 'denied':
          return outcome === 'access-denied';
        case 'expired':
          return outcome === 'expired';
        case 'issued':
          return outcome === 'invalid-grant';
        default:
          return false;
      }
    }
    return outcome === (reservation === 'success' ? 'issued' : 'invalid-grant');
  },
];

export const DEVICE_TOKEN_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['state', 'pollingTiming', 'attempt'],
  ['state', 'reservationResult', 'expiry'],
  ['state', 'clientBinding', 'tenantBinding'],
  ['reservationResult', 'state', 'tokenOutcome'],
];

// =============================================================================
// Matrix C-S: CIBA store owner
// =============================================================================

export const CIBA_STORE_DIMENSION_ORDER = [
  'deliveryMode',
  'state',
  'operation',
  'nonce',
  'acr',
  'approvalResult',
  'tenantBinding',
  'reservationResult',
] as const;

export const CIBA_STORE_VALUES: Record<string, readonly Scalar[]> = {
  deliveryMode: ['poll', 'ping', 'push'],
  state: ['missing', 'pending', 'approved', 'denied', 'expired', 'issued'],
  operation: ['store', 'approve', 'deny', 'mark-issued', 'delete', 'alarm'],
  nonce: ['absent', 'present', 'mismatched', 'not-applicable'],
  acr: ['absent', 'matching', 'mismatched', 'not-applicable'],
  approvalResult: ['success', 'already-approved', 'expired', 'missing', 'not-applicable'],
  tenantBinding: ['matching', 'foreign'],
  reservationResult: ['not-applicable', 'already-issued'],
};

export const CIBA_STORE_CONSTRAINTS: Constraint[] = [
  (row) => String(row.operation) !== 'store' || String(row.state) === 'missing',
  (row) => String(row.operation) !== 'approve' || String(row.state) !== 'issued',
  (row) => String(row.operation) !== 'deny' || String(row.state) === 'pending',
  (row) =>
    String(row.operation) !== 'mark-issued' ||
    String(row.state) === 'approved' ||
    String(row.state) === 'issued',
  (row) => String(row.operation) !== 'delete' || String(row.state) !== 'missing',
  (row) => String(row.operation) !== 'alarm' || String(row.state) !== 'missing',
  // nonce/acr only meaningful on approve.
  (row) => String(row.nonce) !== 'not-applicable' || String(row.operation) !== 'approve',
  (row) => String(row.acr) !== 'not-applicable' || String(row.operation) !== 'approve',
  (row) => String(row.operation) === 'approve' || String(row.nonce) === 'not-applicable',
  (row) => String(row.operation) === 'approve' || String(row.acr) === 'not-applicable',
  // approvalResult only on approve, tied to state.
  (row) =>
    String(row.approvalResult) === 'not-applicable' ||
    (String(row.operation) === 'approve' &&
      ((String(row.approvalResult) === 'success' && String(row.state) === 'pending') ||
        (String(row.approvalResult) === 'already-approved' && String(row.state) === 'approved') ||
        (String(row.approvalResult) === 'expired' && String(row.state) === 'expired') ||
        (String(row.approvalResult) === 'missing' && String(row.state) === 'missing'))),
  (row) => String(row.operation) === 'approve' || String(row.approvalResult) === 'not-applicable',
  // already-issued reservation only through a second mark-issued call.
  (row) =>
    String(row.reservationResult) !== 'already-issued' || String(row.operation) === 'mark-issued',
];

export const CIBA_STORE_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['deliveryMode', 'state', 'operation'],
  // nonce × authenticated ACR × approval result
  ['nonce', 'acr', 'approvalResult'],
  ['state', 'operation', 'tenantBinding'],
  ['state', 'reservationResult', 'expiry'],
];

// =============================================================================
// Matrix C-T: CIBA real token endpoint
// =============================================================================

export const CIBA_TOKEN_DIMENSION_ORDER = [
  'deliveryMode',
  'state',
  'pollingTiming',
  'attempt',
  'nonce',
  'acr',
  'clientAuth',
  'clientBinding',
  'tenantBinding',
  'reservationResult',
  'tokenOutcome',
] as const;

export const CIBA_TOKEN_VALUES: Record<string, readonly Scalar[]> = {
  deliveryMode: ['poll', 'ping', 'push'],
  state: ['missing', 'pending', 'approved', 'denied', 'expired', 'issued'],
  pollingTiming: ['first', 'too-early', 'eligible'],
  attempt: ['first', 'repeated'],
  nonce: ['absent', 'present', 'mismatched'],
  acr: ['absent', 'matching', 'mismatched'],
  clientAuth: ['valid', 'missing', 'invalid', 'wrong-client'],
  clientBinding: ['matching', 'mismatched'],
  tenantBinding: ['matching', 'foreign'],
  reservationResult: ['success', 'already-issued', 'json-non2xx', 'malformed-body', 'empty-body'],
  tokenOutcome: [
    'issued',
    'pending',
    'slow-down',
    'access-denied',
    'expired',
    'invalid-grant',
    'client-auth-failed',
    'client-mismatch',
  ],
};

export const CIBA_TOKEN_CONSTRAINTS: Constraint[] = [
  // Mismatched client binding is only observable through the stub store (rows with a
  // non-success reservation or a pending state); the real store always holds the
  // registered client id.
  (row) =>
    String(row.clientBinding) !== 'mismatched' ||
    String(row.reservationResult) !== 'success' ||
    String(row.state) === 'pending',
  // The token outcome is derived from the other dimensions.
  (row) => {
    const state = String(row.state);
    const deliveryMode = String(row.deliveryMode);
    const clientAuth = String(row.clientAuth);
    const clientBinding = String(row.clientBinding);
    const reservation = String(row.reservationResult);
    const polling = String(row.pollingTiming);
    const outcome = String(row.tokenOutcome);
    if (clientAuth !== 'valid') return outcome === 'client-auth-failed';
    if (clientBinding === 'mismatched') return outcome === 'client-mismatch';
    if (reservation !== 'success') return outcome === 'invalid-grant';
    switch (state) {
      case 'missing':
        return outcome === 'expired';
      case 'pending':
        return (
          outcome === (deliveryMode === 'poll' && polling === 'too-early' ? 'slow-down' : 'pending')
        );
      case 'denied':
        return outcome === 'access-denied';
      case 'expired':
        return outcome === 'expired';
      case 'issued':
        return outcome === 'invalid-grant';
      case 'approved':
        return outcome === 'issued';
      default:
        return false;
    }
  },
  // nonce/acr are only observable on the issued token; other outcomes never read them.
  (row) =>
    String(row.tokenOutcome) === 'issued' ||
    (String(row.nonce) === 'absent' && String(row.acr) === 'absent'),
  // Polling timing only shapes the pending/slow-down outcomes.
  (row) =>
    String(row.tokenOutcome) === 'pending' ||
    String(row.tokenOutcome) === 'slow-down' ||
    (String(row.pollingTiming) === 'first' && String(row.attempt) === 'first'),
  // The reservation only runs for an approved request; issued requests are rejected
  // before the reservation and other states never reach it.
  (row) => String(row.reservationResult) === 'success' || String(row.state) === 'approved',
];

export const CIBA_TOKEN_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['deliveryMode', 'state', 'pollingTiming'],
  ['deliveryMode', 'pollingTiming', 'attempt'],
  // nonce × authenticated ACR × approval result
  ['nonce', 'acr', 'tokenOutcome'],
  // client authentication × tenant binding × state
  ['clientAuth', 'tenantBinding', 'state'],
  // reservation result × state × token endpoint outcome
  ['reservationResult', 'state', 'tokenOutcome'],
];

// =============================================================================
// Matrices Q: queue consumers
// =============================================================================

export const QUEUE_AUDIT_DIMENSION_ORDER = [
  'batchComposition',
  'attempt',
  'delivery',
  'bindingState',
  'tenant',
  'dlqArchive',
  'payloadFamily',
] as const;

export const QUEUE_AUDIT_VALUES: Record<string, readonly Scalar[]> = {
  batchComposition: ['all-success', 'mixed', 'all-fail'],
  attempt: ['first', 'retry', 'terminal'],
  delivery: ['first', 'duplicate'],
  bindingState: ['present', 'missing', 'throws'],
  tenant: ['matching', 'foreign'],
  dlqArchive: ['success', 'missing', 'throws'],
  payloadFamily: ['event-log', 'pii-log', 'unknown-audit', 'fanout'],
};

export const QUEUE_AUDIT_CONSTRAINTS: Constraint[] = [
  // attempts are only observable on the fanout path (attempt_count is recorded in the
  // aggregates and delivery events); event/pii/unknown paths never read attempts.
  (row) => String(row.attempt) === 'first' || String(row.payloadFamily) === 'fanout',
  // Only fanout touches the AUDIT_ARCHIVE bucket; other payloads never read it.
  (row) => String(row.payloadFamily) === 'fanout' || String(row.dlqArchive) === 'success',
  // all-success batches contain one healthy message.
  (row) =>
    String(row.batchComposition) !== 'all-success' ||
    (String(row.payloadFamily) !== 'unknown-audit' && String(row.bindingState) === 'present'),
  // all-fail batches contain a failing message.
  (row) =>
    String(row.batchComposition) !== 'all-fail' ||
    String(row.payloadFamily) === 'unknown-audit' ||
    String(row.bindingState) !== 'present',
  // mixed batches hold a healthy first message plus the failing second one.
  (row) =>
    String(row.batchComposition) !== 'mixed' ||
    (String(row.payloadFamily) !== 'unknown-audit' && String(row.bindingState) === 'present'),
  // A fanout success requires the archive bucket.
  (row) =>
    String(row.batchComposition) !== 'all-success' ||
    String(row.payloadFamily) !== 'fanout' ||
    String(row.dlqArchive) === 'success',
  // A fanout all-fail batch with a present binding must fail through the archive.
  (row) =>
    String(row.batchComposition) !== 'all-fail' ||
    String(row.payloadFamily) !== 'fanout' ||
    String(row.bindingState) !== 'present' ||
    String(row.dlqArchive) !== 'success',
];

export const QUEUE_AUDIT_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['batchComposition', 'attempt', 'delivery'],
  ['delivery', 'bindingState', 'payloadFamily'],
  ['tenant', 'dlqArchive', 'payloadFamily'],
];

export const QUEUE_DLQ_DIMENSION_ORDER = [
  'batchComposition',
  'attempt',
  'delivery',
  'bindingState',
  'tenant',
  'dlqArchive',
  'payloadFamily',
] as const;

export const QUEUE_DLQ_VALUES: Record<string, readonly Scalar[]> = {
  batchComposition: ['all-success', 'all-fail'],
  attempt: ['first', 'retry', 'terminal'],
  delivery: ['first', 'duplicate'],
  bindingState: ['present', 'missing', 'throws'],
  tenant: ['matching', 'foreign'],
  dlqArchive: ['success', 'missing', 'throws'],
  payloadFamily: ['event-log', 'pii-log'],
};

export const QUEUE_DLQ_CONSTRAINTS: Constraint[] = [
  (row) => String(row.batchComposition) !== 'mixed',
  // attempts are observable only when the DLQ save runs (binding present).
  (row) => String(row.attempt) === 'first' || String(row.bindingState) === 'present',
  // all-fail batches require a throwing binding or a throwing archive bucket.
  (row) =>
    String(row.batchComposition) !== 'all-fail' ||
    String(row.bindingState) === 'throws' ||
    String(row.dlqArchive) === 'throws',
];

export const QUEUE_DLQ_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['batchComposition', 'attempt', 'delivery'],
  ['bindingState', 'dlqArchive', 'tenant'],
  ['delivery', 'payloadFamily', 'bindingState'],
];

export const QUEUE_LOG_DIMENSION_ORDER = [
  'batchComposition',
  'attempt',
  'schema',
  'delivery',
  'lane',
  'bindingState',
  'tenant',
  'dlqArchive',
  'payloadFamily',
] as const;

export const QUEUE_LOG_VALUES: Record<string, readonly Scalar[]> = {
  batchComposition: ['all-success', 'mixed', 'all-fail'],
  attempt: ['first', 'retry', 'terminal'],
  schema: ['supported', 'future', 'malformed'],
  delivery: ['first', 'duplicate'],
  lane: ['critical', 'default', 'bulk', 'fallback'],
  bindingState: ['present', 'missing', 'throws'],
  tenant: ['matching', 'foreign'],
  dlqArchive: ['success', 'missing', 'throws'],
  payloadFamily: [
    'chunk-write',
    'delivery-fanout',
    'http-sink-batch',
    'dlq-replay',
    'rewrap-chunk',
    'future-schema',
    'malformed',
  ],
};

export const QUEUE_LOG_CONSTRAINTS: Constraint[] = [
  (row) =>
    String(row.batchComposition) !== 'mixed' ||
    (String(row.schema) === 'future' &&
      String(row.dlqArchive) === 'success' &&
      String(row.bindingState) === 'present'),
  // attempts are observable only through recorded attempt_count values (chunk-write
  // aggregates, future-schema DLQ save, fanout/sink delivery events).
  (row) =>
    String(row.attempt) === 'first' ||
    ['chunk-write', 'future-schema', 'delivery-fanout', 'http-sink-batch'].includes(
      String(row.payloadFamily)
    ),
  // Schema semantics tied to the payload family.
  (row) => String(row.payloadFamily) !== 'future-schema' || String(row.schema) === 'future',
  (row) => String(row.payloadFamily) !== 'malformed' || String(row.schema) === 'malformed',
  (row) => String(row.payloadFamily) === 'future-schema' || String(row.schema) !== 'future',
  (row) => String(row.payloadFamily) === 'malformed' || String(row.schema) !== 'malformed',
  // Only the chunk-write payload succeeds for a supported schema in this environment;
  // the other supported families require real external destinations that the Node fake
  // cannot provide.
  (row) =>
    String(row.payloadFamily) === 'chunk-write' ||
    String(row.schema) !== 'supported' ||
    String(row.bindingState) !== 'present',
  // Fallback lanes require a missing primary binding and an all-fail batch.
  (row) => String(row.lane) !== 'fallback' || String(row.bindingState) === 'missing',
  (row) => String(row.lane) !== 'fallback' || String(row.batchComposition) === 'all-fail',
  // chunk-write success requires the archive bucket and a present binding.
  (row) =>
    String(row.batchComposition) !== 'all-success' ||
    String(row.payloadFamily) !== 'chunk-write' ||
    (String(row.bindingState) === 'present' && String(row.dlqArchive) === 'success'),
  // future-schema success requires the archive bucket and a present binding.
  (row) =>
    String(row.batchComposition) !== 'all-success' ||
    String(row.payloadFamily) !== 'future-schema' ||
    (String(row.bindingState) === 'present' && String(row.dlqArchive) === 'success'),
  // malformed envelopes always retry (never an all-success batch).
  (row) => String(row.schema) !== 'malformed' || String(row.batchComposition) !== 'all-success',
  // all-fail batches contain a failing message.
  (row) =>
    String(row.batchComposition) !== 'all-fail' ||
    String(row.schema) === 'malformed' ||
    String(row.bindingState) !== 'present' ||
    ['delivery-fanout', 'http-sink-batch', 'dlq-replay', 'rewrap-chunk'].includes(
      String(row.payloadFamily)
    ),
];

export const QUEUE_LOG_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['batchComposition', 'schema', 'delivery'],
  ['schema', 'attempt', 'lane'],
  ['lane', 'bindingState', 'tenant'],
  ['delivery', 'bindingState', 'payloadFamily'],
  ['tenant', 'dlqArchive', 'payloadFamily'],
  ['dlqArchive', 'schema', 'attempt'],
];

// =============================================================================
// Decision tables
// =============================================================================

export interface DeviceDecision {
  status: number;
  error: string | null;
  errorDescription: string | null;
  state: string | null;
  tokenIssued: boolean;
  tokenIssuedAt: number | null;
  accessTokenIssued: boolean;
  signingCalls: number;
  reservationReached: boolean;
  storageWrites: number;
  storageDeletes: number;
  alarmSet: boolean;
  foreignInstanceTouched: boolean;
}

export function decideDeviceStore(row: Row): DeviceDecision {
  const state = String(row.state);
  const op = String(row.operation);
  const reservationResult = String(row.reservationResult);
  const expiry = String(row.expiry);
  const base: DeviceDecision = {
    status: 0,
    error: null,
    errorDescription: null,
    state: null,
    tokenIssued: false,
    tokenIssuedAt: null,
    accessTokenIssued: false,
    signingCalls: 0,
    reservationReached: false,
    storageWrites: 0,
    storageDeletes: 0,
    alarmSet: false,
    foreignInstanceTouched: false,
  };
  // Device expiry uses `Date.now() > expires_at`, so a boundary expiry is still valid;
  // only a past expiry self-deletes on read. (CIBA uses >= and differs; see C-S.)
  const expired = expiry === 'expired';
  // The REAL store keeps the record status 'approved' with token_issued=true after
  // mark-token-issued; a seeded 'issued' state is stored that way.
  const storedStatus = state === 'issued' ? 'approved' : state;
  const storedTokenIssued = state === 'issued';
  switch (op) {
    case 'store':
      return { ...base, status: 200, state: 'pending', storageWrites: 2, alarmSet: !expired };
    case 'approve':
      if (expired) {
        // The expired code self-deletes on read and approval fails closed.
        return { ...base, status: 500, error: 'server_error', state: null, storageDeletes: 1 };
      }
      if (state !== 'pending') {
        // Forbidden edge: approving a non-pending record throws 'Device code already
        // <status>' and the store fails closed without any write.
        return {
          ...base,
          status: 500,
          error: 'server_error',
          state: storedStatus,
          tokenIssued: storedTokenIssued,
        };
      }
      return { ...base, status: 200, state: 'approved', storageWrites: 1 };
    case 'deny':
      if (expired) {
        return { ...base, status: 500, error: 'server_error', state: null, storageDeletes: 1 };
      }
      if (state !== 'pending') {
        // Forbidden edge: denying a non-pending record fails closed.
        return {
          ...base,
          status: 500,
          error: 'server_error',
          state: storedStatus,
          tokenIssued: storedTokenIssued,
        };
      }
      return { ...base, status: 200, state: 'denied', storageWrites: 1 };
    case 'mark-issued':
      if (state === 'approved' && expired) {
        return { ...base, status: 500, error: 'server_error', state: null, storageDeletes: 1 };
      }
      if (state === 'approved' && reservationResult === 'not-applicable') {
        return {
          ...base,
          status: 200,
          state: 'approved',
          tokenIssued: true,
          tokenIssuedAt: 1700000000,
          storageWrites: 1,
        };
      }
      // An already-issued reservation (seeded as such) or an issued record fails closed
      // on the mark-issued call; the record status stays 'approved'.
      return {
        ...base,
        status: 500,
        error: 'server_error',
        state: 'approved',
        tokenIssued: true,
        storageWrites: 0,
        reservationReached: false,
      };
    case 'delete':
      return { ...base, status: 200, state: null, storageDeletes: 1 };
    case 'alarm':
      return {
        ...base,
        status: 200,
        state: state === 'issued' ? 'approved' : state,
        tokenIssued: state === 'issued',
        storageWrites: 1,
        alarmSet: true,
      };
    default:
      throw new Error(`unreachable device store op ${op}`);
  }
}

export function decideDeviceToken(row: Row): DeviceDecision {
  const state = String(row.state);
  const clientBinding = String(row.clientBinding);
  const pollingTiming = String(row.pollingTiming);
  const reservationResult = String(row.reservationResult);
  const base: DeviceDecision = {
    status: 0,
    error: null,
    errorDescription: null,
    state: null,
    tokenIssued: false,
    tokenIssuedAt: null,
    accessTokenIssued: false,
    signingCalls: 0,
    reservationReached: false,
    storageWrites: 0,
    storageDeletes: 0,
    alarmSet: false,
    foreignInstanceTouched: false,
  };
  // A missing or real-store-expired code surfaces as expired_token before any client
  // check (the real store self-deletes the expired record during the get).
  if (state === 'missing') {
    return {
      ...base,
      status: 400,
      error: 'expired_token',
      errorDescription: 'Device code has expired or is invalid',
      state: null,
    };
  }
  if (state === 'expired' && reservationResult === 'success') {
    return {
      ...base,
      status: 400,
      error: 'expired_token',
      errorDescription: 'Device code has expired or is invalid',
      state: null,
    };
  }
  if (clientBinding === 'wrong') {
    return {
      ...base,
      status: 400,
      error: 'invalid_grant',
      errorDescription: 'Device code does not belong to this client',
      state,
      tokenIssued: state === 'issued',
    };
  }
  // The reservation only runs for an approved request.
  if (state !== 'approved') {
    switch (state) {
      case 'pending':
        return {
          ...base,
          status: 400,
          error: pollingTiming === 'too-early' ? 'slow_down' : 'authorization_pending',
          errorDescription:
            pollingTiming === 'too-early'
              ? 'You are polling too frequently. Please slow down.'
              : 'User has not yet authorized the device',
          state,
        };
      case 'denied':
        return {
          ...base,
          status: 403,
          error: 'access_denied',
          errorDescription: 'User denied the authorization request',
          state: null,
          storageDeletes: 0,
        };
      case 'expired':
        return {
          ...base,
          status: 400,
          error: 'expired_token',
          errorDescription: 'Device code has expired',
          state,
        };
      case 'issued':
        if (reservationResult === 'success') {
          // Real store: the record status is still approved, so the reservation runs
          // and fails closed with the already-used description.
          return {
            ...base,
            status: 400,
            error: 'invalid_grant',
            errorDescription: 'Device code has already been used or is not approved',
            state: 'approved',
            tokenIssued: true,
            reservationReached: true,
            signingCalls: 0,
          };
        }
        return {
          ...base,
          status: 400,
          error: 'invalid_grant',
          errorDescription: 'Device code is not approved',
          state,
          tokenIssued: true,
          signingCalls: 0,
        };
      default:
        throw new Error(`unreachable device token state ${state}`);
    }
  }
  if (reservationResult !== 'success') {
    return {
      ...base,
      status: 400,
      error: 'invalid_grant',
      errorDescription: 'Device code has already been used or is not approved',
      state,
      reservationReached: true,
      signingCalls: 0,
    };
  }
  return {
    ...base,
    status: 200,
    state: 'approved',
    tokenIssued: true,
    tokenIssuedAt: 1700000000,
    accessTokenIssued: true,
    signingCalls: 1,
    reservationReached: true,
    storageWrites: 0,
  };
}

export interface CibaDecision {
  status: number;
  error: string | null;
  errorDescription: string | null;
  state: string | null;
  tokenIssued: boolean;
  accessTokenIssued: boolean;
  signingCalls: number;
  reservationReached: boolean;
  idTokenNonce: string | null;
  idTokenAcr: string | null;
  storedNonce: string | null;
  storedAcr: string | null;
  storageWrites: number;
  storageDeletes: number;
  alarmSet: boolean;
  foreignInstanceTouched: boolean;
}

export function decideCibaStore(row: Row): CibaDecision {
  const state = String(row.state);
  const op = String(row.operation);
  const nonce = String(row.nonce);
  const acr = String(row.acr);
  const reservationResult = String(row.reservationResult);
  const base: CibaDecision = {
    status: 0,
    error: null,
    errorDescription: null,
    state: null,
    tokenIssued: false,
    accessTokenIssued: false,
    signingCalls: 0,
    reservationReached: false,
    idTokenNonce: null,
    idTokenAcr: null,
    storedNonce: null,
    storedAcr: null,
    storageWrites: 0,
    storageDeletes: 0,
    alarmSet: false,
    foreignInstanceTouched: false,
  };
  const nonceValue =
    nonce === 'absent' || nonce === 'not-applicable'
      ? null
      : nonce === 'present'
        ? 'nonce-approved-a'
        : 'nonce-approved-b';
  const acrValue =
    acr === 'absent' || acr === 'not-applicable'
      ? null
      : acr === 'matching'
        ? 'urn:authrim:acr:1'
        : 'urn:authrim:acr:2';
  switch (op) {
    case 'store':
      return { ...base, status: 200, state: 'pending', storageWrites: 1, alarmSet: true };
    case 'approve':
      if (state === 'pending') {
        return {
          ...base,
          status: 200,
          state: 'approved',
          storageWrites: 1,
          storedNonce: nonceValue,
          storedAcr: acrValue,
        };
      }
      if (state === 'missing') {
        return { ...base, status: 500, error: 'server_error', state: null };
      }
      if (state === 'expired') {
        // The expired request self-deletes on read and approval fails closed.
        return { ...base, status: 500, error: 'server_error', state: null, storageDeletes: 1 };
      }
      // The record carries the approved nonce/acr from the seed only when it was
      // approved; denied/missing records never stored them.
      return {
        ...base,
        status: 500,
        error: 'server_error',
        state: state === 'issued' ? 'approved' : state,
        storedNonce: state === 'approved' || state === 'issued' ? nonceValue : null,
        storedAcr: state === 'approved' || state === 'issued' ? acrValue : null,
      };
    case 'deny':
      if (state === 'pending') {
        return { ...base, status: 200, state: 'denied', storageWrites: 1 };
      }
      return { ...base, status: 500, error: 'server_error', state };
    case 'mark-issued':
      if (state === 'approved' && reservationResult === 'not-applicable') {
        return { ...base, status: 200, state: 'approved', tokenIssued: true, storageWrites: 1 };
      }
      // An already-issued reservation (seeded as such) or an issued record fails closed;
      // the record status stays approved.
      return {
        ...base,
        status: 500,
        error: 'server_error',
        state: 'approved',
        tokenIssued: true,
        storageWrites: 0,
        reservationReached: false,
      };
    case 'delete':
      return { ...base, status: 200, state: null, storageDeletes: 1 };
    case 'alarm':
      if (state === 'expired') {
        // The expired request is cleaned up by the alarm.
        return {
          ...base,
          status: 200,
          state: null,
          storageWrites: 1,
          storageDeletes: 1,
          alarmSet: true,
        };
      }
      return {
        ...base,
        status: 200,
        state: state === 'issued' ? 'approved' : state,
        tokenIssued: state === 'issued',
        storageWrites: 1,
        alarmSet: true,
      };
    default:
      throw new Error(`unreachable ciba store op ${op}`);
  }
}

export function decideCibaToken(row: Row): CibaDecision {
  const state = String(row.state);
  const deliveryMode = String(row.deliveryMode);
  const pollingTiming = String(row.pollingTiming);
  const nonce = String(row.nonce);
  const acr = String(row.acr);
  const clientAuth = String(row.clientAuth);
  const clientBinding = String(row.clientBinding);
  const reservationResult = String(row.reservationResult);
  const base: CibaDecision = {
    status: 0,
    error: null,
    errorDescription: null,
    state: null,
    tokenIssued: false,
    accessTokenIssued: false,
    signingCalls: 0,
    reservationReached: false,
    idTokenNonce: null,
    idTokenAcr: null,
    storedNonce: null,
    storedAcr: null,
    storageWrites: 0,
    storageDeletes: 0,
    alarmSet: false,
    foreignInstanceTouched: false,
  };
  const nonceValue =
    nonce === 'absent' || nonce === 'not-applicable'
      ? null
      : nonce === 'present'
        ? 'nonce-approved-a'
        : 'nonce-approved-b';
  const acrValue =
    acr === 'absent' || acr === 'not-applicable'
      ? null
      : acr === 'matching'
        ? 'urn:authrim:acr:1'
        : 'urn:authrim:acr:2';
  // The real store is used for success reservations except pending rows; it always
  // holds the registered client id and keeps the record status for approved/issued
  // records (expired records keep status pending because the expiry lives in the
  // timestamp).
  const realStore = reservationResult === 'success' && state !== 'pending';
  const realStatus =
    state === 'missing'
      ? null
      : state === 'expired' && realStore
        ? 'pending'
        : state === 'issued' && realStore
          ? 'approved'
          : state;

  if (clientAuth === 'missing') {
    return {
      ...base,
      status: 400,
      error: 'invalid_request',
      errorDescription: 'client_id is required',
      state: realStatus,
      tokenIssued: state === 'issued',
    };
  }
  if (clientAuth !== 'valid') {
    return {
      ...base,
      status: 401,
      error: 'invalid_client',
      errorDescription: 'Client authentication failed',
      state: realStatus,
      tokenIssued: state === 'issued',
    };
  }
  if (clientBinding === 'mismatched') {
    return {
      ...base,
      status: 400,
      error: 'invalid_grant',
      errorDescription: 'auth_req_id does not belong to this client',
      state: realStatus,
      tokenIssued: state === 'issued',
    };
  }
  if (state === 'expired' && realStore) {
    // The real store self-deletes the expired request during the get (the update-poll
    // write is skipped because the read throws first).
    return {
      ...base,
      status: 400,
      error: 'expired_token',
      errorDescription: 'CIBA request has expired or is invalid',
      state: null,
      storageWrites: 0,
    };
  }
  if (state === 'missing') {
    return {
      ...base,
      status: 400,
      error: 'expired_token',
      errorDescription: 'CIBA request has expired or is invalid',
      state: null,
    };
  }
  if (reservationResult !== 'success') {
    return {
      ...base,
      status: 400,
      error: 'invalid_grant',
      errorDescription: 'CIBA request has already been used or is not approved',
      state,
      reservationReached: true,
      signingCalls: 0,
    };
  }
  switch (state) {
    case 'pending':
      return {
        ...base,
        status: 400,
        error:
          deliveryMode === 'poll' && pollingTiming === 'too-early'
            ? 'slow_down'
            : 'authorization_pending',
        errorDescription:
          deliveryMode === 'poll' && pollingTiming === 'too-early'
            ? 'You are polling too frequently. Please slow down.'
            : 'User has not yet authorized the authentication request',
        state,
      };
    case 'denied':
      return {
        ...base,
        status: 400,
        error: 'access_denied',
        errorDescription: 'User denied the authentication request',
        state: null,
        storageDeletes: 0,
        storageWrites: 1,
      };
    case 'expired':
      return {
        ...base,
        status: 400,
        error: 'expired_token',
        errorDescription: 'CIBA request has expired',
        state: null,
      };
    case 'issued':
      // The handler rejects an already-issued request before the reservation; the
      // real-store update-poll write is still observed.
      return {
        ...base,
        status: 400,
        error: 'invalid_grant',
        errorDescription: 'Tokens have already been issued for this auth_req_id',
        state: 'approved',
        tokenIssued: true,
        reservationReached: false,
        signingCalls: 0,
        storageWrites: realStore ? 1 : 0,
      };
    case 'approved':
      return {
        ...base,
        status: 200,
        state: 'approved',
        tokenIssued: true,
        accessTokenIssued: true,
        signingCalls: 1,
        reservationReached: true,
        storageWrites: 2,
        idTokenNonce: nonceValue,
        idTokenAcr: acrValue,
        storedNonce: nonceValue,
        storedAcr: acrValue,
      };
    default:
      throw new Error(`unreachable ciba token state ${state}`);
  }
}

export interface QueueDecision {
  acked: string[];
  retried: string[];
  ackCalls: Record<string, number>;
  retryCalls: Record<string, number>;
  effective: Record<string, 'ack' | 'retry'>;
  writeCalls: number;
  uniqueEffects: number;
  dlqSaved: boolean;
  tenantKey: string;
  attemptsDelivered: number;
  secretLeak: boolean;
}

function baseQueueDecision(): QueueDecision {
  return {
    acked: [],
    retried: [],
    ackCalls: {},
    retryCalls: {},
    effective: {},
    writeCalls: 0,
    uniqueEffects: 0,
    dlqSaved: false,
    tenantKey: '',
    attemptsDelivered: 1,
    secretLeak: false,
  };
}

/**
 * Fill per-message ack/retry call counts and effective dispositions for a single
 * delivery (delivery=first). Every acked message gets exactly one ack() call; every
 * retried message gets exactly one retry() call; the effective disposition is the
 * first call.
 */
function fillSingleDeliveryCalls(
  decision: QueueDecision,
  ids: string[],
  acked: string[],
  retried: string[]
): void {
  for (const id of ids) {
    const isAcked = acked.includes(id);
    const isRetried = retried.includes(id);
    if (isAcked && !isRetried) {
      decision.ackCalls[id] = 1;
      decision.retryCalls[id] = 0;
      decision.effective[id] = 'ack';
    } else if (isRetried && !isAcked) {
      decision.ackCalls[id] = 0;
      decision.retryCalls[id] = 1;
      decision.effective[id] = 'retry';
    } else {
      throw new Error(`message ${id} must be acked or retried, not both/neither`);
    }
  }
  decision.acked = [...acked];
  decision.retried = [...retried];
}

/**
 * Redelivery (delivery=duplicate): the SAME message id/body is delivered twice with the
 * same durable backing state, so every message gets exactly TWO ack/retry calls (one
 * per delivery) unless the first delivery retried and the consumer failed again, which
 * still produces a retry call per delivery. Effective disposition is first-call-wins.
 * All messages are deterministic: acked messages ack twice, retried messages retry
 * twice.
 */
function fillDuplicateDeliveryCalls(
  decision: QueueDecision,
  ids: string[],
  acked: string[],
  retried: string[],
  attempts: number
): void {
  for (const id of ids) {
    const isAcked = acked.includes(id);
    const isRetried = retried.includes(id);
    if (isAcked && !isRetried) {
      decision.ackCalls[id] = 2;
      decision.retryCalls[id] = 0;
      decision.effective[id] = 'ack';
    } else if (isRetried && !isAcked) {
      decision.ackCalls[id] = 0;
      decision.retryCalls[id] = 2;
      decision.effective[id] = 'retry';
    } else {
      throw new Error(`message ${id} must be acked or retried, not both/neither`);
    }
  }
  decision.acked = [...acked];
  decision.retried = [...retried];
  decision.attemptsDelivered = attempts;
}

export function decideQueueAudit(row: Row): QueueDecision {
  const payloadFamily = String(row.payloadFamily);
  const batchComposition = String(row.batchComposition);
  const bindingState = String(row.bindingState);
  const dlqArchive = String(row.dlqArchive);
  const tenant = String(row.tenant);
  const delivery = String(row.delivery);
  const attempts = String(row.attempt) === 'retry' ? 2 : String(row.attempt) === 'terminal' ? 5 : 1;
  const decision = baseQueueDecision();
  decision.attemptsDelivered = attempts;
  const ids = batchComposition === 'all-success' ? ['m1'] : ['m1', 'm2'];
  const fanout = payloadFamily === 'fanout';
  const single = delivery === 'first';

  // ---- per-message outcome ----
  let acked: string[];
  let retried: string[];
  const messageFails =
    payloadFamily === 'unknown-audit' ||
    bindingState !== 'present' ||
    (fanout && dlqArchive !== 'success');
  if (batchComposition === 'all-fail') {
    acked = [];
    retried = ids;
  } else if (messageFails) {
    acked = [];
    retried = batchComposition === 'mixed' ? ['m1', 'm2'] : ids;
  } else {
    acked = batchComposition === 'all-success' || batchComposition === 'mixed' ? ['m1'] : ids;
    retried = batchComposition === 'mixed' ? ['m2'] : [];
  }
  // all-success batches carry exactly one message.
  if (batchComposition === 'all-success') {
    acked = acked.length > 0 ? ['m1'] : [];
    retried = retried.length > 0 ? ['m1'] : [];
  }

  // ---- durable effects (single delivery, from the production probe) ----
  let writeCalls = 0;
  let uniqueEffects = 0;
  let dlqSaved = false;
  let tenantKey = '';
  const perMessage = delivery === 'duplicate' ? 2 : 1;
  if (batchComposition === 'all-success') {
    const healthy = acked.length === 1;
    if (healthy && fanout) {
      // fanout success: catalog + index + delivery aggregate + 1 R2 object. Queue-stable
      // chunk/catalog ids and object keys make redelivery converge on the same effects.
      writeCalls = 6 * perMessage;
      uniqueEffects = 4;
      tenantKey = tenant === 'foreign' ? 'foreign' : 'default';
    } else if (healthy && !fanout) {
      // event/pii-log: 1 INSERT with the stable entry id (idempotent on redelivery)
      writeCalls = 1 * perMessage;
      uniqueEffects = 1;
      tenantKey = tenant === 'foreign' ? 'foreign' : 'default';
    } else if (fanout && bindingState === 'present' && dlqArchive === 'missing') {
      // fanout archive-missing: delivery aggregate + notification (retried)
      writeCalls = 2 * perMessage;
      uniqueEffects = 2;
    } else if (fanout && bindingState === 'present' && dlqArchive === 'throws') {
      // fanout archive-throws: catalog + delivery event/aggregate + notification
      writeCalls = 6 * perMessage;
      uniqueEffects = 4;
    } else {
      writeCalls = 0;
      uniqueEffects = 0;
    }
  } else {
    // mixed/all-fail batches: only the healthy message writes anything. A redelivery
    // re-runs the healthy message, so the per-delivery effects double.
    if (acked.length > 0 && fanout) {
      writeCalls = 6 * perMessage;
      uniqueEffects = 4;
      tenantKey = tenant === 'foreign' ? 'foreign' : 'default';
    } else if (acked.length > 0) {
      writeCalls = 1 * perMessage;
      uniqueEffects = 1;
      tenantKey = tenant === 'foreign' ? 'foreign' : 'default';
    } else if (fanout && bindingState === 'present' && dlqArchive === 'missing') {
      writeCalls = 2 * perMessage;
      uniqueEffects = 2;
      tenantKey = tenant === 'foreign' ? 'foreign' : 'default';
    } else if (fanout && bindingState === 'present' && dlqArchive === 'throws') {
      writeCalls = 6 * perMessage;
      uniqueEffects = 4;
      tenantKey = tenant === 'foreign' ? 'foreign' : 'default';
    }
  }

  decision.writeCalls = writeCalls;
  decision.uniqueEffects = uniqueEffects;
  decision.dlqSaved = dlqSaved;
  decision.tenantKey = tenantKey;
  if (single) {
    fillSingleDeliveryCalls(decision, ids, acked, retried);
  } else {
    fillDuplicateDeliveryCalls(decision, ids, acked, retried, attempts);
  }
  return decision;
}

export function decideQueueDlq(row: Row): QueueDecision {
  const dlqArchive = String(row.dlqArchive);
  const bindingState = String(row.bindingState);
  const tenant = String(row.tenant);
  const batchComposition = String(row.batchComposition);
  const delivery = String(row.delivery);
  const attempts = String(row.attempt) === 'retry' ? 2 : String(row.attempt) === 'terminal' ? 5 : 1;
  const decision = baseQueueDecision();
  decision.attemptsDelivered = attempts;
  const ids = batchComposition === 'all-success' ? ['m1'] : ['m1', 'm2'];
  const single = delivery === 'first';

  let acked: string[];
  let retried: string[];
  if (bindingState === 'throws' || dlqArchive === 'throws') {
    acked = [];
    retried = ids;
  } else {
    acked = ids;
    retried = [];
  }

  let writeCalls = 0;
  let uniqueEffects = 0;
  let dlqSaved = false;
  let tenantKey = '';
  const perMessage = delivery === 'duplicate' ? 2 : 1;
  if (acked.length > 0) {
    if (bindingState === 'missing') {
      writeCalls = 0;
      uniqueEffects = 0;
    } else if (dlqArchive === 'success') {
      // dlq save: dlq item + delivery aggregate + notification + R2 object. Stable
      // queue-derived ids and object keys make a redelivery idempotent.
      writeCalls = 4 * perMessage;
      uniqueEffects = 4;
      dlqSaved = true;
      tenantKey = tenant === 'foreign' ? 'foreign' : 'default';
    } else {
      // archive missing: delivery aggregate + notification (no R2)
      writeCalls = 2 * perMessage;
      uniqueEffects = 2;
      tenantKey = tenant === 'foreign' ? 'foreign' : 'default';
    }
  }

  decision.writeCalls = writeCalls;
  decision.uniqueEffects = uniqueEffects;
  decision.dlqSaved = dlqSaved;
  decision.tenantKey = tenantKey;
  if (single) {
    fillSingleDeliveryCalls(decision, ids, acked, retried);
  } else {
    fillDuplicateDeliveryCalls(decision, ids, acked, retried, attempts);
  }
  return decision;
}

export function decideQueueLog(row: Row): QueueDecision {
  const schema = String(row.schema);
  const bindingState = String(row.bindingState);
  const dlqArchive = String(row.dlqArchive);
  const batchComposition = String(row.batchComposition);
  const tenant = String(row.tenant);
  const lane = String(row.lane);
  const delivery = String(row.delivery);
  const payloadFamily = String(row.payloadFamily);
  const attempts = String(row.attempt) === 'retry' ? 2 : String(row.attempt) === 'terminal' ? 5 : 1;
  const decision = baseQueueDecision();
  decision.attemptsDelivered = attempts;
  const ids = batchComposition === 'all-success' ? ['m1'] : ['m1', 'm2'];
  const single = delivery === 'first';

  let acked: string[];
  let retried: string[];
  if (batchComposition === 'mixed') {
    // m1 is the unsupported-schema message (DLQ + ack), m2 is a malformed retry.
    acked = ['m1'];
    retried = ['m2'];
  } else if (schema === 'malformed') {
    acked = [];
    retried = ids;
  } else if (schema === 'future') {
    const dlqOk = dlqArchive === 'success' && bindingState === 'present';
    if (!dlqOk) {
      acked = [];
      retried = ids;
    } else {
      acked = ids;
      retried = [];
    }
  } else if (
    payloadFamily === 'chunk-write' &&
    bindingState === 'present' &&
    dlqArchive === 'success'
  ) {
    acked = ids;
    retried = [];
  } else {
    acked = [];
    retried = ids;
  }

  let writeCalls = 0;
  let uniqueEffects = 0;
  let dlqSaved = false;
  let tenantKey = '';
  const perMessage = delivery === 'duplicate' ? 2 : 1;
  if (batchComposition === 'mixed') {
    // m1 future-schema DLQ save; m2 malformed retries without durable writes. Stable
    // queue-derived identifiers make the DLQ effect idempotent on redelivery.
    writeCalls = 4 * perMessage;
    uniqueEffects = 4;
    dlqSaved = true;
    tenantKey = tenant === 'foreign' ? 'foreign' : 'default';
  } else if (acked.length > 0) {
    if (schema === 'future') {
      writeCalls = 4 * perMessage;
      uniqueEffects = 4;
      dlqSaved = true;
      tenantKey = tenant === 'foreign' ? 'foreign' : 'default';
    } else {
      // chunk-write: catalog + index + aggregates + 1 R2 object. A redelivery writes a
      // NEW chunk id and a NEW R2 object; the decision keeps the IDEMPOTENT expectation
      // so the duplication fails the row as a strict finding.
      writeCalls = 7 * perMessage;
      uniqueEffects = delivery === 'duplicate' ? 4 : 4 * perMessage;
      tenantKey = tenant === 'foreign' ? 'foreign' : 'default';
    }
  } else if (
    bindingState === 'present' &&
    (payloadFamily === 'delivery-fanout' || payloadFamily === 'http-sink-batch')
  ) {
    // retrying sink/fanout: lde + aggregates (+ critical notification)
    const per = lane === 'critical' ? 4 : 3;
    writeCalls = per * perMessage;
    uniqueEffects = 3 * perMessage;
  } else if (
    payloadFamily === 'chunk-write' &&
    bindingState === 'present' &&
    dlqArchive === 'missing'
  ) {
    writeCalls = 0;
    uniqueEffects = 0;
  }

  decision.writeCalls = writeCalls;
  decision.uniqueEffects = uniqueEffects;
  decision.dlqSaved = dlqSaved;
  decision.tenantKey = tenantKey;
  if (single) {
    fillSingleDeliveryCalls(decision, ids, acked, retried);
  } else {
    fillDuplicateDeliveryCalls(decision, ids, acked, retried, attempts);
  }
  return decision;
}

// =============================================================================
// Case tables
// =============================================================================

export interface StateCase {
  id: string;
  title: string;
  dimensions: Record<string, Scalar>;
  family: 'refresh' | 'device' | 'ciba' | 'queue';
  matrix: string;
  fingerprint: string;
  mutationIds: string[];
}

function refreshMutationIds(row: Row): string[] {
  const ids: string[] = [];
  const op = String(row.operation);
  const versionRelation = String(row.versionRelation);
  const jtiRelation = String(row.jtiRelation);
  const scopeRelation = String(row.scopeRelation);
  if (op === 'rotate' && versionRelation === 'old') {
    ids.push('refresh:keep-family-after-old-version-theft');
  }
  if (op === 'rotate' && jtiRelation === 'mismatched') {
    ids.push('refresh:keep-family-after-jti-mismatch-theft');
  }
  if (op === 'rotate' && scopeRelation === 'expanded') {
    ids.push('refresh:allow-scope-expansion');
  }
  return ids;
}

function deviceMutationIds(row: Row): string[] {
  const ids: string[] = [];
  const op = String(row.operation);
  const state = String(row.state);
  const expiry = String(row.expiry);
  const reservationResult = String(row.reservationResult);
  const tokenOutcome = String(row.tokenOutcome);
  if (op === '' || op === 'undefined') {
    // D-T token endpoint rows: the forbidden-transition witnesses map to the observed
    // endpoint outcomes — a denied request would be approved, a pending request would
    // be denied, and an already-used request would be re-issued.
    if (tokenOutcome === 'access-denied') ids.push('device:allow-forbidden-approval');
    if (tokenOutcome === 'pending' || tokenOutcome === 'slow-down')
      ids.push('device:allow-forbidden-denial');
    if (tokenOutcome === 'invalid-grant' || tokenOutcome === 'expired')
      ids.push('device:allow-forbidden-issuance');
    return ids;
  }
  // The forbidden-transition witnesses map to REAL DeviceCodeStore edges that fail
  // closed: approving/denying a non-pending (denied/approved/issued) code and
  // re-issuing an already-issued code.
  if (op === 'approve' && state !== 'pending' && expiry !== 'expired') {
    ids.push('device:allow-forbidden-approval');
  }
  if (op === 'deny' && state !== 'pending' && expiry !== 'expired') {
    ids.push('device:allow-forbidden-denial');
  }
  if (op === 'mark-issued' && (state === 'issued' || reservationResult === 'already-issued')) {
    ids.push('device:allow-forbidden-issuance');
  }
  return ids;
}

function cibaMutationIds(row: Row): string[] {
  const ids: string[] = [];
  const reservationResult = String(row.reservationResult);
  const state = String(row.state);
  // The reservation-failure witness targets the real token ENDPOINT on an approved
  // request whose reservation is actually non-successful (never a store-only row).
  if (
    state === 'approved' &&
    reservationResult !== 'success' &&
    reservationResult !== 'not-applicable'
  ) {
    ids.push('ciba:issue-after-reservation-failure');
  }
  return ids;
}

function queueMutationIds(row: Row): string[] {
  const ids: string[] = [];
  const batchComposition = String(row.batchComposition);
  const schema = String(row.schema);
  const delivery = String(row.delivery);
  const payloadFamily = String(row.payloadFamily);
  const bindingState = String(row.bindingState);
  const dlqArchive = String(row.dlqArchive);
  if (batchComposition === 'mixed') ids.push('queue:retry-entire-mixed-batch');
  if (schema === 'future' && payloadFamily === 'future-schema' && batchComposition !== 'mixed') {
    ids.push('queue:ack-unsupported-schema-before-durable-dlq');
  }
  if (delivery === 'duplicate') {
    ids.push('queue:duplicate-durable-effect-on-redelivery');
  }
  if (
    delivery === 'first' &&
    (bindingState === 'throws' || schema === 'malformed' || payloadFamily === 'unknown-audit')
  ) {
    ids.push('queue:ack-transient-failure');
  }
  return ids;
}

function buildStateCaseTable(
  suitePrefix: string,
  matrix: string,
  dimensionOrder: readonly string[],
  values: Record<string, readonly Scalar[]>,
  constraints: Constraint[],
  selectedTriples: Array<[string, string, string]>,
  family: StateCase['family'],
  mutationIds: (row: Row) => string[]
): StateCase[] {
  const rows = generateCoveringArray({
    dimensionOrder: [...dimensionOrder],
    values,
    constraints,
    selectedTriples,
  });
  return rows.map((row, index) => {
    const dimensions: Record<string, Scalar> = {};
    for (const dimension of dimensionOrder) {
      dimensions[dimension] = row[dimension];
    }
    return {
      id: deriveCaseId(suitePrefix, index + 1),
      title: Object.entries(dimensions)
        .map(([key, value]) => `${key}=${value}`)
        .join(', '),
      dimensions,
      family,
      matrix,
      fingerprint: `${matrix}|${semanticFingerprint(dimensions)}`,
      mutationIds: mutationIds(row),
    };
  });
}

export const REFRESH_CASE_TABLE = [
  ...buildStateCaseTable(
    'st-ref',
    'R',
    REFRESH_DIMENSION_ORDER,
    REFRESH_VALUES,
    REFRESH_CONSTRAINTS,
    REFRESH_SELECTED_TRIPLES,
    'refresh',
    refreshMutationIds
  ),
  // The greedy covering array never selects the exact rotate rows that reach the
  // version/JTI/scope checks (matching tenant + client + active family + active TTL),
  // so they are appended like the token-matrix success/replay rows. Each appended row
  // carries exactly the mutation that targets its production edge.
  {
    id: 'st-ref-app-001',
    title: 'rotate, versionRelation=old, active family, matching binding, active TTL (theft edge)',
    dimensions: {
      familyState: 'active',
      operation: 'rotate',
      versionRelation: 'old',
      jtiRelation: 'matching',
      clientBinding: 'matching',
      tenantBinding: 'matching',
      scopeRelation: 'omitted',
      storageOutcome: 'success',
      instanceState: 'same',
      sequence: 'replay',
      ttlState: 'active',
    },
    family: 'refresh' as const,
    matrix: 'R',
    fingerprint: 'R|refresh-app-theft-old',
    mutationIds: ['refresh:keep-family-after-old-version-theft'],
  },
  {
    id: 'st-ref-app-002',
    title: 'rotate, jtiRelation=mismatched, exact version, active family (theft edge)',
    dimensions: {
      familyState: 'active',
      operation: 'rotate',
      versionRelation: 'exact',
      jtiRelation: 'mismatched',
      clientBinding: 'matching',
      tenantBinding: 'matching',
      scopeRelation: 'omitted',
      storageOutcome: 'success',
      instanceState: 'same',
      sequence: 'repeated',
      ttlState: 'active',
    },
    family: 'refresh' as const,
    matrix: 'R',
    fingerprint: 'R|refresh-app-theft-jti',
    mutationIds: ['refresh:keep-family-after-jti-mismatch-theft'],
  },
  {
    id: 'st-ref-app-003',
    title: 'rotate, scopeRelation=expanded, exact version, matching JTI (scope edge)',
    dimensions: {
      familyState: 'active',
      operation: 'rotate',
      versionRelation: 'exact',
      jtiRelation: 'matching',
      clientBinding: 'matching',
      tenantBinding: 'matching',
      scopeRelation: 'expanded',
      storageOutcome: 'success',
      instanceState: 'same',
      sequence: 'repeated',
      ttlState: 'active',
    },
    family: 'refresh' as const,
    matrix: 'R',
    fingerprint: 'R|refresh-app-scope',
    mutationIds: ['refresh:allow-scope-expansion'],
  },
];
export const DEVICE_STORE_CASE_TABLE = buildStateCaseTable(
  'st-ds',
  'D-S',
  DEVICE_STORE_DIMENSION_ORDER,
  DEVICE_STORE_VALUES,
  DEVICE_STORE_CONSTRAINTS,
  DEVICE_STORE_SELECTED_TRIPLES,
  'device',
  deviceMutationIds
);
export const DEVICE_TOKEN_CASE_TABLE = buildStateCaseTable(
  'st-dt',
  'D-T',
  DEVICE_TOKEN_DIMENSION_ORDER,
  DEVICE_TOKEN_VALUES,
  DEVICE_TOKEN_CONSTRAINTS,
  DEVICE_TOKEN_SELECTED_TRIPLES,
  'device',
  deviceMutationIds
);
export const CIBA_STORE_CASE_TABLE = buildStateCaseTable(
  'st-cs',
  'C-S',
  CIBA_STORE_DIMENSION_ORDER,
  CIBA_STORE_VALUES,
  CIBA_STORE_CONSTRAINTS,
  CIBA_STORE_SELECTED_TRIPLES,
  'ciba',
  cibaMutationIds
);
export const CIBA_TOKEN_CASE_TABLE = buildStateCaseTable(
  'st-ct',
  'C-T',
  CIBA_TOKEN_DIMENSION_ORDER,
  CIBA_TOKEN_VALUES,
  CIBA_TOKEN_CONSTRAINTS,
  CIBA_TOKEN_SELECTED_TRIPLES,
  'ciba',
  cibaMutationIds
);
export const QUEUE_AUDIT_CASE_TABLE = buildStateCaseTable(
  'st-qa',
  'Q-A',
  QUEUE_AUDIT_DIMENSION_ORDER,
  QUEUE_AUDIT_VALUES,
  QUEUE_AUDIT_CONSTRAINTS,
  QUEUE_AUDIT_SELECTED_TRIPLES,
  'queue',
  queueMutationIds
);
export const QUEUE_DLQ_CASE_TABLE = buildStateCaseTable(
  'st-qd',
  'Q-D',
  QUEUE_DLQ_DIMENSION_ORDER,
  QUEUE_DLQ_VALUES,
  QUEUE_DLQ_CONSTRAINTS,
  QUEUE_DLQ_SELECTED_TRIPLES,
  'queue',
  queueMutationIds
);
export const QUEUE_LOG_CASE_TABLE = [
  ...buildStateCaseTable(
    'st-ql',
    'Q-L',
    QUEUE_LOG_DIMENSION_ORDER,
    QUEUE_LOG_VALUES,
    QUEUE_LOG_CONSTRAINTS,
    QUEUE_LOG_SELECTED_TRIPLES,
    'queue',
    queueMutationIds
  ),
  // The greedy covering array never selects an all-success future-schema row with a
  // single first delivery that reaches the unsupported-schema DLQ save, so it is
  // appended like the R theft rows.
  {
    id: 'st-ql-app-001',
    title:
      'all-success, first attempt, first delivery, future schema, present binding, archive success (unsupported-schema DLQ edge)',
    dimensions: {
      batchComposition: 'all-success',
      attempt: 'first',
      schema: 'future',
      delivery: 'first',
      lane: 'default',
      bindingState: 'present',
      tenant: 'matching',
      dlqArchive: 'success',
      payloadFamily: 'future-schema',
    },
    family: 'queue' as const,
    matrix: 'Q-L',
    fingerprint: 'Q-L|queue-app-unsupported-schema',
    mutationIds: ['queue:ack-unsupported-schema-before-durable-dlq'],
  },
];

export const STATE_CASE_TABLES: Record<string, StateCase[]> = {
  refresh: REFRESH_CASE_TABLE,
  device: [...DEVICE_STORE_CASE_TABLE, ...DEVICE_TOKEN_CASE_TABLE],
  ciba: [...CIBA_STORE_CASE_TABLE, ...CIBA_TOKEN_CASE_TABLE],
  queue: [...QUEUE_AUDIT_CASE_TABLE, ...QUEUE_DLQ_CASE_TABLE, ...QUEUE_LOG_CASE_TABLE],
};
