import {
  buildIssuerUrl,
  requireDedicatedAdminDatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { buildCanonicalTenantIssuerUrl } from '@authrim/ar-lib-core/services/tenant-vanity-domain-resolver';
import {
  resolveBackupTenantDatabaseResources,
  backupDatabaseResourceDescriptor,
} from '@authrim/ar-lib-core/services/tenant-portability/database-resources';
import { TenantBackupRequestStore } from '@authrim/ar-lib-core/services/tenant-portability/operation-request';
import { createTenantBackupBoundaryRpcClient } from '@authrim/ar-lib-core/services/tenant-portability/boundary-rpc-client';
import { sqliteBoundaryClockParameter } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-boundary-clock';
import {
  assertSamlDrWriterCoverage,
  runSamlDrHeldTenantOperation,
} from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer';
import { assertGuestCoreErasureAdmission } from '@authrim/ar-lib-core/services/guest-core-erasure-admission';
import { createGuestPiiErasurePort } from '@authrim/ar-lib-core/services/guest-pii-erasure';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { GuestCurrentDenyWitness } from '@authrim/ar-lib-core/services/tenant-portability/guest-current-deny-witness';
import type { GuestRestoreAuthoritySource } from './tenant-backup-guest-authority';

async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function blocked(): never {
  throw new Error('backup_guest_current_deny_authority_unavailable');
}

/** Same-environment, authenticated live authority; uploaded manifests and empty targets are not proof. */
export function createProductionGuestRestoreAuthority(
  env: Env,
  now: () => number,
  durableContext: () => TenantBackupStepContext
) {
  const admin = () => requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup-guest-authority');
  const requests = () => new TenantBackupRequestStore(admin());
  async function authorize(context: TenantBackupStepContext) {
    context.signal.throwIfAborted();
    // Dataset executors use a synthetic phase/cursor while one durable scheduler step runs.
    // Their authority stays bound to the original leased operation, never that inner cursor.
    const durable = durableContext();
    if (
      context.signal !== durable.signal ||
      context.operation.kind !== 'import' ||
      context.operation.state !== 'running' ||
      durable.operation.kind !== 'import' ||
      durable.operation.state !== 'running' ||
      context.operation.revision !== durable.operation.revision ||
      context.lease.tenantId !== durable.lease.tenantId ||
      context.lease.operationId !== durable.lease.operationId ||
      context.lease.owner !== durable.lease.owner ||
      context.lease.fencingToken !== durable.lease.fencingToken
    )
      blocked();
    const lease = { ...durable.lease },
      operation = { ...durable.operation };
    const live = await admin().queryOne(
      `SELECT 1 AS live FROM tenant_backup_operations WHERE tenant_id=? AND id=?
      AND kind='import' AND state='running' AND lease_owner=? AND fencing_token=? AND revision=? AND phase=?
      AND cursor_json IS ? AND lease_expires_at>${sqliteBoundaryClockParameter(true)}`,
      [
        lease.tenantId,
        lease.operationId,
        lease.owner,
        lease.fencingToken,
        operation.revision,
        operation.phase,
        operation.cursor_json,
        now(),
      ],
      { consistencyClass: 'primary_required' }
    );
    if (!live) blocked();
    context.signal.throwIfAborted();
  }
  async function enabled(context: TenantBackupStepContext) {
    await authorize(context);
    const selected = (await requests().load(context.lease.tenantId, context.lease.operationId))
      .selection.users;
    if (selected && env.ENABLE_SAML_DR_EXPORT !== 'true')
      throw new Error('backup_guest_strict_writer_admission_required');
    return selected;
  }
  async function source(context: TenantBackupStepContext): Promise<GuestRestoreAuthoritySource> {
    await authorize(context);
    const intent = await requests().load(context.lease.tenantId, context.lease.operationId);
    const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
    if (!environmentId || intent.source.tenantId !== context.lease.tenantId) blocked();
    const issuer = await buildCanonicalTenantIssuerUrl(
      env,
      context.lease.tenantId,
      buildIssuerUrl(env, context.lease.tenantId),
      { strict: true }
    );
    if (intent.source.issuer !== issuer)
      throw new Error('backup_guest_cross_environment_authority_unavailable');
    const resources = await resolveBackupTenantDatabaseResources(env, {
      tenantId: context.lease.tenantId,
      roles: ['tenant_core', 'tenant_pii'],
      signal: context.signal,
    });
    const generation = await admin().queryOne<{ generation: number }>(
      "SELECT generation FROM tenant_runtime_cache_generations WHERE tenant_id=? AND cache_namespace='runtime_registry'",
      [context.lease.tenantId],
      { consistencyClass: 'primary_required' }
    );
    if (!generation || resources.some((value) => value.runtimeGeneration !== generation.generation))
      blocked();
    const described = resources.map(backupDatabaseResourceDescriptor);
    const result: GuestRestoreAuthoritySource = {
      environmentId,
      issuer,
      inventoryDigest: await hash(JSON.stringify([environmentId, issuer, ...described])),
      resources: [],
    };
    for (const resource of resources) {
      if (
        resource.assignments.some(
          (value) => value.role === 'tenant_core' && value.dataRole === 'tenant_core/users'
        )
      ) {
        await assertGuestCoreErasureAdmission(resource.database);
        result.resources.push({
          id: resource.databaseId,
          family: 'core',
          database: resource.database,
        });
      }
      if (
        resource.assignments.some(
          (value) => value.role === 'tenant_pii' && value.dataRole === 'tenant_pii'
        )
      ) {
        const assignment =
          resource.assignments.find(
            (value) => value.role === 'tenant_pii' && value.dataRole === 'tenant_pii'
          ) ?? blocked();
        await createGuestPiiErasurePort(resource.database, {
          databaseId: resource.databaseId,
          bindingRef: assignment.bindingRef,
          dataRole: 'tenant_pii',
          residencyPartition: assignment.residencyPartition,
          shardId: assignment.shardId,
          assignmentGeneration: assignment.assignmentGeneration,
          bindingRouteGeneration: assignment.bindingRouteGeneration,
        }).tables();
        result.resources.push({
          id: resource.databaseId,
          family: 'pii',
          database: resource.database,
        });
      }
    }
    // The production restore map already requires one installed physical target per role.
    // A missing or newly empty owner is rejected by row admission, never inferred from a bundle.
    if (
      result.resources.filter((value) => value.family === 'core').length !== 1 ||
      result.resources.filter((value) => value.family === 'pii').length !== 1
    )
      blocked();
    await authorize(context);
    return result;
  }
  async function withHeldBoundary<T>(
    context: TenantBackupStepContext,
    witness: GuestCurrentDenyWitness,
    publish: (deadlineAt: number, assertHeld: () => Promise<void>, scopedEnv: Env) => Promise<T>
  ): Promise<T> {
    await authorize(context);
    if (env.ENABLE_SAML_DR_EXPORT !== 'true')
      throw new Error('backup_guest_strict_writer_admission_required');
    await assertSamlDrWriterCoverage(env, context.lease.tenantId, context.signal);
    const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
    if (!environmentId || !env.CONTROL || witness.sourceEnvironmentId !== environmentId) blocked();
    // This is a mutation fence, not a snapshot. No synthetic snapshot/participant receipt is made.
    const identity = {
      environmentId,
      tenantId: context.lease.tenantId,
      operationId: context.lease.operationId,
      inventoryDigest: witness.inventoryDigest,
      boundaryId: await hash(
        JSON.stringify([
          'guest-restore-activation-v1',
          context.lease.operationId,
          context.lease.fencingToken,
          crypto.randomUUID(),
        ])
      ),
    };
    const client = createTenantBackupBoundaryRpcClient(env.CONTROL, identity);
    let begun = false;
    try {
      const boundary = await client.admission.begin({
        id: identity.boundaryId,
        tenantId: identity.tenantId,
        operationId: identity.operationId,
        inventoryDigest: identity.inventoryDigest,
        now: now(),
      });
      if (!boundary) blocked();
      begun = true;
      const held = await client.admission.hold(identity.tenantId, identity.boundaryId, now());
      if (!held || held.state !== 'held') throw new Error('backup_guest_source_mutations_pending');
      const assertHeld = async () => {
        await authorize(context);
        await client.receipts.assertHeld(identity, now());
      };
      await assertHeld();
      const result = await runSamlDrHeldTenantOperation(
        env,
        undefined,
        { tenantId: identity.tenantId, assertHeld },
        (scopedEnv) => publish(held.deadline_at, assertHeld, scopedEnv)
      );
      await assertHeld();
      return result;
    } finally {
      // Aborting a control-only fence releases it without claiming a captured snapshot.
      if (begun) await client.receipts.abort(identity, now());
    }
  }
  return { source, authorize, enabled, withHeldBoundary };
}
