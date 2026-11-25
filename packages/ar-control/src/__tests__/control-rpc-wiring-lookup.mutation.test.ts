import { describe, expect, it, vi } from 'vitest';
import { defineWiringSuite, useWiringEnvironment } from './support/rpc-wiring-suite';
import { LOOKUP_ROWS } from './support/lookup-wiring-rows';

const recorder = vi.hoisted(() => () => import('./support/control-rpc-recorder'));
vi.mock('../service', async (orig) =>
  (await recorder()).partial(await orig(), { ControlService: [] })
);
vi.mock('../lookup-hmac-key-state', async (orig) =>
  (await recorder()).partial(await orig(), { LookupHmacKeyStateService: [] })
);
vi.mock('../lookup-hmac-key-state-publisher', async (orig) =>
  (await recorder()).partial(await orig(), { LookupHmacKeyStatePublisher: [] })
);
vi.mock('../lookup-hmac-candidate-verifier', async (orig) =>
  (await recorder()).partial(await orig(), { D1LookupHmacCandidateVerificationRepository: [] })
);
vi.mock('../lookup-bucket-migration', async (orig) =>
  (await recorder()).partial(await orig(), { LookupBucketMigrationService: [] })
);
vi.mock('../lookup-retention-projection', async (orig) =>
  (await recorder()).partial(await orig(), { LookupRetentionProjectionService: [] })
);
vi.mock('../read-replication', async (orig) =>
  (await recorder()).partial(await orig(), { ReadReplicationService: [] })
);
vi.mock('../service-site-binding', async (orig) =>
  (await recorder()).partial(await orig(), { ServiceSiteBindingService: [] })
);
vi.mock('../control-api-clients', async () => {
  const { fn: recorded } = await recorder();
  return {
    createControlApiClients: (...args: unknown[]) => recorded('createControlApiClients')(...args),
  };
});

useWiringEnvironment();
defineWiringSuite('Control lookup RPC', LOOKUP_ROWS);

describe('wiring table coverage', () => {
  it('lists every lookup, HMAC rotation, retention and replication RPC exactly once', () => {
    const expected = [
      'initializeLookupHmacKeyState',
      'startLookupHmacRotation',
      'getLookupHmacRotation',
      'getLookupHmacVerificationStatus',
      'activateLookupHmacRotation',
      'observeLookupHmacRotationGeneration',
      'claimNextLookupHmacRotation',
      'checkpointLookupHmacRotation',
      'getNextLookupHmacRotationSource',
      'checkpointLookupHmacRotationSource',
      'beginLookupHmacRotationVerification',
      'getNextLookupHmacRotationVerificationShard',
      'checkpointLookupHmacRotationVerificationShard',
      'finalizeLookupHmacRotationVerification',
      'recordLookupHmacRotationVerification',
      'completeLookupHmacRotationGrace',
      'startLookupBucketMigration',
      'claimLookupBucketMigration',
      'claimNextLookupBucketMigration',
      'checkpointLookupBucketMigration',
      'releaseLookupBucketMigration',
      'completeLookupBucketMigration',
      'blockLookupBucketMigration',
      'planNextLookupBucketMigration',
      'getLookupBucketWriteRoute',
      'resolveLookupBucketRouteVersion',
      'applyLookupRetentionPolicyProjection',
      'applyAccountLegalHoldProjection',
      'getLookupRetentionProjectionStatus',
      'getReadReplicationStatus',
      'getServiceSiteBindingStatus',
    ];
    const listed = LOOKUP_ROWS.map((row) => row.rpc);
    expect([...listed].sort()).toEqual([...expected].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });
});
