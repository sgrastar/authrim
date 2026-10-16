/**
 * Fifth round: a key written with escapes, inside JSON that was stringified many times, and
 * parameter names percent-encoded many times, are decoded as often as it takes (within a cap, and
 * a key that cannot be decoded in full is taken for a secret).
 */

import { describe, it, expect } from 'vitest';
import { redactSecretsInText, redactionWork } from '../diagnostic-redaction';
import { applyPrivacyModeToEntry } from '../diagnostic-security';
import type { DiagnosticLogEntry } from '../../services/diagnostic/types';

const MODES = ['full', 'masked', 'minimal'] as const;

function entry(overrides: Record<string, unknown>): DiagnosticLogEntry {
  return {
    id: 'entry-1',
    tenantId: 't1',
    category: 'token-validation',
    level: 'debug',
    timestamp: 1_700_000_000_000,
    step: 'issuer-check',
    result: 'pass',
    ...overrides,
  } as unknown as DiagnosticLogEntry;
}

async function inMode(mode: (typeof MODES)[number], e: DiagnosticLogEntry) {
  return (await applyPrivacyModeToEntry(
    { ...e, storageMode: mode },
    { mode, secret: 'test-secret' }
  )) as unknown as Record<string, any>;
}

/** `text` stringified `levels` times in all (1 = the text itself, as JSON text). */
function nested(text: string, levels: number): string {
  let result = text;
  for (let i = 1; i < levels; i += 1) result = JSON.stringify(result);
  return result;
}

// Keys written with escapes (the backslashes are in the text)
const ESCAPED_KEYS = [
  '\\u0073ecret',
  'client_\\u0073ecret',
  '\\u0063lient_\\u0073ecret',
  'Client_\\u0053ecret',
  '\\u0043LIENT\\u005FSECRET',
  'pass\\u0077ord',
  '\\u0061ccess\\u005ftoken',
  're\\u0066resh_token',
];

describe('an escaped key in JSON stringified many times', () => {
  it.each(
    ESCAPED_KEYS.flatMap((key) => [1, 2, 3, 4, 5, 6, 7, 8].map((levels) => [key, levels] as const))
  )('key %s at %i level(s)', (key, levels) => {
    const json = `{"${key}":"secret-value","other":"keep-me"}`;
    const text = nested(json, levels);
    const out = redactSecretsInText(text);
    expect(out, `${key} ${levels}`).not.toContain('secret-value');
    expect(out, `${key} ${levels}`).toContain('keep-me');
    expect(redactSecretsInText(out), `${key} ${levels}`).toBe(out);
  });

  it.each(MODES)('%s: the reported case is not stored', async (mode) => {
    const text = nested('{"\\u0073ecret":"secret-value"}', 4);
    const once = await inMode(mode, entry({ details: { message: text } }));
    expect(JSON.stringify(once)).not.toContain('secret-value');
    const twice = await inMode(mode, once as unknown as DiagnosticLogEntry);
    expect(JSON.stringify(twice)).not.toContain('secret-value');
    expect(twice).toEqual(once);
  });

  it('keeps an escaped key that is not a secret, whatever the nesting', () => {
    for (let levels = 1; levels <= 8; levels += 1) {
      const text = nested('{"\\u0073tatus":"fine","note":"keep-me"}', levels);
      expect(redactSecretsInText(text), String(levels)).toBe(text);
    }
  });
});

/** `\u005c` repeated: each round of decoding peels one, so the key needs `chain` + 1 rounds. */
function chainKey(chain: number, tail: string): string {
  return '\\u005c' + 'u005c'.repeat(chain - 1) + tail;
}

describe('a key that cannot be decoded in full is taken for a secret', () => {
  it('decodes a key that needs a few rounds, and judges the decoded key', () => {
    const secret = redactSecretsInText(
      `{"${chainKey(10, 'u0073ecret')}":"secret-value","x":"keep"}`
    );
    expect(secret).not.toContain('secret-value');
    expect(secret).toContain('keep');
    const plain = `{"${chainKey(10, 'u0073tatus')}":"fine","x":"keep"}`;
    expect(redactSecretsInText(plain)).toBe(plain);
  });

  it.each([100, 400])('hides the value of a key that needs %i rounds', (chain) => {
    // Not a secret once decoded, but it cannot be decoded within the cap: taken for a secret
    const text = `{"${chainKey(chain, 'u0073tatus')}":"secret-value","x":"keep"}`;
    const out = redactSecretsInText(text);
    expect(out).not.toContain('secret-value');
    expect(out).toContain('keep');
  });

  it('stays linear for an absurd number of backslashes (depth 1000 and beyond)', () => {
    for (const count of [1_000, 5_000, 20_000]) {
      const quote = `${'\\'.repeat(count)}"`;
      const text = `{${quote}${'\\'.repeat(count + 1)}u0073ecret${quote}:${quote}secret-value${quote}}`;
      redactionWork.units = 0;
      const started = performance.now();
      const out = redactSecretsInText(text);
      const elapsed = performance.now() - started;
      expect(out, String(count)).not.toContain('secret-value');
      expect(elapsed, String(count)).toBeLessThan(2_500);
      // 64 rounds at most, each over the key: linear in the length with a constant bound
      expect(redactionWork.units, String(count)).toBeLessThanOrEqual(text.length * 140);
    }
  });

  it('stays linear for many keys that each need many rounds', () => {
    const text = Array.from(
      { length: 400 },
      (_, i) => `{"${chainKey(300, 'u0073tatus')}${i}":"v"}`
    ).join(',');
    redactionWork.units = 0;
    const started = performance.now();
    redactSecretsInText(text);
    expect(performance.now() - started).toBeLessThan(5_000);
    // the rounds are counted (64 over each key), and bounded
    expect(redactionWork.units).toBeGreaterThanOrEqual(text.length * 20);
    expect(redactionWork.units).toBeLessThanOrEqual(text.length * 140);
  });
});

describe('a parameter name percent-encoded many times', () => {
  it.each([
    'access%5Ftoken',
    'access%255Ftoken',
    'access%25255Ftoken',
    'access%2525255Ftoken',
    'client%255Fsecret',
  ])('hides the value of %s', (name) => {
    const out = redactSecretsInText(`?${name}=hidden-value&x=1`);
    expect(out).not.toContain('hidden-value');
    expect(out).toContain('x=1');
  });

  it('hides the value of a name that cannot be decoded in full', () => {
    const name = `a%${'25'.repeat(100)}5Fb`;
    expect(name.length).toBeLessThan(256);
    expect(redactSecretsInText(`?${name}=hidden-value`)).not.toContain('hidden-value');
  });

  it('leaves the value of a name that is not a secret', () => {
    expect(redactSecretsInText('?stat%255Fus=fine')).toBe('?stat%255Fus=fine');
  });
});
