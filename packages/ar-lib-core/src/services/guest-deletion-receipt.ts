import { isValidPersistedUserId } from '../utils/persisted-user-id';
import {
  validateAccountRouteProjection,
  type AccountRouteProjection,
  type TenantRouteTarget,
} from './control-plane/control-plane-contracts';

export interface GuestPhysicalPinV2 {
  databaseId: string;
  bindingRef: string;
  dataRole: 'tenant_core/users' | 'tenant_pii';
  residencyPartition: string;
  shardId: string;
  assignmentGeneration: number;
  bindingRouteGeneration: number;
}
export interface GuestDeletionReceiptV2 {
  schemaVersion: 2;
  tenantId: string;
  accountId: string;
  userId: string;
  operationId: string;
  accountRouteGeneration: number;
  routeProjection: AccountRouteProjection;
  corePin: GuestPhysicalPinV2;
  piiPin: GuestPhysicalPinV2;
  completionAuditMode: 'outbox';
  completionAuditId: string;
  origin: 'admin' | 'retention';
  execution: {
    phase: 'accepted' | 'erasure_started';
    boundaryId: string | null;
    erasureStartedAtMs: number | null;
  };
}
/** Positive source evidence passed only after same-Core primary/owner/task verification. */
export interface GuestErasureSourceReceipt {
  tenantId: string;
  accountId: string;
  userId: string;
  accountRouteGeneration: number;
  operationId: string;
  boundaryId: string;
  sourceStartedAtMs: number;
  piiPin: GuestPhysicalPinV2;
}
export interface GuestErasureDrainReceipt extends GuestErasureSourceReceipt {
  preparedComplete: true;
}
export interface GuestErasureCompletionReceipt extends GuestErasureDrainReceipt {
  coreCompleted: true;
}
export interface GuestDeletionReceiptExpected {
  tenantId: string;
  userId: string;
  accountId?: string;
  operationId?: string;
  acceptedOnly?: boolean;
}
const rejected = (): never => {
  throw new Error('guest_deletion_route_unverified');
};
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return rejected();
  const result = value as Record<string, unknown>;
  if (
    Object.keys(result).length !== keys.length ||
    Object.keys(result).some((key) => !keys.includes(key))
  )
    return rejected();
  return result;
}
function text(value: unknown, max = 256): string {
  if (
    typeof value !== 'string' ||
    !value ||
    new TextEncoder().encode(value).length > max ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return rejected();
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return rejected();
  return value;
}
export function parseGuestPhysicalPinV2(
  value: unknown,
  role: GuestPhysicalPinV2['dataRole']
): GuestPhysicalPinV2 {
  const pin = record(value, [
    'databaseId',
    'bindingRef',
    'dataRole',
    'residencyPartition',
    'shardId',
    'assignmentGeneration',
    'bindingRouteGeneration',
  ]);
  const bindingRef = text(pin.bindingRef, 128);
  if (pin.dataRole !== role || !/^[A-Z][A-Z0-9_]*$/u.test(bindingRef)) return rejected();
  return {
    databaseId: text(pin.databaseId),
    bindingRef,
    dataRole: role,
    residencyPartition: text(pin.residencyPartition, 63),
    shardId: text(pin.shardId, 128),
    assignmentGeneration: positive(pin.assignmentGeneration),
    bindingRouteGeneration: positive(pin.bindingRouteGeneration),
  };
}
function projection(value: unknown): AccountRouteProjection {
  const input = record(value, [
    'schemaVersion',
    'accountRouteGeneration',
    'residencyPolicyId',
    'targets',
  ]);
  if (input.schemaVersion !== 1 || !Array.isArray(input.targets) || input.targets.length !== 2)
    return rejected();
  const targets: TenantRouteTarget[] = input.targets.map((item: unknown) => {
    const target = record(item, [
      'dataRole',
      'residencyPartition',
      'shardId',
      'bindingRef',
      'requiredBindingRouteGeneration',
    ]);
    if (target.dataRole !== 'tenant_core/users' && target.dataRole !== 'tenant_pii')
      return rejected();
    return {
      dataRole: target.dataRole,
      residencyPartition: text(target.residencyPartition, 63),
      shardId: text(target.shardId, 128),
      bindingRef: text(target.bindingRef, 128),
      requiredBindingRouteGeneration: positive(target.requiredBindingRouteGeneration),
    };
  });
  try {
    return validateAccountRouteProjection({
      schemaVersion: 1,
      accountRouteGeneration: positive(input.accountRouteGeneration),
      residencyPolicyId: text(input.residencyPolicyId),
      targets,
    });
  } catch {
    return rejected();
  }
}
/** A pure decoder; saved pins never substitute for fresh signed registry/owner checks. */
export function parseGuestDeletionReceiptV2(
  json: string | null,
  expected: GuestDeletionReceiptExpected
): GuestDeletionReceiptV2 {
  if (
    typeof json !== 'string' ||
    json.length > 16384 ||
    new TextEncoder().encode(json).length > 16384
  )
    return rejected();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return rejected();
  }
  const value = record(parsed, [
    'schemaVersion',
    'tenantId',
    'accountId',
    'userId',
    'operationId',
    'accountRouteGeneration',
    'routeProjection',
    'corePin',
    'piiPin',
    'completionAuditMode',
    'completionAuditId',
    'origin',
    'execution',
  ]);
  const tenantId = text(value.tenantId),
    accountId = text(value.accountId),
    userId = text(value.userId),
    operationId = text(value.operationId);
  if (
    value.schemaVersion !== 2 ||
    tenantId !== expected.tenantId ||
    userId !== expected.userId ||
    !isValidPersistedUserId(userId) ||
    (expected.accountId !== undefined && accountId !== expected.accountId) ||
    (expected.operationId !== undefined && operationId !== expected.operationId) ||
    value.completionAuditMode !== 'outbox' ||
    (value.origin !== 'admin' && value.origin !== 'retention')
  )
    return rejected();
  const accountRouteGeneration = positive(value.accountRouteGeneration);
  const corePin = parseGuestPhysicalPinV2(value.corePin, 'tenant_core/users'),
    piiPin = parseGuestPhysicalPinV2(value.piiPin, 'tenant_pii');
  const routeProjection = projection(value.routeProjection);
  if (
    corePin.residencyPartition !== piiPin.residencyPartition ||
    routeProjection.accountRouteGeneration !== accountRouteGeneration
  )
    return rejected();
  for (const pin of [corePin, piiPin]) {
    const targets = routeProjection.targets.filter((target) => target.dataRole === pin.dataRole);
    if (targets.length !== 1) return rejected();
    const target = targets[0];
    if (
      target.bindingRef !== pin.bindingRef ||
      target.shardId !== pin.shardId ||
      target.residencyPartition !== pin.residencyPartition ||
      target.requiredBindingRouteGeneration > pin.bindingRouteGeneration
    )
      return rejected();
  }
  const execution = record(value.execution, ['phase', 'boundaryId', 'erasureStartedAtMs']);
  let phase: GuestDeletionReceiptV2['execution'];
  if (execution.phase === 'accepted') {
    if (execution.boundaryId !== null || execution.erasureStartedAtMs !== null) return rejected();
    phase = { phase: 'accepted', boundaryId: null, erasureStartedAtMs: null };
  } else if (execution.phase === 'erasure_started' && !expected.acceptedOnly) {
    phase = {
      phase: 'erasure_started',
      boundaryId: text(execution.boundaryId),
      erasureStartedAtMs: positive(execution.erasureStartedAtMs),
    };
  } else return rejected();
  return {
    schemaVersion: 2,
    tenantId,
    accountId,
    userId,
    operationId,
    accountRouteGeneration,
    routeProjection,
    corePin,
    piiPin,
    completionAuditMode: 'outbox',
    completionAuditId: text(value.completionAuditId),
    origin: value.origin,
    execution: phase,
  };
}
export async function guestErasureBoundaryId(operationId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(['authrim-guest-erasure-start', 2, text(operationId)]))
  );
  return `guest-erasure:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Bind bounded directory pages to this immutable deletion, without persisting raw identifiers. */
export async function guestDirectoryRemovalOperationPrefix(
  route: Pick<GuestDeletionReceiptV2, 'tenantId' | 'operationId'>
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify(['guest-directory-removal', 2, text(route.tenantId), text(route.operationId)])
    )
  );
  const suffix = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
  return `guest-removal:${suffix}:`;
}

/** Validated projections compare by fields; JSON object property order has no authority meaning. */
export function sameGuestRouteProjection(
  left: AccountRouteProjection,
  right: AccountRouteProjection
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.accountRouteGeneration === right.accountRouteGeneration &&
    left.residencyPolicyId === right.residencyPolicyId &&
    left.targets.length === right.targets.length &&
    left.targets.every((target) =>
      right.targets.some(
        (other) =>
          target.dataRole === other.dataRole &&
          target.residencyPartition === other.residencyPartition &&
          target.shardId === other.shardId &&
          target.bindingRef === other.bindingRef &&
          target.requiredBindingRouteGeneration === other.requiredBindingRouteGeneration
      )
    )
  );
}
