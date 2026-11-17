import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair } from 'jose';
import { verifyBootstrapAcceleratorProof } from '@authrim/ar-lib-core/control-plane';
import { logIcebergReadinessAttemptDigest } from '@authrim/ar-lib-core/services/log-iceberg-readiness';
import {
  LOG_ARCHIVE_READINESS_TIMEOUT_MS,
  prepareLogArchiveReadinessAttempt,
  startLogArchiveReadiness,
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
    // One line saying why it waits, one saying it passed.
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenLastCalledWith(
      expect.stringMatching(/^Log archive check passed after /u)
    );
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
  it('keeps waiting past one Pipeline roll interval before giving up', async () => {
    const f = await fixture();
    let clock = 0;
    let calls = 0;
    await expect(
      waitForLogArchiveReadiness({
        ...f.input,
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        },
        fetch: async () => {
          calls += 1;
          return new Response(null, { status: 202 });
        },
      })
    ).rejects.toThrow('log_archive_readiness_not_confirmed_resume_setup');
    expect(clock).toBeGreaterThanOrEqual(LOG_ARCHIVE_READINESS_TIMEOUT_MS);
    expect(LOG_ARCHIVE_READINESS_TIMEOUT_MS).toBeGreaterThan(5 * 60_000);
    expect(calls).toBeGreaterThan(60);
  });
  it('starts the check with one request: pending is null, already readable is the proof', async () => {
    const f = await fixture();
    const messages: string[] = [];
    const wait = vi.fn(async () => undefined);
    const pending = vi.fn(async () =>
      Response.json({ ...f.result, state: 'pending', snapshotId: null }, { status: 202 })
    );
    expect(
      await startLogArchiveReadiness({
        ...f.input,
        fetch: pending,
        wait,
        onProgress: (message) => messages.push(message),
      })
    ).toBeNull();
    expect(pending).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
    expect(messages).toEqual([expect.stringMatching(/^Log archive check started: /u)]);

    const ready = vi.fn(async () => Response.json(f.result, { status: 200 }));
    expect(await startLogArchiveReadiness({ ...f.input, fetch: ready, wait })).toEqual(f.result);

    const interrupted = vi.fn(
      async () =>
        new Response(null, {
          status: 503,
          headers: { 'x-authrim-error-code': 'runtime_smoke_log_archive_probe_failed' },
        })
    );
    expect(await startLogArchiveReadiness({ ...f.input, fetch: interrupted, wait })).toBeNull();
    expect(wait).not.toHaveBeenCalled();
  });
  it('says how long ago the early start sent the probe', async () => {
    const f = await fixture();
    let clock = 100_000;
    const messages: string[] = [];
    let calls = 0;
    await waitForLogArchiveReadiness({
      ...f.input,
      probeSentAt: 10_000,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
      fetch: async () =>
        ++calls === 1
          ? Response.json({ ...f.result, state: 'pending', snapshotId: null }, { status: 202 })
          : Response.json(f.result, { status: 200 }),
      onProgress: (message) => messages.push(message),
    });
    expect(messages[0]).toMatch(/ The probe was sent 1m 30s ago\.$/u);
  });
  it('says once why it waits, then how long it has waited every 30 s, not every check', async () => {
    const f = await fixture();
    let clock = 0;
    const messages: string[] = [];
    await expect(
      waitForLogArchiveReadiness({
        ...f.input,
        timeoutMs: 2 * 60_000,
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        },
        fetch: async () => new Response(null, { status: 202 }),
        onProgress: (message) => messages.push(message),
      })
    ).rejects.toThrow('log_archive_readiness_not_confirmed_resume_setup');
    // 24 checks in two minutes: one explanation, then a line every 30 s.
    expect(messages[0]).toMatch(
      /^Waiting for the log archive check: .*about every 5m 00s\).*gives up after 2m 00s\.$/u
    );
    expect(messages.slice(1)).toEqual([
      '  Still waiting for the log archive check: 30.0s of up to 2m 00s (checked 7 times)',
      '  Still waiting for the log archive check: 1m 00s of up to 2m 00s (checked 13 times)',
      '  Still waiting for the log archive check: 1m 30s of up to 2m 00s (checked 19 times)',
    ]);
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

  it('reports the failure code Control returns with an HTTP error, and nothing unsafe', async () => {
    const f = await fixture();
    const messages: string[] = [];
    const reject = (code: string) => async () =>
      new Response(null, { status: 503, headers: { 'X-Authrim-Error-Code': code } });
    await expect(
      waitForLogArchiveReadiness({
        ...f.input,
        onProgress: (message) => messages.push(message),
        fetch: reject('runtime_smoke_log_archive_binding_unavailable'),
      })
    ).rejects.toThrow('log_archive_readiness_http_503');
    expect(messages).toEqual([
      'Control rejected the log probe (HTTP 503): runtime_smoke_log_archive_binding_unavailable',
    ]);
    messages.length = 0;
    await expect(
      waitForLogArchiveReadiness({
        ...f.input,
        onProgress: (message) => messages.push(message),
        fetch: reject('Bearer secret-token'),
      })
    ).rejects.toThrow('log_archive_readiness_http_503');
    expect(messages).toEqual([]);
  });
  it('retries an interrupted runtime probe using the same signed attempt', async () => {
    const f = await fixture();
    let clock = 0;
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 503,
          headers: { 'X-Authrim-Error-Code': 'runtime_smoke_log_archive_probe_failed' },
        })
      )
      .mockResolvedValueOnce(
        Response.json({ ...f.result, state: 'pending', snapshotId: null }, { status: 202 })
      )
      .mockResolvedValueOnce(Response.json(f.result));
    expect(
      await waitForLogArchiveReadiness({
        ...f.input,
        fetch: request,
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        },
      })
    ).toEqual(f.result);
    expect(request).toHaveBeenCalledTimes(3);
    expect(clock).toBe(10000);
  });
});
