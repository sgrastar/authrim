import { authorityCanonicalJson, authorityFailure, type DeploymentIdentity } from './authority';

/** Bounded initial aggregate implementation; never truncate an authoritative tenant inventory. */
export const ENVIRONMENT_REPLICATION_MAX_TENANTS = 16;
export interface EnvironmentPairDefinition {
  pairId: string;
  environmentId: string;
  deployments: readonly [DeploymentIdentity, DeploymentIdentity];
  initialOwnerDeploymentId: string;
  initialGenerationId: string;
}
export interface EnvironmentAuthorityState {
  pairId: string;
  environmentId: string;
  ownerDeploymentId: string;
  selectedGenerationId: string;
  epoch: number;
  revision: number;
  phase: 'active' | 'draining';
  activeOperationId: string | null;
  drainedAtMs: number | null;
  outstandingPermits: number;
}
export interface EnvironmentWritePermit {
  tenantId?: string;
  restoreId?: string;
  pairId: string;
  environmentId: string;
  deploymentId: string;
  epoch: number;
  generationId: string;
  permitId: string;
  operationDigest: string;
}
export interface EnvironmentOperationIdentity {
  pairId: string;
  environmentId: string;
  operationId: string;
}
export interface EnvironmentDrainRequest extends EnvironmentOperationIdentity {
  kind: 'planned' | 'failover';
  sourceDeploymentId: string;
  destinationDeploymentId: string;
  expectedEpoch: number;
  expectedRevision: number;
}
export interface EnvironmentInventory {
  formatVersion: 1;
  environmentId: string;
  sourceDeploymentId: string;
  sourceEpoch: number;
  /** Zero is an explicitly unfenced periodic snapshot; planned captures use the global drain revision. */
  sourceFenceRevision: number;
  capturedAtMs: number;
  /** Digest of the complete source response authenticated by the trusted export controller. */
  sourceReceiptSha256: string;
  complete: true;
  /** All non-deleted source tenants. Unsupported lifecycles must reject the operation, not disappear. */
  tenants: { tenantId: string; issuer: string; lifecycle: 'active' }[];
}
/** Immutable object/secret pins; credentials never belong in generation catalog records. */
export interface EnvironmentGenerationAssetPins {
  region: string;
  issuerOrigin: string;
  secretArn: string;
  secretVersionId: string;
  bucket: string;
  bucketOwner: string;
  manifestKey: string;
  manifestVersionId: string;
  manifestSha256: string;
}
export interface EnvironmentGenerationChild {
  tenantId: string;
  restoreId: string;
  sourceEpoch: number;
  sourceFenceRevision: number;
  capturedAtMs: number;
  verificationSha256: string;
  location: EnvironmentGenerationAssetPins;
}
export interface EnvironmentGenerationRecord {
  formatVersion: 1;
  pairId: string;
  environmentId: string;
  sourceDeploymentId: string;
  deploymentId: string;
  generationId: string;
  epoch: number;
  sourceEpoch: number;
  sourceFenceRevision: number;
  /** The reviewed aggregate sync/switch operation, not an individual tenant export operation. */
  sourceOperationId: string;
  sourcePlanSha256: string;
  inventory: EnvironmentInventory;
  children: EnvironmentGenerationChild[];
  digestSha256: string;
}
export interface EnvironmentDataLossAcceptance {
  sourceSyncOperationId: string;
  sourceSyncPlanSha256: string;
  maximumSnapshotAgeMs: number;
  acceptedAtMs: number;
}
export interface EnvironmentGenerationProof {
  generationId: string;
  digestSha256: string;
  acceptedDataLoss: EnvironmentDataLossAcceptance | null;
}
export interface EnvironmentSwitchOperation extends EnvironmentDrainRequest {
  state: 'draining' | 'verified' | 'promoted' | 'cancelled';
  drainRevision: number;
  drainedAtMs: number | null;
  generation: EnvironmentGenerationProof | null;
  promotedEpoch: number | null;
}
export interface EnvironmentAuthority {
  initialize(input: EnvironmentPairDefinition): Promise<EnvironmentAuthorityState>;
  get(pairId: string, environmentId: string): Promise<EnvironmentAuthorityState>;
  enter(permit: EnvironmentWritePermit): Promise<EnvironmentWritePermit>;
  complete(permit: EnvironmentWritePermit): Promise<void>;
  beginDrain(input: EnvironmentDrainRequest): Promise<EnvironmentSwitchOperation>;
  getOperation(input: EnvironmentOperationIdentity): Promise<EnvironmentSwitchOperation>;
  registerGeneration(input: EnvironmentGenerationRecord): Promise<void>;
  getGeneration(input: {
    pairId: string;
    environmentId: string;
    deploymentId: string;
    generationId: string;
    epoch: number;
  }): Promise<EnvironmentGenerationRecord>;
  verifyGeneration(
    input: EnvironmentOperationIdentity,
    proof: EnvironmentGenerationProof
  ): Promise<EnvironmentSwitchOperation>;
  promote(input: EnvironmentOperationIdentity): Promise<EnvironmentSwitchOperation>;
  cancelDrain(input: EnvironmentOperationIdentity): Promise<EnvironmentSwitchOperation>;
  getServingGeneration(input: {
    pairId: string;
    environmentId: string;
    deploymentId: string;
  }): Promise<EnvironmentGenerationRecord>;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
function fail(): never {
  return authorityFailure('environment_invalid');
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    fail();
}
function ids(...values: unknown[]) {
  if (values.some((value) => typeof value !== 'string' || !ID.test(value))) fail();
}
function positive(...values: unknown[]) {
  if (values.some((value) => !Number.isSafeInteger(value) || Number(value) < 1)) fail();
}
function fence(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail();
}
function hash(...values: unknown[]) {
  if (values.some((value) => typeof value !== 'string' || !HASH.test(value))) fail();
}
function origin(value: unknown) {
  if (typeof value !== 'string') return fail();
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) fail();
}
export function assertEnvironmentPairDefinition(
  value: unknown
): asserts value is EnvironmentPairDefinition {
  object(value, [
    'pairId',
    'environmentId',
    'deployments',
    'initialOwnerDeploymentId',
    'initialGenerationId',
  ]);
  ids(value.pairId, value.environmentId, value.initialOwnerDeploymentId, value.initialGenerationId);
  if (!Array.isArray(value.deployments) || value.deployments.length !== 2) fail();
  for (const deployment of value.deployments) {
    object(deployment, ['deploymentId', 'provider']);
    ids(deployment.deploymentId);
    if (!['cloudflare', 'aws'].includes(String(deployment.provider))) fail();
  }
  const deployments = value.deployments as DeploymentIdentity[];
  if (
    deployments[0].deploymentId === deployments[1].deploymentId ||
    !deployments.some((item) => item.deploymentId === value.initialOwnerDeploymentId)
  )
    fail();
}
export function assertEnvironmentOperationIdentity(
  value: unknown
): asserts value is EnvironmentOperationIdentity {
  object(value, ['pairId', 'environmentId', 'operationId']);
  ids(value.pairId, value.environmentId, value.operationId);
}
export function assertEnvironmentDrainRequest(
  value: unknown
): asserts value is EnvironmentDrainRequest {
  object(value, [
    'pairId',
    'environmentId',
    'operationId',
    'kind',
    'sourceDeploymentId',
    'destinationDeploymentId',
    'expectedEpoch',
    'expectedRevision',
  ]);
  ids(
    value.pairId,
    value.environmentId,
    value.operationId,
    value.sourceDeploymentId,
    value.destinationDeploymentId
  );
  positive(value.expectedEpoch, value.expectedRevision);
  if (
    value.sourceDeploymentId === value.destinationDeploymentId ||
    !['planned', 'failover'].includes(String(value.kind))
  )
    fail();
}
export function assertEnvironmentWritePermit(
  value: unknown
): asserts value is EnvironmentWritePermit {
  const child =
    typeof value === 'object' && value !== null && ('tenantId' in value || 'restoreId' in value);
  object(value, [
    ...(child ? ['tenantId', 'restoreId'] : []),
    'pairId',
    'environmentId',
    'deploymentId',
    'epoch',
    'generationId',
    'permitId',
    'operationDigest',
  ]);
  ids(value.pairId, value.environmentId, value.deploymentId, value.generationId, value.permitId);
  positive(value.epoch);
  if (child) ids(value.tenantId, value.restoreId);
  hash(value.operationDigest);
}
export function assertEnvironmentInventory(value: unknown): asserts value is EnvironmentInventory {
  object(value, [
    'formatVersion',
    'environmentId',
    'sourceDeploymentId',
    'sourceEpoch',
    'sourceFenceRevision',
    'capturedAtMs',
    'sourceReceiptSha256',
    'complete',
    'tenants',
  ]);
  ids(value.environmentId, value.sourceDeploymentId);
  positive(value.sourceEpoch, value.capturedAtMs);
  fence(value.sourceFenceRevision);
  hash(value.sourceReceiptSha256);
  if (
    value.formatVersion !== 1 ||
    value.complete !== true ||
    !Array.isArray(value.tenants) ||
    value.tenants.length < 1 ||
    value.tenants.length > ENVIRONMENT_REPLICATION_MAX_TENANTS
  )
    fail();
  const seen = new Set<string>();
  const issuers = new Set<string>();
  let previous = '';
  for (const tenant of value.tenants) {
    object(tenant, ['tenantId', 'issuer', 'lifecycle']);
    ids(tenant.tenantId);
    origin(tenant.issuer);
    const id = String(tenant.tenantId);
    const issuer = String(tenant.issuer);
    if (
      tenant.lifecycle !== 'active' ||
      seen.has(id) ||
      issuers.has(issuer) ||
      (previous && previous >= id)
    )
      fail();
    seen.add(id);
    issuers.add(issuer);
    previous = id;
  }
}
export function assertEnvironmentGenerationProof(
  value: unknown
): asserts value is EnvironmentGenerationProof {
  object(value, ['generationId', 'digestSha256', 'acceptedDataLoss']);
  ids(value.generationId);
  hash(value.digestSha256);
  if (value.acceptedDataLoss !== null) {
    object(value.acceptedDataLoss, [
      'sourceSyncOperationId',
      'sourceSyncPlanSha256',
      'maximumSnapshotAgeMs',
      'acceptedAtMs',
    ]);
    const a = value.acceptedDataLoss;
    ids(a.sourceSyncOperationId);
    hash(a.sourceSyncPlanSha256);
    positive(a.maximumSnapshotAgeMs, a.acceptedAtMs);
    if (Number(a.maximumSnapshotAgeMs) > 30 * 86400_000) fail();
  }
}
/** Structural validation plus complete exact tenant coverage; runtime validates cloud asset pin syntax. */
export function assertEnvironmentGenerationRecord(
  value: unknown
): asserts value is EnvironmentGenerationRecord {
  object(value, [
    'formatVersion',
    'pairId',
    'environmentId',
    'sourceDeploymentId',
    'deploymentId',
    'generationId',
    'epoch',
    'sourceEpoch',
    'sourceFenceRevision',
    'sourceOperationId',
    'sourcePlanSha256',
    'inventory',
    'children',
    'digestSha256',
  ]);
  ids(
    value.pairId,
    value.environmentId,
    value.sourceDeploymentId,
    value.deploymentId,
    value.generationId,
    value.sourceOperationId
  );
  positive(value.epoch, value.sourceEpoch);
  fence(value.sourceFenceRevision);
  hash(value.sourcePlanSha256, value.digestSha256);
  assertEnvironmentInventory(value.inventory);
  if (
    value.formatVersion !== 1 ||
    value.sourceDeploymentId === value.deploymentId ||
    Number(value.epoch) !== Number(value.sourceEpoch) + 1 ||
    value.inventory.environmentId !== value.environmentId ||
    value.inventory.sourceDeploymentId !== value.sourceDeploymentId ||
    value.inventory.sourceEpoch !== value.sourceEpoch ||
    value.inventory.sourceFenceRevision !== value.sourceFenceRevision ||
    !Array.isArray(value.children) ||
    value.children.length !== value.inventory.tenants.length
  )
    fail();
  const restores = new Set<string>();
  for (let index = 0; index < value.children.length; index++) {
    const child: unknown = value.children[index];
    object(child, [
      'tenantId',
      'restoreId',
      'sourceEpoch',
      'sourceFenceRevision',
      'capturedAtMs',
      'verificationSha256',
      'location',
    ]);
    ids(child.tenantId, child.restoreId);
    positive(child.sourceEpoch, child.capturedAtMs);
    fence(child.sourceFenceRevision);
    hash(child.verificationSha256);
    if (
      child.tenantId !== value.inventory.tenants[index].tenantId ||
      child.sourceEpoch !== value.sourceEpoch ||
      child.sourceFenceRevision !== value.sourceFenceRevision ||
      restores.has(String(child.restoreId))
    )
      fail();
    restores.add(String(child.restoreId));
    object(child.location, [
      'region',
      'issuerOrigin',
      'secretArn',
      'secretVersionId',
      'bucket',
      'bucketOwner',
      'manifestKey',
      'manifestVersionId',
      'manifestSha256',
    ]);
    if (
      Object.values(child.location).some((item) => typeof item !== 'string' || !item) ||
      child.location.issuerOrigin !== value.inventory.tenants[index].issuer
    )
      fail();
    hash(child.location.manifestSha256);
  }
}
export async function environmentGenerationDigest(
  value: Omit<EnvironmentGenerationRecord, 'digestSha256'>
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(authorityCanonicalJson(value))
  );
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function verifyEnvironmentGenerationDigest(
  value: EnvironmentGenerationRecord
): Promise<void> {
  assertEnvironmentGenerationRecord(value);
  const { digestSha256, ...body } = value;
  if ((await environmentGenerationDigest(body)) !== digestSha256) fail();
}
