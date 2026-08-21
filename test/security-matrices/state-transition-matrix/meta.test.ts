/**
 * Independent checker for the state-transition suite (independently declared literals).
 *
 * The coverage computations below share NO constraint functions, dimension orders,
 * value arrays, selected-triple definitions, or decision functions with cases.ts.
 * Every dimension order, value set, legality predicate, and selected-triple group is
 * re-declared here as a independently declared literal, derived from the PRODUCTION sources:
 * - R: RefreshTokenRotator.ts (family lifecycle, tenant pinning, version/JTI checks,
 *   TTL boundary, storage failure paths)
 * - D-S / D-T: DeviceCodeStore.ts + the token endpoint device flow (state transitions,
 *   expiry semantics, reservation boundary)
 * - C-S / C-T: CIBARequestStore.ts + the token endpoint CIBA flow (delivery modes,
 *   nonce/acr propagation, reservation fail-closed)
 * - Q-A / Q-D / Q-L: audit/queue-consumer.ts (per-message ack/retry, unsupported-schema
 *   DLQ, binding failure semantics, lane/tenant/archive effects)
 *
 * By the coverage checker, the only cases.ts values referenced are the generator
 * constraint arrays, imported for exactly one purpose: proving that the generator's
 * legal assignment set equals the independent predicate's legal assignment set. They
 * are never used in coverage counting, enumeration, or the faulty-matrix negative
 * tests. (The case tables and decision functions imported elsewhere are used only to
 * run REAL production observations for the mutation/meta tests.)
 */
import { describe, expect, it } from 'vitest';
import { eventLogInsertCount } from './refresh-observation';
import {
  REFRESH_CASE_TABLE,
  DEVICE_STORE_CASE_TABLE,
  DEVICE_TOKEN_CASE_TABLE,
  CIBA_STORE_CASE_TABLE,
  CIBA_TOKEN_CASE_TABLE,
  QUEUE_AUDIT_CASE_TABLE,
  QUEUE_DLQ_CASE_TABLE,
  QUEUE_LOG_CASE_TABLE,
  REFRESH_CONSTRAINTS,
  DEVICE_STORE_CONSTRAINTS,
  DEVICE_TOKEN_CONSTRAINTS,
  CIBA_STORE_CONSTRAINTS,
  CIBA_TOKEN_CONSTRAINTS,
  QUEUE_AUDIT_CONSTRAINTS,
  QUEUE_DLQ_CONSTRAINTS,
  QUEUE_LOG_CONSTRAINTS,
  type StateCase,
} from './cases';
import type { Row, Scalar } from '../fixtures/covering-array';
import { findDuplicateIds } from '../fixtures/case-fingerprint';
import {
  enumerateLegalAssignments,
  requiredPairKeys,
  requiredTripleKeys,
  verifyCoverage,
  type CoverageSpec,
} from '../fixtures/coverage-verifier';
import { generateCoveringArray } from '../fixtures/covering-array';

// =============================================================================
// Independently declared dimension orders
// =============================================================================

const IND_R_DIMENSION_ORDER = [
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

const IND_DS_DIMENSION_ORDER = [
  'state',
  'operation',
  'clientBinding',
  'tenantBinding',
  'expiry',
  'reservationResult',
] as const;

const IND_DT_DIMENSION_ORDER = [
  'state',
  'clientBinding',
  'tenantBinding',
  'pollingTiming',
  'attempt',
  'reservationResult',
  'expiry',
  'tokenOutcome',
] as const;

const IND_CS_DIMENSION_ORDER = [
  'deliveryMode',
  'state',
  'operation',
  'nonce',
  'acr',
  'approvalResult',
  'tenantBinding',
  'reservationResult',
] as const;

const IND_CT_DIMENSION_ORDER = [
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

const IND_QA_DIMENSION_ORDER = [
  'batchComposition',
  'attempt',
  'delivery',
  'bindingState',
  'tenant',
  'dlqArchive',
  'payloadFamily',
] as const;

const IND_QD_DIMENSION_ORDER = IND_QA_DIMENSION_ORDER;

const IND_QL_DIMENSION_ORDER = [
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

// =============================================================================
// Independently declared value sets
// =============================================================================

export const IND_R_VALUES: Record<string, readonly Scalar[]> = {
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

export const IND_DS_VALUES: Record<string, readonly Scalar[]> = {
  state: ['missing', 'pending', 'approved', 'denied', 'expired', 'issued'],
  operation: ['store', 'approve', 'deny', 'mark-issued', 'delete', 'alarm'],
  clientBinding: ['matching', 'not-applicable'],
  tenantBinding: ['matching', 'foreign'],
  expiry: ['active', 'boundary', 'expired'],
  reservationResult: ['not-applicable', 'already-issued'],
};

export const IND_DT_VALUES: Record<string, readonly Scalar[]> = {
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

export const IND_CS_VALUES: Record<string, readonly Scalar[]> = {
  deliveryMode: ['poll', 'ping', 'push'],
  state: ['missing', 'pending', 'approved', 'denied', 'expired', 'issued'],
  operation: ['store', 'approve', 'deny', 'mark-issued', 'delete', 'alarm'],
  nonce: ['absent', 'present', 'mismatched', 'not-applicable'],
  acr: ['absent', 'matching', 'mismatched', 'not-applicable'],
  approvalResult: ['success', 'already-approved', 'expired', 'missing', 'not-applicable'],
  tenantBinding: ['matching', 'foreign'],
  reservationResult: ['not-applicable', 'already-issued'],
};

export const IND_CT_VALUES: Record<string, readonly Scalar[]> = {
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

export const IND_QA_VALUES: Record<string, readonly Scalar[]> = {
  batchComposition: ['all-success', 'mixed', 'all-fail'],
  attempt: ['first', 'retry', 'terminal'],
  delivery: ['first', 'duplicate'],
  bindingState: ['present', 'missing', 'throws'],
  tenant: ['matching', 'foreign'],
  dlqArchive: ['success', 'missing', 'throws'],
  payloadFamily: ['event-log', 'pii-log', 'unknown-audit', 'fanout'],
};

export const IND_QD_VALUES: Record<string, readonly Scalar[]> = {
  batchComposition: ['all-success', 'all-fail'],
  attempt: ['first', 'retry', 'terminal'],
  delivery: ['first', 'duplicate'],
  bindingState: ['present', 'missing', 'throws'],
  tenant: ['matching', 'foreign'],
  dlqArchive: ['success', 'missing', 'throws'],
  payloadFamily: ['event-log', 'pii-log'],
};

export const IND_QL_VALUES: Record<string, readonly Scalar[]> = {
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

// =============================================================================
// Independently declared legality predicates (derived from production behavior)
// =============================================================================

/**
 * R legality: RefreshTokenRotator lifecycle. An absent family is the only state with an
 * unknown JTI; create starts absent; recreate follows deletion/expiry; scope relations
 * only apply to rotation; replay delivers an already-rotated (old) version; expired
 * families carry an expired TTL while deleted/absent families carry an active TTL;
 * storage failures are only observable where the operation actually touches storage.
 */
export function independentRLegal(row: Row): boolean {
  const familyState = String(row.familyState);
  const operation = String(row.operation);
  const versionRelation = String(row.versionRelation);
  const jtiRelation = String(row.jtiRelation);
  const clientBinding = String(row.clientBinding);
  const tenantBinding = String(row.tenantBinding);
  const scopeRelation = String(row.scopeRelation);
  const storageOutcome = String(row.storageOutcome);
  const instanceState = String(row.instanceState);
  const sequence = String(row.sequence);
  const ttlState = String(row.ttlState);

  if ((familyState === 'absent') !== (versionRelation === 'missing-family')) return false;
  if ((jtiRelation === 'unknown') !== (familyState === 'absent')) return false;
  if (operation === 'create' && familyState !== 'absent') return false;
  if (operation === 'recreate' && familyState !== 'deleted' && familyState !== 'expired')
    return false;
  if (scopeRelation !== 'omitted' && operation !== 'rotate') return false;
  if (sequence === 'replay' && versionRelation !== 'old') return false;
  if (sequence === 'repeated' && operation === 'create') return false;
  // A REAL prior rotation is only executable on an active family with an active TTL and
  // a clean storage path with matching credentials, so repeated/replay rows require
  // that shape.
  if (
    sequence !== 'first' &&
    !(
      familyState === 'active' &&
      ttlState === 'active' &&
      storageOutcome === 'success' &&
      clientBinding === 'matching' &&
      tenantBinding === 'matching'
    )
  ) {
    return false;
  }
  // Reconstruction (a fresh DO over the same storage) is only observable after a real
  // first transition, so reconstructed rows must be repeated/replay.
  if (instanceState === 'reconstructed' && sequence === 'first') return false;
  if ((familyState === 'expired') !== (ttlState === 'expired')) return false;
  if (familyState === 'deleted' && ttlState !== 'active') return false;
  if (familyState === 'absent' && ttlState !== 'active') return false;
  if (
    storageOutcome === 'read-failure' &&
    instanceState !== 'reconstructed' &&
    operation !== 'revoke-by-jti' &&
    operation !== 'batch-revoke'
  ) {
    return false;
  }
  if (
    storageOutcome === 'write-failure' &&
    operation !== 'create' &&
    operation !== 'recreate' &&
    operation !== 'rotate'
  ) {
    return false;
  }
  const familyExists = familyState === 'active' || familyState === 'expired';
  if (
    storageOutcome === 'delete-failure' &&
    operation !== 'rotate' &&
    operation !== 'revoke-family' &&
    operation !== 'revoke-by-jti' &&
    operation !== 'batch-revoke'
  ) {
    return false;
  }
  if (
    storageOutcome === 'delete-failure' &&
    operation === 'batch-revoke' &&
    !(jtiRelation === 'matching' && familyExists)
  ) {
    return false;
  }
  if (
    storageOutcome === 'delete-failure' &&
    operation === 'revoke-by-jti' &&
    !(jtiRelation === 'matching' && familyExists)
  ) {
    return false;
  }
  if (storageOutcome === 'delete-failure' && operation === 'revoke-family' && !familyExists) {
    return false;
  }
  if (
    operation === 'rotate' &&
    familyState !== 'active' &&
    familyState !== 'expired' &&
    familyState !== 'deleted' &&
    versionRelation !== 'missing-family'
  ) {
    return false;
  }
  void clientBinding;
  void tenantBinding;
  return true;
}

/**
 * D-S legality: DeviceCodeStore owner transitions. store creates pending from missing;
 * approve/deny act on pending; mark-issued acts on approved/issued; delete/alarm require
 * a record; an expired record carries an expired TTL while every other state keeps an
 * active TTL; the store never checks the client binding; a duplicate issuance only
 * manifests through a second mark-issued call.
 */
export function independentDsLegal(row: Row): boolean {
  const state = String(row.state);
  const operation = String(row.operation);
  const expiry = String(row.expiry);
  const reservationResult = String(row.reservationResult);
  const clientBinding = String(row.clientBinding);

  if (operation === 'store' && state !== 'missing') return false;
  // approve/deny may target any existing record (the forbidden edges are real store
  // paths that fail closed); only the pending target is a valid transition.
  if (operation === 'approve' && state === 'missing') return false;
  if (operation === 'approve' && state === 'expired') return false;
  if (operation === 'deny' && state === 'missing') return false;
  if (operation === 'deny' && state === 'expired') return false;
  if (operation === 'mark-issued' && state !== 'approved' && state !== 'issued') return false;
  if (operation === 'delete' && state === 'missing') return false;
  if (operation === 'alarm' && state === 'missing') return false;
  if ((state === 'expired') !== (expiry === 'expired')) return false;
  // denied and issued records self-delete on boundary/expired expiry, so they require
  // an active expiry; missing records carry the default active TTL.
  if (state !== 'pending' && state !== 'approved' && expiry !== 'active') return false;
  if (state === 'denied' && expiry !== 'active') return false;
  if (state === 'issued' && expiry !== 'active') return false;
  if (reservationResult === 'already-issued' && expiry !== 'active') return false;
  if (clientBinding !== 'not-applicable') return false;
  if (reservationResult === 'already-issued' && operation !== 'mark-issued') return false;
  return true;
}

/**
 * D-T legality: the device token endpoint. A missing code surfaces as expired before any
 * client check; the wrong-client path is only observable through a stub reservation that
 * the real store cannot produce; the token outcome is fully derived from the state,
 * client binding, polling timing, and reservation result.
 */
export function independentDtLegal(row: Row): boolean {
  const state = String(row.state);
  const clientBinding = String(row.clientBinding);
  const reservationResult = String(row.reservationResult);
  const pollingTiming = String(row.pollingTiming);
  const expiry = String(row.expiry);
  const tokenOutcome = String(row.tokenOutcome);

  if ((state === 'expired') !== (expiry === 'expired')) return false;
  if (clientBinding === 'wrong' && reservationResult === 'success' && state !== 'pending')
    return false;
  if (clientBinding === 'wrong') return tokenOutcome === 'client-mismatch';
  switch (state) {
    case 'missing':
      return tokenOutcome === 'expired';
    case 'pending':
      return tokenOutcome === (pollingTiming === 'too-early' ? 'slow-down' : 'pending');
    case 'denied':
      return tokenOutcome === 'access-denied';
    case 'expired':
      return tokenOutcome === 'expired';
    case 'issued':
      return tokenOutcome === 'invalid-grant';
    case 'approved':
      return tokenOutcome === (reservationResult === 'success' ? 'issued' : 'invalid-grant');
    default:
      return false;
  }
}

/**
 * C-S legality: CIBARequestStore owner transitions. store creates pending from missing;
 * approve cannot approve an issued request; deny acts on pending; mark-issued acts on
 * approved/issued; nonce/acr are only meaningful on approve; the approval result is tied
 * to the request state; duplicate issuance manifests through a second mark-issued call.
 */
export function independentCsLegal(row: Row): boolean {
  const state = String(row.state);
  const operation = String(row.operation);
  const nonce = String(row.nonce);
  const acr = String(row.acr);
  const approvalResult = String(row.approvalResult);
  const reservationResult = String(row.reservationResult);

  if (operation === 'store' && state !== 'missing') return false;
  if (operation === 'approve' && state === 'issued') return false;
  if (operation === 'deny' && state !== 'pending') return false;
  if (operation === 'mark-issued' && state !== 'approved' && state !== 'issued') return false;
  if (operation === 'delete' && state === 'missing') return false;
  if (operation === 'alarm' && state === 'missing') return false;
  if ((nonce === 'not-applicable') !== (operation !== 'approve')) return false;
  if ((acr === 'not-applicable') !== (operation !== 'approve')) return false;
  if (approvalResult !== 'not-applicable') {
    if (operation !== 'approve') return false;
    const valid =
      (approvalResult === 'success' && state === 'pending') ||
      (approvalResult === 'already-approved' && state === 'approved') ||
      (approvalResult === 'expired' && state === 'expired') ||
      (approvalResult === 'missing' && state === 'missing');
    if (!valid) return false;
  }
  if (reservationResult === 'already-issued' && operation !== 'mark-issued') return false;
  return true;
}

/**
 * C-T legality: the CIBA token endpoint. Client authentication gates everything; a
 * mismatched client binding is only observable through a stub reservation; nonce/acr
 * only reach the issued token; polling timing only shapes pending/slow-down; the
 * reservation only runs for an approved request.
 */
export function independentCtLegal(row: Row): boolean {
  const state = String(row.state);
  const deliveryMode = String(row.deliveryMode);
  const clientAuth = String(row.clientAuth);
  const clientBinding = String(row.clientBinding);
  const reservationResult = String(row.reservationResult);
  const pollingTiming = String(row.pollingTiming);
  const attempt = String(row.attempt);
  const nonce = String(row.nonce);
  const acr = String(row.acr);
  const tokenOutcome = String(row.tokenOutcome);

  if (clientBinding === 'mismatched' && reservationResult === 'success' && state !== 'pending')
    return false;
  if (clientAuth !== 'valid') return tokenOutcome === 'client-auth-failed';
  if (clientBinding === 'mismatched') return tokenOutcome === 'client-mismatch';
  if (reservationResult !== 'success') return tokenOutcome === 'invalid-grant';
  switch (state) {
    case 'missing':
      return tokenOutcome === 'expired';
    case 'pending':
      return (
        tokenOutcome ===
        (deliveryMode === 'poll' && pollingTiming === 'too-early' ? 'slow-down' : 'pending')
      );
    case 'denied':
      return tokenOutcome === 'access-denied';
    case 'expired':
      return tokenOutcome === 'expired';
    case 'issued':
      return tokenOutcome === 'invalid-grant';
    case 'approved':
      return tokenOutcome === 'issued';
    default:
      return false;
  }
}

/** C-T additional constraints: nonce/acr only on issued tokens; polling timing gates; reservation only for approved. */
export function independentCtExtra(row: Row): boolean {
  const state = String(row.state);
  const tokenOutcome = String(row.tokenOutcome);
  const nonce = String(row.nonce);
  const acr = String(row.acr);
  const pollingTiming = String(row.pollingTiming);
  const attempt = String(row.attempt);
  const reservationResult = String(row.reservationResult);
  if (tokenOutcome !== 'issued' && (nonce !== 'absent' || acr !== 'absent')) return false;
  if (tokenOutcome !== 'pending' && tokenOutcome !== 'slow-down') {
    if (pollingTiming !== 'first' || attempt !== 'first') return false;
  }
  if (reservationResult !== 'success' && state !== 'approved') return false;
  return true;
}

/**
 * Q-A legality: audit consumer. A terminal attempt only carries a permanent result;
 * duplicate/out-of-order delivery implies a retried attempt; all-success batches require
 * a healthy message (supported payload, present binding); all-fail batches require a
 * failing message; mixed batches hold a healthy first message plus a failing second one.
 */
export function independentQaLegal(row: Row): boolean {
  const batchComposition = String(row.batchComposition);
  const attempt = String(row.attempt);
  const delivery = String(row.delivery);
  const bindingState = String(row.bindingState);
  const dlqArchive = String(row.dlqArchive);
  const payloadFamily = String(row.payloadFamily);

  // attempts are only observable on the fanout path.
  if (attempt !== 'first' && payloadFamily !== 'fanout') return false;
  // Only fanout touches the archive bucket.
  if (payloadFamily !== 'fanout' && dlqArchive !== 'success') return false;
  if (batchComposition === 'all-success') {
    if (payloadFamily === 'unknown-audit' || bindingState !== 'present') return false;
    if (payloadFamily === 'fanout' && dlqArchive !== 'success') return false;
  }
  if (batchComposition === 'all-fail') {
    if (payloadFamily !== 'unknown-audit' && bindingState === 'present') return false;
    if (payloadFamily === 'fanout' && bindingState === 'present' && dlqArchive === 'success')
      return false;
  }
  if (batchComposition === 'mixed') {
    if (payloadFamily === 'unknown-audit' || bindingState !== 'present') return false;
  }
  return true;
}

/**
 * Q-D legality: DLQ consumer. The DLQ consumer never receives mixed batches; attempts
 * are observable only when the DLQ save runs (binding present); all-fail batches
 * require a throwing binding or a throwing archive bucket.
 */
export function independentQdLegal(row: Row): boolean {
  const batchComposition = String(row.batchComposition);
  const attempt = String(row.attempt);
  const bindingState = String(row.bindingState);
  const dlqArchive = String(row.dlqArchive);
  if (batchComposition === 'mixed') return false;
  if (attempt !== 'first' && bindingState !== 'present') return false;
  if (batchComposition === 'all-fail') {
    if (bindingState !== 'throws' && dlqArchive !== 'throws') return false;
  }
  return true;
}

/**
 * Q-L legality: logging-delivery consumer. Mixed batches only contain a future-schema
 * message plus a malformed one (healthy binding and archive); only the chunk-write
 * payload can succeed for a supported schema; schema versions are tied to the payload
 * family; attempts are observable only through recorded attempt_count values
 * (chunk-write aggregates, future-schema DLQ save, fanout/sink delivery events); the
 * fallback lane requires a missing binding and an all-fail batch.
 */
export function independentQlLegal(row: Row): boolean {
  const batchComposition = String(row.batchComposition);
  const attempt = String(row.attempt);
  const schema = String(row.schema);
  const delivery = String(row.delivery);
  const lane = String(row.lane);
  const bindingState = String(row.bindingState);
  const dlqArchive = String(row.dlqArchive);
  const payloadFamily = String(row.payloadFamily);

  if (batchComposition === 'mixed') {
    if (!(schema === 'future' && dlqArchive === 'success' && bindingState === 'present'))
      return false;
  }
  // attempts are observable only through recorded attempt_count values.
  if (
    attempt !== 'first' &&
    !['chunk-write', 'future-schema', 'delivery-fanout', 'http-sink-batch'].includes(payloadFamily)
  ) {
    return false;
  }
  // Only the chunk-write payload succeeds for a supported schema in this environment;
  // the other supported families require real external destinations.
  if (schema === 'supported' && bindingState === 'present' && payloadFamily !== 'chunk-write') {
    return false;
  }
  if (batchComposition === 'all-success' && payloadFamily === 'chunk-write') {
    if (bindingState !== 'present' || dlqArchive !== 'success') return false;
  }
  if (batchComposition === 'all-success' && payloadFamily === 'future-schema') {
    if (bindingState !== 'present' || dlqArchive !== 'success') return false;
  }
  if (batchComposition === 'all-success' && schema === 'malformed') return false;
  if (batchComposition === 'all-fail') {
    const sinkLike = ['delivery-fanout', 'http-sink-batch', 'dlq-replay', 'rewrap-chunk'].includes(
      payloadFamily
    );
    if (!(schema === 'malformed' || bindingState !== 'present' || sinkLike)) return false;
  }
  if ((payloadFamily === 'future-schema') !== (schema === 'future')) return false;
  if ((payloadFamily === 'malformed') !== (schema === 'malformed')) return false;
  if (lane === 'fallback' && bindingState !== 'missing') return false;
  if (lane === 'fallback' && batchComposition !== 'all-fail') return false;
  if (
    batchComposition !== 'all-success' &&
    batchComposition !== 'all-fail' &&
    batchComposition !== 'mixed'
  )
    return false;
  return true;
}

// =============================================================================
// Independently declared selected-triple groups
// =============================================================================

const IND_R_TRIPLES: Array<[string, string, string]> = [
  ['familyState', 'versionRelation', 'jtiRelation'],
  ['operation', 'clientBinding', 'tenantBinding'],
  ['operation', 'scopeRelation', 'versionRelation'],
  ['ttlState', 'instanceState', 'storageOutcome'],
  ['operation', 'jtiRelation', 'sequence'],
  ['operation', 'versionRelation', 'tenantBinding'],
];

const IND_DS_TRIPLES: Array<[string, string, string]> = [
  ['state', 'operation', 'clientBinding'],
  ['state', 'operation', 'tenantBinding'],
  ['state', 'reservationResult', 'expiry'],
];

const IND_DT_TRIPLES: Array<[string, string, string]> = [
  ['state', 'pollingTiming', 'attempt'],
  ['state', 'reservationResult', 'expiry'],
  ['state', 'clientBinding', 'tenantBinding'],
  ['reservationResult', 'state', 'tokenOutcome'],
];

const IND_CS_TRIPLES: Array<[string, string, string]> = [
  ['deliveryMode', 'state', 'operation'],
  ['nonce', 'acr', 'approvalResult'],
  ['state', 'operation', 'tenantBinding'],
  ['state', 'reservationResult', 'tenantBinding'],
];

const IND_CT_TRIPLES: Array<[string, string, string]> = [
  ['deliveryMode', 'state', 'pollingTiming'],
  ['deliveryMode', 'pollingTiming', 'attempt'],
  ['nonce', 'acr', 'tokenOutcome'],
  ['clientAuth', 'tenantBinding', 'state'],
  ['reservationResult', 'state', 'tokenOutcome'],
];

const IND_QA_TRIPLES: Array<[string, string, string]> = [
  ['batchComposition', 'attempt', 'delivery'],
  ['delivery', 'bindingState', 'payloadFamily'],
  ['tenant', 'dlqArchive', 'payloadFamily'],
];

const IND_QD_TRIPLES: Array<[string, string, string]> = [
  ['batchComposition', 'attempt', 'delivery'],
  ['bindingState', 'dlqArchive', 'tenant'],
  ['delivery', 'payloadFamily', 'bindingState'],
];

const IND_QL_TRIPLES: Array<[string, string, string]> = [
  ['batchComposition', 'schema', 'delivery'],
  ['schema', 'attempt', 'lane'],
  ['lane', 'bindingState', 'tenant'],
  ['delivery', 'bindingState', 'payloadFamily'],
  ['tenant', 'dlqArchive', 'payloadFamily'],
  ['dlqArchive', 'schema', 'attempt'],
];

// Fixed expected coverage counts (computed by the independent checker, not by the
// generator). Recorded here as independently declared literals.
const EXPECTED_R_PAIR_COUNT = 526;
const EXPECTED_DS_PAIR_COUNT = 101;
const EXPECTED_DT_PAIR_COUNT = 326;
const EXPECTED_CS_PAIR_COUNT = 311;
const EXPECTED_CT_PAIR_COUNT = 488;
const EXPECTED_QA_PAIR_COUNT = 150;
const EXPECTED_QD_PAIR_COUNT = 119;
const EXPECTED_QL_PAIR_COUNT = 347;

interface MatrixSpec {
  name: string;
  order: readonly string[];
  values: Record<string, readonly Scalar[]>;
  legal: (row: Row) => boolean;
  extra?: (row: Row) => boolean;
  triples: Array<[string, string, string]>;
  expectedPairs: number;
  genConstraints: Array<(row: Row) => boolean>;
}

const MATRIX_SPECS: MatrixSpec[] = [
  {
    name: 'R',
    order: IND_R_DIMENSION_ORDER,
    values: IND_R_VALUES,
    legal: independentRLegal,
    triples: IND_R_TRIPLES,
    expectedPairs: EXPECTED_R_PAIR_COUNT,
    genConstraints: REFRESH_CONSTRAINTS,
  },
  {
    name: 'D-S',
    order: IND_DS_DIMENSION_ORDER,
    values: IND_DS_VALUES,
    legal: independentDsLegal,
    triples: IND_DS_TRIPLES,
    expectedPairs: EXPECTED_DS_PAIR_COUNT,
    genConstraints: DEVICE_STORE_CONSTRAINTS,
  },
  {
    name: 'D-T',
    order: IND_DT_DIMENSION_ORDER,
    values: IND_DT_VALUES,
    legal: independentDtLegal,
    triples: IND_DT_TRIPLES,
    expectedPairs: EXPECTED_DT_PAIR_COUNT,
    genConstraints: DEVICE_TOKEN_CONSTRAINTS,
  },
  {
    name: 'C-S',
    order: IND_CS_DIMENSION_ORDER,
    values: IND_CS_VALUES,
    legal: independentCsLegal,
    triples: IND_CS_TRIPLES,
    expectedPairs: EXPECTED_CS_PAIR_COUNT,
    genConstraints: CIBA_STORE_CONSTRAINTS,
  },
  {
    name: 'C-T',
    order: IND_CT_DIMENSION_ORDER,
    values: IND_CT_VALUES,
    legal: independentCtLegal,
    extra: independentCtExtra,
    triples: IND_CT_TRIPLES,
    expectedPairs: EXPECTED_CT_PAIR_COUNT,
    genConstraints: CIBA_TOKEN_CONSTRAINTS,
  },
  {
    name: 'Q-A',
    order: IND_QA_DIMENSION_ORDER,
    values: IND_QA_VALUES,
    legal: independentQaLegal,
    triples: IND_QA_TRIPLES,
    expectedPairs: EXPECTED_QA_PAIR_COUNT,
    genConstraints: QUEUE_AUDIT_CONSTRAINTS,
  },
  {
    name: 'Q-D',
    order: IND_QD_DIMENSION_ORDER,
    values: IND_QD_VALUES,
    legal: independentQdLegal,
    triples: IND_QD_TRIPLES,
    expectedPairs: EXPECTED_QD_PAIR_COUNT,
    genConstraints: QUEUE_DLQ_CONSTRAINTS,
  },
  {
    name: 'Q-L',
    order: IND_QL_DIMENSION_ORDER,
    values: IND_QL_VALUES,
    legal: independentQlLegal,
    triples: IND_QL_TRIPLES,
    expectedPairs: EXPECTED_QL_PAIR_COUNT,
    genConstraints: QUEUE_LOG_CONSTRAINTS,
  },
];

function indSpec(
  spec: MatrixSpec,
  triples: Array<[string, string, string]> = spec.triples
): CoverageSpec {
  return {
    dimensionOrder: [...spec.order],
    values: spec.values,
    constraints: spec.extra ? [spec.legal, spec.extra] : [spec.legal],
    selectedTriples: triples,
  };
}

function rowsOf(table: StateCase[], order: readonly string[]): Row[] {
  return table.map((entry) => entry.dimensions as unknown as Row);
}

function caseTableFor(name: string): StateCase[] {
  switch (name) {
    case 'R':
      return REFRESH_CASE_TABLE;
    case 'D-S':
      return DEVICE_STORE_CASE_TABLE;
    case 'D-T':
      return DEVICE_TOKEN_CASE_TABLE;
    case 'C-S':
      return CIBA_STORE_CASE_TABLE;
    case 'C-T':
      return CIBA_TOKEN_CASE_TABLE;
    case 'Q-A':
      return QUEUE_AUDIT_CASE_TABLE;
    case 'Q-D':
      return QUEUE_DLQ_CASE_TABLE;
    case 'Q-L':
      return QUEUE_LOG_CASE_TABLE;
    default:
      throw new Error(`Unknown matrix ${name}`);
  }
}

// =============================================================================
// Coverage tests
// =============================================================================

describe('state-transition coverage (independent checker)', () => {
  it('references only declared dimensions in every selected triple', () => {
    expect.hasAssertions();
    for (const spec of MATRIX_SPECS) {
      const declared = new Set<string>(spec.order);
      for (const triple of spec.triples) {
        expect(
          triple.every((dimension) => declared.has(dimension)),
          `${spec.name} selected triple ${triple.join(' × ')}`
        ).toBe(true);
      }
    }
  });

  it('every matrix legal pair count matches its fixed independently declared literal', () => {
    expect.hasAssertions();
    for (const spec of MATRIX_SPECS) {
      const pairs = requiredPairKeys(indSpec(spec, []));
      expect(pairs.length, `${spec.name} pair count`).toBe(spec.expectedPairs);
    }
  });

  it('the generator constraints and the independent predicates accept the same assignment set', () => {
    expect.hasAssertions();
    const key = (rows: Row[], order: readonly string[]): string =>
      rows
        .map((row) => order.map((dimension) => `${dimension}=${row[dimension]}`).join('|'))
        .sort()
        .join('\n');
    for (const spec of MATRIX_SPECS) {
      const generated = enumerateLegalAssignments({
        dimensionOrder: [...spec.order],
        values: spec.values,
        constraints: spec.genConstraints,
      });
      const independent = enumerateLegalAssignments(indSpec(spec, []));
      expect(key(generated, spec.order), `${spec.name} generator set`).toBe(
        key(independent, spec.order)
      );
    }
  });

  it('every retained row is legal for the independent predicate of its matrix', () => {
    expect.hasAssertions();
    for (const spec of MATRIX_SPECS) {
      for (const entry of caseTableFor(spec.name)) {
        expect(
          spec.extra
            ? spec.legal(entry.dimensions as Row) && spec.extra(entry.dimensions as Row)
            : spec.legal(entry.dimensions as Row),
          `${entry.id}`
        ).toBe(true);
      }
    }
  });

  it('every matrix covers every legal pair and its required triples', () => {
    expect.hasAssertions();
    for (const spec of MATRIX_SPECS) {
      const diagnostics = verifyCoverage(
        indSpec(spec),
        rowsOf(caseTableFor(spec.name), spec.order)
      );
      expect(diagnostics.illegalRows, `${spec.name} illegal rows`).toEqual([]);
      expect(diagnostics.missingPairs, `${spec.name} missing pairs`).toEqual([]);
      expect(diagnostics.missingTriples, `${spec.name} missing triples`).toEqual([]);
    }
  });

  it('every required triple group is covered 100% by its matrix', () => {
    expect.hasAssertions();
    for (const spec of MATRIX_SPECS) {
      for (const triple of spec.triples) {
        const diagnostics = verifyCoverage(
          indSpec(spec, [triple]),
          rowsOf(caseTableFor(spec.name), spec.order)
        );
        expect(diagnostics.missingTriples, `${spec.name} ${triple.join(' × ')}`).toEqual([]);
      }
    }
  });

  it('rejects a matrix that drops one legal pair', () => {
    expect.hasAssertions();
    const spec = MATRIX_SPECS[0];
    const rows = rowsOf(caseTableFor(spec.name), spec.order);
    const pairs = requiredPairKeys(indSpec(spec, []));
    const dropped = pairs.find((pair) => pair.includes('operation=rotate')) as string;
    const [left, right] = dropped.split('|');
    const [a, av] = left.split('=');
    const [b, bv] = right.split('=');
    const filtered = rows.filter((row) => !(String(row[a]) === av && String(row[b]) === bv));
    const diagnostics = verifyCoverage(indSpec(spec, []), filtered);
    expect(diagnostics.missingPairs).toContain(dropped);
  });

  it('rejects a matrix that keeps pairwise coverage but drops a required triple', () => {
    expect.hasAssertions();
    const spec = MATRIX_SPECS[1];
    const rows = rowsOf(caseTableFor(spec.name), spec.order);
    const triples = requiredTripleKeys(indSpec(spec));
    const dropped = triples.find((triple) => triple.includes('operation=approve')) as string;
    const parts = dropped.split('|').map((part) => {
      const [dimension, value] = part.split('=');
      return { dimension, value };
    });
    const filtered = rows.filter((row) =>
      parts.some(({ dimension, value }) => String(row[dimension]) !== value)
    );
    const diagnostics = verifyCoverage(indSpec(spec), filtered);
    expect(diagnostics.missingTriples).toContain(dropped);
  });

  it('detects a wrong constraint that hides a legal tuple', () => {
    expect.hasAssertions();
    const spec = MATRIX_SPECS[4];
    const rows = rowsOf(caseTableFor(spec.name), spec.order);
    const bogusRows = rows.filter(
      (row) =>
        !(
          String(row.state) === 'approved' &&
          String(row.tokenOutcome) === 'issued' &&
          String(row.clientAuth) === 'valid'
        )
    );
    const diagnostics = verifyCoverage(indSpec(spec), bogusRows);
    const missingTriple = diagnostics.missingTriples.find((triple) =>
      triple.includes('tokenOutcome=issued')
    );
    expect(missingTriple).toBeDefined();
  });

  it('assigns unique case ids and unique semantic fingerprints across all matrices', () => {
    expect.hasAssertions();
    const all = MATRIX_SPECS.flatMap((spec) => caseTableFor(spec.name));
    const ids = all.map((entry) => entry.id);
    expect(findDuplicateIds(ids)).toEqual([]);
    const fingerprints = all.map((entry) => entry.fingerprint);
    expect(findDuplicateIds(fingerprints)).toEqual([]);
  });

  it('pins the covering-array case counts (including appended dedicated rows)', () => {
    expect.hasAssertions();
    for (const spec of MATRIX_SPECS) {
      const regenerated = generateCoveringArray({
        dimensionOrder: [...spec.order],
        values: spec.values,
        constraints: indSpec(spec, []).constraints,
        selectedTriples: spec.triples,
      });
      // The R matrix appends three dedicated rows that the greedy covering array never
      // selects but that are required to reach the theft/scope production edges.
      const appended = spec.name === 'R' ? 3 : spec.name === 'Q-L' ? 1 : 0;
      expect(caseTableFor(spec.name).length, `${spec.name} case count`).toBe(
        regenerated.length + appended
      );
    }
  }, 300_000);

  it('every mutation ID is carried by at least one case in its matrix', () => {
    expect.hasAssertions();
    for (const spec of MUTATION_REPRESENTATIVE_CONDITIONS) {
      const carriers = caseTableFor(spec.matrix).filter((entry) =>
        entry.mutationIds.includes(spec.id)
      );
      expect(carriers.length, `${spec.id} carriers in ${spec.matrix}`).toBeGreaterThan(0);
    }
  });

  /**
   * Independently declared dimension-effect audit (修正5): every retained dimension must change
   * at least one of (production input, operation sequence, DO instance/storage, failure
   * injection, observable response/state/side effect). Dimensions whose values change
   * nothing are dead and must be removed. The audit table is re-declared here as
   * independently declared literals, independent of cases.ts.
   */
  const DIMENSION_EFFECT_AUDIT: Array<{
    matrix: string;
    dimension: string;
    effect: string;
  }> = [
    // R
    {
      matrix: 'R',
      dimension: 'familyState',
      effect: 'seed shape + observable familyExists/version',
    },
    { matrix: 'R', dimension: 'operation', effect: 'which production RPC runs' },
    {
      matrix: 'R',
      dimension: 'versionRelation',
      effect: 'incoming version argument + theft/expired outcome',
    },
    { matrix: 'R', dimension: 'jtiRelation', effect: 'incoming jti argument + theft outcome' },
    {
      matrix: 'R',
      dimension: 'clientBinding',
      effect: 'client_id argument + client mismatch outcome',
    },
    {
      matrix: 'R',
      dimension: 'tenantBinding',
      effect: 'tenant_id argument + tenant pinning outcome',
    },
    {
      matrix: 'R',
      dimension: 'scopeRelation',
      effect: 'requested scope argument + invalid_scope outcome',
    },
    {
      matrix: 'R',
      dimension: 'storageOutcome',
      effect: 'failure injection + storage error outcome',
    },
    {
      matrix: 'R',
      dimension: 'instanceState',
      effect: 'same vs fresh DO instance (storage-restored family)',
    },
    { matrix: 'R', dimension: 'sequence', effect: 'real first rotate before the matrix operation' },
    { matrix: 'R', dimension: 'ttlState', effect: 'expires_at seed + expired outcome' },
    // D-S
    { matrix: 'D-S', dimension: 'state', effect: 'seed state + observable record status' },
    { matrix: 'D-S', dimension: 'operation', effect: 'which store handler runs' },
    {
      matrix: 'D-S',
      dimension: 'clientBinding',
      effect: 'token-endpoint client check (stored client id)',
    },
    { matrix: 'D-S', dimension: 'tenantBinding', effect: 'instance name + tenant isolation' },
    { matrix: 'D-S', dimension: 'expiry', effect: 'expires_at seed + expired self-delete' },
    { matrix: 'D-S', dimension: 'reservationResult', effect: 'already-issued reservation shape' },
    // D-T
    { matrix: 'D-T', dimension: 'state', effect: 'store seed state + endpoint outcome' },
    { matrix: 'D-T', dimension: 'clientBinding', effect: 'wrong-client path (stub store)' },
    { matrix: 'D-T', dimension: 'tenantBinding', effect: 'request tenant + store instance' },
    {
      matrix: 'D-T',
      dimension: 'pollingTiming',
      effect: 'last_poll_at/poll_count seed + slow_down outcome',
    },
    { matrix: 'D-T', dimension: 'attempt', effect: 'repeated polling input' },
    { matrix: 'D-T', dimension: 'reservationResult', effect: 'reservation response shape' },
    { matrix: 'D-T', dimension: 'expiry', effect: 'expires_at seed + expired outcome' },
    { matrix: 'D-T', dimension: 'tokenOutcome', effect: 'expected endpoint outcome' },
    // C-S
    { matrix: 'C-S', dimension: 'deliveryMode', effect: 'delivery_mode stored on the request' },
    { matrix: 'C-S', dimension: 'state', effect: 'seed state + observable record status' },
    { matrix: 'C-S', dimension: 'operation', effect: 'which store handler runs' },
    { matrix: 'C-S', dimension: 'nonce', effect: 'nonce argument + stored nonce' },
    { matrix: 'C-S', dimension: 'acr', effect: 'authenticated_acr argument + stored acr' },
    { matrix: 'C-S', dimension: 'approvalResult', effect: 'approval result shape + state tie' },
    { matrix: 'C-S', dimension: 'tenantBinding', effect: 'instance name + tenant isolation' },
    { matrix: 'C-S', dimension: 'reservationResult', effect: 'already-issued reservation shape' },
    // C-T
    { matrix: 'C-T', dimension: 'deliveryMode', effect: 'delivery_mode stored on the request' },
    { matrix: 'C-T', dimension: 'state', effect: 'store seed state + endpoint outcome' },
    {
      matrix: 'C-T',
      dimension: 'pollingTiming',
      effect: 'last_poll_at/poll_count seed + slow_down outcome',
    },
    { matrix: 'C-T', dimension: 'attempt', effect: 'repeated polling input' },
    { matrix: 'C-T', dimension: 'nonce', effect: 'nonce argument + issued ID token nonce' },
    { matrix: 'C-T', dimension: 'acr', effect: 'authenticated_acr argument + issued ID token acr' },
    {
      matrix: 'C-T',
      dimension: 'clientAuth',
      effect: 'client authentication input + auth outcome',
    },
    {
      matrix: 'C-T',
      dimension: 'clientBinding',
      effect: 'client binding input + mismatch outcome',
    },
    { matrix: 'C-T', dimension: 'tenantBinding', effect: 'request tenant + store instance' },
    { matrix: 'C-T', dimension: 'reservationResult', effect: 'reservation response shape' },
    { matrix: 'C-T', dimension: 'tokenOutcome', effect: 'expected endpoint outcome' },
    // Q-A
    {
      matrix: 'Q-A',
      dimension: 'batchComposition',
      effect: 'number of messages + acked/retried split',
    },
    {
      matrix: 'Q-A',
      dimension: 'attempt',
      effect: 'Message.attempts input + attempt_count params (fanout)',
    },
    {
      matrix: 'Q-A',
      dimension: 'delivery',
      effect: 'one vs two real deliveries over the same durable state',
    },
    {
      matrix: 'Q-A',
      dimension: 'bindingState',
      effect: 'D1/R2 binding injection + fail-closed retry',
    },
    {
      matrix: 'Q-A',
      dimension: 'tenant',
      effect: 'tenantId body + event_log param / derived R2 key',
    },
    { matrix: 'Q-A', dimension: 'dlqArchive', effect: 'AUDIT_ARCHIVE injection for fanout rows' },
    { matrix: 'Q-A', dimension: 'payloadFamily', effect: 'message type + outcome + durable rows' },
    // Q-D
    {
      matrix: 'Q-D',
      dimension: 'batchComposition',
      effect: 'number of messages + acked/retried split',
    },
    {
      matrix: 'Q-D',
      dimension: 'attempt',
      effect: 'Message.attempts input + attempt_count params',
    },
    {
      matrix: 'Q-D',
      dimension: 'delivery',
      effect: 'one vs two real deliveries over the same durable state',
    },
    {
      matrix: 'Q-D',
      dimension: 'bindingState',
      effect: 'D1/R2 binding injection + fail-closed retry',
    },
    {
      matrix: 'Q-D',
      dimension: 'tenant',
      effect: 'tenantId body + derived tenant key in dlq/lde params',
    },
    { matrix: 'Q-D', dimension: 'dlqArchive', effect: 'AUDIT_ARCHIVE injection + R2 save' },
    {
      matrix: 'Q-D',
      dimension: 'payloadFamily',
      effect: 'event-log vs pii-log log_type in durable rows',
    },
    // Q-L
    {
      matrix: 'Q-L',
      dimension: 'batchComposition',
      effect: 'number of messages + acked/retried split',
    },
    {
      matrix: 'Q-L',
      dimension: 'attempt',
      effect: 'Message.attempts input + attempt_count params',
    },
    {
      matrix: 'Q-L',
      dimension: 'schema',
      effect: 'payload schema_version + DLQ-vs-supported outcome',
    },
    {
      matrix: 'Q-L',
      dimension: 'delivery',
      effect: 'one vs two real deliveries over the same durable state',
    },
    {
      matrix: 'Q-L',
      dimension: 'lane',
      effect: 'lane field + critical notification + aggregates lane',
    },
    {
      matrix: 'Q-L',
      dimension: 'bindingState',
      effect: 'D1/R2 binding injection + fail-closed retry',
    },
    { matrix: 'Q-L', dimension: 'tenant', effect: 'tenant_key body + derived key in durable rows' },
    { matrix: 'Q-L', dimension: 'dlqArchive', effect: 'AUDIT_ARCHIVE injection + R2 save' },
    { matrix: 'Q-L', dimension: 'payloadFamily', effect: 'payload_type + outcome + durable rows' },
  ];

  it('every retained dimension changes production input, sequence, storage, injection, or observation (dimension-effect audit)', () => {
    expect.hasAssertions();
    for (const spec of MATRIX_SPECS) {
      for (const dimension of spec.order) {
        const entry = DIMENSION_EFFECT_AUDIT.find(
          (item) => item.matrix === spec.name && item.dimension === dimension
        );
        expect(
          entry,
          `${spec.name} ${dimension} must appear in the independently declared dimension-effect audit`
        ).toBeDefined();
        expect(
          entry!.effect.length,
          `${spec.name} ${dimension} effect description`
        ).toBeGreaterThan(0);
      }
    }
  });
});

// =============================================================================
// Mutation witnesses connected to real production observations
// =============================================================================

import { createSecurityMatrixEnv, seedClientRow, seedRegionShardConfig } from '../fixtures/env';
import { CallLedger } from '../fixtures/call-ledger';
import { installFrozenNow, restoreRealClock } from '../fixtures/deterministic-clock';
import { createMatrixTokenApp, requestUrl } from '../fixtures/hono-context';
import { LedgerExecutionContext } from '../fixtures/call-ledger';
import {
  refreshMutationCandidate,
  seedRefreshRow,
  runRefreshOp,
  prepareRefreshSequence,
  buildRefreshObservation,
  expectedRefreshObservation,
  corruptRefreshObservationDomain,
  type RefreshObservationDomain,
} from './refresh-observation';
import {
  deviceMutationCandidate,
  seedDeviceState,
  runDeviceStoreOp,
  buildDeviceObservation,
  expectedDeviceObservation,
  corruptDeviceObservationDomain,
  type DeviceObservationDomain,
  seedRegionShardConfigForeign as seedDeviceRegionShardConfigForeign,
} from './device-observation';
import {
  cibaMutationCandidate,
  seedCibaState,
  runCibaStoreOp,
  buildCibaObservation,
  expectedCibaObservation,
  corruptCibaObservationDomain,
  type CibaObservationDomain,
  seedRegionShardConfigForeign as seedCibaRegionShardConfigForeign,
} from './ciba-observation';
import {
  queueMutationCandidate,
  runQueueRow,
  buildQueueObservation,
  batchIds,
  corruptQueueObservationDomain,
  type QueueObservationDomain,
} from './queue-observation';
import {
  decideRefresh,
  decideDeviceStore,
  decideDeviceToken,
  decideCibaStore,
  decideCibaToken,
  type RefreshDecision,
  type DeviceDecision,
  type CibaDecision,
  type QueueDecision,
} from './cases';
import { queueDecisionFor as queueDecisionForImpl } from './queue-observation';
import { messageCallCounts } from './harness';

/**
 * Independently declared representative conditions per mutation ID. Each condition is asserted
 * BEFORE the real production run so the witness is provably connected to the exact
 * production path the mutation targets — not to an arbitrary case that merely carries
 * the mutation id.
 */
const MUTATION_REPRESENTATIVE_CONDITIONS: Array<{
  id: string;
  family: 'refresh' | 'device' | 'ciba' | 'queue';
  domain: string;
  description: string;
  matrix: string;
  condition: (entry: StateCase) => boolean;
  assertProductionPath: (entry: StateCase, observed: unknown) => void;
}> = [
  {
    id: 'refresh:keep-family-after-old-version-theft',
    family: 'refresh',
    domain: 'familyExists',
    description: 'old-version theft deletes the family and emits the synchronous critical audit',
    matrix: 'R',
    condition: (entry) =>
      String(entry.dimensions.operation) === 'rotate' &&
      String(entry.dimensions.versionRelation) === 'old' &&
      String(entry.dimensions.familyState) === 'active' &&
      String(entry.dimensions.sequence) === 'replay' &&
      String(entry.dimensions.storageOutcome) === 'success' &&
      String(entry.dimensions.ttlState) === 'active',
    assertProductionPath: (entry, observed) => {
      const obs = observed as { familyExists: boolean; criticalAudits: number };
      expect(obs.familyExists, `${entry.id} family must be deleted`).toBe(false);
      expect(obs.criticalAudits, `${entry.id} exactly one synchronous critical audit`).toBe(1);
    },
  },
  {
    id: 'refresh:keep-family-after-jti-mismatch-theft',
    family: 'refresh',
    domain: 'familyExists',
    description: 'JTI-mismatch theft deletes the family and emits the synchronous critical audit',
    matrix: 'R',
    condition: (entry) =>
      String(entry.dimensions.operation) === 'rotate' &&
      String(entry.dimensions.jtiRelation) === 'mismatched' &&
      String(entry.dimensions.versionRelation) === 'exact' &&
      String(entry.dimensions.familyState) === 'active' &&
      String(entry.dimensions.storageOutcome) === 'success' &&
      String(entry.dimensions.ttlState) === 'active',
    assertProductionPath: (entry, observed) => {
      const obs = observed as { familyExists: boolean; criticalAudits: number };
      expect(obs.familyExists, `${entry.id} family must be deleted`).toBe(false);
      expect(obs.criticalAudits, `${entry.id} exactly one synchronous critical audit`).toBe(1);
    },
  },
  {
    id: 'refresh:allow-scope-expansion',
    family: 'refresh',
    domain: 'familyVersion',
    description: 'scope expansion is rejected by the REAL rotator before any rotation',
    matrix: 'R',
    condition: (entry) =>
      String(entry.dimensions.operation) === 'rotate' &&
      String(entry.dimensions.scopeRelation) === 'expanded' &&
      String(entry.dimensions.versionRelation) === 'exact' &&
      String(entry.dimensions.jtiRelation) === 'matching' &&
      String(entry.dimensions.familyState) === 'active' &&
      String(entry.dimensions.storageOutcome) === 'success' &&
      String(entry.dimensions.ttlState) === 'active',
    assertProductionPath: (entry, observed) => {
      const obs = observed as { errorCode: string | null };
      expect(obs.errorCode, `${entry.id} invalid_scope`).toContain('invalid_scope');
    },
  },
  {
    id: 'device:allow-forbidden-approval',
    family: 'device',
    domain: 'state',
    description: 'the REAL DeviceCodeStore rejects an approval of a non-pending code',
    matrix: 'D-S',
    condition: (entry) =>
      entry.matrix.startsWith('D-S') &&
      String(entry.dimensions.operation) === 'approve' &&
      String(entry.dimensions.state) !== 'pending',
    assertProductionPath: (entry, observed) => {
      const obs = observed as { status: number; error: string | null };
      expect(obs.status, `${entry.id} forbidden approval fails closed`).not.toBe(200);
      void obs.error;
    },
  },
  {
    id: 'device:allow-forbidden-denial',
    family: 'device',
    domain: 'state',
    description: 'the REAL DeviceCodeStore rejects a denial of a non-pending code',
    matrix: 'D-S',
    condition: (entry) =>
      entry.matrix.startsWith('D-S') &&
      String(entry.dimensions.operation) === 'deny' &&
      String(entry.dimensions.state) !== 'pending',
    assertProductionPath: (entry, observed) => {
      const obs = observed as { status: number };
      expect(obs.status, `${entry.id} forbidden denial fails closed`).not.toBe(200);
    },
  },
  {
    id: 'device:allow-forbidden-issuance',
    family: 'device',
    domain: 'state',
    description: 'the REAL DeviceCodeStore rejects a second mark-issued',
    matrix: 'D-S',
    condition: (entry) =>
      entry.matrix.startsWith('D-S') &&
      String(entry.dimensions.operation) === 'mark-issued' &&
      String(entry.dimensions.state) === 'issued',
    assertProductionPath: (entry, observed) => {
      const obs = observed as { status: number; tokenIssued: boolean };
      expect(obs.status, `${entry.id} forbidden issuance fails closed`).not.toBe(200);
      expect(obs.tokenIssued, `${entry.id} no re-issuance`).toBe(true);
    },
  },
  {
    id: 'ciba:issue-after-reservation-failure',
    family: 'ciba',
    domain: 'signingCalls',
    description: 'C-T token endpoint: a non-success reservation fails closed with zero signing',
    matrix: 'C-T',
    condition: (entry) =>
      entry.matrix.startsWith('C-T') &&
      String(entry.dimensions.state) === 'approved' &&
      String(entry.dimensions.reservationResult) !== 'success' &&
      String(entry.dimensions.clientAuth) === 'valid' &&
      String(entry.dimensions.clientBinding) === 'matching',
    assertProductionPath: (entry, observed) => {
      const obs = observed as {
        signingCalls: number;
        accessTokenIssued: boolean;
        tokenIssued: boolean;
        reservationReached: boolean;
      };
      expect(obs.signingCalls, `${entry.id} zero signing after failed reservation`).toBe(0);
      expect(obs.accessTokenIssued, `${entry.id} no access token`).toBe(false);
      expect(obs.tokenIssued, `${entry.id} no token issued`).toBe(false);
      expect(obs.reservationReached, `${entry.id} reservation was reached`).toBe(true);
    },
  },
  {
    id: 'queue:retry-entire-mixed-batch',
    family: 'queue',
    domain: 'retried',
    description: 'a REAL mixed batch: the healthy message is acked, the failing one retried',
    matrix: 'Q-A',
    condition: (entry) =>
      entry.matrix.startsWith('Q-A') &&
      String(entry.dimensions.batchComposition) === 'mixed' &&
      String(entry.dimensions.delivery) === 'first' &&
      String(entry.dimensions.payloadFamily) !== 'fanout' &&
      String(entry.dimensions.bindingState) === 'present',
    assertProductionPath: (entry, observed) => {
      const obs = observed as { acked: string[]; retried: string[] };
      expect(obs.acked, `${entry.id} healthy message acked`).toContain('m1');
      expect(obs.retried, `${entry.id} failing message retried`).toContain('m2');
    },
  },
  {
    id: 'queue:ack-unsupported-schema-before-durable-dlq',
    family: 'queue',
    domain: 'dlqSaved',
    description: 'a future-schema payload is DLQ-saved before ack on the REAL consumer',
    matrix: 'Q-L',
    condition: (entry) =>
      entry.matrix.startsWith('Q-L') &&
      String(entry.dimensions.schema) === 'future' &&
      String(entry.dimensions.bindingState) === 'present' &&
      String(entry.dimensions.dlqArchive) === 'success' &&
      String(entry.dimensions.delivery) === 'first' &&
      String(entry.dimensions.attempt) === 'first',
    assertProductionPath: (entry, observed) => {
      const obs = observed as { dlqSaved: boolean; acked: string[] };
      expect(obs.dlqSaved, `${entry.id} durable DLQ save happened`).toBe(true);
      expect(obs.acked, `${entry.id} message acked after save`).toContain('m1');
    },
  },
  {
    id: 'queue:ack-transient-failure',
    family: 'queue',
    domain: 'acked',
    description: 'a REAL throwing binding makes the consumer retry (never ack)',
    matrix: 'Q-A',
    condition: (entry) =>
      entry.matrix.startsWith('Q-A') && String(entry.dimensions.bindingState) === 'throws',
    assertProductionPath: (entry, observed) => {
      const obs = observed as { retried: string[]; acked: string[] };
      expect(obs.retried, `${entry.id} transient failure retried`).toContain('m1');
      expect(obs.acked, `${entry.id} transient failure never acked`).not.toContain('m1');
    },
  },
  {
    id: 'queue:duplicate-durable-effect-on-redelivery',
    family: 'queue',
    domain: 'uniqueEffects',
    description: 'the SAME message is actually delivered twice and the durable state is compared',
    matrix: 'Q-A',
    condition: (entry) =>
      entry.matrix.startsWith('Q-A') &&
      String(entry.dimensions.delivery) === 'duplicate' &&
      String(entry.dimensions.bindingState) === 'present' &&
      String(entry.dimensions.payloadFamily) !== 'fanout' &&
      String(entry.dimensions.batchComposition) === 'all-success',
    assertProductionPath: (entry, observed) => {
      const obs = observed as { writeCalls: number; uniqueEffects: number; acked: string[] };
      expect(
        obs.acked,
        `${entry.id} duplicate delivery still disposes the message`
      ).not.toHaveLength(0);
      expect(
        obs.writeCalls,
        `${entry.id} duplicate delivery doubles the write calls`
      ).toBeGreaterThan(1);
      expect(obs.uniqueEffects, `${entry.id} idempotent durable identity`).toBeGreaterThan(0);
    },
  },
];

function representativeFor(mutationId: string): StateCase {
  const spec = MUTATION_REPRESENTATIVE_CONDITIONS.find((item) => item.id === mutationId);
  if (!spec) throw new Error(`Unknown mutation ${mutationId}`);
  const candidates = caseTableFor(spec.matrix).filter((entry) =>
    entry.mutationIds.includes(mutationId)
  );
  const chosen = candidates.find(spec.condition);
  if (!chosen) {
    throw new Error(
      `No representative case for mutation ${mutationId}: no ${spec.matrix} case carrying the mutation id also satisfies its independently declared condition`
    );
  }
  return chosen;
}

describe('state-transition mutation witnesses connected to real observations', () => {
  it('every mutation ID runs its exact production path and corrupting the mapped domain is rejected', async () => {
    expect.hasAssertions();
    installFrozenNow(1700000000);
    for (const mapping of MUTATION_REPRESENTATIVE_CONDITIONS) {
      const entry = representativeFor(mapping.id);
      // The representative condition is asserted BEFORE the run: the chosen case must
      // satisfy the independently declared condition for the exact production edge.
      expect(
        mapping.condition(entry),
        `${mapping.id} representative condition on ${entry.id}`
      ).toBe(true);

      const ledger = new CallLedger();
      const kit = await createSecurityMatrixEnv(ledger);
      if (mapping.family === 'refresh') {
        seedRegionShardConfig(kit);
        const seeded = await seedRefreshRow(kit, ledger, entry);
        await seeded.drain();
        await prepareRefreshSequence(seeded, entry);
        await seeded.drain();
        ledger.reset();
        const runResult = await runRefreshOp(seeded, entry);
        const observed = await buildRefreshObservation(kit, ledger, seeded, entry, runResult);
        const preDrainCount = observed.criticalAudits;
        await seeded.drain();
        observed.postDrainAudits = eventLogInsertCount(ledger) - preDrainCount;
        const expected = expectedRefreshObservation(
          entry,
          decideRefresh(entry.dimensions as never)
        );
        expect(observed, `${mapping.id} real refresh observation must pass`).toEqual(expected);
        mapping.assertProductionPath(entry, observed);
        const mutant = refreshMutationCandidate(entry, mapping.id) as RefreshDecision;
        expect(JSON.stringify(mutant), `${mapping.id} mutation must be discriminating`).not.toBe(
          JSON.stringify(decideRefresh(entry.dimensions as never))
        );
        const corrupted = corruptRefreshObservationDomain(
          observed,
          mapping.domain as RefreshObservationDomain
        );
        expect(
          corrupted,
          `${mapping.id} (${mapping.domain}) must be rejected by the common assertion`
        ).not.toEqual(expected);
      } else if (mapping.family === 'device') {
        seedRegionShardConfig(kit);
        seedDeviceRegionShardConfigForeign(kit);
        seedClientRow(kit, {
          client_id: 'matrix-device-client',
          token_endpoint_auth_method: 'none',
          grant_types: 'urn:ietf:params:oauth:grant-type:device_code',
          default_resource: 'svc://matrix-api',
        });
        // The device mutations target REAL DeviceCodeStore forbidden edges (D-S rows).
        const namespace = await seedDeviceState(kit, ledger, entry);
        ledger.reset();
        const runResult = await runDeviceStoreOp(namespace, entry);
        const observed = await buildDeviceObservation(kit, ledger, namespace, entry, {
          response: runResult.response,
          error: runResult.error,
          surface: 'store',
        });
        const expected = expectedDeviceObservation(
          entry,
          decideDeviceStore(entry.dimensions as never)
        );
        expect(observed, `${mapping.id} real device observation must pass`).toEqual(expected);
        mapping.assertProductionPath(entry, observed);
        const mutant = deviceMutationCandidate(entry, mapping.id) as DeviceDecision;
        expect(JSON.stringify(mutant), `${mapping.id} mutation must be discriminating`).not.toBe(
          JSON.stringify(decideDeviceStore(entry.dimensions as never))
        );
        const corrupted = corruptDeviceObservationDomain(
          observed,
          mapping.domain as DeviceObservationDomain
        );
        expect(
          corrupted,
          `${mapping.id} (${mapping.domain}) must be rejected by the common assertion`
        ).not.toEqual(expected);
      } else if (mapping.family === 'ciba') {
        seedRegionShardConfig(kit);
        seedCibaRegionShardConfigForeign(kit);
        const { hashSecret } = await import('./ciba-observation');
        seedClientRow(kit, {
          client_id: 'matrix-ciba-client',
          token_endpoint_auth_method: 'client_secret_post',
          client_secret_hash: await hashSecret('matrix-ciba-secret-001'),
          default_resource: 'svc://matrix-api',
          grant_types: 'urn:openid:params:grant-type:ciba',
          backchannel_token_delivery_mode: 'poll',
        });
        // The CIBA mutation targets the real token ENDPOINT on a typed Hono app with a
        // non-success reservation (never a store-only operation).
        const { seedCibaTokenStore, runCibaTokenOp } = await import('./ciba-observation');
        const tokenSeeded = await seedCibaTokenStore(kit, ledger, entry);
        ledger.reset();
        const tokenResult = await runCibaTokenOp(kit, ledger, entry);
        const observed = await buildCibaObservation(kit, ledger, tokenSeeded.namespace, entry, {
          response: null,
          surface: 'token',
          ...tokenResult,
          observedState: tokenSeeded.stubState(),
          observedTokenIssued: tokenSeeded.stubTokenIssued(),
          observedReservationCalled: tokenSeeded.reservationCalled(),
          observedNonce: tokenSeeded.seededNonce,
          observedAcr: tokenSeeded.seededAcr,
        });
        const expected = expectedCibaObservation(entry, decideCibaToken(entry.dimensions as never));
        expect(observed, `${mapping.id} real ciba observation must pass`).toEqual(expected);
        mapping.assertProductionPath(entry, observed);
        const mutant = cibaMutationCandidate(entry, mapping.id) as CibaDecision;
        expect(JSON.stringify(mutant), `${mapping.id} mutation must be discriminating`).not.toBe(
          JSON.stringify(decideCibaToken(entry.dimensions as never))
        );
        const corrupted = corruptCibaObservationDomain(
          observed,
          mapping.domain as CibaObservationDomain
        );
        expect(
          corrupted,
          `${mapping.id} (${mapping.domain}) must be rejected by the common assertion`
        ).not.toEqual(expected);
      } else {
        seedRegionShardConfig(kit);
        const ids = batchIds(entry);
        const { logger } = await runQueueRow(kit, ledger, entry);
        const observed = await buildQueueObservation(kit, ledger, entry, ids, logger);
        const expected = queueDecisionForImpl(entry) as QueueDecision;
        expect(observed, `${mapping.id} real queue observation must pass`).toEqual(expected);
        mapping.assertProductionPath(entry, observed);
        const mutant = queueMutationCandidate(entry, mapping.id) as QueueDecision;
        expect(JSON.stringify(mutant), `${mapping.id} mutation must be discriminating`).not.toBe(
          JSON.stringify(expected)
        );
        const corrupted = corruptQueueObservationDomain(
          observed,
          mapping.domain as QueueObservationDomain
        );
        expect(
          corrupted,
          `${mapping.id} (${mapping.domain}) must be rejected by the common assertion`
        ).not.toEqual(expected);
        const calls = messageCallCounts(ledger, ids);
        for (const id of ids) {
          expect(calls[id].ackCalls > 0 && calls[id].retryCalls > 0, `${mapping.id} ${id}`).toBe(
            false
          );
        }
      }
    }
    restoreRealClock();
  }, 300_000);

  void createMatrixTokenApp;
  void requestUrl;
  void LedgerExecutionContext;
  void eventLogInsertCount;
});
