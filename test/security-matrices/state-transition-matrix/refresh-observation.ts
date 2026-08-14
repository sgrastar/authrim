/**
 * Refresh-family shared helpers: seed the REAL RefreshTokenRotator over failure-injectable
 * storage, run one matrix row, and build/compare observations.
 *
 * This helper module is intentionally not collected as a test.
 */
import { createSecurityMatrixEnv, type SecurityMatrixEnvKit } from '../fixtures/env';
import { CallLedger } from '../fixtures/call-ledger';
import { frozenNowMs } from '../fixtures/deterministic-clock';
import { MemoryDurableObjectStorage } from '../fixtures/durable-storage';
import { RefreshTokenRotator } from '../../../packages/ar-lib-core/src/durable-objects/RefreshTokenRotator';
import { decideRefresh, type RefreshDecision, type StateCase } from './cases';
import { StateTransitionStorage, createStateDoState, type StorageFailureKind } from './harness';

export const TENANT = 'default';
export const CLIENT_ID = 'matrix-confidential';
export const USER_ID = 'user-001';
export const FROZEN_NOW = 1700000000;

export interface RefreshObservation {
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
  secretLeak: boolean;
}

export function emptyRefreshObservation(): RefreshObservation {
  return {
    outcome: 'success',
    errorCode: null,
    familyExists: false,
    familyVersion: null,
    valid: null,
    revoked: null,
    batchRevoked: null,
    batchNotFound: null,
    criticalAudits: 0,
    postDrainAudits: 0,
    secretLeak: false,
  };
}

export function normalizeError(error: unknown): string | null {
  if (error instanceof Error) {
    const message = error.message;
    if (message.includes('Durable storage')) return 'storage';
    return message;
  }
  if (error === undefined) return null;
  return String(error);
}

export function eventLogInsertCount(ledger: CallLedger): number {
  return ledger
    .all()
    .filter(
      (entry) => entry.kind === 'd1.execute' && entry.target.includes('INSERT INTO event_log')
    ).length;
}

export interface SeededRefresh {
  storage: StateTransitionStorage;
  rotator: RefreshTokenRotator;
  drain: () => Promise<void>;
  family: {
    version: number;
    lastJti: string;
    clientId: string;
    tenantId: string;
    allowedScope: string;
  } | null;
  /** When true the matrix operation must run on a NEW instance over the same storage. */
  reconstructBeforeRun: boolean;
  env: unknown;
}

export async function seedRefreshRow(
  kit: SecurityMatrixEnvKit,
  ledger: CallLedger,
  entry: StateCase
): Promise<SeededRefresh> {
  const d = entry.dimensions;
  const familyState = String(d.familyState);
  const storageOutcome = String(d.storageOutcome);
  const sequence = String(d.sequence);
  const storage = new StateTransitionStorage(
    new MemoryDurableObjectStorage(ledger, 'rotator'),
    ledger
  );

  const failureKind: Record<string, StorageFailureKind> = {
    'read-failure': 'get',
    'write-failure': 'put',
    'delete-failure': 'delete',
  };
  const kind = failureKind[storageOutcome];

  const expiresAt =
    String(d.ttlState) === 'active'
      ? frozenNowMs() + 3600_000
      : String(d.ttlState) === 'boundary'
        ? frozenNowMs()
        : frozenNowMs() - 1;
  const seedJti = `rt-seed-${entry.id}`;

  // Seed the family record directly (a ttl-based createFamily cannot express expired or
  // boundary expiry, since createFamily requires ttl >= 1), and BEFORE constructing the
  // DO so initializeStateBlocking loads the pinned tenant metadata. The seed is ALWAYS
  // version 1: repeated/replay rows perform a REAL first rotate to reach version 2.
  if (familyState === 'active' || familyState === 'expired') {
    await storage.put('f:user-001', {
      tenant_id: TENANT,
      version: 1,
      last_jti: seedJti,
      last_used_at: frozenNowMs(),
      expires_at: expiresAt,
      user_id: USER_ID,
      client_id: CLIENT_ID,
      allowed_scope: 'openid profile',
    });
    await storage.put('m:tenantId', TENANT);
  } else if (familyState === 'deleted') {
    await storage.put('m:tenantId', TENANT);
  }

  const created = createStateDoState({ idName: 'rotator', storage });
  const drain = created.drain;
  const rotator = new RefreshTokenRotator(created.state, kit.env);

  // The family info is derived from the seeded record; probing would warm the DO cache
  // and hide read failures. For repeated/replay rows the family is rotated for real
  // BEFORE the matrix operation (see runRefreshOp), which moves it to version 2.
  const familyInfo =
    familyState === 'active' || familyState === 'expired'
      ? {
          version: 1,
          lastJti: seedJti,
          clientId: CLIENT_ID,
          tenantId: TENANT,
          allowedScope: 'openid profile',
        }
      : null;
  // Inject the failure AFTER seeding so the seed writes are clean; the operation below
  // then observes the failure. (Repeated/replay rows are constrained to storage success;
  // first rows observe the injected failure.)
  if (kind) {
    if (storageOutcome === 'read-failure') {
      storage.injectFailure('get', 'f:');
      storage.injectFailure('list', 'f:');
    } else {
      storage.injectFailure(kind, 'f:');
    }
  }
  return {
    storage,
    rotator,
    drain,
    family: familyInfo,
    reconstructBeforeRun: String(d.instanceState) === 'reconstructed',
    env: kit.env,
  };
}

/**
 * Execute the REAL first transition for repeated/replay rows: rotate the seeded family
 * from version 1 to version 2 (a genuine production call with matching credentials),
 * drain its waitUntil, and — for reconstructed instances — build a NEW production DO
 * over the SAME storage so the matrix operation cannot reuse the memory cache. Called
 * BEFORE the ledger is reset, so the first rotate's audits never leak into the matrix
 * observation. For sequence=first rows this is a no-op.
 */
export async function prepareRefreshSequence(
  seeded: SeededRefresh,
  entry: StateCase
): Promise<void> {
  const sequence = String(entry.dimensions.sequence);
  if (sequence === 'first' || seeded.family === null) {
    return;
  }
  await seeded.rotator.rotateRpc({
    incomingVersion: 1,
    incomingJti: seeded.family.lastJti,
    userId: USER_ID,
    clientId: CLIENT_ID,
    tenantId: TENANT,
    requestedScope: undefined,
  });
  await seeded.drain();
  const stored = (await seeded.storage.get('f:user-001')) as
    | { version: number; last_jti: string }
    | undefined;
  if (!stored) {
    throw new Error('refresh first rotate did not persist the family');
  }
  seeded.family.version = stored.version;
  seeded.family.lastJti = stored.last_jti;
  if (seeded.reconstructBeforeRun) {
    const created = createStateDoState({
      idName: 'rotator-reconstructed',
      storage: seeded.storage,
    });
    seeded.rotator = new RefreshTokenRotator(created.state, seeded.env as never);
    seeded.drain = created.drain;
  }
}

export async function runRefreshOp(
  seeded: SeededRefresh,
  entry: StateCase
): Promise<{
  error: unknown;
  valid: boolean | null;
  revoked: boolean | null;
  batchRevoked: number | null;
  batchNotFound: number | null;
}> {
  const d = entry.dimensions;
  const op = String(d.operation);
  const clientId = String(d.clientBinding) === 'mismatched' ? 'other-client' : CLIENT_ID;
  const tenantId = String(d.tenantBinding) === 'foreign' ? 'foreign' : TENANT;
  const family = seeded.family;
  const versionRelation = String(d.versionRelation);
  const jtiRelation = String(d.jtiRelation);
  const scopeRelation = String(d.scopeRelation);

  const incomingVersion =
    family === null
      ? 1
      : versionRelation === 'old'
        ? family.version - 1
        : versionRelation === 'future'
          ? family.version + 1
          : family.version;
  const incomingJti =
    family === null ? 'rt-none' : jtiRelation === 'matching' ? family.lastJti : 'rt-other-jti';
  const requestedScope =
    scopeRelation === 'omitted'
      ? undefined
      : scopeRelation === 'equal'
        ? 'openid profile'
        : scopeRelation === 'subset'
          ? 'openid'
          : 'openid profile admin';

  try {
    switch (op) {
      case 'create':
      case 'recreate':
        await seeded.rotator.createFamilyRpc({
          jti: `rt-new-${entry.id}`,
          userId: USER_ID,
          clientId,
          scope: 'openid profile',
          ttl: 2592000,
          tenantId,
        });
        return {
          error: undefined,
          valid: null,
          revoked: null,
          batchRevoked: null,
          batchNotFound: null,
        };
      case 'rotate':
        await seeded.rotator.rotateRpc({
          incomingVersion,
          incomingJti,
          userId: USER_ID,
          clientId,
          tenantId,
          requestedScope,
        });
        return {
          error: undefined,
          valid: null,
          revoked: null,
          batchRevoked: null,
          batchNotFound: null,
        };
      case 'validate': {
        const result = await seeded.rotator.validateRpc(USER_ID, incomingVersion, clientId);
        return {
          error: undefined,
          valid: result.valid,
          revoked: null,
          batchRevoked: null,
          batchNotFound: null,
        };
      }
      case 'revoke-family':
        await seeded.rotator.revokeFamilyRpc(USER_ID, 'matrix-revoke');
        return {
          error: undefined,
          valid: null,
          revoked: null,
          batchRevoked: null,
          batchNotFound: null,
        };
      case 'revoke-by-jti': {
        const revoked = await seeded.rotator.revokeByJtiRpc(incomingJti, 'matrix-revoke');
        return { error: undefined, valid: null, revoked, batchRevoked: null, batchNotFound: null };
      }
      case 'batch-revoke': {
        const result = await seeded.rotator.batchRevokeRpc(
          [incomingJti, 'rt-not-present'],
          'matrix-revoke'
        );
        return {
          error: undefined,
          valid: null,
          revoked: null,
          batchRevoked: result.revoked,
          batchNotFound: result.notFound,
        };
      }
      default:
        throw new Error(`unreachable refresh op ${op}`);
    }
  } catch (error) {
    return { error, valid: null, revoked: null, batchRevoked: null, batchNotFound: null };
  }
}

export async function buildRefreshObservation(
  kit: SecurityMatrixEnvKit,
  ledger: CallLedger,
  seeded: SeededRefresh,
  entry: StateCase,
  runResult: {
    error: unknown;
    valid: boolean | null;
    revoked: boolean | null;
    batchRevoked: number | null;
    batchNotFound: number | null;
  }
): Promise<RefreshObservation> {
  const obs = emptyRefreshObservation();
  obs.errorCode = normalizeError(runResult.error);
  obs.outcome = runResult.error === undefined ? 'success' : 'error';
  obs.valid = runResult.valid ?? (String(entry.dimensions.operation) === 'validate' ? false : null);
  // A failed revoke-by-jti did not complete a revocation.
  obs.revoked =
    runResult.revoked ?? (String(entry.dimensions.operation) === 'revoke-by-jti' ? false : null);
  obs.batchRevoked = runResult.batchRevoked;
  obs.batchNotFound = runResult.batchNotFound;
  // The durable family state is read from the storage snapshot (source of truth),
  // independent of the DO cache and of injected read failures.
  const storedFamily = seeded.storage.snapshot().get('f:user-001') as
    | { version: number }
    | undefined;
  obs.familyExists = storedFamily !== undefined;
  obs.familyVersion = storedFamily?.version ?? null;
  obs.criticalAudits = eventLogInsertCount(ledger);
  // Secrets must never appear in ledger targets or the error surface.
  const serialized = ledger
    .all()
    .map((e) => `${e.kind}:${e.target}`)
    .join('\n');
  obs.secretLeak = serialized.includes('rt-seed-') || (obs.errorCode ?? '').includes('rt-seed-');
  void kit;
  return obs;
}

export function expectedRefreshObservation(
  entry: StateCase,
  decision: RefreshDecision
): RefreshObservation {
  const obs = emptyRefreshObservation();
  obs.outcome = decision.outcome;
  obs.errorCode = decision.errorCode;
  obs.familyExists = decision.familyExists;
  obs.familyVersion = decision.familyVersion;
  obs.valid = decision.valid;
  obs.revoked = decision.revoked;
  obs.batchRevoked = decision.batchRevoked;
  obs.batchNotFound = decision.batchNotFound;
  obs.criticalAudits = decision.criticalAudits;
  obs.postDrainAudits = decision.postDrainAudits;
  obs.secretLeak = false;
  void entry;
  return obs;
}

export function refreshMutationCandidate(entry: StateCase, mutationId: string): RefreshDecision {
  const base = decideRefresh(entry.dimensions as never);
  switch (mutationId) {
    case 'refresh:keep-family-after-old-version-theft':
      // Theft (old version) would leave the family in place.
      return {
        ...base,
        outcome: 'success',
        errorCode: null,
        familyExists: true,
        familyVersion: 3,
        criticalAudits: 0,
        postDrainAudits: 1,
      };
    case 'refresh:keep-family-after-jti-mismatch-theft':
      // Theft (JTI mismatch) would leave the family in place.
      return {
        ...base,
        outcome: 'success',
        errorCode: null,
        familyExists: true,
        familyVersion: 2,
        criticalAudits: 0,
        postDrainAudits: 1,
      };
    case 'refresh:allow-scope-expansion':
      // Scope expansion would be accepted.
      return { ...base, outcome: 'success', errorCode: null, familyVersion: 2, postDrainAudits: 1 };
    default:
      throw new Error(`Unknown refresh mutation ${mutationId}`);
  }
}

export { createSecurityMatrixEnv };

export type RefreshObservationDomain =
  | 'outcome'
  | 'errorCode'
  | 'familyExists'
  | 'familyVersion'
  | 'valid'
  | 'revoked'
  | 'batchRevoked'
  | 'batchNotFound'
  | 'criticalAudits'
  | 'postDrainAudits'
  | 'secretLeak';

export function corruptRefreshObservationDomain(
  observation: RefreshObservation,
  domain: RefreshObservationDomain
): RefreshObservation {
  const corrupted = { ...observation };
  switch (domain) {
    case 'outcome':
      corrupted.outcome = corrupted.outcome === 'success' ? 'error' : 'success';
      break;
    case 'errorCode':
      corrupted.errorCode = corrupted.errorCode === null ? 'storage' : null;
      break;
    case 'familyExists':
      corrupted.familyExists = !corrupted.familyExists;
      break;
    case 'familyVersion':
      corrupted.familyVersion = (corrupted.familyVersion ?? 0) + 1;
      break;
    case 'valid':
      corrupted.valid = corrupted.valid === null ? true : !corrupted.valid;
      break;
    case 'revoked':
      corrupted.revoked = corrupted.revoked === null ? true : !corrupted.revoked;
      break;
    case 'batchRevoked':
      corrupted.batchRevoked = (corrupted.batchRevoked ?? 0) + 1;
      break;
    case 'batchNotFound':
      corrupted.batchNotFound = (corrupted.batchNotFound ?? 0) + 1;
      break;
    case 'criticalAudits':
      corrupted.criticalAudits = corrupted.criticalAudits + 1;
      break;
    case 'postDrainAudits':
      corrupted.postDrainAudits = corrupted.postDrainAudits + 1;
      break;
    case 'secretLeak':
      corrupted.secretLeak = !corrupted.secretLeak;
      break;
    default:
      throw new Error(`Unknown refresh domain ${domain}`);
  }
  return corrupted;
}
