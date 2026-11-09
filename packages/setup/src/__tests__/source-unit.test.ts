import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<Response>>());
vi.mock('../core/http-limits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/http-limits.js')>()),
  fetchWithTimeout: fetchMock,
}));

import {
  checkForUpdate,
  compareVersions,
  downloadTarball,
  downloadWithDegit,
  getAvailableTags,
  getCommitHash,
  getLatestRelease,
  getLocalVersion,
  getRemoteVersion,
  verifySourceStructure,
} from '../core/source.js';

describe('source metadata and local source validation', () => {
  let sourceDir = '';

  beforeEach(async () => {
    fetchMock.mockReset();
    sourceDir = await mkdtemp(join(tmpdir(), 'authrim-source-unit-'));
  });

  afterEach(async () => {
    await rm(sourceDir, { recursive: true, force: true });
  });

  it('reads release, commit, and tag metadata through the bounded HTTP client', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ tag_name: 'v1.2.3' }))
      .mockResolvedValueOnce(Response.json({ sha: 'a'.repeat(40) }))
      .mockResolvedValueOnce(Response.json([{ name: 'v1.2.3' }, { name: 'v1.2.2' }]));

    expect(await getLatestRelease('owner/repo')).toBe('v1.2.3');
    expect(await getCommitHash('owner/repo', 'v1.2.3')).toBe('a'.repeat(40));
    expect(await getAvailableTags('owner/repo')).toEqual(['v1.2.3', 'v1.2.2']);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/owner/repo/releases/latest',
      'https://api.github.com/repos/owner/repo/commits/v1.2.3',
      'https://api.github.com/repos/owner/repo/tags',
    ]);
  });

  it('returns no metadata on HTTP failure or a failed bounded read', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce(new Response('{', { status: 200 }));

    expect(await getLatestRelease('owner/repo')).toBeNull();
    expect(await getCommitHash('owner/repo', 'main')).toBeNull();
    expect(await getAvailableTags('owner/repo')).toEqual([]);
  });

  it('prefers the release tag and falls back to the main package version', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ tag_name: 'v1.2.3' }));
    expect(await getRemoteVersion('owner/repo')).toEqual({ version: '1.2.3', gitRef: 'v1.2.3' });

    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ version: '1.3.0' }));
    expect(await getRemoteVersion('owner/repo')).toEqual({ version: '1.3.0', gitRef: 'main' });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      'https://raw.githubusercontent.com/owner/repo/main/package.json'
    );
  });

  it('reports absent or malformed local package metadata without throwing', async () => {
    expect(await getLocalVersion(sourceDir)).toBeNull();
    await writeFile(join(sourceDir, 'package.json'), '{');
    expect(await getLocalVersion(sourceDir)).toBeNull();
    await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ version: '0.5.1' }));
    expect(await getLocalVersion(sourceDir)).toBe('0.5.1');
  });

  it('reports every missing required source path before accepting an extracted tree', async () => {
    const first = await verifySourceStructure(sourceDir);
    expect(first.valid).toBe(false);
    expect(first.errors).toContain('Missing required path: packages/ar-auth');
    expect(first.errors).toContain('Missing required path: package.json');

    for (const name of ['ar-auth', 'ar-token', 'ar-lib-core', 'ar-discovery']) {
      await mkdir(join(sourceDir, 'packages', name), { recursive: true });
    }
    await writeFile(join(sourceDir, 'package.json'), '{}');
    expect(await verifySourceStructure(sourceDir)).toEqual({ valid: true, errors: [] });
  });

  it('compares numeric version components and ignores an optional v prefix', () => {
    expect(compareVersions('v1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('1.10.0', 'v1.9.9')).toBe(1);
    expect(compareVersions('1.2.0', 'v1.2')).toBe(0);
  });

  it('reports an available update only when both versions exist and remote is newer', async () => {
    await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ version: '0.5.1' }));
    fetchMock.mockResolvedValueOnce(Response.json({ tag_name: 'v0.5.2' }));
    expect(await checkForUpdate(sourceDir, 'owner/repo')).toEqual({
      updateAvailable: true,
      localVersion: '0.5.1',
      remoteVersion: '0.5.2',
      gitRef: 'v0.5.2',
    });

    fetchMock.mockResolvedValueOnce(Response.json({ tag_name: 'v0.5.1' }));
    expect((await checkForUpdate(sourceDir, 'owner/repo')).updateAvailable).toBe(false);
    await rm(join(sourceDir, 'package.json'));
    fetchMock.mockResolvedValueOnce(Response.json({ tag_name: 'v0.5.2' }));
    expect(await checkForUpdate(sourceDir, 'owner/repo')).toMatchObject({
      updateAvailable: false,
      localVersion: null,
      remoteVersion: '0.5.2',
    });
  });

  it('rejects malformed repository and ref input before starting a download', async () => {
    await expect(
      downloadWithDegit({ targetDir: join(sourceDir, 'degit'), repository: 'owner/repo;echo' })
    ).rejects.toThrow('Invalid repository format');
    await expect(
      downloadTarball({ targetDir: join(sourceDir, 'tarball'), gitRef: 'main;echo' })
    ).rejects.toThrow('Invalid git ref format');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
