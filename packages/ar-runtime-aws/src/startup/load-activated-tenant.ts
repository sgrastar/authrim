/** Reconstruct a published SAML IdP after a Lambda cold start without importing rows again. */
import { Client, Pool } from 'pg';
import { PostgresAdapter } from '@authrim/ar-lib-core';
import type { LookupBlindIndexKey } from '@authrim/ar-lib-core/services/lookup-directory/blind-index';
import { createPostgresAuditRuntimePorts } from '../storage/postgres-audit';
import { assertAwsRuntimeSchemaReady } from '../import/aws-schema-bootstrap';
import {
  openVerifiedTenantBackupV2,
  type OpenVerifiedTenantBackupV2Input,
} from '../import/backup-reader';
import {
  type PostgresFamilyRestoreReceipt,
  validatePostgresFamilyStagingReceiptRow,
} from '../import/postgres-restore';
import {
  assertAwsRestoreActivationReady,
  type AwsRestoreActivationEvidence,
} from '../import/restore-coordinator';
import { readVerifiedAwsSamlSupplement, restoreEvidenceDigest } from '../import/restore-evidence';
import { deriveAwsStateSourceExpectations } from '../import/restore-offline';
import { assembleAwsSamlTenantFromBackup } from '../import/runtime-assembly';
import {
  assertAwsLiveStateCompatible,
  awsStateSupplementPayloadSha256,
  type AwsStateRestoreReceipt,
} from '../import/state-restore';
import type { AwsTenantRuntime } from '../http-runtime';
import { verifyActivatedDatabaseRows } from './live-database-verification';

export interface LoadActivatedAwsSamlTenantInput {
  /** Trusted, independently pinned AUTHRIM2 receipt and local ciphertext files. */
  backup: OpenVerifiedTenantBackupV2Input;
  supplement: { path: string; expectedSha256: string };
  /** Trusted activation receipt, supplied from operator configuration, not from state DB alone. */
  evidence: AwsRestoreActivationEvidence;
  core: { connectionString: string; targetId: string; bindingRefs: readonly string[] };
  pii: { connectionString: string; targetId: string; bindingRefs: readonly string[] };
  state: { connectionString: string };
  environmentName: string;
  spEntityIds: readonly string[];
  allocationScope: 'shared_pool' | 'tenant_exclusive';
  awsFlowRuntimeHmacSecret: string;
  awsLookupReadKeys: readonly LookupBlindIndexKey[];
}

function invalid(): never {
  throw new Error('aws_activated_runtime_load_invalid');
}

function boundedClient(connectionString: string): Client {
  return new Client({ connectionString, connectionTimeoutMillis: 5_000 });
}

async function adapterClient(connectionString: string) {
  const client = boundedClient(connectionString);
  await client.connect();
  return {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
    },
    end: () => client.end(),
  };
}

async function databaseIdentity(connectionString: string): Promise<string> {
  const client = boundedClient(connectionString);
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

function bindings(refs: readonly string[], db: PostgresAdapter): Record<string, PostgresAdapter> {
  if (
    !Array.isArray(refs as unknown) ||
    refs.length === 0 ||
    new Set(refs).size !== refs.length ||
    refs.some((ref) => !ref || typeof ref !== 'string')
  )
    invalid();
  return Object.fromEntries(refs.map((ref) => [ref, db]));
}

function sameManifest(
  manifest: Awaited<ReturnType<typeof openVerifiedTenantBackupV2>>['manifest'],
  evidence: AwsRestoreActivationEvidence
): void {
  if (
    manifest.source.tenantId !== evidence.tenantId ||
    manifest.source.issuer !== evidence.issuer ||
    manifest.bundleId !== evidence.bundleId ||
    manifest.snapshotId !== evidence.snapshotId ||
    manifest.inventoryDigestSha256 !== evidence.inventoryDigestSha256 ||
    manifest.boundaryUnixMs !== evidence.boundaryUnixMs
  )
    invalid();
}

function stateReceipt(
  manifest: Awaited<ReturnType<typeof openVerifiedTenantBackupV2>>['manifest'],
  supplement: Awaited<ReturnType<typeof readVerifiedAwsSamlSupplement>>
): AwsStateRestoreReceipt {
  const state = supplement.state;
  if (
    state.persistentNameIdsComplete !== true ||
    !Array.isArray(state.accountAuthStates) ||
    !Array.isArray(state.passkeyCounters) ||
    !Array.isArray(state.persistentNameIds) ||
    state.receipt.supplementSha256 !== awsStateSupplementPayloadSha256(state)
  )
    invalid();
  return {
    tenantId: manifest.source.tenantId,
    source: { ...manifest.source },
    bundleId: manifest.bundleId,
    snapshotId: manifest.snapshotId,
    inventoryDigestSha256: manifest.inventoryDigestSha256,
    supplementSha256: state.receipt.supplementSha256,
    accountAuthStates: state.accountAuthStates.length,
    passkeyCounters: state.passkeyCounters.length,
    persistentNameIds: state.persistentNameIds.length,
  };
}

function assertReceipt(
  receipt: PostgresFamilyRestoreReceipt | null,
  family: 'core' | 'pii',
  evidence: AwsRestoreActivationEvidence,
  expectedSha256: string
): asserts receipt is PostgresFamilyRestoreReceipt {
  if (
    !receipt ||
    receipt.status !== 'committed_staging' ||
    receipt.family !== family ||
    receipt.targetId !== (family === 'core' ? evidence.coreTargetId : evidence.piiTargetId) ||
    receipt.tenantId !== evidence.tenantId ||
    receipt.bundleId !== evidence.bundleId ||
    receipt.snapshotId !== evidence.snapshotId ||
    receipt.inventoryDigestSha256 !== evidence.inventoryDigestSha256 ||
    restoreEvidenceDigest(receipt) !== expectedSha256
  )
    invalid();
}

async function load(input: LoadActivatedAwsSamlTenantInput): Promise<{
  runtime: AwsTenantRuntime;
  close(): Promise<void>;
}> {
  const plan = structuredClone({ ...input, backup: { ...input.backup, signal: undefined } });
  const evidence = structuredClone(plan.evidence);
  if (
    evidence.coreTargetId !== plan.core.targetId ||
    evidence.piiTargetId !== plan.pii.targetId ||
    plan.backup.maxSnapshotAgeMs !== evidence.maxSnapshotAgeMs ||
    restoreEvidenceDigest(plan.backup.receipt) !== evidence.backupReceiptSha256 ||
    plan.supplement.expectedSha256 !== evidence.supplementFileSha256 ||
    restoreEvidenceDigest({
      environmentName: plan.environmentName,
      spEntityIds: plan.spEntityIds,
      allocationScope: plan.allocationScope,
      coreBindingRefs: plan.core.bindingRefs,
      piiBindingRefs: plan.pii.bindingRefs,
      awsLookupReadKeys: plan.awsLookupReadKeys,
      awsFlowRuntimeHmacSecret: plan.awsFlowRuntimeHmacSecret,
    }) !== evidence.configurationSha256
  )
    invalid();

  // The source's age was judged at activation. Recheck at that same boundary on every
  // cold start, not at the present time after a healthy DR runtime has run for days.
  const backup = await openVerifiedTenantBackupV2({
    ...plan.backup,
    signal: input.backup.signal,
    nowMs: evidence.activatedAtMs,
  });
  const cleanup: Array<() => Promise<void>> = [];
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled(cleanup.map((release) => release()));
  };
  try {
    sameManifest(backup.manifest, evidence);
    const supplement = await readVerifiedAwsSamlSupplement({
      ...plan.supplement,
      manifest: backup.manifest,
    });
    const state = stateReceipt(backup.manifest, supplement);
    if (restoreEvidenceDigest(state) !== evidence.stateReceiptSha256) invalid();
    const targets = await Promise.all(
      [plan.core.connectionString, plan.pii.connectionString, plan.state.connectionString].map(
        databaseIdentity
      )
    );
    if (new Set(targets).size !== 3) invalid();
    const stateDb = new Pool({
      connectionString: plan.state.connectionString,
      max: 2,
      connectionTimeoutMillis: 5_000,
    });
    cleanup.push(() => stateDb.end());
    const coreDb = new PostgresAdapter({
      connectionString: plan.core.connectionString,
      clientFactory: adapterClient,
      statementConsentClientFactory: adapterClient,
    });
    cleanup.push(() => coreDb.close());
    const piiDb = new PostgresAdapter({
      connectionString: plan.pii.connectionString,
      clientFactory: adapterClient,
      statementConsentClientFactory: adapterClient,
    });
    cleanup.push(() => piiDb.close());
    await assertAwsRuntimeSchemaReady(stateDb);
    const readFamilyReceipts = async () => {
      const [coreRow, piiRow] = await Promise.all([
        coreDb.queryOne(
          `SELECT target_id,tenant_id,family,receipt_json FROM authrim_aws_import_staging
           WHERE target_id = ?`,
          [plan.core.targetId]
        ),
        piiDb.queryOne(
          `SELECT target_id,tenant_id,family,receipt_json FROM authrim_aws_import_staging
           WHERE target_id = ?`,
          [plan.pii.targetId]
        ),
      ]);
      const core = validatePostgresFamilyStagingReceiptRow(coreRow, plan.core.targetId);
      const pii = validatePostgresFamilyStagingReceiptRow(piiRow, plan.pii.targetId);
      assertReceipt(core, 'core', evidence, evidence.coreReceiptSha256);
      assertReceipt(pii, 'pii', evidence, evidence.piiReceiptSha256);
      return { core, pii };
    };
    const assertSnapshotReady = () =>
      assertAwsRestoreActivationReady({
        stateDb,
        evidence,
        assertCommittedTargets: async () => {
          await readFamilyReceipts();
        },
      });
    await assertSnapshotReady();
    const { core, pii } = await readFamilyReceipts();
    await assertAwsLiveStateCompatible({
      manifest: backup.manifest,
      supplement: supplement.state,
      expected: await deriveAwsStateSourceExpectations(backup),
      receipt: state,
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
    });
    await verifyActivatedDatabaseRows({
      backup,
      core: plan.core,
      pii: plan.pii,
      stateDb,
      activatedAtMs: evidence.activatedAtMs,
    });
    const runtime = await assembleAwsSamlTenantFromBackup({
      backup,
      supplement,
      restored: {
        metadataCoreDb: coreDb,
        accountCoreByBindingRef: bindings(plan.core.bindingRefs, coreDb),
        accountPiiByBindingRef: bindings(plan.pii.bindingRefs, piiDb),
        stateDb,
        committed: { core, pii, state },
      },
      environmentName: plan.environmentName,
      spEntityIds: plan.spEntityIds,
      allocationScope: plan.allocationScope,
      auditPorts: createPostgresAuditRuntimePorts(stateDb, [evidence.tenantId]),
      awsFlowRuntimeHmacSecret: plan.awsFlowRuntimeHmacSecret,
      awsLookupReadKeys: plan.awsLookupReadKeys,
      assertSnapshotReady,
    });
    await runtime.assertReady();
    await backup.close();
    return { runtime, close };
  } catch {
    await close();
    throw new Error('aws_activated_runtime_load_invalid');
  } finally {
    await backup.close().catch(() => undefined);
  }
}

/** No source import, bootstrap, or activation marker mutation occurs on this path. */
export async function loadActivatedAwsSamlTenant(input: LoadActivatedAwsSamlTenantInput) {
  try {
    return await load(input);
  } catch {
    throw new Error('aws_activated_runtime_load_failed');
  }
}
