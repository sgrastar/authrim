/**
 * Eleventh round: the password hash Authrim itself stores (hashPassword, `pbkdf2v1$600000$salt$hash`)
 * and the private members of a JWK are secrets by their shape, in any text and under any name.
 * A `name: value` pair in free text is a known limit and is not asserted either way.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { hashPassword } from '../crypto';
import { redactSecretsInText, protectDiagnosticEntry, isSecretName } from '../diagnostic-redaction';
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

let real = '';
let variants: string[] = [];

beforeAll(async () => {
  // The real output of the function that stores passwords (600,000 iterations: once)
  real = await hashPassword('correct horse battery staple');
  const [, , salt, hash] = real.split('$');
  variants = [
    real,
    `pbkdf2v2$1200000$${salt}$${hash}`,
    `pbkdf2v10$1000000$${salt}$${hash}${hash}`,
    `pbkdf2v1$600000$${salt}$${hash.slice(0, 20)}`,
    `pbkdf2v3$9$${salt}${salt}$${hash}`,
  ];
}, 60_000);

/** The last part of a hash: no marker of the format is needed to know it is gone. */
const tailOf = (hash: string) => hash.slice(-14);

describe('the format of hashPassword', () => {
  it('is what the test expects of it', () => {
    expect(real).toMatch(/^pbkdf2v1\$600000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  });

  it('is hidden in free text, JSON text and parameters', () => {
    for (const hash of variants) {
      for (const text of [
        `stored ${hash} did not match`,
        `${hash}`,
        `{"stored":"${hash}","p":1}`,
        `?stored=${hash}&x=1`,
        `stored=${hash}`,
        `db row: (${hash}), next`,
        `a|${hash}|b`,
      ]) {
        const out = redactSecretsInText(text);
        expect(out, text).not.toContain(tailOf(hash));
        expect(out, text).not.toContain('pbkdf2v');
        expect(redactSecretsInText(out), text).toBe(out);
      }
    }
  });

  it('is hidden under any key and in any entry text field, in every mode', async () => {
    for (const mode of MODES) {
      for (const hash of variants) {
        const result = await inMode(
          mode,
          entry({
            errorMessage: `compare ${hash} failed`,
            reason: `h=${hash}`,
            details: { note: hash, nested: { list: [hash], 'a b': hash }, message: `row ${hash}` },
            metadata: { x: hash },
          })
        );
        expect(JSON.stringify(result), mode).not.toContain(tailOf(hash));
        const again = await inMode(mode, result as unknown as DiagnosticLogEntry);
        expect(again, mode).toEqual(result);
      }
    }
  });

  it('is hidden as an object value outside a mode', async () => {
    const result = (await protectDiagnosticEntry({
      details: { note: real, list: [real] },
    } as any)) as any;
    expect(JSON.stringify(result)).not.toContain(tailOf(real));
  });

  it('is hidden under a password name too (the name rule and the shape rule agree)', async () => {
    const result = await inMode(
      'full',
      entry({ details: { password_hash: real, passwordHash: real } })
    );
    expect(JSON.stringify(result)).not.toContain(tailOf(real));
  });

  it('does not take other text for a hash', () => {
    for (const text of [
      'pbkdf2v1 is the name of the scheme',
      'pbkdf2v1$600000$short$short',
      'xpbkdf2v1$600000$aaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'costs $5$ per unit',
      'price $100 or $2b',
      'path $HOME/x and $PATH',
      'cash$1$ok',
      'pbkdf2 with 600000 iterations',
    ]) {
      expect(redactSecretsInText(text), text).toBe(text);
    }
  });

  it('is linear on a long run of its prefix', () => {
    const text = 'pbkdf2v1$600000$'.repeat(30_000);
    const started = performance.now();
    redactSecretsInText(text);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe('the private members of a JWK', () => {
  const D = 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A';
  const X = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';

  it('are hidden in JSON text, whatever the other members', () => {
    for (const text of [
      `{"kty":"OKP","crv":"Ed25519","x":"${X}","d":"${D}"}`,
      `{"d":"${D}","kty":"OKP","x":"${X}"}`,
      `key = {'kty': 'EC', 'd': '${D}', 'x': '${X}'}`,
      `{"kty":"RSA","n":"${X}","e":"AQAB","d":"${D}","p":"${D}","q":"${D}","dp":"${D}","dq":"${D}","qi":"${D}"}`,
      `{"kty":"oct","k":"${D}"}`,
    ]) {
      const out = redactSecretsInText(text);
      expect(out, text).not.toContain(D);
      expect(redactSecretsInText(out), text).toBe(out);
    }
    // the public members stay
    expect(redactSecretsInText(`{"kty":"OKP","x":"${X}","d":"${D}"}`)).toContain(X);
  });

  it('are hidden as object members, in every mode', async () => {
    for (const mode of MODES) {
      const result = await inMode(
        mode,
        entry({
          details: {
            jwk: { kty: 'OKP', crv: 'Ed25519', x: X, d: D },
            list: [{ kty: 'oct', k: D }],
          },
        })
      );
      const text = JSON.stringify(result);
      expect(text, mode).not.toContain(D);
      if (mode === 'full') expect(text).toContain(X);
    }
  });

  it('an object that is no JWK keeps its d, p and q', async () => {
    const result = (await protectDiagnosticEntry({
      details: { dims: { d: 3, p: 'plain', q: 'x' } },
    } as any)) as any;
    expect(result.details.dims).toEqual({ d: 3, p: 'plain', q: 'x' });
  });

  it('a private JWK name is a secret', () => {
    for (const name of ['privateJwk', 'private_jwk', 'tenant.privateJwk']) {
      expect(isSecretName(name), name).toBe(true);
    }
    expect(isSecretName('publicJwk')).toBe(false);
  });
});
