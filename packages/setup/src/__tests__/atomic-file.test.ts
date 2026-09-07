import { chmod, link, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPrivateFileSecurely } from '../core/atomic-file.js';

const directories: string[] = [];

async function createFile(mode: number): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'authrim-atomic-file-'));
  directories.push(directory);
  const path = join(directory, 'config.json');
  await writeFile(path, '{"environment":"test"}\n');
  await chmod(path, mode);
  return { directory, path };
}

const OPTIONS = {
  maxBytes: 1024,
  invalidError: 'config_invalid',
  permissionsError: 'config_permissions_invalid',
} as const;

describe('readPrivateFileSecurely legacy config permissions', () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it('repairs an owner-controlled legacy 0644 config through the pinned descriptor', async () => {
    const { path } = await createFile(0o644);

    await expect(
      readPrivateFileSecurely(path, {
        ...OPTIONS,
        repairLegacyPublicReadPermissions: true,
      })
    ).resolves.toBe('{"environment":"test"}\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('keeps exact 0600 enforcement unless legacy config repair is explicitly enabled', async () => {
    const { path } = await createFile(0o644);

    await expect(readPrivateFileSecurely(path, OPTIONS)).rejects.toThrow(
      'config_permissions_invalid'
    );
    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });

  it('does not repair a group-writable legacy file', async () => {
    const { path } = await createFile(0o664);

    await expect(
      readPrivateFileSecurely(path, {
        ...OPTIONS,
        repairLegacyPublicReadPermissions: true,
      })
    ).rejects.toThrow('config_permissions_invalid');
    expect((await stat(path)).mode & 0o777).toBe(0o664);
  });

  it('does not chmod a hard-linked legacy file', async () => {
    const { directory, path } = await createFile(0o644);
    await link(path, join(directory, 'other-link.json'));

    await expect(
      readPrivateFileSecurely(path, {
        ...OPTIONS,
        repairLegacyPublicReadPermissions: true,
      })
    ).rejects.toThrow('config_permissions_invalid');
    expect((await stat(path)).mode & 0o777).toBe(0o644);
  });
});
