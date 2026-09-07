import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Plugin Runner ownership boundary', () => {
  it('does not initialize or execute plugins in the protocol endpoint Worker', () => {
    const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');

    expect(source).not.toContain('pluginContextMiddleware');
    expect(source).not.toContain('getRequiredPluginContext');
    expect(source).not.toContain('.getNotifier(');
  });
});
