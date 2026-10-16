/**
 * Fourth round: JSON stringified many times over, personal data under keys too long to keep,
 * canonical fingerprints as ids, null and sparse values in the node budget, Basic credentials with
 * an empty user name, and presence flags of the minimal storage mode.
 */

import { describe, it, expect } from 'vitest';
import {
  identifierOrFingerprint,
  protectDiagnosticEntry,
  redactSecretsInText,
  redactionWork,
  safeSnapshot,
} from '../diagnostic-redaction';
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

async function inMode(mode: (typeof MODES)[number], e: DiagnosticLogEntry, filterPii?: boolean) {
  return (await applyPrivacyModeToEntry(
    { ...e, storageMode: mode },
    { mode, secret: 'test-secret', filterPii }
  )) as unknown as Record<string, any>;
}

function stringified(value: unknown, levels: number): string {
  let text = JSON.stringify(value);
  for (let i = 1; i < levels; i += 1) text = JSON.stringify(text);
  return text;
}

describe('JSON stringified many times over', () => {
  const levels = [1, 2, 3, 4, 5, 6];

  it.each(levels)('removes a secret nested %i level(s) deep and keeps what follows it', (level) => {
    const text = stringified({ client_secret: 'secret-value', other: 'keep-me' }, level);
    const out = redactSecretsInText(text);
    expect(out, `level ${level}`).not.toContain('secret-value');
    expect(out, `level ${level}`).toContain('keep-me');
    expect(redactSecretsInText(out), `level ${level}`).toBe(out);
  });

  it.each(levels)('removes a secret value holding quotes and backslashes at level %i', (level) => {
    const text = stringified({ password: 'sec"ret\\value-tail', other: 'keep-me' }, level);
    const out = redactSecretsInText(text);
    expect(out, `level ${level}`).not.toContain('value-tail');
    expect(out, `level ${level}`).not.toContain('sec');
    expect(out, `level ${level}`).toContain('keep-me');
  });

  it.each(levels)('removes a numeric and an object secret at level %i', (level) => {
    const text = stringified(
      { token: 123456789, refresh_token: { a: 'raw-nested' }, k: 'keep' },
      level
    );
    const out = redactSecretsInText(text);
    expect(out, `level ${level}`).not.toContain('123456789');
    expect(out, `level ${level}`).not.toContain('raw-nested');
  });

  it.each(MODES)(
    '%s: a triple-stringified secret in details.message is not stored',
    async (mode) => {
      const message = stringified({ client_secret: 'secret-value' }, 3);
      const once = await inMode(mode, entry({ details: { message } }));
      expect(JSON.stringify(once)).not.toContain('secret-value');
      const twice = await inMode(mode, once as unknown as DiagnosticLogEntry);
      expect(JSON.stringify(twice)).not.toContain('secret-value');
      expect(twice).toEqual(once);
    }
  );

  it('redacts to the end of the text when the structure cannot be followed', () => {
    const out = redactSecretsInText('{\\\\"client_secret\\":\\\\\\"secret-value\\", "x": 1}');
    expect(out).not.toContain('secret-value');
  });
});

describe('personal data under a key too long to keep', () => {
  const givenName = `given${'_'.repeat(300)}name`;
  const phoneNumber = `phone${'_'.repeat(300)}number`;
  const ip = `ip${'_'.repeat(300)}address`;

  it.each(MODES)('%s: the value is classified by its original key', async (mode) => {
    const result = await inMode(
      mode,
      entry({
        step: 'userinfo-response',
        details: {
          claims: { [givenName]: 'JaneDoe', [phoneNumber]: 12025550199, [ip]: '203.0.113.42' },
        },
      })
    );
    const text = JSON.stringify(result);
    for (const raw of ['JaneDoe', '12025550199', '203.0.113.42']) {
      expect(text, `${mode} ${raw}`).not.toContain(raw);
    }
    const again = await inMode(mode, result as unknown as DiagnosticLogEntry);
    expect(again).toEqual(result);
  });

  it('full: a short key is masked, a key too long to inspect is hidden as a secret', async () => {
    const result = await inMode(
      'full',
      entry({ details: { claims: { givenName: 'JaneDoe', [givenName]: 'JaneDoe' } } })
    );
    const values = Object.values(result.details.claims);
    expect(values).toHaveLength(2);
    expect(JSON.stringify(values)).not.toContain('JaneDoe');
    // the long key cannot be inspected: fail-closed, its value is a fingerprint
    expect(values.some((value) => /^sha256:/.test(String(value)))).toBe(true);
  });

  it('a key too long to inspect hides its value even when the PII filter is off', async () => {
    const result = await inMode('full', entry({ details: { [givenName]: 'JaneDoe' } }), false);
    expect(JSON.stringify(result)).not.toContain('JaneDoe');
  });
});

describe('a canonical fingerprint is an identifier', () => {
  it.each([12, 40, 64])('returns sha256:<%i hex> as it is', async (length) => {
    const canonical = `sha256:${'0123456789abcdef'.repeat(4).slice(0, length)}`;
    expect(await identifierOrFingerprint(canonical, length)).toBe(canonical);
    const result = (await protectDiagnosticEntry(
      entry({ diagnosticSessionId: canonical, flowId: canonical, requestId: canonical }),
      { hashPrefixLength: length }
    )) as any;
    expect(result.diagnosticSessionId).toBe(canonical);
    expect(result.flowId).toBe(canonical);
    expect(result.requestId).toBe(canonical);
  });

  it.each([12, 40, 64])(
    'a long id fingerprinted at length %i is stable under protection',
    async (length) => {
      const long = `session-${'A1b2C3d4'.repeat(8)}`;
      const first = await identifierOrFingerprint(long, length);
      expect(first).toMatch(new RegExp(`^sha256:[0-9a-f]{${length}}$`));
      expect(await identifierOrFingerprint(first, length)).toBe(first);
    }
  );
});

describe('the node budget counts null, undefined and holes', () => {
  it('cuts an array of 50,010 nulls and of undefined', () => {
    for (const filler of [null, undefined]) {
      const items = Array.from({ length: 50_010 }, () => filler);
      const copy = safeSnapshot({ items }) as { items: unknown[] };
      expect(copy.items.length, String(filler)).toBeLessThanOrEqual(50_001);
      expect(copy.items[copy.items.length - 1]).toBe('[TRUNCATED]');
    }
  });

  it('stops a sparse array by its length, not by walking it all', () => {
    const sparse = new Array<unknown>(4_000_000_000);
    redactionWork.units = 0;
    const started = performance.now();
    const copy = safeSnapshot({ sparse }) as { sparse: unknown[] };
    expect(performance.now() - started).toBeLessThan(2_500);
    expect(redactionWork.units).toBeLessThanOrEqual(100_000);
    expect(copy.sparse.length).toBeLessThanOrEqual(50_001);
    expect(copy.sparse[copy.sparse.length - 1]).toBe('[TRUNCATED]');
  });

  it('cuts an object with many null properties', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 60_000; i += 1) properties[`k${i}`] = null;
    const copy = safeSnapshot({ properties }) as { properties: Record<string, unknown> };
    expect(Object.keys(copy.properties).length).toBeLessThanOrEqual(50_002);
    expect(copy.properties['[TRUNCATED]']).toBe('[TRUNCATED]');
  });
});

describe('Basic credentials with an empty user name', () => {
  it.each([
    ['Basic Ong=', ':x'],
    ['Basic Om5vdGhpbmc=', ':nothing'],
    ['Basic OnA=', ':p'],
  ])('redacts %s', (credential, decoded) => {
    expect(atob(credential.slice(6))).toBe(decoded);
    expect(redactSecretsInText(`Authorization: ${credential}`)).toBe(
      'Authorization: Basic [TOKEN_REDACTED]'
    );
  });

  it('still leaves prose alone', () => {
    for (const text of ['Basic authentication is used', 'basic information', 'Basic setup']) {
      expect(redactSecretsInText(text)).toBe(text);
    }
  });
});

describe('an empty secret holds nothing to hide', () => {
  it.each(MODES)('%s: an empty token stays empty, not a fingerprint of nothing', async (mode) => {
    const result = await inMode(
      mode,
      entry({ step: 'token-response', details: { access_token: '', refresh_token: '' } })
    );
    if (mode === 'minimal') return;
    expect(result.details.access_token).toBe('');
    expect(result.details.refresh_token).toBe('');
  });
});

describe('minimal mode presence flags', () => {
  it.each([
    ['', false],
    [0, false],
    [null, false],
    [false, false],
    ['token-value', true],
    [12345, true],
  ])('token-response with access_token %j: has_access_token is %s', async (value, expected) => {
    const result = await inMode(
      'minimal',
      entry({ step: 'token-response', details: { access_token: value, id_token: value } })
    );
    expect(result.details.has_access_token).toBe(expected);
    expect(result.details.has_id_token).toBe(expected);
    expect(result.details).not.toHaveProperty('access_token');
    expect(result.details).not.toHaveProperty('id_token');
    const again = await inMode('minimal', result as unknown as DiagnosticLogEntry);
    expect(again).toEqual(result);
  });

  it.each([
    [{ sub: '', email: 0 }, false, false],
    [{ sub: 's', email: '' }, true, false],
    [{ sub: 0, email: 'e@example.com' }, false, true],
  ])('userinfo-response claims %j: has_sub %s, has_email %s', async (claims, sub, email) => {
    const result = await inMode(
      'minimal',
      entry({ step: 'userinfo-response', details: { claims } })
    );
    expect(result.details.has_sub).toBe(sub);
    expect(result.details.has_email).toBe(email);
    expect(await inMode('minimal', result as unknown as DiagnosticLogEntry)).toEqual(result);
  });
});
