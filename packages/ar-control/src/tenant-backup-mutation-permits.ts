import { TenantBackupMutationAdmission } from '@authrim/ar-lib-core/services/tenant-portability/mutation-admission';
import type { ControlEnv } from './types';

function request(value: unknown): { tenantId: string; permitId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_backup_mutation_permit');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    typeof input.tenantId !== 'string' ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.tenantId) ||
    typeof input.permitId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.permitId)
  )
    throw new Error('invalid_backup_mutation_permit');
  return { tenantId: input.tenantId, permitId: input.permitId };
}
export async function controlBackupIdentity(...parts: string[]): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)))
  );
  return Array.from(hash, (value) => value.toString(16).padStart(2, '0')).join('');
}

/** Called only after service-binding props authenticate the originating Worker/environment. */
export async function controlTenantMutationPermit(input: {
  database: ControlEnv['CONTROL_DB'];
  environmentId: string;
  caller: string;
  request: unknown;
  action: 'acquire' | 'complete';
  scope?: 'environment';
  now: number;
}): Promise<{ admitted: boolean } | void> {
  let value = input.request;
  if (input.scope === 'environment') {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !('permitId' in value)
    )
      throw new Error('invalid_backup_mutation_permit');
    value = { permitId: value.permitId, tenantId: '__environment__' };
  }
  const parsed = request(value);
  const tenant = await controlBackupIdentity(
    'authrim-mutation-tenant-v1',
    input.environmentId,
    parsed.tenantId
  );
  const permit = await controlBackupIdentity(
    input.scope === 'environment'
      ? 'authrim-mutation-environment-permit-v1'
      : 'authrim-mutation-permit-v1',
    input.environmentId,
    input.caller,
    parsed.tenantId,
    parsed.permitId
  );
  const database = input.database;
  const admission = new TenantBackupMutationAdmission(
    {
      async queryOne<T>(sql: string, params: unknown[] = []) {
        return database
          .prepare(sql)
          .bind(...params)
          .first<T>();
      },
      async execute(sql: string, params: unknown[] = []) {
        const result = await database
          .prepare(sql)
          .bind(...params)
          .run();
        return { success: result.success, rowsAffected: result.meta.changes ?? 0 };
      },
    },
    input.environmentId
  );
  if (input.scope === 'environment') {
    if (input.action === 'complete') {
      await admission.completeEnvironment(permit, input.now);
      return;
    }
    return { admitted: await admission.acquireEnvironment(permit, input.now) };
  }
  if (input.action === 'complete') {
    // Completion remains possible if placement metadata changes while a writer is in flight.
    await admission.complete(tenant, permit, input.now);
    return;
  }
  const registered = await database
    .prepare(
      'SELECT tenant_id FROM control_tenant_placement_policies WHERE environment_id=? AND tenant_id=?'
    )
    .bind(input.environmentId, parsed.tenantId)
    .first();
  if (!registered) throw new Error('invalid_backup_mutation_tenant');
  return { admitted: await admission.acquire(tenant, permit, input.now) };
}
