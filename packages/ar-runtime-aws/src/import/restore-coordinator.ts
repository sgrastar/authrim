import type { PostgresQueryClient } from '../storage/postgres-transient-state';
import { canonicalRestoreJson, restoreEvidenceDigest } from './restore-evidence';

export interface AwsRestoreSourceEvidence {
  tenantId: string;
  issuer: string;
  bundleId: string;
  snapshotId: string;
  inventoryDigestSha256: string;
  boundaryUnixMs: number;
  backupReceiptSha256: string;
  supplementFileSha256: string;
  maxSnapshotAgeMs: number;
}

export interface AwsRestoreActivationEvidence extends AwsRestoreSourceEvidence {
  formatVersion: 1;
  restoreId: string;
  activatedAtMs: number;
  coreTargetId: string;
  piiTargetId: string;
  coreReceiptSha256: string;
  piiReceiptSha256: string;
  stateReceiptSha256: string;
  configurationSha256: string;
}

type CommittedEvidence = Pick<
  AwsRestoreActivationEvidence,
  | 'coreTargetId'
  | 'piiTargetId'
  | 'coreReceiptSha256'
  | 'piiReceiptSha256'
  | 'stateReceiptSha256'
  | 'configurationSha256'
>;

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

function invalid(): never {
  throw new Error('aws_restore_activation_invalid');
}

function assertSource(source: AwsRestoreSourceEvidence, now: number, enforceFreshness: boolean) {
  let origin: URL;
  try {
    origin = new URL(source.issuer);
  } catch {
    return invalid();
  }
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(source.tenantId) ||
    origin.protocol !== 'https:' ||
    origin.origin !== source.issuer ||
    !/^[a-f0-9]{32}$/u.test(source.bundleId) ||
    !source.snapshotId ||
    source.snapshotId.length > 512 ||
    !HASH.test(source.inventoryDigestSha256) ||
    !HASH.test(source.backupReceiptSha256) ||
    !HASH.test(source.supplementFileSha256) ||
    !Number.isSafeInteger(source.boundaryUnixMs) ||
    source.boundaryUnixMs < 1 ||
    !Number.isSafeInteger(source.maxSnapshotAgeMs) ||
    source.maxSnapshotAgeMs < 1 ||
    !Number.isSafeInteger(now) ||
    now < 1 ||
    (enforceFreshness &&
      (now - source.boundaryUnixMs > source.maxSnapshotAgeMs ||
        source.boundaryUnixMs > now + 300_000))
  )
    invalid();
}

function assertEvidence(evidence: AwsRestoreActivationEvidence) {
  assertSource(evidence, evidence.activatedAtMs, true);
  if (
    evidence.formatVersion !== 1 ||
    !UUID.test(evidence.restoreId) ||
    !UUID.test(evidence.coreTargetId) ||
    !UUID.test(evidence.piiTargetId) ||
    evidence.coreTargetId === evidence.piiTargetId ||
    ![
      evidence.coreReceiptSha256,
      evidence.piiReceiptSha256,
      evidence.stateReceiptSha256,
      evidence.configurationSha256,
    ].every((value) => HASH.test(value))
  )
    invalid();
}

/** Reusable after process restart; expected evidence must come from the trusted deployment. */
export async function assertAwsRestoreActivationReady(input: {
  stateDb: PostgresQueryClient;
  evidence: AwsRestoreActivationEvidence;
  assertCommittedTargets(): Promise<void>;
}): Promise<void> {
  try {
    assertEvidence(input.evidence);
    await input.assertCommittedTargets();
    const result = await input.stateDb.query<{
      status: string;
      evidence_json: string | null;
      evidence_sha256: string | null;
    }>(
      `SELECT status, evidence_json, evidence_sha256 FROM authrim_aws_restore_activations
       WHERE tenant_id = $1 AND restore_id = $2`,
      [input.evidence.tenantId, input.evidence.restoreId]
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      row.status !== 'active' ||
      row.evidence_json !== canonicalRestoreJson(input.evidence) ||
      row.evidence_sha256 !== restoreEvidenceDigest(input.evidence)
    )
      invalid();
  } catch {
    invalid();
  }
}

/**
 * Family commits are independent. Only this final publication permits requests. A crash or
 * failed family leaves unpublished staging databases, which must be replaced, not retried.
 * The returned runtime always checks the durable active marker, including after first login.
 */
export async function coordinateAwsRestore<
  Runtime extends { assertReady(): Promise<void> },
>(input: {
  stateDb: PostgresQueryClient;
  restoreId: string;
  source: AwsRestoreSourceEvidence;
  now?: () => number;
  stage(): Promise<{
    committed: CommittedEvidence;
    assertCommittedTargets(): Promise<void>;
    /** Full row equality is checked only while staging, before live AWS writes begin. */
    assertStagingComplete?(): Promise<void>;
    createRuntime(assertSnapshotReady: () => Promise<void>): Promise<Runtime>;
  }>;
}): Promise<{ runtime: Runtime; evidence: AwsRestoreActivationEvidence }> {
  const now = input.now ?? Date.now;
  const source = structuredClone(input.source);
  const restoreId = input.restoreId;
  let claimed = false;
  try {
    assertSource(source, now(), true);
    if (!UUID.test(restoreId)) invalid();
    const inserted = await input.stateDb.query<{ restore_id: string }>(
      `INSERT INTO authrim_aws_restore_activations
        (tenant_id, restore_id, status, created_at_ms)
       VALUES ($1, $2, 'staging', $3)
       ON CONFLICT DO NOTHING RETURNING restore_id`,
      [source.tenantId, restoreId, now()]
    );
    if (inserted.rows.length !== 1) invalid();
    claimed = true;
    const staged = await input.stage();
    const evidence: AwsRestoreActivationEvidence = {
      ...source,
      ...structuredClone(staged.committed),
      formatVersion: 1,
      restoreId,
      activatedAtMs: now(),
    };
    assertEvidence(evidence);
    Object.freeze(evidence);
    let validating = true;
    const assertSnapshotReady = async () => {
      if (!validating) {
        return assertAwsRestoreActivationReady({
          stateDb: input.stateDb,
          evidence,
          assertCommittedTargets: () => staged.assertCommittedTargets(),
        });
      }
      assertSource(source, now(), true);
      await staged.assertCommittedTargets();
      const result = await input.stateDb.query<{ status: string }>(
        `SELECT status FROM authrim_aws_restore_activations
         WHERE tenant_id = $1 AND restore_id = $2`,
        [source.tenantId, restoreId]
      );
      if (result.rows.length !== 1 || result.rows[0].status !== 'staging') invalid();
    };
    const runtime = await staged.createRuntime(assertSnapshotReady);
    await assertSnapshotReady();
    await runtime.assertReady();
    await staged.assertStagingComplete?.();
    // Recheck freshness immediately before publication; a long import cannot reuse an old check.
    assertSource(source, now(), true);
    const activated = await input.stateDb.query<{ restore_id: string }>(
      `UPDATE authrim_aws_restore_activations
       SET status = 'active', evidence_json = $3, evidence_sha256 = $4, activated_at_ms = $5
       WHERE tenant_id = $1 AND restore_id = $2 AND status = 'staging'
       RETURNING restore_id`,
      [
        source.tenantId,
        restoreId,
        canonicalRestoreJson(evidence),
        restoreEvidenceDigest(evidence),
        evidence.activatedAtMs,
      ]
    );
    validating = false;
    if (activated.rows.length !== 1) invalid();
    await assertSnapshotReady();
    return { runtime, evidence };
  } catch {
    if (claimed) {
      await input.stateDb
        .query(
          `UPDATE authrim_aws_restore_activations SET status = 'failed', activated_at_ms = NULL
           WHERE tenant_id = $1 AND restore_id = $2`,
          [source.tenantId, restoreId]
        )
        .catch(() => undefined);
    }
    // PostgreSQL errors can contain plaintext row values. Never forward them to a CLI or log.
    throw new Error('aws_restore_failed');
  }
}
