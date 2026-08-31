import { existsSync } from 'node:fs';
import { lstat, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  withPrivateTemporaryBinaryFile,
  withPrivateTemporaryOutputFile,
  withPrivateTemporaryTextFile,
} from '../core/private-temporary-file.js';

const cleanupPaths: string[] = [];

async function expectPrivateRegularFile(path: string): Promise<void> {
  const file = await lstat(path);
  expect(file.isFile()).toBe(true);
  expect(file.isSymbolicLink()).toBe(false);
  expect(file.nlink).toBe(1);
  const directory = await lstat(dirname(path));
  expect(directory.isDirectory()).toBe(true);
  expect(directory.isSymbolicLink()).toBe(false);
  if (process.platform !== 'win32') {
    expect(file.mode & 0o777).toBe(0o600);
    expect(directory.mode & 0o777).toBe(0o700);
  }
}

describe('private temporary files', () => {
  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
  });

  it('creates private text, binary, and output files and removes them after use', async () => {
    const observedPaths: string[] = [];
    await withPrivateTemporaryTextFile('secret text', async (path) => {
      observedPaths.push(path);
      await expectPrivateRegularFile(path);
    });
    await withPrivateTemporaryBinaryFile(new Uint8Array([1, 2, 3]), async (path) => {
      observedPaths.push(path);
      await expectPrivateRegularFile(path);
    });
    await withPrivateTemporaryOutputFile(async (path) => {
      observedPaths.push(path);
      await expectPrivateRegularFile(path);
      await writeFile(path, new Uint8Array([4, 5, 6]));
      await expectPrivateRegularFile(path);
    });

    expect(observedPaths).toHaveLength(3);
    for (const path of observedPaths) {
      expect(existsSync(path)).toBe(false);
      expect(existsSync(dirname(path))).toBe(false);
    }
  });

  it('rejects a symlink substituted for the pinned file before trusting callback output', async () => {
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'authrim-private-outside-'));
    cleanupPaths.push(outsideDirectory);
    const outsidePath = join(outsideDirectory, 'outside.bin');
    await writeFile(outsidePath, 'outside', { mode: 0o600 });
    let temporaryPath = '';

    await expect(
      withPrivateTemporaryOutputFile(async (path, access) => {
        temporaryPath = path;
        await unlink(path);
        await symlink(outsidePath, path);
        await access.readBytes(1024);
      })
    ).rejects.toThrow('private_temporary_file_identity_changed');

    expect(existsSync(temporaryPath)).toBe(false);
    expect(existsSync(outsidePath)).toBe(true);
  });
});
