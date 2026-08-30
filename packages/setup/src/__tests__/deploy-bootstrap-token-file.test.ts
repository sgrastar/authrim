import { chmod, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { consumeControlBootstrapTokenFile } from '../cli/commands/deploy.js';

const roots: string[] = [];

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
});
