import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Cloudflare validates an uploaded Worker by evaluating its global scope with WebAssembly code
// generation disabled. hyparquet-compressors used to compile hysnappy's module while loading,
// which made every Worker that bundles the Iceberg reader fail to deploy. Load the real
// dependencies in a fresh process whose WebAssembly constructors throw, as they do there.
describe('Workers global-scope validation', () => {
  it('loads the Parquet and Iceberg dependencies without generating WebAssembly', () => {
    const script = `
      for (const name of ['Module', 'Instance', 'instantiate', 'compile', 'instantiateStreaming'])
        Object.defineProperty(WebAssembly, name, {
          configurable: true,
          value: function () { throw new Error('Wasm code generation disallowed by embedder'); },
        });
      await import('hyparquet-compressors');
      await import('icebird/src/fetch.js');
      await import('icebird/src/read.js');
      await import('icebird/src/avro/avro.read.js');
      console.log('loaded');
    `;
    const output = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: packageDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output.trim()).toBe('loaded');
  });
});
