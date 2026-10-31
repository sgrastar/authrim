/**
 * Tenth round:
 *  1. password_hash and the other stored forms of a credential are secrets; only the hash or
 *     fingerprint of a TOKEN is a public handle. Password hash formats (Argon2, bcrypt, scrypt,
 *     PBKDF2, crypt) are secrets by their shape, under any name and in any text.
 *  2. A plural name is judged on its decoded form too (tokens.%70assword, tokens.%FF).
 *  3. A value after a line break is still the value (client_secret =\nraw), after `=`.
 */

import { describe, it, expect } from 'vitest';
import {
  isSecretName,
  secretNameKind,
  redactSecretsInText,
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
// 1. hashes
// ---------------------------------------------------------------------------------------------

const ARGON2 =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$RdescudvJCsgt3ub+b+dWRWJTmaaJObG';
const BCRYPT = '$2b$12$KIXQJ5eq3bQ5kq7e3Pq1YOaS6mH0ZyC1rPZ5oQ5y7Yb2pU8mXkq2G';
const SCRYPT =
  '$scrypt$ln=16,r=8,p=1$aM15713r3Xsvxbi31lqr1Q$nFNh2CVHVjNldFVKDHDlm4CbdRSCdEBsjjJxD+iCs5E';
const PBKDF2 =
  '$pbkdf2-sha256$29000$N2YMIWQsBUIoZYyxVgqBMA$eKZDkNGV9r3QCEUG4WfpY5mMLzbPB2fcQFHfUVs0gY8';
const CRYPT_SHA512 = '$6$rounds=5000$saltsalt$Gcm6FsVtF/Qa77ZKD.iwsJlCVPY0XSMgLJL0Hnww/c1';
const CRYPT_SHA256 = '$5$saltsalt$bw3FVTEc3d3CkcQ8HkKI3PfNdWHT1aJTiqQDWpDLoh1';
const CRYPT_MD5 = '$1$saltsalt$qjXMvbEw8oaL.CzflDtaK/';
const CRYPT_YESCRYPT = '$y$j9T$F5Jx5fExrKuPp53xLKQ..1$X3DX6M94c7o.9agCG9G317fhZg9SqC.5i5rd.RhAtQ7';
const HASHES = [
  ARGON2,
  BCRYPT,
  SCRYPT,
  PBKDF2,
  CRYPT_SHA512,
  CRYPT_SHA256,
  CRYPT_MD5,
  CRYPT_YESCRYPT,
];

const STORED_SECRET_NAMES = [
  'password_hash',
  'passwordHash',
  'PasswordHash',
  'pwd_hash',
  'pwdHash',
  'passwd_hash',
  'client_secret_hash',
  'clientSecretHash',
  'secret_hash',
  'secret_digest',
  'pin_hash',
  'api_key_hash',
  'apiKeyHash',
  'api_key_digest',
  'private_key_hash',
  'otp_hash',
  'code_verifier_hash',
  'credential_hash',
  'passphrase_hash',
  'password_fingerprint',
  'cookie_hash',
  'password.hash',
  'password-digest',
  'my+password+hash',
];

const TOKEN_HANDLE_NAMES = [
  'tokenHash',
  'token_hash',
  'at_hash',
  'c_hash',
  'access_token_fingerprint',
  'accessTokenFingerprint',
  'refresh_token_hash',
  'id_token_digest',
  'session_token_hash',
  'tokenFingerprint',
  'access_token_hash',
  'logout_token_hash',
];

const IDENTIFIER_NAMES = [
  'secret_id',
  'secretId',
  'secret_version',
  'secret_name',
  'secretName',
  'pin_length',
  'pin_policy',
  'password_policy',
  'password_length',
  'credential_type',
  'otp_length',
];

describe('a hash of a credential is a secret, a hash of a token is a handle', () => {
  it('names', () => {
    for (const name of STORED_SECRET_NAMES) expect(isSecretName(name), name).toBe(true);
    for (const name of [...TOKEN_HANDLE_NAMES, ...IDENTIFIER_NAMES])
      expect(isSecretName(name), name).toBe(false);
  });

  it('a short secret word counts only on its own', () => {
    expect(isSecretName('pin')).toBe(true);
    expect(isSecretName('PIN')).toBe(true);
    expect(isSecretName('user_pin')).toBe(true);
    expect(isSecretName('pwd')).toBe(true);
    for (const name of ['spin', 'shipping', 'mapping', 'hotp', 'pinned', 'ping', 'opinion']) {
      expect(isSecretName(name), name).toBe(false);
    }
  });

  it.each(MODES)(
    '%s: stored secrets are hidden, token handles and identifiers stay',
    async (mode) => {
      const details: Record<string, unknown> = {};
      STORED_SECRET_NAMES.forEach((name, i) => {
        details[name] = `private-stored-${i}`;
      });
      TOKEN_HANDLE_NAMES.forEach((name, i) => {
        details[name] = `handle-${i}`;
      });
      IDENTIFIER_NAMES.forEach((name, i) => {
        details[name] = `ident-${i}`;
      });
      const result = await inMode(mode, entry({ details }));
      const text = JSON.stringify(result);
      STORED_SECRET_NAMES.forEach((_, i) =>
        expect(text, `${mode} ${i}`).not.toContain(`private-stored-${i}"`)
      );
      if (mode === 'minimal') return;
      TOKEN_HANDLE_NAMES.forEach((name, i) =>
        expect(result.details[name], `${mode} ${name}`).toBe(`handle-${i}`)
      );
      IDENTIFIER_NAMES.forEach((name, i) =>
        expect(result.details[name], `${mode} ${name}`).toBe(`ident-${i}`)
      );
    }
  );

  it.each(MODES)('%s: the reported password_hash with an Argon2 value', async (mode) => {
    const result = await inMode(mode, entry({ details: { password_hash: ARGON2, user: 'u1' } }));
    expect(JSON.stringify(result)).not.toContain('argon2id');
    expect(JSON.stringify(result)).not.toContain('RdescudvJ');
    const again = await inMode(mode, result as unknown as DiagnosticLogEntry);
    expect(again).toEqual(result);
  });
});

describe('a password hash is a secret by its shape', () => {
  it('under any key, in every mode', async () => {
    for (const mode of MODES) {
      for (const [i, hash] of HASHES.entries()) {
        const result = await inMode(
          mode,
          entry({ details: { note: hash, anything: { deep: [hash] }, 'k e y': hash } })
        );
        const text = JSON.stringify(result);
        const marker = hash.slice(0, 20);
        expect(text, `${mode} ${i}`).not.toContain(marker.slice(0, 12));
        expect(text, `${mode} ${i}`).not.toContain(hash.slice(-16));
        const again = await inMode(mode, result as unknown as DiagnosticLogEntry);
        expect(again, `${mode} ${i}`).toEqual(result);
      }
    }
  });

  it('in free text, JSON text, parameters and the entry text fields', async () => {
    for (const hash of HASHES) {
      const tail = hash.slice(-16);
      for (const text of [
        `stored hash ${hash} did not match`,
        `{"x":"${hash}","p":1}`,
        `?foo=${hash}&x=1`,
        `foo=${hash}`,
        `value:${hash};next`,
      ]) {
        expect(redactSecretsInText(text), text).not.toContain(tail);
      }
      for (const mode of MODES) {
        const result = await inMode(
          mode,
          entry({ errorMessage: `compare ${hash} failed`, reason: `h=${hash}` })
        );
        expect(JSON.stringify(result), mode).not.toContain(tail);
      }
    }
  });

  it('keeps what only looks a little like one', () => {
    for (const text of [
      'costs $5$ per unit',
      'price $100 or $2b',
      'a $argon2 note',
      '$6$ short',
      'cash$1$ok',
      'path $HOME/x',
    ]) {
      expect(redactSecretsInText(text), text).toBe(text);
    }
  });

  it('is linear on a long run of dollar signs', () => {
    const text = '$argon2id$'.repeat(30_000);
    const started = performance.now();
    redactSecretsInText(text);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. plural and decoding
// ---------------------------------------------------------------------------------------------

const PLURAL_ENCODED = [
  'tokens.%70assword',
  'tokens.%FF',
  'secrets.%2570assword',
  'tokens%2Epassword',
  'tokens.password',
  'tokens.%2570%252561ssword',
  'tokens.%C0%AF',
  'tokens.%ED%A0%80',
];

describe('a plural name is judged on its decoded form', () => {
  it('kinds', () => {
    for (const name of PLURAL_ENCODED) expect(secretNameKind(name), name).toBe('secret');
    // a plural whose decoded form is the same plural keeps the count exception
    expect(secretNameKind('total_tokens')).toBe('plural');
    expect(secretNameKind('total%5Ftokens')).toBe('plural');
    expect(secretNameKind('tokens%20')).toBe('plural');
    // the two readings disagree: no count exception
    expect(secretNameKind('tokens%20type')).toBe('secret');
    expect(secretNameKind('%74okens')).toBe('secret');
    // the decoded form is judged even when the name as written is not a secret
    expect(secretNameKind('%70assword')).toBe('secret');
  });

  it.each(MODES)('%s: numbers and strings under such keys are hidden', async (mode) => {
    const details: Record<string, unknown> = {};
    PLURAL_ENCODED.forEach((name, i) => {
      details[`${name}`] = 123456 + i;
      details[`s:${name}`] = `private-plural-${i}`;
    });
    const text = JSON.stringify(await inMode(mode, entry({ details })));
    PLURAL_ENCODED.forEach((_, i) => {
      expect(text, `${mode} ${i}`).not.toContain(String(123456 + i));
      expect(text, `${mode} ${i}`).not.toContain(`private-plural-${i}`);
    });
  });

  it('the reported keys', async () => {
    const result = (await protectDiagnosticEntry({
      details: { 'tokens.%70assword': 123456, 'tokens.%FF': 654321, total_tokens: 120 },
    } as any)) as any;
    const values = Object.entries(result.details);
    expect(JSON.stringify(values)).not.toContain('123456');
    expect(JSON.stringify(values)).not.toContain('654321');
    expect(result.details.total_tokens).toBe(120);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. a value after a line break
// ---------------------------------------------------------------------------------------------

const BREAKS = [
  '\n',
  '\r\n',
  '\r',
  '\n\n',
  '\r\n\r\n',
  ' \n ',
  '\n  ',
  '\v',
  '\f',
  '\u0085',
  ' ',
  ' ',
  ' ',
  '　',
  '\t\n\t',
];

describe('a value after a line break is still the value', () => {
  it('equals sign', () => {
    for (const gap of BREAKS) {
      for (const before of ['', ' ']) {
        const text = `client_secret${before}=${gap}raw-secret and more`;
        expect(redactSecretsInText(text), JSON.stringify(text)).not.toContain('raw-secret');
        expect(redactSecretsInText(text), JSON.stringify(text)).toContain('and more');
      }
    }
  });

  it('the reported cases', () => {
    expect(redactSecretsInText('client_secret =\nraw-secret')).toBe(
      'client_secret =\n[SECRET_REDACTED]'
    );
    expect(redactSecretsInText('client_secret=\r\nraw-secret')).toBe(
      'client_secret=\r\n[SECRET_REDACTED]'
    );
    expect(redactSecretsInText('client_secret=\n\nraw-secret')).toBe(
      'client_secret=\n\n[SECRET_REDACTED]'
    );
  });

  it('an empty value stays empty', () => {
    for (const text of [
      'client_secret=&x=1',
      'client_secret=',
      'client_secret= ',
      'client_secret=;x=1',
      '{"client_secret": "", "x": 1}',
      '{"client_secret":""}',
    ]) {
      expect(redactSecretsInText(text), JSON.stringify(text)).toBe(text);
    }
  });

  it('an empty value before a line break takes the next word: when in doubt it is hidden', () => {
    expect(redactSecretsInText('client_secret=\nstatus=ok and more')).toBe(
      'client_secret=\n[SECRET_REDACTED] and more'
    );
  });

  it.each(MODES)('%s: in entry text, every mode, idempotent', async (mode) => {
    const messages = BREAKS.map((gap, i) => `client_secret =${gap}raw-secret-${i} x`);
    const e = entry({
      details: { message: messages.join(' | ') },
      errorMessage: 'client_secret=\r\nraw-secret-e',
    });
    const result = await inMode(mode, e);
    const text = JSON.stringify(result);
    expect(text).not.toContain('raw-secret');
    const again = await inMode(mode, result as unknown as DiagnosticLogEntry);
    expect(again).toEqual(result);
  });
});
