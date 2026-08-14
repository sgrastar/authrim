import {
  verifyBootstrapAcceleratorProof,
  type BootstrapAcceleratorClaims,
} from '@authrim/ar-lib-core/control-plane';
import type { D1Result } from '@cloudflare/workers-types';
import { BootstrapHandoffVerifier, D1BootstrapHandoffRepository } from './bootstrap-handoff';
import { createControlApiClients } from './control-api-clients';
import { D1ControlRepository } from './repository';
import { ControlService } from './service';
import type { ControlEnv } from './types';
import { D1WorkerBindingRepository } from './worker-binding-repository';
import {
  WorkerBindingReconciler,
  type WorkerBindingReconcilerResult,
} from './worker-binding-reconciler';

const ACCELERATOR_LEASE_SECONDS = 60;

export type BootstrapAcceleratorAdmission =
  | { state: 'acquired'; claims: BootstrapAcceleratorClaims }
  | { state: 'busy' | 'inactive' | 'replayed' };

function changes(result: D1Result<unknown>): number {
  const value = result.meta?.changes;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function activeSmokePublicJwk(
  env: ControlEnv
): Parameters<typeof verifyBootstrapAcceleratorProof>[1]['publicJwk'] {
  const slot = env.SMOKE_RPC_SIGNING_ACTIVE_SLOT ?? 'A';
  const serialized =
    slot === 'A' ? env.SMOKE_RPC_SIGNING_JWK_SLOT_A : env.SMOKE_RPC_SIGNING_JWK_SLOT_B;
  if (!serialized) throw new Error('bootstrap_accelerator_active_key_missing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('bootstrap_accelerator_active_key_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('bootstrap_accelerator_active_key_invalid');
  }
  const privateJwk = parsed as Record<string, unknown>;
  const publicJwk = { ...privateJwk };
  Reflect.deleteProperty(publicJwk, 'd');
  return publicJwk as Parameters<typeof verifyBootstrapAcceleratorProof>[1]['publicJwk'];
}

export async function admitInitialBootstrapAcceleration(input: {
  env: ControlEnv;
  proof: string;
  now?: number;
}): Promise<BootstrapAcceleratorAdmission> {
  const environmentId = input.env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId) throw new Error('bootstrap_accelerator_environment_missing');
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const claims = await verifyBootstrapAcceleratorProof(input.proof, {
    environmentId,
    publicJwk: activeSmokePublicJwk(input.env),
    now,
  });

  await input.env.CONTROL_DB.prepare(
    `DELETE FROM control_bootstrap_accelerator_proofs
      WHERE environment_id = ? AND expires_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM control_bootstrap_accelerator_leases lease
           WHERE lease.environment_id = control_bootstrap_accelerator_proofs.environment_id
             AND lease.owner_jti = control_bootstrap_accelerator_proofs.jti
             AND lease.lease_expires_at > ?
        )`
  )
    .bind(environmentId, now, now)
    .run();

  const consumed = await input.env.CONTROL_DB.prepare(
    `INSERT INTO control_bootstrap_accelerator_proofs (
       environment_id, jti, expires_at, consumed_at
     )
     SELECT ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM control_bootstrap_handoffs
         WHERE environment_id = ? AND state IN ('creating', 'pending_verification')
      )
     ON CONFLICT(environment_id, jti) DO NOTHING`
  )
    .bind(environmentId, claims.jti, claims.exp, now, environmentId)
    .run();
  if (changes(consumed) !== 1) {
    const handoff = await input.env.CONTROL_DB.prepare(
      `SELECT state FROM control_bootstrap_handoffs WHERE environment_id = ?`
    )
      .bind(environmentId)
      .first<{ state: string }>();
    return handoff?.state === 'creating' || handoff?.state === 'pending_verification'
      ? { state: 'replayed' }
      : { state: 'inactive' };
  }

  const lease = await input.env.CONTROL_DB.prepare(
    `INSERT INTO control_bootstrap_accelerator_leases (
       environment_id, owner_jti, lease_expires_at, updated_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(environment_id) DO UPDATE SET
       owner_jti = excluded.owner_jti,
       lease_expires_at = excluded.lease_expires_at,
       updated_at = excluded.updated_at
     WHERE control_bootstrap_accelerator_leases.lease_expires_at <= ?`
  )
    .bind(environmentId, claims.jti, now + ACCELERATOR_LEASE_SECONDS, now, now)
    .run();
  return changes(lease) === 1 ? { state: 'acquired', claims } : { state: 'busy' };
}

export async function releaseInitialBootstrapAcceleration(input: {
  env: ControlEnv;
  claims: BootstrapAcceleratorClaims;
}): Promise<void> {
  await input.env.CONTROL_DB.prepare(
    `DELETE FROM control_bootstrap_accelerator_leases
      WHERE environment_id = ? AND owner_jti = ?`
  )
    .bind(input.claims.environmentId, input.claims.jti)
    .run();
}

export async function advanceInitialBootstrap(input: {
  env: ControlEnv;
  now?: () => number;
}): Promise<WorkerBindingReconcilerResult> {
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const environmentId = input.env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId) throw new Error('bootstrap_accelerator_environment_missing');
  const repository = new D1ControlRepository(input.env.CONTROL_DB);
  const automaticProvisioningReady =
    input.env.AUTHRIM_AUTOMATIC_PROVISIONING === 'true' &&
    Boolean(input.env.CLOUDFLARE_D1_API_TOKEN?.trim()) &&
    Boolean(input.env.CLOUDFLARE_WORKERS_API_TOKEN?.trim()) &&
    input.env.CLOUDFLARE_D1_API_TOKEN?.trim() !== input.env.CLOUDFLARE_WORKERS_API_TOKEN?.trim() &&
    (await repository.hasReadyAutomaticProvisioning());
  if (!automaticProvisioningReady) {
    throw new Error('bootstrap_accelerator_automatic_provisioning_unavailable');
  }
  if (repository.resumeAutomaticBootstrapOperations) {
    await repository.resumeAutomaticBootstrapOperations(environmentId, now());
  }
  const control = new ControlService({ repository, env: input.env, now });
  await control.reconcilePending();
  const apiClients = createControlApiClients(input.env);
  const result = await new WorkerBindingReconciler(
    new D1WorkerBindingRepository(input.env.CONTROL_DB),
    repository,
    apiClients.workers,
    input.env,
    now,
    true
  ).reconcile();
  await new BootstrapHandoffVerifier(
    new D1BootstrapHandoffRepository(input.env.CONTROL_DB),
    {
      getD1Database: (databaseId) => apiClients.d1.getD1Database(databaseId),
      queryD1Batch: (databaseId, queries) => apiClients.d1.queryD1Batch(databaseId, queries),
      getWorkerSettings: (scriptName) => apiClients.workers.getWorkerSettings(scriptName),
      listWorkerDeployments: (scriptName) => apiClients.workers.listWorkerDeployments(scriptName),
    },
    now
  ).reconcile(1);
  return result;
}
