import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../core/cloudflare.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/cloudflare.js')>()),
  getAccountId: vi.fn(async () => cloudflare.accountId),
  getCloudflareApiToken: vi.fn(async () => ({ token: 'setup-control-token', source: 'env' })),
}));
import { createDefaultConfig } from '../core/config.js';
import { repairLogArchiveCatalogCredential } from '../core/log-archive-catalog-credential.js';
import { stageLogArchiveSecrets } from '../core/log-archive-secrets.js';
import { LogArchiveApi, ensureLogArchiveCatalogCredential } from '../core/log-archive.js';
import { waitForLogArchiveReadiness } from '../core/log-archive-readiness.js';
import { archiveLockFixture, selectScheduledArchive } from './fixtures/log-archive.js';

const accountId = 'a'.repeat(32);
const cloudflare = { accountId: accountId as string | null };
const writeToken = 'fake-write-token';
const writeTokenId = 'f'.repeat(32);
const bucket = 'demo-log-archive';
const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  cloudflare.accountId = accountId;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A Catalog whose maintenance service has no credential yet: `credential_status: absent` at the
 * catalog level and `next_eligible_reason: no_credential` on every table, as the real API reports.
 */
function catalog(initial: { credentialStatus?: string; tableFollowsCredential?: boolean } = {}) {
  const state = {
    credentialStatus: initial.credentialStatus ?? 'absent',
    registeredToken: undefined as string | undefined,
  };
  const calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
    const path = String(url).split(`/accounts/${accountId}/`)[1];
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ path, method, body });
    let result: unknown;
    if (path === 'tokens/verify') {
      const bearer = new Headers(init?.headers).get('authorization');
      result =
        bearer === `Bearer ${writeToken}`
          ? { id: writeTokenId, status: 'active' }
          : { id: '1'.repeat(32), status: 'active' };
    } else if (path === `basin-catalog/${bucket}/credential` && method === 'POST') {
      state.credentialStatus = 'present';
      state.registeredToken = String(body!.token);
      result = {};
    } else if (path === `basin-catalog/${bucket}/maintenance-configs`) {
      result = {
        credential_status: state.credentialStatus,
        compaction: { state: 'enabled', target_size_mb: '128' },
      };
    } else if (path.endsWith('/maintenance-configs')) {
      const noCredential =
        state.credentialStatus !== 'present' || initial.tableFollowsCredential === false;
      result = {
        maintenance_config: {
          compaction: {
            state: 'enabled',
            target_size_mb: '64',
            ...(noCredential
              ? { next_eligible_at: null, next_eligible_reason: 'no_credential' }
              : { next_eligible_at: '2026-11-26T00:00:00.000Z' }),
          },
          snapshot_expiration: { state: 'disabled', next_eligible_at: null },
        },
      };
    }
    return new Response(
      JSON.stringify(result === undefined ? { success: false } : { success: true, result }),
      { status: result === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as unknown as typeof fetch;
  const api = new LogArchiveApi(accountId, 'setup-control-token', fetcher);
  const credentialPosts = () =>
    calls.filter((call) => call.method === 'POST' && call.path.endsWith('/credential'));
  return { api, fetcher, calls, state, credentialPosts };
}

describe('Catalog maintenance service credential', () => {
  it('registers the write token on first run, verifies the provider reports it, and records only its id', async () => {
    const c = catalog();
    const progress: string[] = [];
    const recorded = await ensureLogArchiveCatalogCredential({
      api: c.api,
      bucketName: bucket,
      catalogWriteToken: writeToken,
      onProgress: (message) => progress.push(message),
    });
    expect(c.credentialPosts()).toHaveLength(1);
    expect(c.credentialPosts()[0].body).toEqual({ token: writeToken });
    expect(c.state.registeredToken).toBe(writeToken);
    expect(recorded).toMatchObject({
      tokenId: writeTokenId,
      source: 'catalog_write_token',
      status: 'present',
    });
    expect(Number.isFinite(Date.parse(recorded.registeredAt))).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain(writeToken);
    expect(progress.join('\n')).not.toContain(writeToken);
    // Verified after the upsert, with the catalog-level status, not assumed from the POST.
    const reads = c.calls.filter(
      (call) => call.path === `basin-catalog/${bucket}/maintenance-configs`
    );
    expect(reads).toHaveLength(2);
  });

  it('is idempotent: a re-run with the recorded id and a present credential sends no upsert', async () => {
    const c = catalog();
    const recorded = await ensureLogArchiveCatalogCredential({
      api: c.api,
      bucketName: bucket,
      catalogWriteToken: writeToken,
    });
    const again = await ensureLogArchiveCatalogCredential({
      api: c.api,
      bucketName: bucket,
      catalogWriteToken: writeToken,
      recorded,
    });
    expect(again).toEqual(recorded);
    expect(c.credentialPosts()).toHaveLength(1);
  });

  it('re-registers when the write token was rotated or the provider lost the credential', async () => {
    const c = catalog({ credentialStatus: 'present' });
    const stale = {
      tokenId: '9'.repeat(32),
      source: 'catalog_write_token' as const,
      status: 'present' as const,
      registeredAt: '2026-10-27T00:00:00.000Z',
    };
    const rotated = await ensureLogArchiveCatalogCredential({
      api: c.api,
      bucketName: bucket,
      catalogWriteToken: writeToken,
      recorded: stale,
    });
    expect(rotated.tokenId).toBe(writeTokenId);
    expect(c.credentialPosts()).toHaveLength(1);
    c.state.credentialStatus = 'absent';
    await ensureLogArchiveCatalogCredential({
      api: c.api,
      bucketName: bucket,
      catalogWriteToken: writeToken,
      recorded: rotated,
    });
    expect(c.credentialPosts()).toHaveLength(2);
  });

  it('fails with a clear code when the provider still reports no credential after the upsert', async () => {
    const c = catalog();
    c.api.request = (async (path: string, method?: string, body?: unknown, token?: string) => {
      if (path.endsWith('/credential')) return undefined;
      return LogArchiveApi.prototype.request.call(c.api, path, method, body, token);
    }) as typeof c.api.request;
    await expect(
      ensureLogArchiveCatalogCredential({
        api: c.api,
        bucketName: bucket,
        catalogWriteToken: writeToken,
      })
    ).rejects.toThrow('log_archive_catalog_maintenance_credential_absent');
  });

  it('refuses an inactive write token before touching the Catalog', async () => {
    const c = catalog();
    await expect(
      ensureLogArchiveCatalogCredential({
        api: c.api,
        bucketName: bucket,
        catalogWriteToken: 'not-the-write-token',
      })
    ).resolves.toMatchObject({ tokenId: '1'.repeat(32) });
    const inactive = catalog();
    inactive.api.request = (async (path: string) => {
      if (path === 'tokens/verify') return { id: writeTokenId, status: 'disabled' };
      throw new Error('unexpected');
    }) as typeof inactive.api.request;
    await expect(
      ensureLogArchiveCatalogCredential({
        api: inactive.api,
        bucketName: bucket,
        catalogWriteToken: writeToken,
      })
    ).rejects.toThrow('log_archive_catalog_token_inactive');
    expect(inactive.credentialPosts()).toHaveLength(0);
  });

  it('repairs an archive set up before the credential existed from the published write token', async () => {
    const config = selectScheduledArchive(createDefaultConfig('demo'));
    config.cloudflare.accountId = accountId;
    const owned = archiveLockFixture(config);
    const legacy = { ...owned, maintenance: { ...owned.maintenance, credential: undefined } };
    const c = catalog();
    vi.stubGlobal('fetch', c.fetcher);
    const dir = await mkdtemp(join(tmpdir(), 'authrim-log-credential-'));
    cleanup.push(dir);
    // The published key file is what deploys use; a staged copy from before a rotation is stale.
    await mkdir(join(dir, 'keys'), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'keys', 'log_archive_catalog_write_token.txt'), `${writeToken}\n`, {
      mode: 0o600,
    });
    await stageLogArchiveSecrets(dir, 'demo', {
      readToken: 'fake-read-token',
      writeToken: 'rotated-away-write-token',
    });
    const repaired = await repairLogArchiveCatalogCredential({
      baseDir: dir,
      environment: 'demo',
      keysDir: join(dir, 'keys'),
      owned: legacy,
    });
    expect(repaired.maintenance.credential).toMatchObject({ tokenId: writeTokenId });
    expect(c.state.registeredToken).toBe(writeToken);
    // The second deploy finds the record and the present credential: no upsert.
    await repairLogArchiveCatalogCredential({
      baseDir: dir,
      environment: 'demo',
      keysDir: join(dir, 'keys'),
      owned: repaired,
    });
    expect(c.credentialPosts()).toHaveLength(1);
    // A login for another account must not register anything on this Catalog.
    cloudflare.accountId = 'b'.repeat(32);
    await expect(
      repairLogArchiveCatalogCredential({
        baseDir: dir,
        environment: 'demo',
        keysDir: join(dir, 'keys'),
        owned: legacy,
      })
    ).rejects.toThrow('log_archive_catalog_credential_account_mismatch');
    expect(c.credentialPosts()).toHaveLength(1);
  });

  it('fails the repair when the owned table still reports no credential after registration', async () => {
    const config = selectScheduledArchive(createDefaultConfig('demo'));
    config.cloudflare.accountId = accountId;
    const owned = archiveLockFixture(config);
    const c = catalog({ tableFollowsCredential: false });
    vi.stubGlobal('fetch', c.fetcher);
    vi.stubEnv('LOG_ARCHIVE_CATALOG_WRITE_TOKEN', writeToken);
    const dir = await mkdtemp(join(tmpdir(), 'authrim-log-credential-'));
    cleanup.push(dir);
    await expect(
      repairLogArchiveCatalogCredential({
        baseDir: dir,
        environment: 'demo',
        keysDir: join(dir, 'keys'),
        owned: { ...owned, maintenance: { ...owned.maintenance, credential: undefined } },
      })
    ).rejects.toThrow('log_archive_provider_compaction_credential_missing');
    expect(c.state.credentialStatus).toBe('present');
  });

  it('readiness refuses a lock whose maintenance credential was never recorded', async () => {
    const config = selectScheduledArchive(createDefaultConfig('test'));
    const owned = archiveLockFixture(config);
    const dir = await mkdtemp(join(tmpdir(), 'authrim-log-credential-'));
    cleanup.push(dir);
    await writeFile(join(dir, 'smoke_rpc_signing_jwk_slot_a.private.jwk.json'), '{}', {
      mode: 0o600,
    });
    const fetch = vi.fn();
    await expect(
      waitForLogArchiveReadiness({
        apiBaseUrl: 'https://auth.example.invalid',
        environmentId: 'test',
        keysDir: dir,
        activeSlot: 'A',
        activeKeyId: 'smoke-key',
        archive: config.logging!.archive,
        owned: { ...owned, maintenance: { ...owned.maintenance, credential: undefined } },
        attempt: {
          attemptId: '7d1a4c1e-2d6e-4a1b-9d6a-2c4a5a6b7c8d',
          startedAt: '2026-11-25T00:00:00.000Z',
          deploymentFingerprint: 'd'.repeat(64),
        },
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
    ).rejects.toThrow('log_archive_catalog_maintenance_credential_absent');
    expect(fetch).not.toHaveBeenCalled();
  });
});
