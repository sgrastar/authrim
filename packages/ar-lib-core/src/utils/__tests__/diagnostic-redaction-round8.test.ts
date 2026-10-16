/**
 * Eighth round, three holes of the same kind:
 *  1. `code` is a secret wherever it is a key, at any depth and in any container, not only in the
 *     entry's OAuth parameter fields. An HTTP status shaped number is the one thing that stays.
 *  2. A parameter name is read back to its real boundary (whitespace, quotes and URL delimiters),
 *     so an unusual separator (`^`, `|`, an em dash, a katakana middle dot) cannot hide a secret.
 *  3. A secret word that ends a name is found without splitting the name into words, so an
 *     acronym before it (HTTPAuthorization, XMLHttpToken, APIKey) cannot hide it either.
 */

import { describe, it, expect } from 'vitest';
import {
  isSecretName,
  normalizeKey,
  piiKeyKind,
  redactSecretsInText,
  redactionWork,
  protectDiagnosticEntry,
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

async function inMode(mode: (typeof MODES)[number], e: DiagnosticLogEntry) {
  return (await applyPrivacyModeToEntry(
    { ...e, storageMode: mode },
    { mode, secret: 'test-secret' }
  )) as unknown as Record<string, any>;
}

/** value wrapped in `depth` levels of objects named by `names` (cycled). */
function nest(depth: number, names: string[], leaf: Record<string, unknown>) {
  let value: Record<string, unknown> = leaf;
  for (let i = depth - 1; i >= 0; i -= 1) value = { [names[i % names.length]]: value };
  return value;
}

describe('code is a secret wherever it is a key', () => {
  const CONTAINERS = [
    ['query'],
    ['metadata'],
    ['params', 'args'],
    ['form', 'body', 'data'],
    ['a', 'b', 'c', 'd', 'e'],
  ];
  const FIELDS = ['details', 'context', 'metadata', 'bodySummary', 'query', 'somethingElse'];

  it.each(MODES)('%s: nested one to five deep, in any field and container', async (mode) => {
    for (const field of FIELDS) {
      for (const names of CONTAINERS) {
        for (let depth = 1; depth <= 5; depth += 1) {
          const e = entry({ [field]: nest(depth, names, { code: 'private-auth-code', n: 1 }) });
          const text = JSON.stringify(await inMode(mode, e));
          expect(text, `${mode} ${field} ${names} ${depth}`).not.toContain('private-auth-code');
        }
      }
    }
  });

  it.each(MODES)(
    '%s: in arrays, next to siblings, under a sibling that is not a secret',
    async (mode) => {
      const e = entry({
        details: {
          items: [{ code: 'private-in-array-1' }, [{ code: 'private-in-array-2' }]],
          first: { note: 'x' },
          second: { query: { code: 'private-sibling' } },
          code: 'private-top',
        },
        metadata: { query: { code: 'auth-code' } },
      });
      const text = JSON.stringify(await inMode(mode, e));
      for (const raw of [
        'private-in-array-1',
        'private-in-array-2',
        'private-sibling',
        'private-top',
      ]) {
        expect(text, `${mode} ${raw}`).not.toContain(raw);
      }
      expect(text).not.toContain('auth-code"');
    }
  );

  it('a `code` is a secret whatever its value: a string, a status shaped number, any number', async () => {
    const result = await protectDiagnosticEntry({
      details: {
        a: { code: '404' },
        b: { code: 123456 },
        c: { code: 99 },
        d: { code: 404.5 },
        e: { code: 404 },
      },
    } as any);
    const d = (result as any).details;
    expect(d.a.code).toMatch(/^sha256:/);
    for (const key of ['b', 'c', 'd', 'e']) expect(d[key].code, key).toBe('[SECRET_REDACTED]');
  });

  it.each(MODES)('%s: names that only contain the word code stay', async (mode) => {
    const result = await inMode(
      mode,
      entry({
        details: { status_code: 404, statusCode: 404, 'error.code': 5, HTTPStatus: 200, name: 'x' },
      })
    );
    if (mode !== 'minimal') {
      expect(result.details.status_code).toBe(404);
      expect(result.details.statusCode).toBe(404);
      expect(result.details['error.code']).toBe(5);
      expect(result.details.HTTPStatus).toBe(200);
    }
  });
});

const ODD_SEPARATORS = [
  '^',
  '|',
  '—',
  '・',
  '¦',
  '§',
  '‖',
  '¬',
  '°',
  '※',
  '＿',
  '‐',
  '→',
  '·',
  '•',
  '…',
];

describe('a parameter name is read back to its boundary', () => {
  it.each(MODES)(
    '%s: code, verifier, client and token names with unusual separators',
    async (mode) => {
      for (const sep of ODD_SEPARATORS) {
        for (const words of [
          ['code', 'verifier'],
          ['client', 'secret'],
          ['id', 'token', 'hint'],
          ['access', 'token'],
          ['x', 'api', 'key'],
          ['set', 'cookie'],
        ]) {
          const name = words.join(sep);
          const message = `?${name}=private-value&x=1`;
          const text = JSON.stringify(await inMode(mode, entry({ details: { message } })));
          expect(text, `${mode} ${name}`).not.toContain('private-value');
        }
      }
    }
  );

  it('the exact reports', () => {
    for (const text of [
      '?code^verifier=private-value&x=1',
      '?code|verifier=private-value&x=1',
      '?code—verifier=private-value&x=1',
      'a=1 code・verifier=private-value',
      'k=1;code¦verifier=private-value;z=2',
    ]) {
      expect(redactSecretsInText(text), text).not.toContain('private-value');
    }
    expect(redactSecretsInText('?code^verifier=private-value&x=1')).toBe(
      '?code^verifier=[SECRET_REDACTED]&x=1'
    );
  });

  it('a code after an unusual character is the code parameter', () => {
    for (const sep of ['^', '|', '—', ',', '!', '*', '(', '・']) {
      const text = `ts=1${sep}code=private-value&x=1`;
      expect(redactSecretsInText(text), text).not.toContain('private-value');
      expect(redactSecretsInText(text), text).toContain('x=1');
    }
  });

  it('a full-width name is the same name', () => {
    expect(redactSecretsInText('?ｃｏｄｅ＿ｖｅｒｉｆｉｅｒ=private-value')).not.toContain(
      'private-value'
    );
    expect(redactSecretsInText('?ｃｏｄｅ=private-value')).not.toContain('private-value');
  });

  it('a name too long to inspect is a secret', () => {
    const text = `?${'a^'.repeat(200)}=private-value&x=1`;
    expect(redactSecretsInText(text)).not.toContain('private-value');
  });

  it('free text with the same characters is left alone', () => {
    for (const text of [
      '1^2 token count',
      '1^2 token count=5',
      'a|b=1',
      'x^y=2 and p—q=3',
      'price—tax=3',
      'see 1^2 token, then size=3',
      'Hello, world=1 and a*b=2',
      'status_code=404&error.code=5',
      'a|b|c=2',
      '?page+size=10',
      '?a+b=1',
      '日本語の文章 結果=成功',
    ]) {
      expect(redactSecretsInText(text), text).toBe(text);
    }
  });

  it('is linear in the input', () => {
    for (const unit of ['^=', '|=', 'a^b=', '—=—', '=^']) {
      const text = unit.repeat(40_000);
      redactionWork.units = 0;
      redactSecretsInText(text);
      expect(redactionWork.units, unit).toBeLessThanOrEqual(text.length * 140);
    }
  });
});

const ACRONYM_SECRETS = [
  'myHTTPAuthorization',
  'HTTPAuthorization',
  'HTTPCookie',
  'HTTPSetCookie',
  'XMLHttpToken',
  'APIKey',
  'myAPIKey',
  'OAuthToken',
  'IDToken',
  'JWTSecret',
  'SAMLResponse',
  'HTTPProxyAuthorization',
  'RFCClientSecret',
  'PKCECodeVerifier',
  'OIDCIDToken',
  'XSRFToken',
  'AWSSecret',
  'DBPassword',
];

describe('a secret word at the end of a name is found whatever precedes it', () => {
  it('isSecretName', () => {
    for (const name of ACRONYM_SECRETS) expect(isSecretName(name), name).toBe(true);
    for (const name of [
      'HTTPStatus',
      'HTMLContent',
      'IDCount',
      'URLPath',
      'statusCode',
      'status_code',
      'error.code',
      'cookie_policy',
      'token_type',
      'page+size',
      'XMLHttpRequest',
      'tokenHash',
    ])
      expect(isSecretName(name), name).toBe(false);
  });

  it.each(MODES)('%s: object keys', async (mode) => {
    const details: Record<string, string> = {};
    ACRONYM_SECRETS.forEach((name, i) => {
      details[name] = `private-acronym-${i}`;
    });
    const text = JSON.stringify(await inMode(mode, entry({ details })));
    ACRONYM_SECRETS.forEach((name, i) => {
      expect(text, `${mode} ${name}`).not.toContain(`private-acronym-${i}`);
    });
  });

  it.each(MODES)('%s: nested and in arrays', async (mode) => {
    const e = entry({
      metadata: {
        a: { b: [{ myHTTPAuthorization: 'private-auth' }, { HTTPCookie: 'sid=private-cookie' }] },
      },
    });
    const text = JSON.stringify(await inMode(mode, e));
    expect(text).not.toContain('private-auth');
    expect(text).not.toContain('private-cookie');
  });

  it('parameter names and JSON members in text', () => {
    for (const name of ACRONYM_SECRETS) {
      expect(redactSecretsInText(`?${name}=private-value&x=1`), name).not.toContain(
        'private-value'
      );
      expect(redactSecretsInText(`{"${name}":"private-value","p":1}`), name).not.toContain(
        'private-value'
      );
    }
  });

  it.each(MODES)('%s: names that are not secrets stay', async (mode) => {
    const result = await inMode(
      mode,
      entry({ details: { HTTPStatus: 200, HTMLContent: 'x', IDCount: 3, status_code: 404 } })
    );
    if (mode !== 'minimal') {
      expect(result.details.HTTPStatus).toBe(200);
      expect(result.details.HTMLContent).toBe('x');
      expect(result.details.IDCount).toBe(3);
    }
  });

  it('judging the normalised name needs no word split: a word glued on is still found', () => {
    for (const name of [
      'xxcookie',
      'XXCOOKIE',
      'abcauthorization',
      'ABCAuthorization',
      'a1b2apikey',
    ]) {
      expect(isSecretName(name), name).toBe(true);
    }
  });
});

describe('key normalisation folds full-width and decorated spellings', () => {
  it('normalizeKey and piiKeyKind', () => {
    expect(normalizeKey('ｃｏｄｅ_ｖｅｒｉｆｉｅｒ')).toBe('codeverifier');
    expect(normalizeKey('Ｔｏｋｅｎ')).toBe('token');
    expect(piiKeyKind('ｅｍａｉｌ')).toBe('email');
  });
});
