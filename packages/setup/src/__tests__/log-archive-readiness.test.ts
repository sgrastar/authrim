import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair } from 'jose';
import { verifyBootstrapAcceleratorProof } from '@authrim/ar-lib-core/control-plane';
import { logIcebergReadinessAttemptDigest } from '@authrim/ar-lib-core/services/log-iceberg-readiness';
import {
  prepareLogArchiveReadinessAttempt,
  waitForLogArchiveReadiness,
} from '../core/log-archive-readiness.js';
import { createDefaultConfig } from '../core/config.js';
import { LOG_ARCHIVE_PRODUCER_COMPONENTS } from '../core/log-archive-config.js';
import type { AuthrimLock } from '../core/lock.js';
import { archiveLockFixture, selectScheduledArchive } from './fixtures/log-archive.js';
const cleanup: string[] = [];
afterEach(async () =>
  Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
);
async function fixture() {
  const config = selectScheduledArchive(createDefaultConfig('test')),
    archive = config.logging!.archive,
    owned = archiveLockFixture(config);
  const workers = Object.fromEntries(
    LOG_ARCHIVE_PRODUCER_COMPONENTS.map((component) => [
      component,
      {
        name: `test-${component}`,
        deployedAt: new Date().toISOString(),
        cloudflareVersionId: crypto.randomUUID(),
        cloudflareScriptTag: `tag-${component}`,
      },
    ])
  ) as AuthrimLock['workers'];
  const attempt = prepareLogArchiveReadinessAttempt(archive, owned, workers);
  const dir = await mkdtemp(join(tmpdir(), 'authrim-log-readiness-'));
  cleanup.push(dir);
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const privateJwk = {
      ...(await exportJWK(pair.privateKey)),
      kid: 'smoke-key',
      alg: 'EdDSA',
      use: 'sig',
    },
    publicJwk = {
      ...(await exportJWK(pair.publicKey)),
      kid: 'smoke-key',
      alg: 'EdDSA',
      use: 'sig',
    };
  await writeFile(
    join(dir, 'smoke_rpc_signing_jwk_slot_a.private.jwk.json'),
    JSON.stringify(privateJwk),
    { mode: 0o600 }
  );
  const result = {
    ...attempt,
    state: 'ready',
    mode: archive.mode,
    generation: archive.storageGeneration,
    schemaVersion: archive.schemaVersion,
    keyVersion: archive.objectEncryptionKeyVersion,
    tableUuid: owned.activation.tableUuid,
    physicalFingerprint: owned.activation.schemaSpecFingerprint,
    eventId: `log_archive_probe_v1:${attempt.attemptId}:${archive.objectEncryptionKeyVersion}`,
    snapshotId: '123',
    checkedAt: new Date().toISOString(),
  };
  return {
    config,
    archive,
    owned,
    workers,
    attempt,
    result,
    publicJwk,
    input: {
      apiBaseUrl: 'https://auth.example.invalid',
      environmentId: 'test',
      keysDir: dir,
      activeSlot: 'A' as const,
      activeKeyId: 'smoke-key',
      archive,
      owned,
      attempt,
    },
  };
}
describe('post-deploy archive readiness authority', () => {
  it('reuses one pending deploy attempt and starts a fresh one only when observed Worker identity changes', async () => {
    const f = await fixture();
    f.owned.activation.pendingRuntimeProbe = f.attempt;
    expect(prepareLogArchiveReadinessAttempt(f.archive, f.owned, f.workers)).toEqual(f.attempt);
    const changed = {
      ...f.workers,
      'ar-management': { ...f.workers['ar-management'], cloudflareVersionId: crypto.randomUUID() },
    };
    const next = prepareLogArchiveReadinessAttempt(f.archive, f.owned, changed);
    expect(next.attemptId).not.toBe(f.attempt.attemptId);
    expect(next.deploymentFingerprint).not.toBe(f.attempt.deploymentFingerprint);
    expect(() => prepareLogArchiveReadinessAttempt(f.archive, f.owned, {})).toThrow(
      'log_archive_probe_worker_identity_missing'
    );
  });
  it('waits past acceptance, binds the request attempt in the signature, and accepts only the exact live roundtrip', async () => {
    const f = await fixture();
    let clock = 0,
      calls = 0;
    const request = vi.fn(async (url: string | URL | Request, init?: globalThis.RequestInit) => {
      expect(String(url)).toBe(
        'https://auth.example.invalid/api/internal/control/bootstrap/advance'
      );
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Authrim-Bootstrap-Action')).toBe('log_archive_readiness');
      const claims = await verifyBootstrapAcceleratorProof(headers.get('Authorization')?.slice(7), {
        environmentId: 'test',
        purpose: 'log_archive_readiness',
        publicJwk: f.publicJwk,
      });
      expect(claims.probeDigest).toBe(await logIcebergReadinessAttemptDigest(f.attempt));
      expect(JSON.parse(String(init?.body))).toEqual(f.attempt);
      calls++;
      return Response.json(
        {
          ...f.result,
          state: calls === 1 ? 'pending' : 'ready',
          snapshotId: calls === 1 ? null : '123',
        },
        { status: calls === 1 ? 202 : 200 }
      );
    });
    const progress = vi.fn();
    expect(
      await waitForLogArchiveReadiness({
        ...f.input,
        fetch: request,
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        },
        onProgress: progress,
      })
    ).toEqual(f.result);
    expect(request).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledOnce();
  });
  it('rejects old-deploy or foreign-table ready responses instead of trusting preflight resource ownership', async () => {
    const f = await fixture();
    for (const wrong of [
      { ...f.result, attemptId: crypto.randomUUID() },
      { ...f.result, physicalFingerprint: 'f'.repeat(64) },
      { ...f.result, keyVersion: 2 },
    ])
      await expect(
        waitForLogArchiveReadiness({ ...f.input, fetch: async () => Response.json(wrong) })
      ).rejects.toThrow('log_archive_readiness_identity_mismatch');
  });
  it('leaves the attempt resumable when visibility never arrives and never treats an empty 202 as ready', async () => {
    const f = await fixture();
    let clock = 0;
    await expect(
      waitForLogArchiveReadiness({
        ...f.input,
        timeoutMs: 10000,
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        },
        fetch: async () => new Response(null, { status: 202 }),
      })
    ).rejects.toThrow('log_archive_readiness_not_confirmed_resume_setup');
    expect(f.attempt.attemptId).toBeTruthy();
  });
});
