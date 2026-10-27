/** Shared writer ownership. Provider names never determine the transfer direction. */
export interface DeploymentIdentity {
  deploymentId: string;
  provider: 'cloudflare' | 'aws';
}

export interface DeploymentPairDefinition {
  pairId: string;
  tenantId: string;
  deployments: readonly [DeploymentIdentity, DeploymentIdentity];
  initialOwnerDeploymentId: string;
  initialGenerationId: string;
}

export interface DeploymentAuthorityState {
  pairId: string;
  tenantId: string;
  ownerDeploymentId: string;
  selectedGenerationId: string;
  epoch: number;
  revision: number;
  phase: 'active' | 'draining';
  activeOperationId: string | null;
  drainedAtMs: number | null;
  outstandingPermits: number;
}

/** A private operation identity, retained until its complete effects have definitely settled. */
export interface DeploymentWritePermit {
  pairId: string;
  tenantId: string;
  deploymentId: string;
  epoch: number;
  generationId: string;
  permitId: string;
  operationDigest: string;
}

export interface DeploymentDrainRequest {
  pairId: string;
  tenantId: string;
  operationId: string;
  sourceDeploymentId: string;
  destinationDeploymentId: string;
  expectedEpoch: number;
  expectedRevision: number;
}

/**
 * Accepted only from a trusted verifier, after it verifies the actual destination data and the
 * final source capture. A caller-supplied digest alone is not proof of a successful transfer.
 */
export interface DeploymentVerifiedGeneration {
  generationId: string;
  sourceDeploymentId: string;
  destinationDeploymentId: string;
  sourceEpoch: number;
  sourceFenceRevision: number;
  capturedAtMs: number;
  manifestSha256: string;
  verificationSha256: string;
}

/** An immutable verified standby, registered while its source epoch is still active. */
export interface DeploymentStandbyGeneration {
  pairId: string;
  tenantId: string;
  sourceSyncOperationId: string;
  sourceSyncPlanSha256: string;
  generation: DeploymentVerifiedGeneration;
}

/** Explicit operator acceptance; it never authorizes discarding an unresolved writer. */
export interface DeploymentAcceptedDataLoss {
  sourceSyncOperationId: string;
  sourceSyncPlanSha256: string;
  maximumSnapshotAgeMs: number;
  acceptedAtMs: number;
}

export interface DeploymentFailoverGeneration {
  generation: DeploymentVerifiedGeneration;
  acceptedDataLoss: DeploymentAcceptedDataLoss;
}

export interface DeploymentSwitchOperation extends DeploymentDrainRequest {
  kind: 'planned' | 'failover';
  acceptedDataLoss: DeploymentAcceptedDataLoss | null;
  state: 'draining' | 'verified' | 'promoted';
  drainRevision: number;
  drainedAtMs: number | null;
  generation: DeploymentVerifiedGeneration | null;
  promotedEpoch: number | null;
}

export interface DeploymentOperationIdentity {
  pairId: string;
  tenantId: string;
  operationId: string;
}

/**
 * All mutations serialize on one durable pair. This API deliberately has no forced promotion,
 * permit expiry, lease takeover, or timer-based permit deletion. Authentication and authorization
 * of the deployment/controller identity belong to the transport, never to request-body fields.
 */
export interface DeploymentAuthority {
  initialize(definition: DeploymentPairDefinition): Promise<DeploymentAuthorityState>;
  get(pairId: string, tenantId: string): Promise<DeploymentAuthorityState>;
  enter(permit: DeploymentWritePermit): Promise<DeploymentWritePermit>;
  complete(permit: DeploymentWritePermit): Promise<void>;
  beginDrain(request: DeploymentDrainRequest): Promise<DeploymentSwitchOperation>;
  beginFailoverDrain(request: DeploymentDrainRequest): Promise<DeploymentSwitchOperation>;
  registerStandbyGeneration(input: DeploymentStandbyGeneration): Promise<void>;
  verifyFailoverGeneration(
    identity: DeploymentOperationIdentity,
    proof: DeploymentFailoverGeneration
  ): Promise<DeploymentSwitchOperation>;
  getOperation(identity: DeploymentOperationIdentity): Promise<DeploymentSwitchOperation>;
  verifyGeneration(
    identity: DeploymentOperationIdentity,
    generation: DeploymentVerifiedGeneration
  ): Promise<DeploymentSwitchOperation>;
  promote(identity: DeploymentOperationIdentity): Promise<DeploymentSwitchOperation>;
}

export class DeploymentAuthorityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DeploymentAuthorityError';
  }
}

export function authorityFailure(code: string): never {
  throw new DeploymentAuthorityError(`deployment_authority_${code}`);
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;

function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    authorityFailure('invalid_input');
}

function ids(...values: unknown[]): void {
  if (values.some((value) => typeof value !== 'string' || !ID.test(value)))
    authorityFailure('invalid_input');
}

function positive(...values: unknown[]): void {
  if (values.some((value) => !Number.isSafeInteger(value) || Number(value) < 1))
    authorityFailure('invalid_input');
}

export function assertDeploymentPairDefinition(
  input: unknown
): asserts input is DeploymentPairDefinition {
  object(input, [
    'pairId',
    'tenantId',
    'deployments',
    'initialOwnerDeploymentId',
    'initialGenerationId',
  ]);
  ids(input.pairId, input.tenantId, input.initialOwnerDeploymentId, input.initialGenerationId);
  if (!Array.isArray(input.deployments) || input.deployments.length !== 2)
    authorityFailure('invalid_input');
  for (const item of input.deployments as unknown[]) {
    object(item, ['deploymentId', 'provider']);
    ids(item.deploymentId);
    if (item.provider !== 'cloudflare' && item.provider !== 'aws')
      authorityFailure('invalid_input');
  }
  const deployments = input.deployments as DeploymentIdentity[];
  if (
    deployments[0].deploymentId === deployments[1].deploymentId ||
    !deployments.some((item) => item.deploymentId === input.initialOwnerDeploymentId)
  )
    authorityFailure('invalid_input');
}

export function assertDeploymentOperationIdentity(
  input: unknown
): asserts input is DeploymentOperationIdentity {
  object(input, ['pairId', 'tenantId', 'operationId']);
  ids(input.pairId, input.tenantId, input.operationId);
}

export function assertDeploymentDrainRequest(
  input: unknown
): asserts input is DeploymentDrainRequest {
  object(input, [
    'pairId',
    'tenantId',
    'operationId',
    'sourceDeploymentId',
    'destinationDeploymentId',
    'expectedEpoch',
    'expectedRevision',
  ]);
  ids(
    input.pairId,
    input.tenantId,
    input.operationId,
    input.sourceDeploymentId,
    input.destinationDeploymentId
  );
  positive(input.expectedEpoch, input.expectedRevision);
  if (input.sourceDeploymentId === input.destinationDeploymentId) authorityFailure('invalid_input');
}

export function assertDeploymentWritePermit(
  input: unknown
): asserts input is DeploymentWritePermit {
  object(input, [
    'pairId',
    'tenantId',
    'deploymentId',
    'epoch',
    'generationId',
    'permitId',
    'operationDigest',
  ]);
  ids(input.pairId, input.tenantId, input.deploymentId, input.generationId, input.permitId);
  positive(input.epoch);
  if (typeof input.operationDigest !== 'string' || !HASH.test(input.operationDigest))
    authorityFailure('invalid_input');
}

export function assertDeploymentVerifiedGeneration(
  input: unknown
): asserts input is DeploymentVerifiedGeneration {
  object(input, [
    'generationId',
    'sourceDeploymentId',
    'destinationDeploymentId',
    'sourceEpoch',
    'sourceFenceRevision',
    'capturedAtMs',
    'manifestSha256',
    'verificationSha256',
  ]);
  ids(input.generationId, input.sourceDeploymentId, input.destinationDeploymentId);
  positive(input.sourceEpoch, input.sourceFenceRevision, input.capturedAtMs);
  if (
    input.sourceDeploymentId === input.destinationDeploymentId ||
    typeof input.manifestSha256 !== 'string' ||
    !HASH.test(input.manifestSha256) ||
    typeof input.verificationSha256 !== 'string' ||
    !HASH.test(input.verificationSha256)
  )
    authorityFailure('invalid_input');
}

export function assertDeploymentAcceptedDataLoss(
  input: unknown
): asserts input is DeploymentAcceptedDataLoss {
  object(input, [
    'sourceSyncOperationId',
    'sourceSyncPlanSha256',
    'maximumSnapshotAgeMs',
    'acceptedAtMs',
  ]);
  ids(input.sourceSyncOperationId);
  positive(input.maximumSnapshotAgeMs, input.acceptedAtMs);
  if (typeof input.sourceSyncPlanSha256 !== 'string' || !HASH.test(input.sourceSyncPlanSha256))
    authorityFailure('invalid_input');
}

export function assertDeploymentStandbyGeneration(
  input: unknown
): asserts input is DeploymentStandbyGeneration {
  object(input, [
    'pairId',
    'tenantId',
    'sourceSyncOperationId',
    'sourceSyncPlanSha256',
    'generation',
  ]);
  ids(input.pairId, input.tenantId, input.sourceSyncOperationId);
  if (typeof input.sourceSyncPlanSha256 !== 'string' || !HASH.test(input.sourceSyncPlanSha256))
    authorityFailure('invalid_input');
  assertDeploymentVerifiedGeneration(input.generation);
}

export function assertDeploymentFailoverGeneration(
  input: unknown
): asserts input is DeploymentFailoverGeneration {
  object(input, ['generation', 'acceptedDataLoss']);
  assertDeploymentVerifiedGeneration(input.generation);
  assertDeploymentAcceptedDataLoss(input.acceptedDataLoss);
}

/** Stable serialization for persisted request identities; never contains credentials. */
export function authorityCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(authorityCanonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${authorityCanonicalJson(record[key])}`)
    .join(',')}}`;
}

/**
 * One effect, never replayed by this helper. The callback must await all nested/deferred writes.
 * A rejected callback may have an unknown write outcome: its permit remains open indefinitely.
 * Only a caller that subsequently proves all effects settled may explicitly complete it.
 */
export async function runWithDeploymentWritePermit<T>(
  authority: Pick<DeploymentAuthority, 'enter' | 'complete'>,
  permit: DeploymentWritePermit,
  effect: () => Promise<T>
): Promise<T> {
  assertDeploymentWritePermit(permit);
  const pinned = Object.freeze(structuredClone(permit));
  const admitted = await authority.enter(pinned);
  assertDeploymentWritePermit(admitted);
  if (authorityCanonicalJson(admitted) !== authorityCanonicalJson(pinned))
    authorityFailure('admission_mismatch');
  const result = await effect();
  await authority.complete(pinned);
  return result;
}
