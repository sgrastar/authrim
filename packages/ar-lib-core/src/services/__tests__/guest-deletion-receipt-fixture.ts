import type { GuestDeletionReceiptV2 } from '../guest-deletion-receipt';

export const GUEST_TEST_TENANT = 'tenant-guest';
export const GUEST_TEST_USER = '10000000-0000-4000-8000-000000000001';
export const GUEST_TEST_ACCOUNT = '20000000-0000-4000-8000-000000000001';
export const GUEST_TEST_OPERATION = 'guest-delete:fixed-operation';
export function guestDeletionReceiptFixture(): GuestDeletionReceiptV2 {
  return {
    schemaVersion: 2,
    tenantId: GUEST_TEST_TENANT,
    userId: GUEST_TEST_USER,
    accountId: GUEST_TEST_ACCOUNT,
    operationId: GUEST_TEST_OPERATION,
    accountRouteGeneration: 1,
    completionAuditMode: 'outbox',
    completionAuditId: 'guest-delete:fixed-audit',
    origin: 'admin',
    corePin: {
      databaseId: 'physical-core',
      bindingRef: 'DB_USERS_A',
      dataRole: 'tenant_core/users',
      residencyPartition: 'region-a',
      shardId: 'users-a',
      assignmentGeneration: 1,
      bindingRouteGeneration: 1,
    },
    piiPin: {
      databaseId: 'physical-pii',
      bindingRef: 'DB_PII_A',
      dataRole: 'tenant_pii',
      residencyPartition: 'region-a',
      shardId: 'pii-a',
      assignmentGeneration: 1,
      bindingRouteGeneration: 1,
    },
    routeProjection: {
      schemaVersion: 1,
      accountRouteGeneration: 1,
      residencyPolicyId: 'residency:fixture',
      targets: [
        {
          dataRole: 'tenant_core/users',
          bindingRef: 'DB_USERS_A',
          shardId: 'users-a',
          residencyPartition: 'region-a',
          requiredBindingRouteGeneration: 1,
        },
        {
          dataRole: 'tenant_pii',
          bindingRef: 'DB_PII_A',
          shardId: 'pii-a',
          residencyPartition: 'region-a',
          requiredBindingRouteGeneration: 1,
        },
      ],
    },
    execution: { phase: 'accepted', boundaryId: null, erasureStartedAtMs: null },
  };
}
