import type { WiringRow } from './rpc-wiring-table';

const KEY = { generation: 2, keyId: 'key-2', slot: 'B', fingerprint: 'a'.repeat(64) };
const MUTATION = { operationId: 'rot-1', ownerId: 'owner-1', fencingToken: 7 };
const BUCKET_MUTATION = { operationId: 'mig-1', ownerId: 'owner-1', fencingToken: 3 };
const PUBLISH = { call: 'LookupHmacKeyStatePublisher.publishEnvironment', args: ['env-1'] };
const hmac = (method: string) => ({
  call: `LookupHmacKeyStateService.${method}`,
  dbClasses: ['LookupHmacKeyStateService'],
  clock: { cls: 'LookupHmacKeyStateService', index: 1 },
});
const bucket = (method: string) => ({
  call: `LookupBucketMigrationService.${method}`,
  dbClasses: ['LookupBucketMigrationService'],
  clock: { cls: 'LookupBucketMigrationService', index: 1 },
});
const SNAPSHOT = {
  ownerId: 'owner-1',
  observedAt: 123,
  buckets: [
    {
      virtualBucket: 1,
      lookupShardId: 'lookup-a',
      assignmentGeneration: 1,
      activeIdentifierCount: 2,
      activeAliasCount: 3,
      successfulRoutePublicationCount: 4,
      publicationCounterUpdatedAt: 5,
      counterUpdatedAt: 6,
    },
  ],
};
const SOURCE_CHECKPOINT = {
  ...MUTATION,
  sourceKind: 'email_exact',
  shardId: 'shard-1',
  cursor: { after: 'x' },
  sourceRowCount: 9,
  complete: false,
};
const VERIFICATION_RESULT = {
  sourceShardsComplete: true,
  currentRowsValid: true,
  reservationsValid: false,
  routeReferencesValid: true,
};

export const LOOKUP_ROWS: readonly WiringRow[] = [
  {
    rpc: 'initializeLookupHmacKeyState',
    input: { current: KEY },
    ...hmac('initialize'),
    args: ['env-1', { current: KEY }],
    also: [PUBLISH],
  },
  {
    rpc: 'startLookupHmacRotation',
    input: { candidate: KEY, idempotencyKey: 'idem-1', ownerId: 'owner-1' },
    ...hmac('start'),
    args: ['env-1', { candidate: KEY, idempotencyKey: 'idem-1', ownerId: 'owner-1' }],
  },
  {
    rpc: 'getLookupHmacRotation',
    input: { operationId: 'rot-1' },
    ...hmac('getRotation'),
    args: ['env-1', 'rot-1'],
  },
  {
    rpc: 'activateLookupHmacRotation',
    input: MUTATION,
    ...hmac('activate'),
    args: ['env-1', MUTATION],
    also: [PUBLISH],
  },
  {
    rpc: 'observeLookupHmacRotationGeneration',
    input: MUTATION,
    ...hmac('observeGeneration'),
    args: ['env-1', MUTATION],
    also: [PUBLISH],
  },
  {
    rpc: 'claimNextLookupHmacRotation',
    input: { ownerId: 'owner-1' },
    ...hmac('claimNext'),
    args: ['env-1', 'owner-1'],
    also: [PUBLISH],
  },
  {
    rpc: 'checkpointLookupHmacRotation',
    input: { ...MUTATION, checkpoint: { c: 1 }, sourceRowCount: 4 },
    ...hmac('checkpoint'),
    args: ['env-1', { ...MUTATION, checkpoint: { c: 1 }, sourceRowCount: 4 }],
  },
  {
    rpc: 'getNextLookupHmacRotationSource',
    input: MUTATION,
    ...hmac('getNextSource'),
    args: ['env-1', MUTATION],
  },
  {
    rpc: 'checkpointLookupHmacRotationSource',
    input: SOURCE_CHECKPOINT,
    ...hmac('checkpointSource'),
    args: ['env-1', SOURCE_CHECKPOINT],
  },
  {
    rpc: 'beginLookupHmacRotationVerification',
    input: MUTATION,
    ...hmac('beginVerification'),
    args: ['env-1', MUTATION],
    also: [PUBLISH],
  },
  {
    rpc: 'getNextLookupHmacRotationVerificationShard',
    input: MUTATION,
    ...hmac('getNextVerificationShard'),
    args: ['env-1', MUTATION],
  },
  {
    rpc: 'checkpointLookupHmacRotationVerificationShard',
    input: {
      ...MUTATION,
      lookupShardId: 'lookup-a',
      cursor: { n: 1 },
      currentRowCount: 5,
      result: { currentRowsValid: true, reservationsValid: true, routeReferencesValid: false },
      complete: true,
    },
    ...hmac('checkpointVerificationShard'),
    args: [
      'env-1',
      {
        ...MUTATION,
        lookupShardId: 'lookup-a',
        cursor: { n: 1 },
        currentRowCount: 5,
        result: { currentRowsValid: true, reservationsValid: true, routeReferencesValid: false },
        complete: true,
      },
    ],
  },
  {
    rpc: 'finalizeLookupHmacRotationVerification',
    input: MUTATION,
    ...hmac('finalizeVerification'),
    args: ['env-1', MUTATION],
    also: [PUBLISH],
  },
  {
    rpc: 'recordLookupHmacRotationVerification',
    input: { ...MUTATION, currentRowCount: 8, result: VERIFICATION_RESULT },
    ...hmac('recordVerification'),
    args: ['env-1', { ...MUTATION, currentRowCount: 8, result: VERIFICATION_RESULT }],
    also: [PUBLISH],
  },
  {
    rpc: 'completeLookupHmacRotationGrace',
    input: MUTATION,
    ...hmac('completeGrace'),
    args: ['env-1', MUTATION],
    also: [PUBLISH],
  },
  {
    rpc: 'getLookupHmacVerificationStatus',
    input: { operationId: 'rot-1', phase: 'generation' },
    call: 'D1LookupHmacCandidateVerificationRepository.status',
    dbClasses: ['D1LookupHmacCandidateVerificationRepository'],
    args: ['env-1', 'rot-1', 'generation'],
  },
  {
    rpc: 'startLookupBucketMigration',
    input: {
      virtualBucket: 4,
      targetLookupShardId: 'lookup-b',
      idempotencyKey: 'idem-1',
      ownerId: 'owner-1',
    },
    ...bucket('start'),
    args: [
      'env-1',
      {
        virtualBucket: 4,
        targetLookupShardId: 'lookup-b',
        idempotencyKey: 'idem-1',
        ownerId: 'owner-1',
      },
    ],
  },
  {
    rpc: 'claimLookupBucketMigration',
    input: { operationId: 'mig-1', ownerId: 'owner-1' },
    ...bucket('claim'),
    args: ['env-1', { operationId: 'mig-1', ownerId: 'owner-1' }],
  },
  {
    rpc: 'claimNextLookupBucketMigration',
    input: { ownerId: 'owner-1' },
    ...bucket('claimNext'),
    args: ['env-1', 'owner-1'],
  },
  {
    rpc: 'checkpointLookupBucketMigration',
    input: {
      ...BUCKET_MUTATION,
      expectedState: 'a',
      nextState: 'b',
      backfillCursor: null,
      sourceRowCount: 1,
      targetRowCount: 2,
      verificationDigest: 'd',
    },
    ...bucket('checkpoint'),
    args: [
      'env-1',
      {
        ...BUCKET_MUTATION,
        expectedState: 'a',
        nextState: 'b',
        backfillCursor: null,
        sourceRowCount: 1,
        targetRowCount: 2,
        verificationDigest: 'd',
      },
    ],
  },
  {
    rpc: 'releaseLookupBucketMigration',
    input: BUCKET_MUTATION,
    ...bucket('release'),
    args: ['env-1', BUCKET_MUTATION],
  },
  {
    rpc: 'completeLookupBucketMigration',
    input: { ...BUCKET_MUTATION, oldRowsQuarantined: true },
    ...bucket('complete'),
    args: ['env-1', { ...BUCKET_MUTATION, oldRowsQuarantined: true }],
  },
  {
    rpc: 'blockLookupBucketMigration',
    input: { ...BUCKET_MUTATION, errorCode: 'lookup_bucket_x' },
    ...bucket('block'),
    args: ['env-1', { ...BUCKET_MUTATION, errorCode: 'lookup_bucket_x' }],
  },
  {
    rpc: 'planNextLookupBucketMigration',
    input: SNAPSHOT,
    ...bucket('planNextAutomaticMigration'),
    args: ['env-1', SNAPSHOT],
  },
  {
    rpc: 'getLookupBucketWriteRoute',
    input: { virtualBucket: 0 },
    ...bucket('writeRoute'),
    args: ['env-1', 0],
  },
  {
    rpc: 'resolveLookupBucketRouteVersion',
    input: { virtualBucket: 9, assignmentGeneration: 1 },
    ...bucket('resolveRouteVersion'),
    args: ['env-1', 9, 1],
  },
  {
    rpc: 'applyLookupRetentionPolicyProjection',
    input: { policy: 1 },
    call: 'LookupRetentionProjectionService.applyPolicy',
    clockMs: true,
    dbClasses: ['LookupRetentionProjectionService'],
    args: ['env-1', { policy: 1 }],
  },
  {
    rpc: 'applyAccountLegalHoldProjection',
    input: { hold: 1 },
    call: 'LookupRetentionProjectionService.applyLegalHold',
    clockMs: true,
    dbClasses: ['LookupRetentionProjectionService'],
    args: ['env-1', { hold: 1 }],
  },
  {
    rpc: 'getLookupRetentionProjectionStatus',
    input: { tenantId: 'tenant-1', accountId: 'acct-1' },
    call: 'LookupRetentionProjectionService.status',
    clockMs: true,
    dbClasses: ['LookupRetentionProjectionService'],
    args: ['env-1', 'tenant-1', 'acct-1'],
  },
  {
    rpc: 'getReadReplicationStatus',
    call: 'ReadReplicationService.getStatus',
    dbClasses: ['ReadReplicationService'],
    args: ['env-1'],
  },
  {
    rpc: 'getServiceSiteBindingStatus',
    call: 'ServiceSiteBindingService.getStatus',
    dbClasses: ['ServiceSiteBindingService'],
    clock: { cls: 'ServiceSiteBindingService', index: 1 },
    args: ['env-1'],
  },
];
