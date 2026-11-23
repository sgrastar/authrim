import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A dynamic `import()` in the client lookup made the Workers bundle wrap hundreds of modules in
 * lazy initialisers (`__esm` / `init_`), and a worker that bundles zod (ar-agent-access, through
 * the MCP SDK) then failed Cloudflare's start-up check (10021, "... is not a constructor"). CI
 * does not run that check, so the rule is pinned here: this module imports statically.
 */
describe('utils/kv.ts', () => {
  it('has no dynamic import()', () => {
    const source = readFileSync(new URL('../kv.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\bimport\s*\(/u);
  });
});
