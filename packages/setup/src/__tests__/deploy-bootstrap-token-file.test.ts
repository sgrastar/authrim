import { execFile as execFileCallback } from 'node:child_process';
import { type BigIntStats } from 'node:fs';
import {
  chmod,
  link,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { consumeControlBootstrapTokenFile } from '../cli/commands/deploy.js';

const roots: string[] = [];
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'authrim-bootstrap-token-'));
  roots.push(root);
  return root;
}

describe('consumeControlBootstrapTokenFile', () => {
  it('reads and deletes a mode 0600 token file', async () => {
    const root = await createRoot();
    const path = join(root, 'token');
    await writeFile(path, 'bootstrap-token-value-123\n', { mode: 0o600 });

    await expect(consumeControlBootstrapTokenFile(path)).resolves.toBe('bootstrap-token-value-123');
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(process.platform !== 'win32')('rejects a group-readable token file', async () => {
    const root = await createRoot();
    const path = join(root, 'token');
    await writeFile(path, 'bootstrap-token-value-123', { mode: 0o600 });
    await chmod(path, 0o640);

    await expect(consumeControlBootstrapTokenFile(path)).rejects.toThrow('mode 0600');
    await expect(readFile(path, 'utf8')).resolves.toBe('bootstrap-token-value-123');
  });

  it('rejects a symlink without consuming its target', async () => {
    const root = await createRoot();
    const target = join(root, 'target');
    const path = join(root, 'token');
    await writeFile(target, 'bootstrap-token-value-123', { mode: 0o600 });
    await symlink(target, path);

    await expect(consumeControlBootstrapTokenFile(path)).rejects.toThrow('regular file');
    await expect(readFile(target, 'utf8')).resolves.toBe('bootstrap-token-value-123');
  });

  it('rejects whitespace and leaves the invalid file for inspection', async () => {
    const root = await createRoot();
    const path = join(root, 'token');
    await writeFile(path, 'bootstrap token value 123', { mode: 0o600 });

    await expect(consumeControlBootstrapTokenFile(path)).rejects.toThrow('invalid token');
    await expect(readFile(path, 'utf8')).resolves.toBe('bootstrap token value 123');
  });

  it.runIf(process.platform !== 'win32')('rejects a FIFO without hanging', async () => {
    const root = await createRoot();
    const path = join(root, 'token');
    await execFile('mkfifo', [path]);

    await expect(consumeControlBootstrapTokenFile(path)).rejects.toThrow('regular file');
  });

  it('rejects an oversized token before reading it into memory and leaves it in place', async () => {
    const root = await createRoot();
    const path = join(root, 'token');
    await writeFile(path, 'x'.repeat(4099), { mode: 0o600 });

    await expect(consumeControlBootstrapTokenFile(path)).rejects.toThrow('invalid token');
    await expect(readFile(path, 'utf8')).resolves.toHaveLength(4099);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a multiply linked token because consumption would not be one-time',
    async () => {
      const root = await createRoot();
      const path = join(root, 'token');
      const secondLink = join(root, 'token-copy');
      await writeFile(path, 'bootstrap-token-value-123', { mode: 0o600 });
      await link(path, secondLink);

      await expect(consumeControlBootstrapTokenFile(path)).rejects.toThrow('regular file');
      await expect(readFile(path, 'utf8')).resolves.toBe('bootstrap-token-value-123');
      await expect(readFile(secondLink, 'utf8')).resolves.toBe('bootstrap-token-value-123');
    }
  );

  it.runIf(process.platform !== 'win32')(
    'does not unlink a replacement installed after the pinned token was validated',
    async () => {
      const root = await createRoot();
      const path = join(root, 'token');
      const openedOriginalPath = join(root, 'opened-original-token');
      const originalToken = 'bootstrap-token-value-123';
      const replacementToken = 'replacement-token-value-456';
      await writeFile(path, originalToken, { mode: 0o600 });

      const probe = await open(path, 'r');
      type BigIntStat = (this: FileHandle, options: { bigint: true }) => Promise<BigIntStats>;
      const fileHandlePrototype = Object.getPrototypeOf(probe) as { stat: BigIntStat };
      await probe.close();
      const originalStat = fileHandlePrototype.stat;
      let statCalls = 0;
      let swappedAfterValidation = false;
      const statSpy = vi.spyOn(fileHandlePrototype, 'stat').mockImplementation(async function (
        this: FileHandle,
        options: { bigint: true }
      ) {
        const metadata = await originalStat.call(this, options);
        statCalls += 1;
        if (statCalls === 3) {
          swappedAfterValidation = true;
          await rename(path, openedOriginalPath);
          await writeFile(path, replacementToken, { mode: 0o600 });
        }
        return metadata;
      });

      try {
        await expect(consumeControlBootstrapTokenFile(path)).rejects.toThrow('regular file');
      } finally {
        statSpy.mockRestore();
      }

      expect(swappedAfterValidation).toBe(true);
      await expect(readFile(path, 'utf8')).resolves.toBe(replacementToken);
      await expect(readFile(openedOriginalPath, 'utf8')).resolves.toBe(originalToken);
      expect((await readdir(root)).filter((name) => name.startsWith('.authrim-consume-'))).toEqual(
        []
      );
    }
  );
});
