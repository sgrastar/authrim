import { deriveAwsStateSourceExpectations } from './state-source-expectations';
export { deriveAwsStateSourceExpectations } from './state-source-expectations';
import { Client, Pool } from 'pg';
import { PostgresAdapter } from '@authrim/ar-lib-core';
import type { LookupBlindIndexKey } from '@authrim/ar-lib-core/services/lookup-directory/blind-index';
import { createPostgresAuditRuntimePorts } from '../storage/postgres-audit';
import {
  assertAwsRuntimeSchemaReady,
  bootstrapFreshAwsRuntimeSchema,
} from './aws-schema-bootstrap';
import { openVerifiedTenantBackupV2, type OpenVerifiedTenantBackupV2Input } from './backup-reader';
import {
  readPostgresFamilyStagingReceipt,
  restoreVerifiedPostgresFamily,
  verifyPostgresFamilyStagingRows,
} from './postgres-restore';
import { coordinateAwsRestore } from './restore-coordinator';
import { readVerifiedAwsSamlSupplement, restoreEvidenceDigest } from './restore-evidence';
import { assembleAwsSamlTenantFromBackup } from './runtime-assembly';
import { assertVerifiedAwsStateRestored, restoreVerifiedAwsState } from './state-restore';

export interface RestoreOfflineAwsSamlTenantInput {
  backup: OpenVerifiedTenantBackupV2Input;
  supplement: { path: string; expectedSha256: string };
  restoreId: string;
  core: { connectionString: string; targetId: string; bindingRefs: readonly string[] };
  pii: { connectionString: string; targetId: string; bindingRefs: readonly string[] };
  state: { connectionString: string; initializeEmptySchema: boolean };
  environmentName: string;
  spEntityIds: readonly string[];
  allocationScope: 'shared_pool' | 'tenant_exclusive';
  awsFlowRuntimeHmacSecret: string;
  awsLookupReadKeys: readonly LookupBlindIndexKey[];
}

function invalid(): never {
  throw new Error('aws_offline_restore_invalid');
}

async function databaseIdentity(connectionString: string): Promise<string> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query<{ identity: string; schema: string }>(
      `SELECT json_build_array(current_database(), inet_server_addr(), inet_server_port())::text AS identity,
              current_schema() AS schema`
    );
    if (result.rows.length !== 1 || result.rows[0].schema !== 'public') invalid();
    return result.rows[0].identity;
  } finally {
    await client.end();
  }
}

function adapters(refs: readonly string[], db: PostgresAdapter): Record<string, PostgresAdapter> {
  if (
    !Array.isArray(refs as unknown) ||
    refs.length === 0 ||
    new Set(refs).size !== refs.length ||
    refs.some((ref) => !ref || typeof ref !== 'string')
  )
    invalid();
  return Object.fromEntries(refs.map((ref) => [ref, db]));
}

/** Offline orchestration: no Cloudflare/AWS API calls and no implicit schema migration. */
export async function restoreOfflineAwsSamlTenant(input: RestoreOfflineAwsSamlTenantInput) {
  try {
    return await restoreOfflineAwsSamlTenantInternal(input);
  } catch {
    throw new Error('aws_offline_restore_failed');
  }
}

async function restoreOfflineAwsSamlTenantInternal(input: RestoreOfflineAwsSamlTenantInput) {
  // Snapshot mutable caller policy before opening files or databases.
  const plan = structuredClone({ ...input, backup: { ...input.backup, signal: undefined } });
  const backup = await openVerifiedTenantBackupV2({ ...plan.backup, signal: input.backup.signal });
  const cleanup: Array<() => Promise<void>> = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled(cleanup.map((release) => release()));
  };
  try {
    const stateDb = new Pool({ connectionString: plan.state.connectionString, max: 4 });
    cleanup.push(() => stateDb.end());
    const coreDb = new PostgresAdapter({ connectionString: plan.core.connectionString });
    cleanup.push(() => coreDb.close());
    const piiDb = new PostgresAdapter({ connectionString: plan.pii.connectionString });
    cleanup.push(() => piiDb.close());
    const supplement = await readVerifiedAwsSamlSupplement({
      ...plan.supplement,
      manifest: backup.manifest,
    });
    const bindings = {
      core: adapters(plan.core.bindingRefs, coreDb),
      pii: adapters(plan.pii.bindingRefs, piiDb),
    };
    const targets = await Promise.all(
      [plan.core.connectionString, plan.pii.connectionString, plan.state.connectionString].map(
        databaseIdentity
      )
    );
    if (new Set(targets).size !== 3 || plan.core.targetId === plan.pii.targetId) invalid();
    if (plan.state.initializeEmptySchema) await bootstrapFreshAwsRuntimeSchema(stateDb);
    await assertAwsRuntimeSchemaReady(stateDb);
    const tenantId = backup.manifest.source.tenantId;
    const restored = await coordinateAwsRestore({
      stateDb,
      restoreId: plan.restoreId,
      source: {
        tenantId,
        issuer: backup.manifest.source.issuer,
        bundleId: backup.manifest.bundleId,
        snapshotId: backup.manifest.snapshotId,
        inventoryDigestSha256: backup.manifest.inventoryDigestSha256,
        boundaryUnixMs: backup.manifest.boundaryUnixMs,
        maxSnapshotAgeMs: plan.backup.maxSnapshotAgeMs,
        backupReceiptSha256: restoreEvidenceDigest(plan.backup.receipt),
        supplementFileSha256: plan.supplement.expectedSha256,
      },
      stage: async () => {
        const core = await restoreVerifiedPostgresFamily({
          backup,
          family: 'core',
          tenantId,
          ...plan.core,
          supplementalRows: {
            'core.oauth_clients': [supplement.sourceLoginUi.client],
            'core.web_origin_registry': supplement.sourceLoginUi.origins,
          },
        });
        const pii = await restoreVerifiedPostgresFamily({
          backup,
          family: 'pii',
          tenantId,
          ...plan.pii,
        });
        const stateInput: Parameters<typeof restoreVerifiedAwsState>[0] = {
          manifest: backup.manifest,
          supplement: supplement.state,
          expected: await deriveAwsStateSourceExpectations(backup),
          connection: {
            withDedicatedConnection: async (run) => {
              const client = await stateDb.connect();
              try {
                return await run(client);
              } finally {
                client.release();
              }
            },
          },
        };
        const state = await restoreVerifiedAwsState(stateInput);
        const assertCommittedTargets = async () => {
          const [observedCore, observedPii] = await Promise.all([
            readPostgresFamilyStagingReceipt(plan.core),
            readPostgresFamilyStagingReceipt(plan.pii),
          ]);
          if (
            restoreEvidenceDigest(observedCore) !== restoreEvidenceDigest(core) ||
            restoreEvidenceDigest(observedPii) !== restoreEvidenceDigest(pii)
          )
            invalid();
        };
        return {
          committed: {
            coreTargetId: core.targetId,
            piiTargetId: pii.targetId,
            coreReceiptSha256: restoreEvidenceDigest(core),
            piiReceiptSha256: restoreEvidenceDigest(pii),
            stateReceiptSha256: restoreEvidenceDigest(state),
            configurationSha256: restoreEvidenceDigest({
              environmentName: plan.environmentName,
              spEntityIds: plan.spEntityIds,
              allocationScope: plan.allocationScope,
              coreBindingRefs: plan.core.bindingRefs,
              piiBindingRefs: plan.pii.bindingRefs,
              awsLookupReadKeys: plan.awsLookupReadKeys,
              awsFlowRuntimeHmacSecret: plan.awsFlowRuntimeHmacSecret,
            }),
          },
          assertCommittedTargets,
          assertStagingComplete: async () => {
            await Promise.all([
              verifyPostgresFamilyStagingRows(plan.core),
              verifyPostgresFamilyStagingRows(plan.pii),
              assertVerifiedAwsStateRestored({ ...stateInput, receipt: state }),
            ]);
            // Closing rechecks the pinned input files. Do this before publication so a
            // replaced artifact cannot leave an active import behind an unsuccessful return.
            await backup.close();
          },
          createRuntime: (assertSnapshotReady: () => Promise<void>) =>
            assembleAwsSamlTenantFromBackup({
              backup,
              supplement,
              restored: {
                metadataCoreDb: coreDb,
                accountCoreByBindingRef: bindings.core,
                accountPiiByBindingRef: bindings.pii,
                stateDb,
                committed: { core, pii, state },
              },
              environmentName: plan.environmentName,
              spEntityIds: plan.spEntityIds,
              allocationScope: plan.allocationScope,
              auditPorts: createPostgresAuditRuntimePorts(stateDb, [tenantId]),
              awsFlowRuntimeHmacSecret: plan.awsFlowRuntimeHmacSecret,
              awsLookupReadKeys: plan.awsLookupReadKeys,
              assertSnapshotReady,
            }),
        };
      },
    });
    return { ...restored, close };
  } catch {
    await close();
    throw new Error('aws_offline_restore_failed');
  } finally {
    await backup.close().catch(() => undefined);
  }
}
