import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '../../..');

describe('package export boundary', () => {
  it('keeps stable, experimental, and test-support exports separated', () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));

    expect(Object.keys(packageJson.exports).sort()).toEqual([
      '.',
      './experimental',
      './test-support',
    ]);
  });

  it('does not root-export preview adapters or test support helpers', () => {
    const rootIndex = readFileSync(resolve(packageRoot, 'src/index.ts'), 'utf8');

    expect(rootIndex).not.toContain('./adapters');
    expect(rootIndex).not.toContain('./test-support');
    expect(rootIndex).not.toContain('adaptCsvPreview');
    expect(rootIndex).not.toContain('validateStaticFixture');
  });

  it('keeps preview adapters in experimental export', () => {
    const experimental = readFileSync(resolve(packageRoot, 'src/experimental.ts'), 'utf8');

    expect(experimental).toContain('adaptCsvPreview');
    expect(experimental).toContain("from './adapters'");
  });

  it('exports documented stable transform execution API from root', () => {
    const rootIndex = readFileSync(resolve(packageRoot, 'src/index.ts'), 'utf8');

    expect(rootIndex).toContain('executeTransformStep');
    expect(rootIndex).toContain('TransformExecutionInput');
    expect(rootIndex).toContain('TransformExecutionResult');
  });
});
