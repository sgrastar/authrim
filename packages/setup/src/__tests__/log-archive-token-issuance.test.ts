import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  issueLogArchiveTokens,
  resolveLogArchiveTokenInput,
} from '../core/log-archive-token-issuance.js';
import { loadLogArchiveSecrets } from '../core/log-archive-secrets.js';
import { loadPendingBootstrap } from '../core/pending-control-bootstrap.js';
import { CloudflareTokenBootstrapError } from '../core/cloudflare-control-token-bootstrap.js';
import * as issuance from '../core/log-archive-token-issuance.js';
import * as pendingStore from '../core/pending-control-bootstrap.js';
import {
  stageLogArchiveSecrets,
  loadStagedLogArchiveEvidence,
} from '../core/log-archive-secrets.js';
import type {
  CloudflareTokenAuthority,
  CloudflareTokenRecord,
} from '../core/cloudflare-control-token-bootstrap.js';

const accountId = 'a'.repeat(32);
const bootstrapId = 'b'.repeat(32);
const sentinel = 'SENTINEL_SECRET_MUST_NEVER_ESCAPE';
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const baseDir = await mkdtemp(join(tmpdir(), 'catalog-issuance-'));
  directories.push(baseDir);
  const groups = [
    'Workers R2 Data Catalog Read',
    'Workers R2 SQL Read',
    'Workers R2 Storage Read',
    'Workers R2 Data Catalog Write',
    'Workers R2 Storage Write',
  ].map((name, index) => ({ id: String(index), name, scopes: ['com.cloudflare.api.account'] }));
  const records = new Map<string, CloudflareTokenRecord>([
    [
      bootstrapId,
      {
        id: bootstrapId,
        name: 'bootstrap',
        status: 'active',
        policies: [
          {
            effect: 'allow',
            permission_groups: [{ id: 'boot', name: 'Account API Tokens Write' }],
            resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
          },
        ],
      },
    ],
  ]);
  const deleted: string[] = [];
  const afterRevocationCalls: string[] = [];
  function makeAuthority(authorityId = bootstrapId): CloudflareTokenAuthority {
    const active = (method: string) => {
      if (!records.has(authorityId)) {
        afterRevocationCalls.push(method);
        throw new CloudflareTokenBootstrapError('cloudflare_token_api_http_403');
      }
    };
    return {
      verifySelf: vi.fn(async () => {
        active('verifySelf');
        return { id: authorityId, status: 'active' as const };
      }),
      getToken: vi.fn(async (id) => {
        active('getToken');
        return records.get(id) ?? null;
      }),
      listTokens: vi.fn(async () => {
        active('listTokens');
        return [...records.values()];
      }),
      listPermissionGroups: vi.fn(async () => {
        active('listPermissionGroups');
        return groups;
      }),
      createToken: vi.fn(async (input) => {
        active('createToken');
        const id = (records.size + 1).toString(16).padStart(32, '0');
        const token = { ...input, id, status: 'active' as const, value: sentinel + id };
        records.set(id, token);
        return token;
      }),
      deleteToken: vi.fn(async (id) => {
        active('deleteToken');
        deleted.push(id);
        records.delete(id);
      }),
      verifyIssuedToken: vi.fn(async (value) => {
        active('verifyIssuedToken');
        const token = [...records.values()].find((record) => record.value === value);
        return token ? { id: token.id, status: token.status } : null;
      }),
      probeIssuedToken: vi.fn(async () => {
        active('probeIssuedToken');
        return 'allowed' as const;
      }),
    };
  }
  const authority = makeAuthority();
  const fetcher: typeof fetch = vi.fn(async (url, init) => {
    const path = String(url).split(`/accounts/${accountId}/`)[1];
    let result: unknown;
    if (path?.startsWith('tokens/permission_groups')) result = groups;
    else if (path === 'tokens/verify') {
      const value = new Headers(init?.headers).get('Authorization')?.slice(7);
      const token = [...records.values()].find((record) => record.value === value);
      result = token && { id: token.id, status: token.status };
    } else result = records.get(path?.split('/')[1]);
    return new Response(JSON.stringify({ success: true, result }));
  });
  return {
    baseDir,
    afterRevocationCalls,
    makeAuthority,
    groups,
    records,
    deleted,
    authority,
    fetcher,
    input: {
      baseDir,
      accountId,
      environment: 'demo',
      bootstrapToken: sentinel,
      authority,
      fetcher,
    },
  };
}

describe('Catalog token issuance', () => {
  it.each(['scheduled', 'pipeline'] as const)(
    'issues and stages exact account policies for %s without returning values',
    async (mode) => {
      const f = await fixture();
      const result = await issueLogArchiveTokens({ ...f.input, mode });
      expect(Object.keys(result)).toHaveLength(mode === 'pipeline' ? 3 : 2);
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(f.authority.createToken).toHaveBeenCalledTimes(mode === 'pipeline' ? 3 : 2);
      const children = [...f.records.values()];
      expect(children[0].policies[0].permission_groups.map((g) => g.id)).toEqual(['0', '1', '2']);
      expect(children[1].policies[0].permission_groups.map((g) => g.id)).toEqual(['3', '4']);
      for (const child of children)
        expect(child.policies[0].resources).toEqual({
          [`com.cloudflare.api.account.${accountId}`]: '*',
        });
      expect((await loadLogArchiveSecrets(f.baseDir, 'demo')).readToken).toContain(sentinel);
      expect(f.deleted).toContain(bootstrapId);
      expect(
        await loadPendingBootstrap({
          baseDir: f.baseDir,
          environment: 'demo',
          purpose: 'log-archive',
        })
      ).toBeNull();
    }
  );
  it.each(['missing', 'ambiguous'])(
    'fails closed on %s permission names before creating anything',
    async (kind) => {
      const f = await fixture();
      if (kind === 'missing') f.groups.shift();
      else f.groups.push({ ...f.groups[0], id: 'duplicate' });
      await expect(issueLogArchiveTokens({ ...f.input, mode: 'scheduled' })).rejects.toThrow(
        'log_archive_permission_group_invalid'
      );
      expect(f.authority.createToken).not.toHaveBeenCalled();
      expect(f.deleted).toContain(bootstrapId);
    }
  );
  it('revokes the first child and bootstrap on later failure and sanitizes arbitrary provider errors', async () => {
    const f = await fixture();
    vi.mocked(f.authority.getToken).mockImplementation(async (id) => {
      if (id !== bootstrapId) throw new Error(sentinel);
      return f.records.get(id) ?? null;
    });
    const error = await issueLogArchiveTokens({ ...f.input, mode: 'scheduled' }).catch(
      (e: Error) => e
    );
    expect(error).toMatchObject({ message: 'log_archive_token_issuance_failed' });
    expect(String(error)).not.toContain(sentinel);
    expect(f.deleted).toEqual(['2'.padStart(32, '0'), bootstrapId]);
  });
  it('keeps purpose-bound recovery state when revocation is interrupted and resumes without issuing', async () => {
    const f = await fixture();
    vi.mocked(f.authority.deleteToken).mockImplementation(async (id) => {
      if (id === bootstrapId) throw new Error(sentinel);
      f.records.delete(id);
    });
    await expect(issueLogArchiveTokens({ ...f.input, mode: 'scheduled' })).rejects.toMatchObject({
      code: 'log_archive_bootstrap_revocation_unconfirmed',
      cleanupRequired: true,
    });
    const pending = await loadPendingBootstrap({
      baseDir: f.baseDir,
      environment: 'demo',
      purpose: 'log-archive',
    });
    expect(pending).toMatchObject({ purpose: 'log-archive', bootstrapTokenId: bootstrapId });
    const count = vi.mocked(f.authority.createToken).mock.calls.length;
    vi.mocked(f.authority.deleteToken).mockImplementation(async (id) => {
      f.records.delete(id);
    });
    await expect(issueLogArchiveTokens({ ...f.input, mode: 'scheduled' })).rejects.toThrow(
      'log_archive_bootstrap_recovered_retry_required'
    );
    expect(f.authority.createToken).toHaveBeenCalledTimes(count);
    await expect(
      readFile(join(f.baseDir, '.authrim/demo/pending-control-bootstrap.json'))
    ).rejects.toThrow();
  });
  it('recovers a response-lost self-revocation with a separately verified one-time token', async () => {
    const f = await fixture();
    vi.mocked(f.authority.deleteToken).mockImplementation(async (id) => {
      f.records.delete(id);
      if (id === bootstrapId) throw new Error(sentinel);
    });
    await expect(issueLogArchiveTokens({ ...f.input, mode: 'scheduled' })).rejects.toMatchObject({
      cleanupRequired: true,
    });
    const recoveryId = 'c'.repeat(32);
    f.records.set(recoveryId, {
      id: recoveryId,
      name: 'recovery',
      status: 'active',
      policies: [
        {
          effect: 'allow',
          permission_groups: [{ id: 'boot', name: 'Account API Tokens Write' }],
          resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
        },
      ],
    });
    const recoveryAuthority = f.makeAuthority(recoveryId);
    const result = await issueLogArchiveTokens({
      ...f.input,
      mode: 'scheduled',
      bootstrapToken: 'separate-recovery-secret',
      authority: recoveryAuthority,
    });
    expect(f.records.size).toBe(2);
    expect(f.records.has(bootstrapId)).toBe(false);
    expect(f.records.has(recoveryId)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(
      await loadPendingBootstrap({
        baseDir: f.baseDir,
        environment: 'demo',
        purpose: 'log-archive',
      })
    ).toBeNull();
    expect((await loadLogArchiveSecrets(f.baseDir, 'demo')).readToken).toContain(sentinel);
    const calls = Object.values(recoveryAuthority).reduce(
      (n, fn) => n + vi.mocked(fn).mock.calls.length,
      0
    );
    const reused = await issuance.ensureLogArchiveTokens({
      ...f.input,
      mode: 'scheduled',
      bootstrapToken: 'separate-recovery-secret',
      authority: recoveryAuthority,
    });
    expect(reused).toMatchObject({ reused: true, readTokenId: result.readTokenId });
    expect(
      Object.values(recoveryAuthority).reduce((n, fn) => n + vi.mocked(fn).mock.calls.length, 0)
    ).toBe(calls);
    expect(JSON.stringify(reused)).not.toContain(sentinel);
  });
  it('rejects broadened policy readback and cleans up both credentials', async () => {
    const f = await fixture();
    vi.mocked(f.authority.getToken).mockImplementation(async (id) => {
      const token = f.records.get(id);
      return token && id !== bootstrapId
        ? { ...token, policies: [...token.policies, token.policies[0]] }
        : (token ?? null);
    });
    await expect(issueLogArchiveTokens({ ...f.input, mode: 'scheduled' })).rejects.toThrow(
      'log_archive_issued_token_scope_invalid'
    );
    expect(f.records.size).toBe(0);
  });
  it('reports incomplete child cleanup and preserves the exact child IDs for recovery', async () => {
    const f = await fixture();
    vi.mocked(f.authority.getToken).mockImplementation(async (id) => {
      if (id !== bootstrapId) throw new Error(sentinel);
      return f.records.get(id) ?? null;
    });
    vi.mocked(f.authority.deleteToken).mockImplementation(async (id) => {
      if (id !== bootstrapId) throw new Error(sentinel);
      f.records.delete(id);
    });
    const error = await issueLogArchiveTokens({ ...f.input, mode: 'scheduled' }).catch(
      (e: Error) => e
    );
    expect(error).toMatchObject({
      code: 'log_archive_child_cleanup_unconfirmed',
      cleanupRequired: true,
      childCleanupRequired: true,
    });
    expect(JSON.stringify(error)).not.toContain(sentinel);
    expect(
      (
        await loadPendingBootstrap({
          baseDir: f.baseDir,
          environment: 'demo',
          purpose: 'log-archive',
        })
      )?.childTokenIds
    ).toEqual(['2'.padStart(32, '0')]);
    expect(f.records.has(bootstrapId)).toBe(false);
  });
  it('reports unconfirmed revocation if bootstrap preflight cannot establish an identity', async () => {
    const f = await fixture();
    vi.mocked(f.authority.verifySelf).mockRejectedValue(new Error(sentinel));
    await expect(issueLogArchiveTokens({ ...f.input, mode: 'scheduled' })).rejects.toMatchObject({
      code: 'log_archive_bootstrap_revocation_unconfirmed',
      cleanupRequired: true,
    });
    expect(f.authority.createToken).not.toHaveBeenCalled();
  });
  it('keeps purpose-bound recovery inside the environment even when the project path contains the Control filename', async () => {
    const f = await fixture();
    const baseDir = join(f.baseDir, 'pending-control-bootstrap-project');
    const environmentDir = join(baseDir, '.authrim', 'demo');
    await mkdir(environmentDir, { recursive: true });
    const controlPath = join(environmentDir, 'pending-control-bootstrap.json');
    await writeFile(controlPath, 'CONTROL_RECOVERY_UNCHANGED');
    vi.mocked(f.authority.deleteToken).mockImplementation(async (id) => {
      if (id === bootstrapId) throw new Error(sentinel);
      f.records.delete(id);
    });
    await expect(
      issueLogArchiveTokens({ ...f.input, baseDir, mode: 'scheduled' })
    ).rejects.toMatchObject({ cleanupRequired: true });
    expect(
      JSON.parse(await readFile(join(environmentDir, 'pending-log-archive-bootstrap.json'), 'utf8'))
        .purpose
    ).toBe('log-archive');
    expect(await readFile(controlPath, 'utf8')).toBe('CONTROL_RECOVERY_UNCHANGED');
  });
  it('prefers exact Cloudflare group names over bucket-item regex matches', async () => {
    const f = await fixture();
    f.groups.push(
      {
        id: 'bucket-read',
        name: 'Workers R2 Storage Bucket Item Read',
        scopes: ['com.cloudflare.api.account'],
      },
      {
        id: 'bucket-write',
        name: 'Workers R2 Storage Bucket Item Write',
        scopes: ['com.cloudflare.api.account'],
      }
    );
    const result = await issueLogArchiveTokens({ ...f.input, mode: 'scheduled' });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(
      f.records.get(result.readTokenId)!.policies[0].permission_groups.map((g) => g.id)
    ).toEqual(['0', '1', '2']);
    expect(
      f.records.get(result.writeTokenId)!.policies[0].permission_groups.map((g) => g.id)
    ).toEqual(['3', '4']);
  });
  it('fails closed when only multiple fallback name matches exist', async () => {
    const f = await fixture();
    f.groups[2].name = 'R2 Storage Bucket Item Read';
    f.groups.push({
      id: 'bucket-other',
      name: 'R2 Storage Other Read',
      scopes: ['com.cloudflare.api.account'],
    });
    await expect(issueLogArchiveTokens({ ...f.input, mode: 'scheduled' })).rejects.toThrow(
      'log_archive_permission_group_invalid'
    );
    expect(f.authority.createToken).not.toHaveBeenCalled();
    expect(f.records.has(bootstrapId)).toBe(false);
  });
  it('clears a definitively rejected create checkpoint and allows a clean next run', async () => {
    const f = await fixture();
    vi.mocked(f.authority.createToken).mockRejectedValueOnce(
      new CloudflareTokenBootstrapError('cloudflare_token_api_http_400')
    );
    const deleteToken = vi.mocked(f.authority.deleteToken).getMockImplementation()!;
    vi.mocked(f.authority.deleteToken).mockImplementation(async (id) => {
      if (id === bootstrapId)
        expect(
          (
            await loadPendingBootstrap({
              baseDir: f.baseDir,
              environment: 'demo',
              purpose: 'log-archive',
            })
          )?.pendingCreateName
        ).toBeNull();
      await deleteToken(id);
    });
    await expect(issueLogArchiveTokens({ ...f.input, mode: 'scheduled' })).rejects.toThrow(
      'log_archive_token_issuance_failed'
    );
    expect(f.records.size).toBe(0);
    expect(
      await loadPendingBootstrap({
        baseDir: f.baseDir,
        environment: 'demo',
        purpose: 'log-archive',
      })
    ).toBeNull();
    const next = await fixture();
    await expect(
      issueLogArchiveTokens({ ...next.input, baseDir: f.baseDir, mode: 'scheduled' })
    ).resolves.toHaveProperty('readTokenId');
  });
  it('retains the pending create name when the provider outcome is unknown', async () => {
    const f = await fixture();
    vi.mocked(f.authority.createToken).mockRejectedValue(
      new CloudflareTokenBootstrapError('cloudflare_token_api_response_lost')
    );
    await expect(issueLogArchiveTokens({ ...f.input, mode: 'scheduled' })).rejects.toMatchObject({
      cleanupRequired: true,
    });
    const pending = await loadPendingBootstrap({
      baseDir: f.baseDir,
      environment: 'demo',
      purpose: 'log-archive',
    });
    expect(pending).toMatchObject({ phase: 'creating' });
    expect(pending?.pendingCreateName).toContain('log-archive-read');
  });
  it.each(['unlink', 'fsync'])(
    'preserves a successful issuance after local %s cleanup fails',
    async (failure) => {
      const f = await fixture();
      const deleteToken = vi.mocked(f.authority.deleteToken).getMockImplementation()!;
      vi.mocked(f.authority.deleteToken).mockImplementation(async (id) => {
        if (id === bootstrapId) {
          const checkpoint = await loadPendingBootstrap({
            baseDir: f.baseDir,
            environment: 'demo',
            purpose: 'log-archive',
          });
          expect(checkpoint).toMatchObject({ phase: 'issued', bootstrapRevoked: false });
          expect(checkpoint?.stagedSecretsFingerprint).toMatch(/^[a-f0-9]{64}$/u);
        }
        await deleteToken(id);
      });
      const clear = pendingStore.clearPendingBootstrap;
      vi.spyOn(pendingStore, 'clearPendingBootstrap').mockImplementationOnce(async (input) => {
        if (failure === 'fsync') await clear(input);
        throw new Error(sentinel);
      });
      const result = await issueLogArchiveTokens({ ...f.input, mode: 'scheduled' });
      const checkpoint = await loadPendingBootstrap({
        baseDir: f.baseDir,
        environment: 'demo',
        purpose: 'log-archive',
      });
      if (failure === 'unlink')
        expect(checkpoint).toMatchObject({ phase: 'issued', bootstrapRevoked: true });
      else expect(checkpoint).toBeNull();
      const evidence = await loadStagedLogArchiveEvidence(f.baseDir, 'demo');
      expect(evidence).toMatchObject({ accountId, mode: 'scheduled', bootstrapRevoked: true });
      expect(JSON.stringify(evidence)).not.toContain(sentinel);
      expect(result).toMatchObject({ warning: 'log_archive_local_cleanup_pending' });
      expect(JSON.stringify(result)).not.toContain(sentinel);
      expect(f.records.has(bootstrapId)).toBe(false);
      expect(f.records.size).toBe(2);
      expect((await loadLogArchiveSecrets(f.baseDir, 'demo')).readToken).toContain(sentinel);
      expect(f.afterRevocationCalls).toEqual([]);
      const beforeCalls = Object.values(f.authority).reduce(
        (n, fn) => n + vi.mocked(fn).mock.calls.length,
        0
      );
      const reused = await issuance.ensureLogArchiveTokens({ ...f.input, mode: 'scheduled' });
      expect(reused).toMatchObject({
        reused: true,
        readTokenId: result.readTokenId,
        writeTokenId: result.writeTokenId,
      });
      expect(JSON.stringify(reused)).not.toContain(sentinel);
      expect(
        Object.values(f.authority).reduce((n, fn) => n + vi.mocked(fn).mock.calls.length, 0)
      ).toBe(beforeCalls);
      expect(
        await loadPendingBootstrap({
          baseDir: f.baseDir,
          environment: 'demo',
          purpose: 'log-archive',
        })
      ).toBeNull();
    }
  );
  it('refuses reissuance over existing staged bytes before using the new bootstrap', async () => {
    const f = await fixture();
    await stageLogArchiveSecrets(f.baseDir, 'demo', {
      readToken: 'PREVIOUS_READ_SENTINEL',
      writeToken: 'PREVIOUS_WRITE_SENTINEL',
    });
    const path = join(f.baseDir, '.authrim/demo/pending-log-archive-secrets.json');
    const original = await readFile(path);
    vi.mocked(f.authority.deleteToken).mockRejectedValue(new Error(sentinel));
    const error = await issueLogArchiveTokens({ ...f.input, mode: 'scheduled' }).catch(
      (e: Error) => e
    );
    expect(error).toMatchObject({ code: 'log_archive_staged_credentials_exist' });
    expect(await readFile(path)).toEqual(original);
    expect(f.authority.verifySelf).not.toHaveBeenCalled();
    expect(f.authority.createToken).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain(sentinel);
    expect(JSON.stringify(error)).not.toContain('PREVIOUS_READ_SENTINEL');
  });
  it('reuses verified staged credentials on CLI resume with the same bootstrap environment variable', async () => {
    const f = await fixture();
    const source = resolveLogArchiveTokenInput({ LOG_ARCHIVE_BOOTSTRAP_TOKEN: sentinel })!;
    expect(source).toHaveProperty('bootstrapToken');
    const first = await issuance.ensureLogArchiveTokens({
      ...f.input,
      ...source,
      mode: 'scheduled',
    });
    const calls = Object.values(f.authority).reduce(
      (n, fn) => n + vi.mocked(fn).mock.calls.length,
      0
    );
    const second = await issuance.ensureLogArchiveTokens({
      ...f.input,
      ...source,
      mode: 'scheduled',
    });
    expect(second).toMatchObject({
      reused: true,
      readTokenId: first.readTokenId,
      writeTokenId: first.writeTokenId,
    });
    expect(
      Object.values(f.authority).reduce((n, fn) => n + vi.mocked(fn).mock.calls.length, 0)
    ).toBe(calls);
    expect(f.afterRevocationCalls).toEqual([]);
    expect(JSON.stringify(second)).not.toContain(sentinel);
  });
  it('rejects mixed environment sources and accepts bootstrap-only input', () => {
    expect(resolveLogArchiveTokenInput({ LOG_ARCHIVE_BOOTSTRAP_TOKEN: sentinel })).toEqual({
      bootstrapToken: sentinel,
    });
    expect(() =>
      resolveLogArchiveTokenInput({
        LOG_ARCHIVE_BOOTSTRAP_TOKEN: sentinel,
        LOG_ARCHIVE_CATALOG_READ_TOKEN: 'read',
      })
    ).toThrow('log_archive_token_sources_conflict');
    expect(
      resolveLogArchiveTokenInput({
        LOG_ARCHIVE_CATALOG_READ_TOKEN: 'read',
        LOG_ARCHIVE_CATALOG_WRITE_TOKEN: 'write',
      })
    ).toEqual({ readToken: 'read', writeToken: 'write' });
  });
  it.each(['observed-name', 'already-absent-id'])(
    'persists partial cleanup before retrying bootstrap revocation (%s)',
    async (scenario) => {
      const f = await fixture();
      const childId = '2'.repeat(32);
      const childName = 'authrim-demo-aaaaaaaa-log-archive-read';
      if (scenario === 'observed-name')
        f.records.set(childId, { id: childId, name: childName, status: 'active', policies: [] });
      await pendingStore.stagePendingBootstrap({
        baseDir: f.baseDir,
        artifact: {
          version: 2,
          phase: 'creating',
          bootstrapRevoked: false,
          purpose: 'log-archive',
          environment: 'demo',
          accountId,
          ownership: 'account',
          bootstrapToken: sentinel,
          bootstrapTokenId: bootstrapId,
          childTokenNames: [childName],
          preservedTokenIds: [bootstrapId],
          childTokenIds: scenario === 'observed-name' ? [] : [childId],
          pendingCreateName: scenario === 'observed-name' ? childName : null,
          stagedSecretsFingerprint: null,
          recoveryToken: null,
          revocationTargetTokenIds: [bootstrapId],
        },
      });
      const remove = vi.mocked(f.authority.deleteToken).getMockImplementation()!;
      let failBootstrapOnce = true;
      vi.mocked(f.authority.deleteToken).mockImplementation(async (id) => {
        if (id === bootstrapId && failBootstrapOnce) {
          failBootstrapOnce = false;
          throw new Error(sentinel);
        }
        if (!f.records.has(id))
          throw new CloudflareTokenBootstrapError('cloudflare_token_api_http_404');
        await remove(id);
      });
      await expect(issueLogArchiveTokens({ ...f.input, mode: 'scheduled' })).rejects.toMatchObject({
        code: 'log_archive_bootstrap_revocation_unconfirmed',
      });
      const pending = await loadPendingBootstrap({
        baseDir: f.baseDir,
        environment: 'demo',
        purpose: 'log-archive',
      });
      expect(pending).toMatchObject({ pendingCreateName: null, childTokenIds: [] });
      const error = await issueLogArchiveTokens({ ...f.input, mode: 'scheduled' }).catch(
        (error: unknown) => error
      );
      expect(error).toMatchObject({ code: 'log_archive_bootstrap_recovered_retry_required' });
      expect(String(error)).not.toContain(sentinel);
      expect(f.records.size).toBe(0);
      expect(f.afterRevocationCalls).toEqual([]);
      expect(
        await loadPendingBootstrap({
          baseDir: f.baseDir,
          environment: 'demo',
          purpose: 'log-archive',
        })
      ).toBeNull();
    }
  );

  it('guards the CLI manual staging boundary while issued cleanup is pending', async () => {
    const f = await fixture();
    vi.spyOn(pendingStore, 'clearPendingBootstrap').mockRejectedValueOnce(new Error(sentinel));
    await issueLogArchiveTokens({ ...f.input, mode: 'scheduled' });
    const files = [
      'pending-log-archive-secrets.json',
      'pending-log-archive-secrets.metadata.json',
    ].map((name) => join(f.baseDir, '.authrim/demo', name));
    const before = await Promise.all(files.map((file) => readFile(file)));
    const error = await stageLogArchiveSecrets(f.baseDir, 'demo', {
      readToken: sentinel + '-manual-read',
      writeToken: sentinel + '-manual-write',
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('log_archive_pending_recovery_required');
    expect(String(error)).not.toContain(sentinel);
    expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(before);
  });
  it('leaves no create checkpoint if the helper pre-POST listing fails', async () => {
    const f = await fixture();
    const list = vi.mocked(f.authority.listTokens).getMockImplementation()!;
    let listings = 0;
    vi.mocked(f.authority.listTokens).mockImplementation(async () => {
      if (++listings === 2) throw new Error(sentinel);
      return list();
    });
    let checkpoint: Awaited<ReturnType<typeof loadPendingBootstrap>> = null;
    const remove = vi.mocked(f.authority.deleteToken).getMockImplementation()!;
    vi.mocked(f.authority.deleteToken).mockImplementation(async (id) => {
      if (id === bootstrapId)
        checkpoint = await loadPendingBootstrap({
          baseDir: f.baseDir,
          environment: 'demo',
          purpose: 'log-archive',
        });
      await remove(id);
    });
    const error = await issueLogArchiveTokens({ ...f.input, mode: 'scheduled' }).catch(
      (error: unknown) => error
    );
    expect(checkpoint).toMatchObject({ pendingCreateName: null, childTokenIds: [] });
    expect(f.authority.createToken).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'log_archive_token_issuance_failed' });
    expect(String(error)).not.toContain(sentinel);
    expect(f.records.size).toBe(0);
    expect(
      await loadPendingBootstrap({
        baseDir: f.baseDir,
        environment: 'demo',
        purpose: 'log-archive',
      })
    ).toBeNull();
    const next = await fixture();
    await expect(
      issueLogArchiveTokens({ ...next.input, baseDir: f.baseDir, mode: 'scheduled' })
    ).resolves.toHaveProperty('readTokenId');
  });
  it('persists helper observation and confirmed deletion before a later listing failure', async () => {
    const f = await fixture();
    const loadCheckpoint = () =>
      loadPendingBootstrap({ baseDir: f.baseDir, environment: 'demo', purpose: 'log-archive' });
    const list = vi.mocked(f.authority.listTokens).getMockImplementation()!;
    let listings = 0;
    let deletedCheckpoint: Awaited<ReturnType<typeof loadPendingBootstrap>> = null;
    vi.mocked(f.authority.listTokens).mockImplementation(async () => {
      if (++listings === 5) {
        deletedCheckpoint = await loadCheckpoint();
        throw new Error(sentinel);
      }
      return list();
    });
    const create = vi.mocked(f.authority.createToken).getMockImplementation()!;
    vi.mocked(f.authority.createToken).mockImplementationOnce(async (input) => {
      await create(input);
      throw new CloudflareTokenBootstrapError('cloudflare_token_api_response_lost');
    });
    const remove = vi.mocked(f.authority.deleteToken).getMockImplementation()!;
    let observedCheckpoint: Awaited<ReturnType<typeof loadPendingBootstrap>> = null;
    let failBootstrapOnce = true;
    vi.mocked(f.authority.deleteToken).mockImplementation(async (id) => {
      if (id === bootstrapId && failBootstrapOnce) {
        failBootstrapOnce = false;
        throw new Error(sentinel);
      }
      if (id !== bootstrapId) observedCheckpoint = await loadCheckpoint();
      await remove(id);
    });
    const error = await issueLogArchiveTokens({ ...f.input, mode: 'scheduled' }).catch(
      (error: unknown) => error
    );
    expect(error).toMatchObject({
      code: 'log_archive_bootstrap_revocation_unconfirmed',
      childCleanupRequired: false,
    });
    expect(String(error)).not.toContain(sentinel);
    expect(observedCheckpoint).toMatchObject({
      pendingCreateName: null,
      childTokenIds: ['2'.padStart(32, '0')],
    });
    expect(deletedCheckpoint).toMatchObject({ pendingCreateName: null, childTokenIds: [] });
    expect(await loadCheckpoint()).toMatchObject({ pendingCreateName: null, childTokenIds: [] });
    expect(f.authority.createToken).toHaveBeenCalledTimes(1);
    await expect(issueLogArchiveTokens({ ...f.input, mode: 'scheduled' })).rejects.toMatchObject({
      code: 'log_archive_bootstrap_recovered_retry_required',
    });
    expect(await loadCheckpoint()).toBeNull();
    expect(f.records.size).toBe(0);
    expect(f.afterRevocationCalls).toEqual([]);
  });
  it('preserves a same-named token discovered just before our rejected POST', async () => {
    const f = await fixture();
    const foreignId = 'e'.repeat(32);
    const foreignName = 'authrim-demo-aaaaaaaa-log-archive-write';
    const list = vi.mocked(f.authority.listTokens).getMockImplementation()!;
    let listings = 0;
    vi.mocked(f.authority.listTokens).mockImplementation(async () => {
      if (++listings === 3)
        f.records.set(foreignId, {
          id: foreignId,
          name: foreignName,
          status: 'active',
          policies: [],
        });
      return list();
    });
    const create = vi.mocked(f.authority.createToken).getMockImplementation()!;
    let checkpoint: Awaited<ReturnType<typeof loadPendingBootstrap>> = null;
    vi.mocked(f.authority.createToken).mockImplementation(async (input) => {
      if (input.name === foreignName) {
        checkpoint = await loadPendingBootstrap({
          baseDir: f.baseDir,
          environment: 'demo',
          purpose: 'log-archive',
        });
        throw new CloudflareTokenBootstrapError('cloudflare_token_api_http_400');
      }
      return create(input);
    });
    const error = await issueLogArchiveTokens({ ...f.input, mode: 'scheduled' }).catch(
      (error: unknown) => error
    );
    expect(error).toMatchObject({ code: 'log_archive_token_issuance_failed' });
    expect(String(error)).not.toContain(sentinel);
    expect(checkpoint?.preservedTokenIds).toContain(foreignId);
    expect([...f.records.keys()]).toEqual([foreignId]);
    expect(f.deleted).toContain('2'.padStart(32, '0'));
    expect(f.deleted).toContain(bootstrapId);
    expect(f.deleted).not.toContain(foreignId);
    expect(
      await loadPendingBootstrap({
        baseDir: f.baseDir,
        environment: 'demo',
        purpose: 'log-archive',
      })
    ).toBeNull();
  });
});
