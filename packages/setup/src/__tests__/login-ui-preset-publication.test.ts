import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOGIN_UI_PRESET_SOURCE_DIR,
  listLoginUiPresetFiles,
  publishLoginUiPresets,
  publishLoginUiPresetsToEnvironment,
} from '../core/login-ui-preset-publication.js';

let base: string;
let presets: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'authrim-presets-'));
  presets = join(base, LOGIN_UI_PRESET_SOURCE_DIR);
  await mkdir(join(presets, 'nature'), { recursive: true });
  await mkdir(join(presets, 'paper'), { recursive: true });
  await mkdir(join(presets, 'Bad Category'), { recursive: true });
  await writeFile(join(presets, 'nature', 'forest.webp'), 'webp-bytes');
  await writeFile(join(presets, 'paper', 'washi.png'), 'png-bytes');
  await writeFile(join(presets, 'paper', 'notes.txt'), 'not an image');
  await writeFile(join(presets, 'Bad Category', 'a.webp'), 'skipped');
  await writeFile(join(base, 'outside.webp'), 'outside');
  await symlink(join(base, 'outside.webp'), join(presets, 'nature', 'escape.webp'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('Login UI background preset publication', () => {
  it('finds the pictures of each category, and nothing outside the folder', async () => {
    const files = await listLoginUiPresetFiles(base);
    expect(files.map((f) => [f.objectKey, f.contentType])).toEqual([
      ['presets/login-ui/backgrounds/nature/forest.webp', 'image/webp'],
      ['presets/login-ui/backgrounds/paper/washi.png', 'image/png'],
    ]);
  });

  it('records the keys, then puts every picture in the bucket once it is known to be ours', async () => {
    const order: string[] = [];
    const upload = vi.fn(async ({ objectKey }: { objectKey: string }) => {
      order.push(`put ${objectKey}`);
    });
    const verify = vi.fn(async () => {
      order.push('verify');
    });
    const record = vi.fn(async (keys: readonly string[]) => {
      order.push(`record ${keys.length}`);
    });
    const result = await publishLoginUiPresets({
      baseDir: base,
      bucketName: 'test-public-assets',
      upload,
      verifyBucketOwnership: verify,
      recordObjectKeys: record,
    });
    expect(order.slice(0, 2)).toEqual(['verify', 'record 2']);
    expect(result.published).toEqual([
      'presets/login-ui/backgrounds/nature/forest.webp',
      'presets/login-ui/backgrounds/paper/washi.png',
    ]);
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketName: 'test-public-assets',
        objectKey: 'presets/login-ui/backgrounds/nature/forest.webp',
        contentType: 'image/webp',
      })
    );
  });

  it('publishes nothing without a bucket or without pictures', async () => {
    const upload = vi.fn(async () => undefined);
    expect(await publishLoginUiPresets({ baseDir: base, upload })).toEqual({
      published: [],
      skipped: 'no_bucket',
    });
    expect(
      await publishLoginUiPresets({ baseDir: join(base, 'none'), bucketName: 'b', upload })
    ).toEqual({ published: [], skipped: 'no_presets' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('reports a failure as a warning instead of stopping the deployment', async () => {
    const warnings: string[] = [];
    const result = await publishLoginUiPresetsToEnvironment({
      baseDir: base,
      environment: 'test',
      // No ownership marker: the check fails.
      bucket: { name: 'test-public-assets' },
      recordObjectKeys: async () => undefined,
      onWarning: (message) => warnings.push(message),
    });
    expect(result).toBeNull();
    expect(warnings[0]).toMatch(/^Login UI background presets were not published/);
  });
});
