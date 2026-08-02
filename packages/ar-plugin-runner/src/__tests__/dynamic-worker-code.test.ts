import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { R2PluginWorkerCodeResolver } from '../dynamic-worker-code';

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    pluginId: 'plugin-a',
    compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat'],
    mainModule: 'index.js',
    modules: { 'index.js': 'export default { fetch() { return new Response(null); } }' },
    ...overrides,
  };
}

function r2Object(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return {
    bytes,
    bucket: {
      get: vi.fn(async () => ({
        size: bytes.byteLength,
        arrayBuffer: async () => bytes.buffer,
      })),
    } as never,
    digest: createHash('sha256').update(bytes).digest('hex'),
  };
}

function objectKey(pluginId: string, digest: string): string {
  return `plugins/${pluginId}/${digest}.json`;
}

describe('R2PluginWorkerCodeResolver', () => {
  it('returns only a digest-verified exact bundle with network disabled by default', async () => {
    const object = r2Object(bundle());
    const resolver = new R2PluginWorkerCodeResolver(object.bucket);

    await expect(
      resolver.resolve({
        pluginId: 'plugin-a',
        codeObjectKey: objectKey('plugin-a', object.digest),
        codeSha256: object.digest,
      })
    ).resolves.toEqual({
      compatibilityDate: '2026-07-30',
      compatibilityFlags: ['nodejs_compat'],
      mainModule: 'index.js',
      modules: bundle().modules,
      globalOutbound: null,
    });
  });

  it('rejects missing stores, malformed references, digest mismatch, and cross-plugin bundles', async () => {
    await expect(
      new R2PluginWorkerCodeResolver(undefined).resolve({
        pluginId: 'plugin-a',
        codeObjectKey: objectKey('plugin-a', 'a'.repeat(64)),
        codeSha256: 'a'.repeat(64),
      })
    ).rejects.toThrow('plugin_worker_code_store_unavailable');

    const object = r2Object(bundle());
    const resolver = new R2PluginWorkerCodeResolver(object.bucket);
    await expect(
      resolver.resolve({
        pluginId: 'plugin-a',
        codeObjectKey: '../bundle.json',
        codeSha256: object.digest,
      })
    ).rejects.toThrow('plugin_worker_code_reference_invalid');
    await expect(
      resolver.resolve({
        pluginId: 'plugin-a',
        codeObjectKey: objectKey('plugin-a', 'f'.repeat(64)),
        codeSha256: 'f'.repeat(64),
      })
    ).rejects.toThrow('plugin_worker_bundle_digest_mismatch');

    const otherPlugin = r2Object(bundle({ pluginId: 'plugin-b' }));
    await expect(
      new R2PluginWorkerCodeResolver(otherPlugin.bucket).resolve({
        pluginId: 'plugin-a',
        codeObjectKey: objectKey('plugin-a', otherPlugin.digest),
        codeSha256: otherPlugin.digest,
      })
    ).rejects.toThrow('plugin_worker_bundle_invalid');
  });

  it('rejects extra fields, unsafe module paths, and oversized objects', async () => {
    for (const invalid of [
      bundle({ unexpected: true }),
      bundle({ mainModule: '../index.js', modules: { '../index.js': 'export default {}' } }),
      bundle({ modules: {} }),
    ]) {
      const object = r2Object(invalid);
      await expect(
        new R2PluginWorkerCodeResolver(object.bucket).resolve({
          pluginId: 'plugin-a',
          codeObjectKey: objectKey('plugin-a', object.digest),
          codeSha256: object.digest,
        })
      ).rejects.toThrow('plugin_worker_bundle_invalid');
    }

    const bucket = {
      get: vi.fn(async () => ({ size: 2 * 1024 * 1024 + 1, arrayBuffer: vi.fn() })),
    } as never;
    await expect(
      new R2PluginWorkerCodeResolver(bucket).resolve({
        pluginId: 'plugin-a',
        codeObjectKey: objectKey('plugin-a', 'a'.repeat(64)),
        codeSha256: 'a'.repeat(64),
      })
    ).rejects.toThrow('plugin_worker_bundle_too_large');
  });
});
