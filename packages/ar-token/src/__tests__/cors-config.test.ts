import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('token CORS configuration', () => {
  it('does not enable credentialed wildcard CORS', () => {
    const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');

    expect(source).toContain("origin: '*'");
    expect(source).not.toMatch(/credentials:\s*true/u);
  });
});
