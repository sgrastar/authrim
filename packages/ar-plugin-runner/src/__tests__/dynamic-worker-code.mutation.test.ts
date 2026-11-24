import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { R2PluginWorkerCodeResolver } from '../dynamic-worker-code';

function resolverFor(bytes: Uint8Array) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const bucket = {
    get: vi.fn(async () => ({ size: bytes.byteLength, arrayBuffer: async () => bytes.buffer })),
  } as never;
  return {
    digest,
    target: {
      pluginId: 'plugin-a',
      codeSha256: digest,
      codeObjectKey: `plugins/plugin-a/${digest}.json`,
    } as never,
    resolver: new R2PluginWorkerCodeResolver(bucket),
  };
}
const encode = (text: string) => new TextEncoder().encode(text);

describe('R2PluginWorkerCodeResolver edges', () => {
  it.each([
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a JSON string', '"x"'],
    ['a JSON number', '5'],
  ])('refuses a bundle that is %s', async (_label, text) => {
    const { resolver, target } = resolverFor(encode(text));
    await expect(resolver.resolve(target)).rejects.toThrow(/^plugin_worker_bundle_invalid$/u);
  });
  it('refuses a bundle that is not valid UTF-8 or not JSON', async () => {
    const invalidUtf8 = resolverFor(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
    await expect(invalidUtf8.resolver.resolve(invalidUtf8.target)).rejects.toThrow(
      /^plugin_worker_bundle_invalid$/u
    );
    const notJson = resolverFor(encode('{nope'));
    await expect(notJson.resolver.resolve(notJson.target)).rejects.toThrow(
      /^plugin_worker_bundle_invalid$/u
    );
  });
  it('refuses a missing store, a malformed reference and a missing object', async () => {
    const { target } = resolverFor(encode('{}'));
    await expect(new R2PluginWorkerCodeResolver(undefined).resolve(target)).rejects.toThrow(
      /^plugin_worker_code_store_unavailable$/u
    );
    const bucket = { get: vi.fn(async () => null) } as never;
    await expect(new R2PluginWorkerCodeResolver(bucket).resolve(target)).rejects.toThrow(
      /^plugin_worker_code_not_found$/u
    );
    await expect(
      new R2PluginWorkerCodeResolver(bucket).resolve({
        ...(target as object),
        codeObjectKey: 'plugins/plugin-a/other.json',
      } as never)
    ).rejects.toThrow(/^plugin_worker_code_reference_invalid$/u);
    await expect(
      new R2PluginWorkerCodeResolver(bucket).resolve({
        ...(target as object),
        pluginId: '-x',
      } as never)
    ).rejects.toThrow(/^plugin_worker_code_reference_invalid$/u);
    await expect(
      new R2PluginWorkerCodeResolver(bucket).resolve({
        ...(target as object),
        codeSha256: 'A'.repeat(64),
      } as never)
    ).rejects.toThrow(/^plugin_worker_code_reference_invalid$/u);
  });
  it('refuses bytes that do not hash to the pinned digest', async () => {
    const { resolver, target } = resolverFor(encode('{}'));
    const other = resolverFor(encode('{"x":1}'));
    await expect(
      resolver.resolve({
        ...(target as object),
        codeSha256: other.digest,
        codeObjectKey: `plugins/plugin-a/${other.digest}.json`,
      } as never)
    ).rejects.toThrow(/^plugin_worker_bundle_digest_mismatch$/u);
  });
});
