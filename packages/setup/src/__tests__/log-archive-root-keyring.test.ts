import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLogArchiveRootKeyring } from '../core/log-archive-root-keyring.js';
import { assertDistributedSecretValues, requiredWorkerSecretNames } from '../core/deploy.js';
import { getSecretNamesForWorker, SECRET_KEY_FILES } from '../core/secrets.js';
import { LOG_ARCHIVE_PRODUCER_COMPONENTS } from '../core/log-archive-config.js';

vi.mock('@authrim/ar-lib-logging/iceberg/capabilities', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-logging/iceberg/capabilities')>()),
  LOG_ARCHIVE_IMPLEMENTED_MODES: ['pipeline', 'scheduled'],
}));

const old = 'ab'.repeat(32),
  next = 'ef'.repeat(32);
const directories: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'authrim-log-root-'));
  directories.push(dir);
  await writeFile(join(dir, 'object_encryption_root_key.txt'), old, { mode: 0o600 });
  await writeFile(join(dir, 'metadata.json'), JSON.stringify({ kid: 'test', files: {} }), {
    mode: 0o600,
  });
  await writeFile(join(dir, 'log_archive_content_hmac_key.txt'), 'cd'.repeat(32), { mode: 0o600 });
  return dir;
}
const read = async (dir: string) =>
  JSON.parse(await readFile(join(dir, 'log_archive_root_keyring.json'), 'utf8'));
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('private log master history', () => {
  it('requires the keyring only on the twelve configured log producer/reader/consumer workers', () => {
    expect(LOG_ARCHIVE_PRODUCER_COMPONENTS).toHaveLength(12);
    expect(SECRET_KEY_FILES.LOG_ARCHIVE_ROOT_KEYRING).toBe('log_archive_root_keyring.json');
    for (const component of LOG_ARCHIVE_PRODUCER_COMPONENTS) {
      expect(getSecretNamesForWorker(component, { logArchive: true })).toContain(
        'LOG_ARCHIVE_ROOT_KEYRING'
      );
      expect(requiredWorkerSecretNames(component, undefined, true).all).toContain(
        'LOG_ARCHIVE_ROOT_KEYRING'
      );
      expect(getSecretNamesForWorker(component)).not.toContain('LOG_ARCHIVE_ROOT_KEYRING');
    }
    expect(getSecretNamesForWorker('ar-control', { logArchive: true })).not.toContain(
      'LOG_ARCHIVE_ROOT_KEYRING'
    );
    expect(getSecretNamesForWorker('ar-router', { logArchive: true })).not.toContain(
      'LOG_ARCHIVE_ROOT_KEYRING'
    );
  });

  it('rejects distributing a ring inconsistent with generated version or current master', async () => {
    const rootDir = await fixture();
    await mkdir(join(rootDir, 'packages/ar-auth'), { recursive: true });
    await writeFile(
      join(rootDir, 'packages/ar-auth/wrangler.toml'),
      '[env.test.vars]\nAUTHRIM_LOG_ARCHIVE_MODE = "scheduled"\nOBJECT_ENCRYPTION_KEY_VERSION = "1"\n'
    );
    const secrets = {
      OBJECT_ENCRYPTION_ROOT_KEY: old,
      LOG_ARCHIVE_CONTENT_HMAC_KEY: 'cd'.repeat(32),
      LOG_ARCHIVE_ROOT_KEYRING: JSON.stringify({
        schema_version: 1,
        current_version: 1,
        roots: { 1: old },
      }),
    };
    expect(() =>
      assertDistributedSecretValues({ rootDir, env: 'test', secrets }, ['ar-auth'])
    ).not.toThrow();
    expect(() =>
      assertDistributedSecretValues(
        {
          rootDir,
          env: 'test',
          secrets: {
            ...secrets,
            OBJECT_ENCRYPTION_ROOT_KEY: next,
          },
        },
        ['ar-auth']
      )
    ).toThrow('current_root_key_mismatch');
    expect(() =>
      assertDistributedSecretValues(
        {
          rootDir,
          env: 'test',
          secrets: {
            ...secrets,
            OBJECT_ENCRYPTION_ROOT_KEY: next,
            LOG_ARCHIVE_ROOT_KEYRING: JSON.stringify({
              schema_version: 1,
              current_version: 2,
              roots: { 1: old, 2: next },
            }),
          },
        },
        ['ar-auth']
      )
    ).toThrow('generated_key_version_mismatch');
  });
  it('registers the initial master, retains previous masters on rotation and never changes stable HMAC', async () => {
    const dir = await fixture();
    await ensureLogArchiveRootKeyring(dir, { keyVersion: 1 });
    expect(await read(dir)).toEqual({ schema_version: 1, current_version: 1, roots: { 1: old } });
    expect((await stat(join(dir, 'log_archive_root_keyring.json'))).mode & 0o777).toBe(0o600);
    await writeFile(join(dir, 'object_encryption_root_key.txt'), next, { mode: 0o600 });
    await ensureLogArchiveRootKeyring(dir, { keyVersion: 2, requireExisting: true });
    await ensureLogArchiveRootKeyring(dir, { keyVersion: 2, requireExisting: true });
    expect(await read(dir)).toEqual({
      schema_version: 1,
      current_version: 2,
      roots: { 1: old, 2: next },
    });
    expect(await readFile(join(dir, 'log_archive_content_hmac_key.txt'), 'utf8')).toBe(
      'cd'.repeat(32)
    );
  });

  it('rejects reuse of a version with different master material and version rollback', async () => {
    const dir = await fixture();
    await ensureLogArchiveRootKeyring(dir, { keyVersion: 1 });
    await writeFile(join(dir, 'object_encryption_root_key.txt'), next, { mode: 0o600 });
    await expect(ensureLogArchiveRootKeyring(dir, { keyVersion: 1 })).rejects.toThrow(
      'version_conflict'
    );
    await ensureLogArchiveRootKeyring(dir, { keyVersion: 2 });
    await expect(ensureLogArchiveRootKeyring(dir, { keyVersion: 1 })).rejects.toThrow(
      'version_rollback'
    );
    expect((await read(dir)).roots).toEqual({ 1: old, 2: next });
  });

  it('never regenerates a registry lost after initialization or provisioning', async () => {
    const dir = await fixture();
    await ensureLogArchiveRootKeyring(dir, { keyVersion: 1 });
    await rm(join(dir, 'log_archive_root_keyring.json'));
    await expect(ensureLogArchiveRootKeyring(dir, { keyVersion: 1 })).rejects.toThrow(
      'missing_restore_original_keys'
    );
    await rm(join(dir, 'metadata.json'));
    await expect(
      ensureLogArchiveRootKeyring(dir, { keyVersion: 1, requireExisting: true })
    ).rejects.toThrow('missing_restore_original_keys');
    await expect(read(dir)).rejects.toThrow();
  });

  it('rejects missing or public-readable masters without generating replacement secrets', async () => {
    const dir = await fixture();
    await rm(join(dir, 'object_encryption_root_key.txt'));
    await expect(ensureLogArchiveRootKeyring(dir, { keyVersion: 1 })).rejects.toThrow(
      'current_root_key_required'
    );
    await writeFile(join(dir, 'object_encryption_root_key.txt'), old, { mode: 0o644 });
    await expect(ensureLogArchiveRootKeyring(dir, { keyVersion: 1 })).rejects.toThrow(
      'permissions_invalid'
    );
    await expect(read(dir)).rejects.toThrow();
  });

  it('refuses a full registry rather than dropping any previous master', async () => {
    const dir = await fixture();
    const roots = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [i + 1, old]));
    const original = JSON.stringify({ schema_version: 1, current_version: 32, roots });
    await writeFile(join(dir, 'log_archive_root_keyring.json'), original, { mode: 0o600 });
    await expect(ensureLogArchiveRootKeyring(dir, { keyVersion: 33 })).rejects.toThrow(
      'root_keyring_invalid'
    );
    expect(await readFile(join(dir, 'log_archive_root_keyring.json'), 'utf8')).toBe(original);
  });
});
