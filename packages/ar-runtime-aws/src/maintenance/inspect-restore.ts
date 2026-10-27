import type { AwsRestoreActivationEvidence } from '../import/restore-coordinator';
import { canonicalRestoreJson, restoreEvidenceDigest } from '../import/restore-evidence';
import {
  assertMaintenanceTls,
  createMaintenanceSqlClient,
  type MaintenanceSqlFactory,
} from './database';

export type MaintenanceActivationExpectation = Pick<
  AwsRestoreActivationEvidence,
  | 'restoreId'
  | 'tenantId'
  | 'issuer'
  | 'backupReceiptSha256'
  | 'supplementFileSha256'
  | 'coreTargetId'
  | 'piiTargetId'
  | 'maxSnapshotAgeMs'
>;

const KEYS: readonly (keyof AwsRestoreActivationEvidence)[] = [
  'formatVersion',
  'restoreId',
  'activatedAtMs',
  'coreTargetId',
  'piiTargetId',
  'coreReceiptSha256',
  'piiReceiptSha256',
  'stateReceiptSha256',
  'configurationSha256',
  'tenantId',
  'issuer',
  'bundleId',
  'snapshotId',
  'inventoryDigestSha256',
  'boundaryUnixMs',
  'backupReceiptSha256',
  'supplementFileSha256',
  'maxSnapshotAgeMs',
];

/** Reads a candidate only. Callers MUST reconstruct and verify the activated runtime before returning it. */
export async function readCommittedMaintenanceActivation(input: {
  connectionString: string;
  expected: MaintenanceActivationExpectation;
  clientFactory?: MaintenanceSqlFactory;
}): Promise<AwsRestoreActivationEvidence> {
  const client = (input.clientFactory ?? createMaintenanceSqlClient)(input.connectionString);
  try {
    await client.connect();
    await assertMaintenanceTls(client);
    const result = await client.query<{
      status: string;
      evidence_json: string | null;
      evidence_sha256: string | null;
    }>(
      `SELECT status, evidence_json, evidence_sha256 FROM authrim_aws_restore_activations
       WHERE tenant_id = $1 AND restore_id = $2`,
      [input.expected.tenantId, input.expected.restoreId]
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      row.status !== 'active' ||
      !row.evidence_json ||
      row.evidence_json.length > 16_384 ||
      !row.evidence_sha256
    )
      throw new Error();
    const evidence = JSON.parse(row.evidence_json) as AwsRestoreActivationEvidence;
    if (
      !evidence ||
      Object.keys(evidence).sort().join() !== [...KEYS].sort().join() ||
      evidence.formatVersion !== 1 ||
      row.evidence_json !== canonicalRestoreJson(evidence) ||
      row.evidence_sha256 !== restoreEvidenceDigest(evidence)
    )
      throw new Error();
    for (const [key, value] of Object.entries(input.expected))
      if (evidence[key as keyof MaintenanceActivationExpectation] !== value) throw new Error();
    for (const [key, value] of Object.entries(evidence)) {
      if (
        !['string', 'number'].includes(typeof value) ||
        (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1)) ||
        (typeof value === 'string' && (!value || value.length > 2048)) ||
        (key.endsWith('Sha256') && !/^[a-f0-9]{64}$/u.test(String(value)))
      )
        throw new Error();
    }
    return evidence;
  } catch {
    // Missing, staging, failed and mismatched restores all stop. Never re-run an import here.
    throw new Error('aws_maintenance_restore_not_verifiable');
  } finally {
    await client.end();
  }
}
