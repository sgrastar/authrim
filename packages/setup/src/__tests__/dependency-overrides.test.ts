import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../../..');

describe('workspace dependency overrides', () => {
  it('keeps duplicated overrides aligned and uses the workspace YAML version for Vite', () => {
    const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
      pnpm: { overrides: Record<string, string> };
    };
    const workspace = parse(readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf8')) as {
      overrides: Record<string, string>;
    };

    for (const [selector, version] of Object.entries(rootPackage.pnpm.overrides)) {
      if (selector in workspace.overrides) {
        expect(workspace.overrides[selector], selector).toBe(version);
      }
    }

    const viteYamlOverrides = Object.entries(rootPackage.pnpm.overrides).filter(([selector]) =>
      /^vite@[^>]+>yaml$/.test(selector)
    );
    expect(viteYamlOverrides).not.toHaveLength(0);
    for (const [selector, version] of viteYamlOverrides) {
      expect(version, selector).toBe(rootPackage.devDependencies.yaml);
      expect(workspace.overrides[selector], selector).toBe(rootPackage.devDependencies.yaml);
    }
  });
});
