import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { logIcebergReadinessAttemptDigest } from '@authrim/ar-lib-core/services/log-iceberg-readiness';
import type { AuthrimLock } from './lock.js';
import { signBootstrapAcceleratorProof } from '@authrim/ar-lib-core/control-plane';
import { readPrivateFileSecurely } from './atomic-file.js';
import { fetchWithTimeout, readResponseTextWithLimit } from './http-limits.js';
import {
  assertLogArchiveLockMatches,
  LOG_ARCHIVE_PRODUCER_COMPONENTS,
  LogArchiveRuntimeProofSchema,
  type LogArchiveProbeAttempt,
  type LogArchiveRuntimeProof,
  type LogArchiveConfig,
  type LogArchiveLock,
} from './log-archive-config.js';

const ResultSchema = LogArchiveRuntimeProofSchema.extend({
  state: z.enum(['pending', 'ready']),
  snapshotId: z
    .string()
    .regex(/^[0-9]+$/u)
    .nullable(),
});
const SAFE_CONTROL_ERROR_CODE = /^(?:bootstrap|cloudflare|control|runtime)_[a-z0-9_:,-]{1,159}$/u;
export interface LogArchiveReadinessOptions {
  apiBaseUrl: string;
  environmentId: string;
  keysDir: string;
  activeSlot: 'A' | 'B';
  activeKeyId: string;
  archive: LogArchiveConfig;
  owned: LogArchiveLock;
  attempt: LogArchiveProbeAttempt;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onProgress?: (message: string) => void;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}
/** Version IDs come from the existing provider readback, never generated package names. */
export function prepareLogArchiveReadinessAttempt(
  archive: LogArchiveConfig,
  owned: LogArchiveLock,
  workers: AuthrimLock['workers']
): LogArchiveProbeAttempt {
  const versions = LOG_ARCHIVE_PRODUCER_COMPONENTS.map((component) => {
    const worker = workers?.[component];
    if (!worker?.cloudflareVersionId || !worker.cloudflareScriptTag)
      throw new Error('log_archive_probe_worker_identity_missing');
    return [component, worker.cloudflareVersionId, worker.cloudflareScriptTag];
  });
  const deploymentFingerprint = createHash('sha256')
    .update(
      JSON.stringify([archive.storageGeneration, archive.objectEncryptionKeyVersion, versions])
    )
    .digest('hex');
  const previous = owned.activation.pendingRuntimeProbe;
  return previous?.deploymentFingerprint === deploymentFingerprint
    ? { ...previous }
    : { attemptId: randomUUID(), startedAt: new Date().toISOString(), deploymentFingerprint };
}
/** Uses the existing signed bootstrap bridge; only a real Worker/Catalog roundtrip can return ready. */
export async function waitForLogArchiveReadiness(
  input: LogArchiveReadinessOptions
): Promise<LogArchiveRuntimeProof> {
  input = {
    ...input,
    archive: structuredClone(input.archive),
    owned: structuredClone(input.owned),
    attempt: { ...input.attempt },
  };
  assertLogArchiveLockMatches(input.archive, input.owned);
  const base = new URL(input.apiBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('log_archive_readiness_url_invalid');
  const keyText = await readPrivateFileSecurely(
    join(
      input.keysDir,
      `smoke_rpc_signing_jwk_slot_${input.activeSlot.toLowerCase()}.private.jwk.json`
    ),
    {
      maxBytes: 16 * 1024,
      invalidError: 'log_archive_readiness_key_invalid',
      permissionsError: 'log_archive_readiness_key_permissions_invalid',
    }
  );
  if (!keyText) throw new Error('log_archive_readiness_key_missing');
  const key = JSON.parse(keyText) as Parameters<
    typeof signBootstrapAcceleratorProof
  >[0]['privateJwk'];
  const now = input.now ?? Date.now,
    deadline = now() + (input.timeoutMs ?? 5 * 60_000);
  const wait =
    input.wait ??
    ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  while (now() < deadline) {
    const proof = await signBootstrapAcceleratorProof({
      environmentId: input.environmentId,
      jti: `log-probe-${randomBytes(18).toString('base64url')}`,
      purpose: 'log_archive_readiness',
      probeDigest: await logIcebergReadinessAttemptDigest(input.attempt),
      privateJwk: key,
      keyId: input.activeKeyId,
    });
    const response = await (input.fetch ?? fetchWithTimeout)(
      new URL('/api/internal/control/bootstrap/advance', base).toString(),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${proof}`,
          'X-Authrim-Bootstrap-Action': 'log_archive_readiness',
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input.attempt),
      }
    );
    if (response.status !== 200 && response.status !== 202) {
      // Control reports why the probe failed in a header (a fixed, secret-free code). Without it a
      // 503 cannot be told apart from a missing binding, a Catalog failure or a Management error.
      const reason = response.headers?.get?.('x-authrim-error-code') ?? '';
      if (SAFE_CONTROL_ERROR_CODE.test(reason))
        input.onProgress?.(`Control rejected the log probe (HTTP ${response.status}): ${reason}`);
      throw new Error(`log_archive_readiness_http_${response.status}`);
    }
    const text = await readResponseTextWithLimit(response, 16 * 1024);
    if (text) {
      const result = ResultSchema.parse(JSON.parse(text));
      if (
        result.mode !== input.archive.mode ||
        result.generation !== input.archive.storageGeneration ||
        result.schemaVersion !== input.archive.schemaVersion ||
        result.keyVersion !== input.archive.objectEncryptionKeyVersion ||
        result.tableUuid !== input.owned.activation.tableUuid ||
        result.physicalFingerprint !== input.owned.activation.schemaSpecFingerprint ||
        result.attemptId !== input.attempt.attemptId ||
        result.startedAt !== input.attempt.startedAt ||
        result.deploymentFingerprint !== input.attempt.deploymentFingerprint ||
        result.eventId !==
          `log_archive_probe_v1:${input.attempt.attemptId}:${input.archive.objectEncryptionKeyVersion}`
      )
        throw new Error('log_archive_readiness_identity_mismatch');
      if (response.status === 200 && result.state === 'ready')
        return LogArchiveRuntimeProofSchema.parse(result);
      if (response.status !== 202 || result.state !== 'pending')
        throw new Error('log_archive_readiness_response_invalid');
    } else if (response.status === 200) throw new Error('log_archive_readiness_response_invalid');
    input.onProgress?.(
      'Waiting for the non-PII log probe to become readable in the owned Iceberg table...'
    );
    await wait(Math.min(5000, Math.max(0, deadline - now())));
  }
  throw new Error('log_archive_readiness_not_confirmed_resume_setup');
}
