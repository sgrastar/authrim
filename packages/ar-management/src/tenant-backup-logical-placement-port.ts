import type { Env } from '@authrim/ar-lib-core';
import {
  encodePortableLogicalTargetPlan,
  type PortableLogicalTargetPlan,
} from '@authrim/ar-lib-core/services/tenant-portability/phase5-record-datasets';
import type { AdapterContext } from './tenant-backup-export-dispatcher';
import { createEncryptedTenantBackupRecordSnapshotPort } from './tenant-backup-record-snapshot-port';

const REQUIRED_DATABASE_ROLES = ['admin', 'tenant_core', 'tenant_pii'] as const;
const REBUILD_TARGETS = ['lookup-routing', 'plugin-runner-runtime', 'session-revocation'] as const;

function invalid(): never {
  throw new Error('backup_logical_placement_invalid');
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function installedPlan(context: AdapterContext): PortableLogicalTargetPlan {
  const roles = new Set(
    context.databases.tenant.flatMap((resource) =>
      resource.assignments.map((assignment) => assignment.role)
    )
  );
  if (
    !sameStrings([...roles], ['tenant_core', 'tenant_pii']) ||
    context.databases.fixed.length !== 1 ||
    context.databases.fixed[0]?.binding !== 'DB_ADMIN'
  )
    invalid();
  return {
    version: 1,
    databaseRoles: [...REQUIRED_DATABASE_ROLES],
    rebuild: [...REBUILD_TARGETS],
    externalPrerequisiteIds: [],
  };
}

function assertSupportedPlan(plan: PortableLogicalTargetPlan): void {
  if (
    plan.version !== 1 ||
    !sameStrings(plan.databaseRoles, REQUIRED_DATABASE_ROLES) ||
    !sameStrings(plan.rebuild, REBUILD_TARGETS) ||
    plan.externalPrerequisiteIds.length !== 0
  )
    invalid();
}

async function* capture(context: AdapterContext): AsyncIterable<Uint8Array> {
  context.context.signal.throwIfAborted();
  yield encodePortableLogicalTargetPlan(context.context.lease.tenantId, installedPlan(context));
}

/**
 * Carries logical roles only. The restore provisioner owns physical database, namespace and bucket
 * identities; runtime cursors and session state are rebuilt after activation.
 */
export function createTenantBackupLogicalPlacementPorts(
  env: Pick<
    Env,
    'EXPORT_ARTIFACTS' | 'OBJECT_ENCRYPTION_ROOT_KEY' | 'OBJECT_ENCRYPTION_KEY_VERSION'
  >
) {
  return {
    logicalPlacement: createEncryptedTenantBackupRecordSnapshotPort({
      env,
      resourceId: 'logical-placement:tenant',
      assertSource: async (context) => {
        installedPlan(context);
      },
      capture,
    }),
    async prepareLogicalTarget(
      context: { signal: AbortSignal },
      plan: PortableLogicalTargetPlan
    ): Promise<void> {
      context.signal.throwIfAborted();
      assertSupportedPlan(plan);
    },
    async verifyLogicalTarget(
      context: { signal: AbortSignal },
      plan: PortableLogicalTargetPlan
    ): Promise<boolean> {
      context.signal.throwIfAborted();
      assertSupportedPlan(plan);
      return true;
    },
  };
}
