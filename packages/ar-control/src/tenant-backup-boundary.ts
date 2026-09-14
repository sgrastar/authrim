import { TenantBackupMutationAdmission } from '@authrim/ar-lib-core/services/tenant-portability/mutation-admission';
import { TenantBackupBoundaryReceipts } from '@authrim/ar-lib-core/services/tenant-portability/boundary-receipts';
import type {
  TenantBackupBoundaryRequest,
  TenantBackupBoundaryResponse,
} from '@authrim/ar-lib-core/services/tenant-portability/boundary-rpc-contract';
import { controlBackupIdentity } from './tenant-backup-mutation-permits';
import type { ControlEnv } from './types';

function participant(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).length === 2 &&
    [item.resourceId, item.snapshotId].every(
      (id) => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(id)
    )
  );
}
function request(value: unknown): TenantBackupBoundaryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_backup_boundary_request');
  const body = value as Record<string, unknown>;
  const list = body.action === 'plan' || body.action === 'readReleased';
  const ack = body.action === 'acknowledge';
  if (
    typeof body.action !== 'string' ||
    ![
      'begin',
      'hold',
      'release',
      'abort',
      'assertHeld',
      'plan',
      'readReleased',
      'acknowledge',
    ].includes(String(body.action)) ||
    Object.keys(body).length !== (list || ack ? 6 : 5) ||
    typeof body.tenantId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.tenantId) ||
    typeof body.operationId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(body.operationId) ||
    typeof body.boundaryId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(body.boundaryId) ||
    typeof body.inventoryDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(body.inventoryDigest) ||
    (list &&
      (!Array.isArray(body.participants) ||
        body.participants.length < 1 ||
        body.participants.length > 64 ||
        !body.participants.every(participant))) ||
    (ack && !participant(body.participant))
  )
    throw new Error('invalid_backup_boundary_request');
  return body as TenantBackupBoundaryRequest;
}

/** Entry point must authenticate service-binding props before calling this storage executor. */
export async function controlTenantBackupBoundary(input: {
  database: ControlEnv['CONTROL_DB'];
  environmentId: string;
  caller: string;
  request: unknown;
  /** Deterministic storage-test clock. Production entrypoints omit this field. */
  now?: number;
}): Promise<TenantBackupBoundaryResponse> {
  const parsed = request(input.request);
  const now = input.now ?? Date.now();
  const databaseClock = input.now === undefined;
  const tenant = await controlBackupIdentity(
    'authrim-mutation-tenant-v1',
    input.environmentId,
    parsed.tenantId
  );
  const boundaryId = await controlBackupIdentity(
    'authrim-backup-boundary-rpc-v1',
    input.environmentId,
    input.caller,
    parsed.boundaryId
  );
  const database = {
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return input.database
        .prepare(sql)
        .bind(...params)
        .first<T>();
    },
    async execute(sql: string, params: unknown[] = []) {
      const result = await input.database
        .prepare(sql)
        .bind(...params)
        .run();
      return { success: result.success, rowsAffected: result.meta.changes ?? 0 };
    },
  };
  const admission = new TenantBackupMutationAdmission(database, input.environmentId, databaseClock);
  const receipts = new TenantBackupBoundaryReceipts(database, databaseClock);
  const identity = {
    environmentId: input.environmentId,
    tenantId: tenant,
    boundaryId,
    operationId: parsed.operationId,
    inventoryDigest: parsed.inventoryDigest,
  };
  let boundary: TenantBackupBoundaryResponse['boundary'] = null;
  let accepted = false;
  switch (parsed.action) {
    case 'begin': {
      const registered = await input.database
        .prepare(
          'SELECT tenant_id FROM control_tenant_placement_policies WHERE environment_id=? AND tenant_id=?'
        )
        .bind(input.environmentId, parsed.tenantId)
        .first();
      if (!registered) throw new Error('invalid_backup_mutation_tenant');
      boundary = await admission.begin({
        id: boundaryId,
        tenantId: tenant,
        operationId: parsed.operationId,
        inventoryDigest: parsed.inventoryDigest,
        now,
      });
      break;
    }
    case 'plan':
      accepted = await receipts.plan(identity, parsed.participants, now);
      break;
    case 'hold': {
      // Do not let a different operation/digest hold an existing caller-scoped boundary.
      const matching = await database.queryOne(
        'SELECT id FROM tenant_backup_mutation_boundaries WHERE id=? AND tenant_id=? AND environment_id=? AND operation_id=? AND inventory_digest=?',
        [boundaryId, tenant, input.environmentId, parsed.operationId, parsed.inventoryDigest]
      );
      if (matching) boundary = await admission.hold(tenant, boundaryId, now);
      break;
    }
    case 'acknowledge':
      accepted = await receipts.acknowledge(identity, parsed.participant, now);
      break;
    case 'release':
      boundary = await receipts.release(identity, now);
      break;
    case 'abort':
      await receipts.abort(identity, now);
      accepted = true;
      break;
    case 'assertHeld':
      await receipts.assertHeld(identity, now);
      accepted = true;
      break;
    case 'readReleased':
      boundary = await receipts.readReleased(identity, parsed.participants, now);
      break;
  }
  if (boundary)
    return {
      environmentId: input.environmentId,
      boundary: { ...boundary, id: parsed.boundaryId, tenant_id: parsed.tenantId },
      accepted: true,
    };
  return { environmentId: input.environmentId, boundary: null, accepted };
}
