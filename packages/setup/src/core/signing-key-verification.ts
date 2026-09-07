import { queryD1Rows } from './cloudflare.js';
import type { ControlSigningKeyPurpose } from './signing-key-rotation.js';

const SAFE_ENVIRONMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_KEY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_WORKER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const SAFE_ERROR = /^(?:runtime|control|lookup)_[a-z0-9_]{1,119}$/u;

interface VerificationRow extends Record<string, unknown> {
  worker_script_name: unknown;
  status: unknown;
  last_error_code: unknown;
  verified_at: unknown;
  updated_at: unknown;
}

export interface SigningKeyVerificationStatus {
  complete: boolean;
  expected: number;
  succeeded: number;
  failed: number;
  pending: string[];
  failures: Array<{ workerScriptName: string; errorCode: string }>;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function loadSigningKeyVerificationStatus(input: {
  controlDatabaseName: string;
  environmentId: string;
  purpose: ControlSigningKeyPurpose;
  keyId: string;
  expectedWorkerScriptNames: readonly string[];
  stagedAt: number;
  query?: typeof queryD1Rows;
}): Promise<SigningKeyVerificationStatus> {
  if (!input.controlDatabaseName.trim()) throw new Error('control_database_name_required');
  if (!SAFE_ENVIRONMENT_ID.test(input.environmentId)) {
    throw new Error('signing_key_verification_environment_invalid');
  }
  if (!SAFE_KEY_ID.test(input.keyId)) throw new Error('signing_key_verification_key_id_invalid');
  if (!Number.isSafeInteger(input.stagedAt) || input.stagedAt < 1) {
    throw new Error('signing_key_verification_staged_at_invalid');
  }
  const expected = new Set(input.expectedWorkerScriptNames);
  if (
    expected.size === 0 ||
    expected.size !== input.expectedWorkerScriptNames.length ||
    [...expected].some((worker) => !SAFE_WORKER.test(worker))
  ) {
    throw new Error('signing_key_verification_targets_invalid');
  }
  const query = input.query ?? queryD1Rows;
  const rows = await query<VerificationRow>(
    input.controlDatabaseName,
    `SELECT evidence.worker_script_name, evidence.status, evidence.last_error_code,
            evidence.verified_at, evidence.updated_at
       FROM control_signing_key_verifications evidence
       JOIN control_signing_key_metadata key_state
         ON key_state.environment_id = evidence.environment_id
        AND key_state.key_purpose = evidence.key_purpose
        AND key_state.key_id = evidence.key_id
      WHERE evidence.environment_id = ${sqlString(input.environmentId)}
        AND evidence.key_purpose = ${sqlString(input.purpose)}
        AND evidence.key_id = ${sqlString(input.keyId)}
        AND key_state.state = 'staged'
        AND key_state.updated_at = ${input.stagedAt}
      ORDER BY evidence.worker_script_name`
  );
  const byWorker = new Map<string, VerificationRow>();
  for (const row of rows) {
    if (
      typeof row.worker_script_name !== 'string' ||
      !expected.has(row.worker_script_name) ||
      byWorker.has(row.worker_script_name) ||
      (row.status !== 'succeeded' && row.status !== 'failed') ||
      !Number.isSafeInteger(row.updated_at) ||
      (row.updated_at as number) < 1
    ) {
      throw new Error('signing_key_verification_evidence_invalid');
    }
    if (
      row.status === 'succeeded' &&
      (!Number.isSafeInteger(row.verified_at) ||
        (row.verified_at as number) < 1 ||
        row.last_error_code !== null)
    ) {
      throw new Error('signing_key_verification_evidence_invalid');
    }
    if (
      row.status === 'failed' &&
      (row.verified_at !== null ||
        typeof row.last_error_code !== 'string' ||
        !SAFE_ERROR.test(row.last_error_code))
    ) {
      throw new Error('signing_key_verification_evidence_invalid');
    }
    byWorker.set(row.worker_script_name, row);
  }
  const pending = [...expected].filter((worker) => !byWorker.has(worker)).sort();
  const failures = [...byWorker.entries()]
    .filter(([, row]) => row.status === 'failed')
    .map(([workerScriptName, row]) => ({
      workerScriptName,
      errorCode: row.last_error_code as string,
    }));
  const succeeded = [...byWorker.values()].filter((row) => row.status === 'succeeded').length;
  return {
    complete: succeeded === expected.size,
    expected: expected.size,
    succeeded,
    failed: failures.length,
    pending,
    failures,
  };
}

export async function waitForSigningKeyVerification(
  input: Parameters<typeof loadSigningKeyVerificationStatus>[0] & {
    timeoutMs?: number;
    pollIntervalMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
    now?: () => number;
    onProgress?: (status: SigningKeyVerificationStatus) => void;
  }
): Promise<SigningKeyVerificationStatus> {
  const timeoutMs = input.timeoutMs ?? 180_000;
  const pollIntervalMs = input.pollIntervalMs ?? 5_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1
  ) {
    throw new Error('signing_key_verification_wait_config_invalid');
  }
  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const deadline = now() + timeoutMs;
  let status: SigningKeyVerificationStatus;
  do {
    status = await loadSigningKeyVerificationStatus(input);
    input.onProgress?.(status);
    if (status.complete) return status;
    if (now() >= deadline) break;
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  } while (now() <= deadline);
  const failureSummary = status.failures
    .slice(0, 3)
    .map((failure) => `${failure.workerScriptName}:${failure.errorCode}`)
    .join(',');
  throw new Error(
    `signing_key_verification_timeout:${status.succeeded}/${status.expected}:${failureSummary || 'pending'}`
  );
}
