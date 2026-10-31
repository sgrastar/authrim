import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as secretFiles from '../core/atomic-file.js';
import { getCloudflareApiToken, getAccountId } from '../core/cloudflare.js';
import { createDefaultConfig } from '../core/config.js';
import { stagePendingBootstrap } from '../core/pending-control-bootstrap.js';
import {
  stageLogArchiveSecrets,
  logArchiveSecretsFingerprint,
} from '../core/log-archive-secrets.js';
import { LogArchiveApi, LogArchiveApiError } from '../core/log-archive.js';
import { createApiRoutes, generateSessionToken } from '../web/api.js';

const mocks = vi.hoisted(() => ({ issue: vi.fn() }));
vi.mock('../core/log-archive-token-issuance.js', async (original) => ({
  ...(await original<typeof import('../core/log-archive-token-issuance.js')>()),
  ensureLogArchiveTokens: mocks.issue,
}));
vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['scheduled', 'pipeline'],
}));
vi.mock('../core/cloudflare.js', async (original) => ({
  ...(await original<typeof import('../core/cloudflare.js')>()),
  getAccountId: vi.fn(async () => 'a'.repeat(32)),
  getCloudflareApiToken: vi.fn(async () => ({ token: 'oauth', source: 'oauth' })),
}));
const cwd = process.cwd();
let root: string;
let session: string;
function post(body: unknown) {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Token': session,
      Origin: 'http://localhost',
    },
    body: JSON.stringify(body),
  };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'catalog-api-'));
  process.chdir(root);
  session = generateSessionToken();
  await mkdir(join(root, '.authrim/demo'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'authrim', version: '0.4.2' })
  );
  const config = createDefaultConfig('demo');
  config.cloudflare = { accountId: 'a'.repeat(32) };
  await writeFile(join(root, '.authrim/demo/config.json'), JSON.stringify(config));
  vi.mocked(getAccountId).mockReset().mockResolvedValue('a'.repeat(32));
  mocks.issue.mockReset().mockResolvedValue({ readTokenId: 'read-id', writeTokenId: 'write-id' });
  vi.spyOn(LogArchiveApi.prototype, 'verifyCatalogCredentials').mockResolvedValue();
});
afterEach(async () => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function issuedPending(bootstrapRevoked = false) {
  const secrets = { readToken: 'SENTINEL_ISSUED_READ', writeToken: 'SENTINEL_ISSUED_WRITE' };
  await stageLogArchiveSecrets(root, 'demo', secrets, {
    accountId: 'a'.repeat(32),
    mode: 'scheduled',
    issuance: {
      readTokenId: '2'.repeat(32),
      writeTokenId: '3'.repeat(32),
      bootstrapTokenId: 'b'.repeat(32),
      bootstrapTokenFingerprint: 'f'.repeat(64),
    },
  });
  await stagePendingBootstrap({
    baseDir: root,
    artifact: {
      version: 2,
      phase: 'issued',
      bootstrapRevoked,
      purpose: 'log-archive',
      environment: 'demo',
      accountId: 'a'.repeat(32),
      ownership: 'account',
      bootstrapToken: 'SENTINEL_BOOTSTRAP',
      bootstrapTokenId: 'b'.repeat(32),
      childTokenNames: [
        'authrim-demo-aaaaaaaa-log-archive-read',
        'authrim-demo-aaaaaaaa-log-archive-write',
      ],
      preservedTokenIds: ['b'.repeat(32)],
      childTokenIds: ['2'.repeat(32), '3'.repeat(32)],
      pendingCreateName: null,
      stagedSecretsFingerprint: logArchiveSecretsFingerprint(secrets),
      recoveryToken: null,
      revocationTargetTokenIds: ['b'.repeat(32)],
    },
  });
}
describe('Catalog setup API', () => {
  it('issues through the shared service and returns IDs only', async () => {
    const response = await createApiRoutes().request(
      'http://localhost/log-archive/issue-tokens',
      post({ environment: 'demo', mode: 'scheduled', bootstrapToken: 'SENTINEL_BOOTSTRAP_SECRET' })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      issued: { readTokenId: 'read-id', writeTokenId: 'write-id' },
    });
    expect(mocks.issue).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'demo', mode: 'scheduled', accountId: 'a'.repeat(32) })
    );
  });
  it('accepts staged tokens without credentials in the configure body', async () => {
    await stageLogArchiveSecrets(
      root,
      'demo',
      {
        readToken: 'sentinel-read',
        writeToken: 'sentinel-write',
      },
      { accountId: 'a'.repeat(32), mode: 'scheduled' }
    );
    const response = await createApiRoutes().request(
      '/log-archive/configure',
      post({ environment: 'demo', mode: 'scheduled', tokenSource: 'staged' })
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain('sentinel');
    expect(await readFile(join(root, '.authrim/demo/config.json'), 'utf8')).not.toContain(
      'sentinel'
    );
  });
  it('reports schema field names without values and rejects tokens mixed with staged source', async () => {
    const app = createApiRoutes();
    const response = await app.request(
      '/log-archive/configure',
      post({ environment: 'demo', mode: 'scheduled', readToken: '', writeToken: 'SENTINEL' })
    );
    expect(await response.json()).toMatchObject({
      error: 'log_archive_request_invalid',
      fields: expect.arrayContaining(['readToken']),
    });
    const mixed = await app.request(
      '/log-archive/configure',
      post({ environment: 'demo', mode: 'scheduled', tokenSource: 'staged', readToken: 'SENTINEL' })
    );
    expect(mixed.status).toBe(400);
    expect(await mixed.text()).not.toContain('SENTINEL');
  });
  it.each([
    new Error('log_archive_catalog_read_token_not_read_only'),
    new LogArchiveApiError(403, 'log_archive_permission_or_subscription_required'),
  ])('passes through verification codes and provider status', async (error) => {
    vi.mocked(LogArchiveApi.prototype.verifyCatalogCredentials).mockRejectedValue(error);
    const response = await createApiRoutes().request(
      '/log-archive/configure',
      post({ environment: 'demo', mode: 'scheduled', readToken: 'read', writeToken: 'write' })
    );
    expect(response.status).toBe(error instanceof LogArchiveApiError ? 403 : 400);
    expect(await response.json()).toMatchObject({ error: error.message });
  });
  it('rejects pipeline configuration without a staged sink', async () => {
    await stageLogArchiveSecrets(root, 'demo', { readToken: 'read', writeToken: 'write' });
    const response = await createApiRoutes().request(
      '/log-archive/configure',
      post({ environment: 'demo', mode: 'pipeline', tokenSource: 'staged' })
    );
    expect(await response.json()).toMatchObject({ error: 'log_archive_sink_credential_required' });
  });
  it('rejects strict issuance inputs before reaching token authority', async () => {
    const response = await createApiRoutes().request(
      '/log-archive/issue-tokens',
      post({
        environment: 'demo',
        mode: 'scheduled',
        bootstrapToken: 'SENTINEL_BOOTSTRAP_VALUE',
        readToken: 'extra',
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'log_archive_request_invalid' });
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it('validates manual duplicates before calling Cloudflare', async () => {
    const response = await createApiRoutes().request(
      '/log-archive/configure',
      post({ environment: 'demo', mode: 'scheduled', readToken: 'same', writeToken: 'same' })
    );
    expect(await response.json()).toMatchObject({
      error: 'log_archive_distinct_catalog_credentials_required',
    });
    expect(LogArchiveApi.prototype.verifyCatalogCredentials).not.toHaveBeenCalled();
  });
  it('uses a purpose-specific account-only token template without changing the Control template', async () => {
    const app = createApiRoutes();
    const response = await app.request(
      '/log-archive/token-template',
      post({ environment: 'demo' })
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    const url = new URL(result.url);
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys')!)).toEqual([
      { key: 'account_api_tokens', type: 'edit' },
    ]);
    expect(url.searchParams.get('name')).toBe('authrim-demo-aaaaaaaa-log-archive-bootstrap');
    expect(result.expiresOnDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });
  it('reports that an unused bootstrap still needs revocation when environment preconditions reject issuance', async () => {
    const response = await createApiRoutes().request(
      '/log-archive/issue-tokens',
      post({
        environment: 'missing',
        mode: 'scheduled',
        bootstrapToken: 'SENTINEL_BOOTSTRAP_VALUE',
      })
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'log_archive_environment_config_required',
      cleanupRequired: true,
    });
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it('rejects account A staged credentials while authenticated as account B without committing', async () => {
    const configPath = join(root, '.authrim/demo/config.json');
    const original = await readFile(configPath);
    mocks.issue.mockImplementationOnce(async (input) => {
      await stageLogArchiveSecrets(
        root,
        'demo',
        { readToken: 'SENTINEL_ACCOUNT_A_READ', writeToken: 'SENTINEL_ACCOUNT_A_WRITE' },
        { accountId: input.accountId, mode: input.mode }
      );
      return { readTokenId: 'read-id', writeTokenId: 'write-id' };
    });
    const issued = await createApiRoutes().request(
      '/log-archive/issue-tokens',
      post({ environment: 'demo', mode: 'scheduled', bootstrapToken: 'SENTINEL_BOOTSTRAP_VALUE' })
    );
    expect(issued.status).toBe(200);
    expect(await issued.text()).not.toContain('SENTINEL');
    vi.mocked(getAccountId).mockResolvedValueOnce('b'.repeat(32));
    const response = await createApiRoutes().request(
      '/log-archive/configure',
      post({ environment: 'demo', mode: 'scheduled', tokenSource: 'staged' })
    );
    expect(response.status).toBe(400);
    const result = await response.json();
    expect(result).toMatchObject({ error: 'log_archive_staged_account_mismatch' });
    expect(JSON.stringify(result)).not.toContain('SENTINEL_ACCOUNT_A');
    expect(await readFile(configPath)).toEqual(original);
    expect(LogArchiveApi.prototype.verifyCatalogCredentials).not.toHaveBeenCalled();
  });
  it('verifies account-bound staged credentials with the same verifier as manual input', async () => {
    await stageLogArchiveSecrets(
      root,
      'demo',
      { readToken: 'SENTINEL_READ', writeToken: 'SENTINEL_WRITE' },
      { accountId: 'a'.repeat(32), mode: 'scheduled' }
    );
    vi.mocked(LogArchiveApi.prototype.verifyCatalogCredentials).mockRejectedValueOnce(
      new Error('log_archive_catalog_read_token_not_read_only')
    );
    const response = await createApiRoutes().request(
      '/log-archive/configure',
      post({ environment: 'demo', mode: 'scheduled', tokenSource: 'staged' })
    );
    expect(await response.json()).toMatchObject({
      error: 'log_archive_catalog_read_token_not_read_only',
    });
    expect(LogArchiveApi.prototype.verifyCatalogCredentials).toHaveBeenCalledWith(
      'SENTINEL_READ',
      'SENTINEL_WRITE',
      undefined,
      undefined
    );
  });
  it('does not ask the deploy login to re-inspect policies of tokens Setup issued', async () => {
    await issuedPending(true);
    const response = await createApiRoutes().request(
      '/log-archive/configure',
      post({ environment: 'demo', mode: 'scheduled', tokenSource: 'staged' })
    );
    expect(await response.json()).toMatchObject({ success: true });
    expect(LogArchiveApi.prototype.verifyCatalogCredentials).toHaveBeenCalledWith(
      'SENTINEL_ISSUED_READ',
      'SENTINEL_ISSUED_WRITE',
      undefined,
      { inspectPolicies: false }
    );
  });
  it('sanitizes unknown issuance failures', async () => {
    mocks.issue.mockRejectedValue(new Error('SENTINEL_PROVIDER_VALUE'));
    const response = await createApiRoutes().request(
      'http://localhost/log-archive/issue-tokens',
      post({ environment: 'demo', mode: 'scheduled', bootstrapToken: 'SENTINEL_BOOTSTRAP_VALUE' })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'log_archive_configuration_invalid' });
  });
  it.each([false, true])(
    'refuses manual overwrite while issued recovery is pending (revoked=%s)',
    async (revoked) => {
      await issuedPending(revoked);
      const files = [
        'pending-log-archive-secrets.json',
        'pending-log-archive-secrets.metadata.json',
        'pending-log-archive-bootstrap.json',
        'config.json',
      ].map((name) => join(root, '.authrim/demo', name));
      const before = await Promise.all(files.map((file) => readFile(file)));
      const response = await createApiRoutes().request(
        '/log-archive/configure',
        post({
          environment: 'demo',
          mode: 'scheduled',
          tokenSource: 'manual',
          readToken: 'SENTINEL_MANUAL_READ',
          writeToken: 'SENTINEL_MANUAL_WRITE',
        })
      );
      expect(response.status).toBe(400);
      const result = await response.json();
      expect(result.error).toBe('log_archive_pending_recovery_required');
      expect(JSON.stringify(result)).not.toContain('SENTINEL');
      expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(before);
      expect(LogArchiveApi.prototype.verifyCatalogCredentials).not.toHaveBeenCalled();
    }
  );
  it.each(['scheduled', 'pipeline'] as const)(
    'returns safe staged status after reload (%s)',
    async (mode) => {
      const app = createApiRoutes();
      const headers = { 'X-Session-Token': session };
      const empty = await app.request('/log-archive/staged-status?environment=demo', { headers });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({
        success: true,
        complete: false,
        mode: null,
        accountMatches: false,
        pendingRecovery: false,
      });
      await stageLogArchiveSecrets(
        root,
        'demo',
        {
          readToken: 'SENTINEL_READ',
          writeToken: 'SENTINEL_WRITE',
          ...(mode === 'pipeline' ? { sinkToken: 'SENTINEL_SINK' } : {}),
        },
        { accountId: 'a'.repeat(32), mode }
      );
      const response = await app.request('/log-archive/staged-status?environment=demo', {
        headers,
      });
      expect(await response.json()).toEqual({
        success: true,
        complete: true,
        mode,
        accountMatches: true,
        pendingRecovery: false,
      });
      vi.mocked(getAccountId).mockResolvedValueOnce('c'.repeat(32));
      const mismatch = await app.request('/log-archive/staged-status?environment=demo', {
        headers,
      });
      expect(await mismatch.json()).toMatchObject({ complete: true, accountMatches: false });
      expect(
        await (await app.request('/log-archive/staged-status?environment=demo', { headers })).text()
      ).not.toMatch(/SENTINEL|Fingerprint|TokenId/u);
    }
  );
  it.each([false, true])(
    'reports issued recovery without exposing its secret values (revoked=%s)',
    async (revoked) => {
      await issuedPending(revoked);
      const response = await createApiRoutes().request(
        '/log-archive/staged-status?environment=demo',
        { headers: { 'X-Session-Token': session } }
      );
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toEqual({
        success: true,
        complete: revoked,
        mode: 'scheduled',
        accountMatches: true,
        pendingRecovery: true,
      });
      expect(JSON.stringify(result)).not.toMatch(/SENTINEL|Fingerprint|TokenId/u);
    }
  );
  it('requires a session and a valid environment for staged status', async () => {
    const app = createApiRoutes();
    expect((await app.request('/log-archive/staged-status?environment=demo')).status).toBe(401);
    const invalid = await app.request('/log-archive/staged-status?environment=../SENTINEL', {
      headers: { 'X-Session-Token': session },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain('SENTINEL');
  });
  it.each(['missing', 'wrong'])(
    'authenticates every log-archive route before side effects (%s session)',
    async (sessionKind) => {
      await stageLogArchiveSecrets(
        root,
        'demo',
        { readToken: 'SENTINEL_READ', writeToken: 'SENTINEL_WRITE' },
        { accountId: 'a'.repeat(32), mode: 'scheduled' }
      );
      const paths = [
        'config.json',
        'pending-log-archive-secrets.json',
        'pending-log-archive-secrets.metadata.json',
      ].map((name) => join(root, '.authrim/demo', name));
      const original = await Promise.all(paths.map((path) => readFile(path)));
      const config = JSON.parse(original[0].toString());
      const routes = [
        {
          path: '/log-archive/configure',
          body: {
            environment: 'demo',
            mode: 'scheduled',
            readToken: 'SENTINEL_MANUAL_READ',
            writeToken: 'SENTINEL_MANUAL_WRITE',
          },
        },
        {
          path: '/log-archive/configure',
          body: { environment: 'demo', mode: 'scheduled', tokenSource: 'staged' },
        },
        {
          path: '/log-archive/issue-tokens',
          body: {
            environment: 'demo',
            mode: 'scheduled',
            bootstrapToken: 'SENTINEL_BOOTSTRAP_SESSION_TEST',
          },
        },
        { path: '/log-archive/token-template', body: { environment: 'demo' } },
        { path: '/log-archive/plan', body: config },
        { path: '/log-archive/staged-status?environment=demo', body: undefined },
      ];
      const readSecrets = vi.spyOn(secretFiles, 'readPrivateFileSecurely');
      const writeSecrets = vi.spyOn(secretFiles, 'writePrivateFileAtomically');
      const app = createApiRoutes();
      vi.clearAllMocks();
      for (const route of routes) {
        const response = await app.request(route.path, {
          method: route.body ? 'POST' : 'GET',
          headers: {
            'Content-Type': 'text/plain',
            Origin: 'https://untrusted.invalid',
            ...(sessionKind === 'wrong' ? { 'X-Session-Token': 'SENTINEL_WRONG_SESSION' } : {}),
          },
          ...(route.body ? { body: JSON.stringify(route.body) } : {}),
        });
        expect(response.status, route.path).toBe(401);
        expect(await response.text()).not.toContain('SENTINEL');
        expect(readSecrets).not.toHaveBeenCalled();
        expect(writeSecrets).not.toHaveBeenCalled();
        expect(getAccountId).not.toHaveBeenCalled();
        expect(getCloudflareApiToken).not.toHaveBeenCalled();
        expect(mocks.issue).not.toHaveBeenCalled();
        expect(LogArchiveApi.prototype.verifyCatalogCredentials).not.toHaveBeenCalled();
        expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(original);
      }
      for (const route of routes) {
        const response = await app.request(
          route.path,
          route.body ? post(route.body) : { headers: { 'X-Session-Token': session } }
        );
        expect(response.status, route.path).toBe(200);
        expect(await response.text()).not.toContain('SENTINEL');
      }
    }
  );
});
