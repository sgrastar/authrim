import { describe, expect, it } from 'vitest';
import { createDeterministicId } from '../../core/ids';

describe('deterministic ids', () => {
  it('normalizes repeated separators without regular expressions', () => {
    expect(
      createDeterministicId({
        kind: 'fixture',
        semanticPath: ['---Tenant---One---', 'Email Address!!'],
        contentHashParts: ['stable'],
      })
    ).toMatch(/^fixture\.tenant-one\.email-address\.[a-f0-9]{6}$/);
  });

  it('handles long separator-heavy inputs deterministically', () => {
    const input = `${'-'.repeat(20_000)}tenant${'-'.repeat(20_000)}field`;
    const id = createDeterministicId({
      kind: 'fixture',
      semanticPath: [input],
      contentHashParts: ['redacted'],
    });

    expect(id).toMatch(/^fixture\.tenant-field\.[a-f0-9]{6}$/);
  });
});
