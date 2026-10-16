/**
 * Ninth round:
 *  1. A name made of a long run of combining marks cannot make Unicode normalisation expensive:
 *     the length and the marks are limited BEFORE normalising, such a name is a secret, and the
 *     work counter charges normalisation by the character.
 *  2. `code` followed by whitespace, a separator or a control character is still `code`.
 *  3. A number named `code` is a secret (a PIN, a one-time code); status goes by status names.
 *  4. A secret word ANYWHERE in a name (at a word boundary) makes it a secret, array indexes are
 *     ignored, and names of metadata (token_type, secret_name ...) are the listed exceptions.
 */

import { describe, it, expect } from 'vitest';
import {
  isSecretName,
  secretNameKind,
  normalizeKey,
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

// ---------------------------------------------------------------------------------------------
// 1. combining marks
// ---------------------------------------------------------------------------------------------

const MARKS = '̀̕';
const markKey = (length: number, tail = 'token') => 'a' + MARKS.repeat(length / 2) + tail;

describe('a name of combining marks is cheap and is a secret', () => {
  const SIZES = [40_000, 80_000, 100_000];

  it.each(MODES)('%s: an object key of 40 KB, 80 KB and 100 KB', async (mode) => {
    const units: number[] = [];
    for (const size of SIZES) {
      const key = markKey(size);
      redactionWork.units = 0;
      const started = performance.now();
      const result = await inMode(mode, entry({ details: { [key]: 'private-value', ok: 1 } }));
      const elapsed = performance.now() - started;
      expect(JSON.stringify(result), `${mode} ${size}`).not.toContain('private-value');
      // the clock bound is loose on purpose (a loaded machine); the counter is the check
      expect(elapsed, `${mode} ${size}`).toBeLessThan(5_000);
      units.push(redactionWork.units);
      expect(redactionWork.units, `${mode} ${size}`).toBeLessThanOrEqual(size * 12);
    }
    // doubling the key at most doubles the work
    expect(units[1] / units[0], mode).toBeLessThanOrEqual(2.6);
    expect(units[2] / units[1], mode).toBeLessThanOrEqual(1.5);
  });

  it('a parameter name, a JSON member and a key in text', () => {
    const units: number[] = [];
    for (const size of [40_000, 80_000, 100_000]) {
      const key = markKey(size, 'x');
      for (const text of [`?${key}=private-value&x=1`, `{"${key}":"private-value","p":1}`]) {
        redactionWork.units = 0;
        const out = redactSecretsInText(text);
        expect(out, `${size}`).not.toContain('private-value');
        units.push(redactionWork.units);
        expect(redactionWork.units, `${size}`).toBeLessThanOrEqual(text.length * 12);
      }
    }
  });

  it('normalizeKey stays linear on a long key', () => {
    for (const size of [40_000, 80_000, 100_000]) {
      redactionWork.units = 0;
      const started = performance.now();
      normalizeKey(markKey(size));
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(redactionWork.units).toBeLessThanOrEqual(size * 4);
    }
  });

  it('a name with many marks but under the length limit is a secret too', () => {
    expect(isSecretName('a' + MARKS.repeat(20) + 'x')).toBe(true);
    expect(isSecretName('café')).toBe(false);
  });

  it('a name over the length limit is a secret; the limit itself is not', () => {
    expect(isSecretName('k'.repeat(257))).toBe(true);
    expect(isSecretName('k'.repeat(256))).toBe(false);
  });

  it('normalisation is charged by the character', () => {
    redactionWork.units = 0;
    normalizeKey('ｃｏｄｅ'.repeat(10));
    expect(redactionWork.units).toBeGreaterThanOrEqual(40 * 8);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. code with a tail
// ---------------------------------------------------------------------------------------------

const CODE_TAILS = [
  '+',
  '%20',
  ' ',
  '\t',
  '_',
  '.',
  '-',
  '%00',
  '　',
  ' ',
  '%2B',
  '__',
  ' \t',
  '%20%20',
];

describe('code with a tail is still code', () => {
  it('parameters', () => {
    for (const tail of CODE_TAILS) {
      for (const head of ['?', '&', ' ', '']) {
        const text = `${head}code${tail}=private-value&x=1`;
        expect(redactSecretsInText(text), JSON.stringify(text)).not.toContain('private-value');
      }
    }
  });

  it('the exact reports', () => {
    expect(redactSecretsInText('?code+=private-value&x=1')).toBe('?code+=[SECRET_REDACTED]&x=1');
    expect(redactSecretsInText('?code%20=private-value&x=1')).toBe(
      '?code%20=[SECRET_REDACTED]&x=1'
    );
  });

  it('a space around the equals sign', () => {
    for (const text of ['code = private-value', 'code =private-value', 'code= private-value']) {
      expect(redactSecretsInText(text), text).not.toContain('private-value');
    }
    expect(redactSecretsInText('x=1 code = private-value&y=2')).toBe(
      'x=1 code = [SECRET_REDACTED]&y=2'
    );
  });

  it('JSON members', () => {
    for (const tail of CODE_TAILS.filter((t) => !t.includes('%'))) {
      const text = JSON.stringify({ [`code${tail}`]: 'private-value', p: 1 });
      expect(redactSecretsInText(text), JSON.stringify(tail)).not.toContain('private-value');
      expect(redactSecretsInText(text)).toContain('"p":1');
    }
  });

  it.each(MODES)('%s: object keys', async (mode) => {
    const details: Record<string, string> = {};
    CODE_TAILS.forEach((tail, i) => {
      details[`code${tail}`] = `private-value-${i}`;
    });
    details['code\u0000'] = 'private-value-nul';
    const text = JSON.stringify(await inMode(mode, entry({ details })));
    CODE_TAILS.forEach((tail, i) => {
      expect(text, `${mode} ${JSON.stringify(tail)}`).not.toContain(`private-value-${i}"`);
    });
    expect(text).not.toContain('private-value-nul');
  });

  it.each(MODES)('%s: parameters inside entry text', async (mode) => {
    const message = CODE_TAILS.map((tail, i) => `?code${tail}=private-${i}-x&k=${i}`).join(' ');
    const result = await inMode(mode, entry({ details: { message } }));
    const text = JSON.stringify(result);
    CODE_TAILS.forEach((_, i) => expect(text, `${mode} ${i}`).not.toContain(`private-${i}-x`));
  });

  it('names that merely contain code stay', () => {
    for (const text of ['?status_code=404', '?error.code=5', '?codec=h264', '?zipcode=100-0001']) {
      expect(redactSecretsInText(text), text).toBe(text);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. a number named code
// ---------------------------------------------------------------------------------------------

const STATUS_NAMES = [
  'status',
  'statusCode',
  'status_code',
  'httpStatus',
  'http_status',
  'responseCode',
  'response_code',
  'errorCode',
  'error_code',
];

describe('a number named code is a secret', () => {
  it.each(MODES)('%s: pin.code 321 and every other number', async (mode) => {
    const result = await inMode(
      mode,
      entry({
        details: { pin: { code: 321 }, a: { code: 404 }, b: { code: 100 }, c: { code: 599 } },
      })
    );
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/"code":(321|404|100|599)\b/);
    expect(text).not.toContain('321');
  });

  it('is a marker, at any depth', async () => {
    const result = (await protectDiagnosticEntry({
      details: { verify: { code: 321 }, x: [{ y: { code: 7 } }] },
    } as any)) as any;
    expect(result.details.verify.code).toBe('[SECRET_REDACTED]');
    expect(result.details.x[0].y.code).toBe('[SECRET_REDACTED]');
  });

  it.each(MODES)('%s: status names keep their value, number or string', async (mode) => {
    const details: Record<string, unknown> = {};
    STATUS_NAMES.forEach((name, i) => {
      details[name] = i % 2 === 0 ? 400 + i : `E${i}`;
    });
    const result = await inMode(mode, entry({ details }));
    if (mode === 'minimal') return;
    STATUS_NAMES.forEach((name, i) => {
      expect(result.details[name], `${mode} ${name}`).toBe(i % 2 === 0 ? 400 + i : `E${i}`);
    });
  });

  it('status names are no secret names', () => {
    for (const name of STATUS_NAMES) expect(isSecretName(name), name).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. a secret word anywhere
// ---------------------------------------------------------------------------------------------

const SECRET_ANYWHERE = [
  'secret_value',
  'secretValue',
  'SecretValue',
  'access_token[0]',
  'access_token.0',
  'access_token[]',
  'accessToken[3]',
  'access_token[0].value',
  'tokens[0].value',
  'tokens[]',
  'token_value',
  'password_value',
  'cookie_header',
  'cookieValue',
  'refresh_token_hint',
  'client_secret_value',
  'api_key_value',
  'private_key_pem',
  'secret.value',
  'my-secret-thing',
  'session_cookie',
  'id_token_hint',
  'authorization_header',
  'authorization_value',
  'authenticationValue',
  'otp_code_value',
  'secret_',
  '_secret',
  'xxcookie',
  'bypasscode',
];

const METADATA_NAMES = [
  'token_type',
  'tokenType',
  'token_count',
  'tokenCount',
  'token_hash',
  'tokenHash',
  'tokenFingerprint',
  'token_expires_in',
  'expires_in',
  'secret_name',
  'secretName',
  'secret_id',
  'secretId',
  'secret_version',
  'cookie_policy',
  'cookiePolicy',
  'password_policy',
  'passwordPolicy',
  'max_token_lifetime',
  'max_token_age',
  'access_token_lifetime',
  'refresh_token_ttl',
  'access_token_ttl',
  'token_endpoint',
  'token_endpoint_auth_method',
  'tokenUrl',
  'token_url',
  'client_secret_basic',
  'client_secret_post',
  'client_secret_jwt',
  'client_secret_expires_at',
  'id_token_signed_response_alg',
  'authorization_endpoint',
  'authorization_details',
  'authentication_method',
  'authentication_time',
  'cookie_domain',
  'password_length',
  'monkey',
  'turkey',
  'hockey',
  'tokenizer',
  'secretary',
  'passwordless',
  'status_code',
  'page_size',
];

describe('a secret word anywhere in a name', () => {
  it('names a secret', () => {
    for (const name of SECRET_ANYWHERE) expect(isSecretName(name), name).toBe(true);
  });

  it('metadata names and look-alikes are not secrets', () => {
    for (const name of METADATA_NAMES) expect(isSecretName(name), name).toBe(false);
  });

  it('an index after a word that ends the name does not hide it', () => {
    for (const name of [
      'authorization[0]',
      'Authorization.0',
      'authorization[]',
      'authentication[1]',
    ]) {
      expect(isSecretName(name), name).toBe(true);
    }
    for (const name of ['token[0].type', 'secret[2].name']) {
      expect(isSecretName(name), name).toBe(false);
    }
  });

  it('a name that reads as code once its separators are gone is code', () => {
    for (const name of ['co de', 'c o d e', 'C-O-D-E', 'co%20de']) {
      expect(isSecretName(name), name).toBe(true);
    }
  });

  it('an array index is dropped, before and after', () => {
    for (const name of [
      'access_token[0]',
      'access_token.0',
      'access_token[]',
      'access_token[12]',
    ]) {
      expect(isSecretName(name), name).toBe(true);
    }
    for (const name of ['token_type[0]', 'token_count.0', 'tokenHash[]']) {
      expect(isSecretName(name), name).toBe(false);
    }
  });

  it('plural names hide strings and structures but keep counts', () => {
    expect(secretNameKind('tokens')).toBe('plural');
    expect(secretNameKind('total_tokens')).toBe('plural');
    expect(secretNameKind('max_tokens')).toBeNull();
    expect(secretNameKind('access_token')).toBe('secret');
  });

  it.each(MODES)('%s: object keys', async (mode) => {
    const details: Record<string, unknown> = {};
    SECRET_ANYWHERE.forEach((name, i) => {
      details[name] = `private-anywhere-${i}`;
    });
    const text = JSON.stringify(await inMode(mode, entry({ details })));
    SECRET_ANYWHERE.forEach((_, i) =>
      expect(text, `${mode} ${i}`).not.toContain(`private-anywhere-${i}"`)
    );
  });

  it.each(MODES)('%s: metadata keys keep their value', async (mode) => {
    const details: Record<string, unknown> = {};
    METADATA_NAMES.forEach((name, i) => {
      details[name] = `value-${i}`;
    });
    const result = await inMode(mode, entry({ details }));
    if (mode === 'minimal') return;
    METADATA_NAMES.forEach((name, i) => {
      expect(result.details[name], `${mode} ${name}`).toBe(`value-${i}`);
    });
  });

  it.each(MODES)('%s: a count under a plural name stays, a string does not', async (mode) => {
    const result = await inMode(
      mode,
      entry({
        details: {
          total_tokens: 120,
          prompt_tokens: 20,
          tokens: ['private-t1'],
          nested: { tokens: { a: 'private-t2' } },
        },
      })
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain('private-t1');
    expect(text).not.toContain('private-t2');
    if (mode !== 'minimal') {
      expect(result.details.total_tokens).toBe(120);
      expect(result.details.prompt_tokens).toBe(20);
    }
  });

  it('parameter names and JSON members in text', () => {
    for (const name of SECRET_ANYWHERE.filter((n) => !/^[_]/.test(n))) {
      expect(redactSecretsInText(`?${name}=private-value&x=1`), name).not.toContain(
        'private-value'
      );
      expect(redactSecretsInText(`{"${name}":"private-value","p":1}`), name).not.toContain(
        'private-value'
      );
    }
    for (const name of METADATA_NAMES) {
      expect(redactSecretsInText(`?${name}=plain&x=1`), name).toBe(`?${name}=plain&x=1`);
      expect(redactSecretsInText(`{"${name}":"plain","p":1}`), name).toBe(
        `{"${name}":"plain","p":1}`
      );
    }
  });

  it('the exact reports', () => {
    expect(redactSecretsInText('?secret_value=private-value&x=1')).toBe(
      '?secret_value=[SECRET_REDACTED]&x=1'
    );
    expect(redactSecretsInText('?access_token[0]=private-value&x=1')).toBe(
      '?access_token[0]=[SECRET_REDACTED]&x=1'
    );
  });

  it('a word that only contains a secret word is not one', () => {
    for (const name of ['monkey', 'turkey', 'hockey', 'tokenizer', 'secretary', 'cookiejar']) {
      expect(isSecretName(name), name).toBe(false);
    }
  });
});
