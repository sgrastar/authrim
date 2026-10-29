/** Guest-only deletion receipts. Never expose physical pins in API/log data. */
import {
  GuestLifecycleRepository,
  assertGuestCoreErasureAdmission,
  resolveTenantDatabaseSourceFromRegistry,
  ensureDatabaseAdapter,
  type DatabaseAdapter,
  type Env,
  type ResolvedTenantDatabaseSource,
} from '@authrim/ar-lib-core';

export type GuestDeletionRouteV2 = ReturnType<typeof GuestLifecycleRepository.parseDeletionRouteV2>;
export type GuestPhysicalPin = GuestDeletionRouteV2['corePin'];
const invalid = () => new Error('guest_deletion_route_unverified');
export function parseGuestPhysicalPin(
  value: unknown,
  role: GuestPhysicalPin['dataRole']
): GuestPhysicalPin {
  return GuestLifecycleRepository.parsePhysicalPinV2(value, role);
}
export function guestPinFromSource(
  source: ResolvedTenantDatabaseSource,
  role: GuestPhysicalPin['dataRole']
): GuestPhysicalPin {
  return parseGuestPhysicalPin(
    {
      databaseId: source.registryRow?.database_id,
      bindingRef: source.bindingRef,
      dataRole: source.dataRole,
      residencyPartition: source.residencyPartition,
      shardId: source.shardId,
      assignmentGeneration: source.assignmentGeneration,
      bindingRouteGeneration: source.bindingRouteGeneration,
    },
    role
  );
}
export function sameGuestPin(left: GuestPhysicalPin, right: GuestPhysicalPin): boolean {
  return (
    left.databaseId === right.databaseId &&
    left.bindingRef === right.bindingRef &&
    left.dataRole === right.dataRole &&
    left.residencyPartition === right.residencyPartition &&
    left.shardId === right.shardId &&
    left.assignmentGeneration === right.assignmentGeneration &&
    left.bindingRouteGeneration === right.bindingRouteGeneration
  );
}
export function parseGuestDeletionRoute(
  json: string | null,
  expected: {
    tenantId: string;
    userId: string;
    operationId?: string;
    accountId?: string;
    acceptedOnly?: boolean;
  }
): GuestDeletionRouteV2 {
  return GuestLifecycleRepository.parseDeletionRouteV2(json, expected);
}
export { guestErasureBoundaryId } from '@authrim/ar-lib-core';
export function sameGuestDeletionIdentity(
  left: GuestDeletionRouteV2,
  right: GuestDeletionRouteV2
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.accountId === right.accountId &&
    left.userId === right.userId &&
    left.operationId === right.operationId &&
    left.accountRouteGeneration === right.accountRouteGeneration &&
    left.completionAuditId === right.completionAuditId &&
    left.origin === right.origin &&
    sameGuestPin(left.corePin, right.corePin) &&
    sameGuestPin(left.piiPin, right.piiPin) &&
    JSON.stringify(left.routeProjection) === JSON.stringify(right.routeProjection) &&
    !(left.execution.phase === 'erasure_started' && right.execution.phase !== 'erasure_started') &&
    (left.execution.phase !== 'erasure_started' ||
      (left.execution.boundaryId === right.execution.boundaryId &&
        left.execution.erasureStartedAtMs === right.execution.erasureStartedAtMs))
  );
}
export async function verifyGuestDeletionPins(
  env: Env,
  route: GuestDeletionRouteV2
): Promise<{ core: DatabaseAdapter; pii: DatabaseAdapter }> {
  const resolve = async (saved: GuestPhysicalPin) => {
    const source = await resolveTenantDatabaseSourceFromRegistry(env, {
      tenantId: route.tenantId,
      role: saved.dataRole === 'tenant_pii' ? 'tenant_pii' : 'tenant_core',
      dataRole: saved.dataRole,
      bindingRef: saved.bindingRef,
      residencyPartition: saved.residencyPartition,
      shardId: saved.shardId,
      requiredBindingRouteGeneration: saved.bindingRouteGeneration,
      memoryCacheTtlMs: 0,
      generationCacheTtlMs: 0,
    });
    if (
      source.tenantId !== route.tenantId ||
      source.residencyPolicyId !== route.routeProjection.residencyPolicyId ||
      !sameGuestPin(saved, guestPinFromSource(source, saved.dataRole))
    )
      throw invalid();
    return ensureDatabaseAdapter(source.source, 'guest-deletion');
  };
  const core = await resolve(route.corePin);
  const pii = await resolve(route.piiPin);
  if (core.getType() !== 'd1' || pii.getType() !== 'd1')
    throw new Error('guest_deletion_backend_unsupported');
  await assertGuestCoreErasureAdmission(core);
  return { core, pii };
}
