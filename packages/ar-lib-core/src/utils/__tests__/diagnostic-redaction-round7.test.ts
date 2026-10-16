/**
 * Seventh round: a parameter name written with `+` (a space in a form), `%20`, `%2B` or another
 * separator is judged as a whole, whatever the notation; so are object keys such as
 * `session_cookie`. A name that is not a secret is left alone.
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

/** Each word of a name joined by every separator a form or URL may use for a space. */
const SEPARATORS = ['+', '%20', '%2B', '~', '!', '*', '$', ',', '.', '_', '-', '(', ')'];
const WORD_SETS = [
  ['code', 'verifier'],
  ['id', 'token', 'hint'],
  ['client', 'secret'],
  ['access', 'token'],
  ['x', 'api', 'key'],
  ['refresh', 'token'],
  ['proxy', 'authorization'],
  ['set', 'cookie'],
];

describe('a name with a separator in it is judged as a whole', () => {
  it.each(WORD_SETS.flatMap((words) => SEPARATORS.map((separator) => [words, separator] as const)))(
    '%j joined by %s',
    (words, separator) => {
      const name = words.join(separator);
      const out = redactSecretsInText(`?${name}=private-value&x=1`);
      expect(out, name).not.toContain('private-value');
      expect(out, name).toContain('x=1');
    }
  );

  it.each(MODES)('%s: the reported names are not stored, in either notation', async (mode) => {
    for (const name of [
      'code+verifier',
      'code%20verifier',
      'code%2Bverifier',
      'id+token+hint',
      'id%20token%20hint',
      'id%2Btoken%2Bhint',
      'client+secret',
      'client%2Bsecret',
      'access+token',
      'access%20token',
    ]) {
      const message = `?${name}=private-value&x=1`;
      const once = await inMode(mode, entry({ details: { message } }));
      expect(JSON.stringify(once), `${mode} ${name}`).not.toContain('private-value');
      expect(JSON.stringify(once), `${mode} ${name}`).toContain('x=1');
      const twice = await inMode(mode, once as unknown as DiagnosticLogEntry);
      expect(twice, `${mode} ${name}`).toEqual(once);
    }
  });

  it('gives the same result in every notation', () => {
    const redacted = (name: string) =>
      redactSecretsInText(`?${name}=private-value&x=1`).replace(name, 'NAME');
    for (const names of [
      ['code+verifier', 'code%20verifier', 'code%2Bverifier'],
      ['id+token+hint', 'id%20token%20hint', 'id%2Btoken%2Bhint'],
      ['client+secret', 'client%20secret', 'client%2Bsecret'],
      ['access+token', 'access%20token', 'access%2Btoken'],
    ]) {
      const results = names.map(redacted);
      expect(new Set(results).size, names.join(' ')).toBe(1);
      expect(results[0]).toBe('?NAME=[SECRET_REDACTED]&x=1');
    }
  });

  it('judges the name by its last words, so a prefix does not hide a secret', () => {
    for (const name of [
      'session_cookie',
      'my.cookie',
      'x.assertion',
      'user+authorization',
      'my~api~key',
    ]) {
      expect(redactSecretsInText(`?${name}=private-value`), name).not.toContain('private-value');
    }
  });
});

describe('a name that is not a secret is left alone', () => {
  it.each([
    '?a+b=1',
    '?page+size=10',
    '?sort+order=asc&x=1',
    '?x~y=1',
    '?error.code=5',
    '?status_code=404',
    '?page%20size=10',
    '?price%2Bvat=3',
    'See (page=2), then size=3.',
    'Hello, world=1 and a*b=2',
    '?cookie_policy=accepted',
    '?token_type=bearer',
  ])('%s', (text) => {
    expect(redactSecretsInText(text)).toBe(text);
  });
});

describe('object keys are judged the same way', () => {
  it.each(MODES)('%s: session_cookie, sessionCookie and x-api~key hold secrets', async (mode) => {
    const result = await inMode(
      mode,
      entry({
        details: {
          session_cookie: 'private-cookie',
          sessionCookie: 'private-cookie-2',
          'my.authorization': 'private-auth',
          status_code: 404,
          cookie_policy: 'accepted',
        },
      })
    );
    const text = JSON.stringify(result);
    for (const raw of ['private-cookie', 'private-cookie-2', 'private-auth']) {
      expect(text, `${mode} ${raw}`).not.toContain(raw);
    }
    if (mode !== 'minimal') {
      expect(result.details.status_code).toBe(404);
      expect(result.details.cookie_policy).toBe('accepted');
    }
  });

  it('a JSON member named with separators is a secret', () => {
    const out = redactSecretsInText(
      '{"session_cookie":"private-value","my-api~key":"private-2","page":1}'
    );
    expect(out).not.toContain('private-value');
    expect(out).not.toContain('private-2');
    expect(out).toContain('"page":1');
  });
});
