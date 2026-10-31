/**
 * Sixth round: a percent-encoded parameter name with an escape that is not valid UTF-8 cannot be
 * judged with certainty, and is taken for a secret (the value is hidden) instead of being passed.
 */

import { describe, it, expect } from 'vitest';
import { redactSecretsInText } from '../diagnostic-redaction';
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

/** A name encoded `levels` times in all (1 = as written). */
function encodedTimes(name: string, levels: number): string {
  let result = name;
  for (let i = 1; i < levels; i += 1) result = result.replace(/%/g, '%25');
  return result;
}

const INVALID = ['%ED%A0%80', '%C0%AF', '%FF', '%E3%81', '%F0%9F', '%80%80', '%C3'];

describe('a parameter name with an escape that is not valid UTF-8', () => {
  it.each(MODES)('%s: the reported value is not stored', async (mode) => {
    const message = '?client%5Fsecret%ED%A0%80=private-value&x=1';
    const once = await inMode(mode, entry({ details: { message } }));
    expect(JSON.stringify(once)).not.toContain('private-value');
    expect(JSON.stringify(once)).toContain('x=1');
    const twice = await inMode(mode, once as unknown as DiagnosticLogEntry);
    expect(JSON.stringify(twice)).not.toContain('private-value');
    expect(twice).toEqual(once);
  });

  it.each(INVALID.flatMap((bad) => [1, 2, 3, 4].map((levels) => [bad, levels] as const)))(
    'hides the value of a secret name followed by %s, encoded %i time(s)',
    (bad, levels) => {
      const name = encodedTimes(`client%5Fsecret${bad}`, levels);
      const out = redactSecretsInText(`?${name}=private-value&x=1`);
      expect(out, name).not.toContain('private-value');
      expect(out, name).toContain('x=1');
    }
  );

  it.each(INVALID.flatMap((bad) => [1, 2, 3].map((levels) => [bad, levels] as const)))(
    'hides the value of a name that is not a secret when %s follows it, encoded %i time(s)',
    (bad, levels) => {
      // A name that cannot be decoded with certainty is not judged: the safe side is to hide
      const out = redactSecretsInText(`?${encodedTimes(`status${bad}`, levels)}=private-value&x=1`);
      expect(out).not.toContain('private-value');
      expect(out).toContain('x=1');
    }
  );

  it('hides the value when the invalid escape is in the middle of the name', () => {
    expect(redactSecretsInText('?acc%FFess%5Ftoken=private-value')).not.toContain('private-value');
    expect(redactSecretsInText('?%E3%81access_token=private-value')).not.toContain('private-value');
  });
});

describe('names that are decoded fine are left as they are', () => {
  it.each([
    '?a%20b=keep-me',
    '?we%C3%A9=keep-me',
    '?%E3%81%82=keep-me',
    '?50%=keep-me',
    '?discount%zz=keep-me',
    '?stat%255Fus=keep-me',
    '?a%2Bb=keep-me&x=1',
  ])('%s', (text) => {
    expect(redactSecretsInText(text)).toBe(text);
  });

  it('still hides a valid percent-encoded secret name', () => {
    for (const name of ['client%5Fsecret', 'client%255Fsecret', 'pass%77ord', '%61ccess_token']) {
      expect(redactSecretsInText(`?${name}=private-value&x=1`), name).not.toContain(
        'private-value'
      );
    }
  });
});
