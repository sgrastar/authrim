/**
 * Hardening of the diagnostic redaction: identifiers that are secrets, secrets in JSON and URL
 * text, linear-time scanning, Unicode personal data, keys, idempotency, hostile values.
 */

import { describe, it, expect } from 'vitest';
import {
  fingerprint,
  isSafeIdentifier,
  protectDiagnosticEntry,
  redactCompactJwts,
  redactEmails,
  redactPhoneNumbers,
  redactPiiText,
  redactSecretsInText,
  redactionWork,
  safeSnapshot,
} from '../diagnostic-redaction';
import { applyPrivacyModeToEntry, redactPII } from '../diagnostic-security';
import type { DiagnosticLogEntry } from '../../services/diagnostic/types';

const MODES = ['full', 'masked', 'minimal'] as const;

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const JWT = `${b64url('{"alg":"RS256","typ":"JWT"}')}.${b64url('{"sub":"user-1"}')}.c2lnbmF0dXJl`;

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

describe('a secret is never accepted as an identifier', () => {
  it('rejects a JWT (by decoding it) and a long token, and accepts dotted ids', () => {
    expect(JWT.length).toBeLessThanOrEqual(128);
    for (const value of [JWT, 'x'.repeat(40), 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0']) {
      expect(isSafeIdentifier(value), value).toBe(false);
    }
    for (const value of [
      'req-123',
      'session-a:1',
      '550e8400-e29b-41d4-a716-446655440000',
      '0123456789abcdef0123456789abcdef',
      'trace.1',
      'sha256:0123456789ab',
      'run-2026.10.16-001',
      'v1.2.3',
      'a.b.c',
    ]) {
      expect(isSafeIdentifier(value), value).toBe(true);
    }
  });

  it.each(MODES)('%s: a JWT as requestId or diagnosticSessionId is not stored', async (mode) => {
    const result = await inMode(
      mode,
      entry({ requestId: JWT, diagnosticSessionId: JWT, flowId: 'x'.repeat(60) })
    );
    expect(JSON.stringify(result)).not.toContain(JWT);
    expect(JSON.stringify(result)).not.toContain(JWT.split('.')[0]);
    expect(result.requestId).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(result.diagnosticSessionId).toMatch(/^sha256:/);
    expect(result.flowId).toMatch(/^sha256:/);
  });
});

describe('secret values are fingerprinted before any mode-specific mask', () => {
  it.each(['masked', 'minimal'] as const)(
    '%s: no step keeps the shell of a token',
    async (mode) => {
      const steps: Array<[string, Record<string, unknown>]> = [
        ['token-request', { code: 'abc123-code-xyz', code_verifier: 'abc123-verifier-xyz' }],
        [
          'token-response',
          {
            access_token: 'abc123',
            id_token: 'abc123-id-xyz',
            refresh_token: 'abc123-refresh-xyz',
          },
        ],
        ['issuer-check', { access_token: 'abc123-other-xyz' }],
        ['userinfo-response', { access_token: 'abc123-userinfo-xyz', claims: { sub: 's' } }],
      ];
      for (const [step, details] of steps) {
        const result = await inMode(mode, entry({ step, details }));
        const text = JSON.stringify(result);
        expect(text, step).not.toMatch(/abc123/);
        if (mode === 'masked') expect(text, step).toMatch(/sha256:[0-9a-f]{12}/);
      }
    }
  );

  it.each(MODES)(
    '%s: the fingerprint is that of the token itself, so entries still correlate',
    async (mode) => {
      const expected = await fingerprint('abc123');
      const result = await inMode(
        mode,
        entry({
          step: 'token-response',
          details: { access_token: 'abc123', other: { refresh_token: 'abc123' } },
        })
      );
      if (mode === 'minimal') {
        expect(result.details).not.toHaveProperty('access_token');
        return;
      }
      expect(result.details.access_token).toBe(expected);
      expect(result.details.other.refresh_token).toBe(expected);
    }
  );

  it('masked: a sender-supplied partial-mask shape under a secret key is not accepted as protection', async () => {
    const result = await inMode(
      'masked',
      entry({ step: 'token-response', details: { access_token: 'abcdef...wxyz (hmac:00000000)' } })
    );
    expect(result.details.access_token).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(JSON.stringify(result)).not.toContain('abcdef');
  });

  it('masked: http-request query and body secrets and an auth-decision context are fingerprints', async () => {
    const request = await inMode(
      'masked',
      entry({
        category: 'http-request',
        method: 'POST',
        path: '/token',
        query: { state: 'opaque-state-value', code: 'qcode-123456' },
        bodySummary: { code: 'bcode-123456', code_verifier: 'bverifier-123456' },
      })
    );
    expect(JSON.stringify(request)).not.toMatch(/qcode|bcode|bverifier/);
    const decision = await inMode(
      'masked',
      entry({
        category: 'auth-decision',
        decision: 'allow',
        reason: 'ok',
        context: { code: 'dcode-123456', access_token: 'dtoken-123456', nonce: 'a-nonce-value' },
      })
    );
    expect(JSON.stringify(decision)).not.toMatch(/dcode|dtoken/);
  });
});

describe('secrets in JSON and URL text', () => {
  it('removes a value with an escaped quote in it entirely', () => {
    const out = redactSecretsInText('{"client_secret":"a\\"remaining-secret","scope":"openid"}');
    expect(out).not.toContain('remaining-secret');
    expect(out).toContain('"scope":"openid"');
    expect(out).toBe('{"client_secret":"[SECRET_REDACTED]","scope":"openid"}');
  });

  it('removes a secret value of any length', () => {
    const secret = 'z'.repeat(4100);
    const out = redactSecretsInText(`{"access_token":"${secret}","x":1}`);
    expect(out).not.toContain('zzzzzzzz');
    expect(out).toBe('{"access_token":"[SECRET_REDACTED]","x":1}');
  });

  it.each([
    ['{"password": 123456, "a": 1}', '{"password": "[SECRET_REDACTED]", "a": 1}'],
    ['{"password": true}', '{"password": "[SECRET_REDACTED]"}'],
    ['{"password": null}', '{"password": "[SECRET_REDACTED]"}'],
    [
      '{"refresh_token": {"v": "x", "w": ["y"]}, "k": 2}',
      '{"refresh_token": "[SECRET_REDACTED]", "k": 2}',
    ],
    ['{"refresh_token": ["a", "b"]}', '{"refresh_token": "[SECRET_REDACTED]"}'],
  ])('removes a non-string secret value: %s', (input, expected) => {
    expect(redactSecretsInText(input)).toBe(expected);
  });

  it('decodes a key written with unicode escapes', () => {
    const out = redactSecretsInText('{"\\u0073ecret":"hidden-value","\\u0063lient_secret":"cs"}');
    expect(out).not.toContain('hidden-value');
    expect(out).not.toContain('"cs"');
  });

  it('removes secrets in stringified JSON inside text, and with single quotes', () => {
    const out = redactSecretsInText(
      'body={\\"refresh_token\\":\\"raw\\\\\\"tail\\",\\"a\\":1} py={\'password\': \'p\\\'w\', \'b\': 2}'
    );
    expect(out).not.toMatch(/raw|tail|p\\'w/);
  });

  it('is not hidden by a stray quote earlier in the text', () => {
    const out = redactSecretsInText('He said " then {"client_secret":"hidden-value"}');
    expect(out).not.toContain('hidden-value');
  });

  it('takes the whole parameter value, a comma included', () => {
    const out = redactSecretsInText(
      'GET /cb?access_token=first,remaining-secret&state=keep&x=1 HTTP/1.1'
    );
    expect(out).not.toContain('remaining-secret');
    expect(out).not.toContain('first');
    expect(out).toContain('state=keep');
    expect(out).toContain('x=1');
  });

  it('splits parameters on & and ; and the fragment, not on commas', () => {
    const out = redactSecretsInText('?a=1;client_secret=s1,s2;b=2#id_token=t1&code=c1');
    for (const raw of ['s1', 's2', 't1', 'c1']) expect(out, raw).not.toContain(raw);
    expect(out).toContain('a=1;');
    expect(out).toContain('b=2');
  });

  it('removes a form body with percent-encoded and camelCase names', () => {
    const out = redactSecretsInText(
      'access%5Ftoken=a1&refreshToken=r1&Client-Secret=c1&grant_type=code'
    );
    for (const raw of ['a1', 'r1', 'c1']) expect(out, raw).not.toContain(raw);
    expect(out).toContain('grant_type=code');
  });

  it('is idempotent on its own markers', () => {
    const once = redactSecretsInText('?code=abc&access_token=def');
    expect(once).toBe('?code=[SECRET_REDACTED]&access_token=[SECRET_REDACTED]');
    expect(redactSecretsInText(once)).toBe(once);
    const json = redactSecretsInText('{"password":"x","a":"b"}');
    expect(redactSecretsInText(json)).toBe(json);
  });

  it('protects Basic credentials: user:password in base64, short or long, not prose', () => {
    expect(redactSecretsInText(`Authorization: Basic ${btoa('a:a')}`)).toBe(
      'Authorization: Basic [TOKEN_REDACTED]'
    );
    expect(redactSecretsInText(`got Basic ${btoa('user:password')} here`)).toBe(
      'got Basic [TOKEN_REDACTED] here'
    );
    expect(redactSecretsInText('Basic authentication is used')).toBe(
      'Basic authentication is used'
    );
    expect(redactSecretsInText('basic information')).toBe('basic information');
  });
});

describe('JWTs over the inspection limit', () => {
  it('replaces a valid JWT of 17,397 characters', () => {
    const big = `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ blob: 'q'.repeat(17_000) }))}.c2ln`;
    expect(big.length).toBeGreaterThan(17_000);
    expect(redactCompactJwts(`token ${big} end`)).toBe('token [JWT_REDACTED] end');
    expect(redactSecretsInText(`token ${big} end`)).not.toContain('eyJhbGci');
  });

  it('leaves a long dotted run that is not JWT-shaped alone', () => {
    const text = `${'word.'.repeat(5000)}end`;
    expect(redactCompactJwts(text)).toBe(text);
  });
});

describe('linear-time scanning', () => {
  const N = 100_000;
  const adversarial: Array<[string, string]> = [
    ['one long run then a dot', `${'x'.repeat(N)}.x`],
    ['a. repeated', 'a.'.repeat(N / 2)],
    ['a@ repeated', 'a@'.repeat(N / 2)],
    ['dots then at', `${'a.'.repeat(N / 2)}@x`],
    ['digit groups', '1 '.repeat(N / 2)],
    ['equals', '='.repeat(N)],
    ['name= repeated', 'a='.repeat(N / 2)],
    ['quotes', '"'.repeat(N)],
    ['key candidates', '":'.repeat(N / 2)],
    ['Bearer repeated', 'Bearer '.repeat(N / 7)],
    ['eyJ segments', 'eyJ.'.repeat(N / 4)],
    ['parentheses', '('.repeat(N)],
    ['spaces then at', `a${' '.repeat(N)}@b.c`],
    ['non-ASCII', 'é'.repeat(N)],
    ['phones', '090-1234-5678 '.repeat(N / 14)],
    ['full-width phones', '０９０－１２３４－５６７８ '.repeat(N / 20)],
    ['unclosed bracket secret', `{"password":${'['.repeat(N)}`],
    ['very long secret value', `{"client_secret":"${'a'.repeat(N)}"}`],
  ];

  it.each(adversarial)('stays linear and fast on 100 KB of %s', async (_name, input) => {
    for (const run of [
      () => redactSecretsInText(input),
      () => redactPiiText(input),
      () => redactEmails(input),
      () => redactPhoneNumbers(input),
      () => redactCompactJwts(input),
    ]) {
      redactionWork.units = 0;
      const started = performance.now();
      run();
      const elapsed = performance.now() - started;
      // The work counter is the check for linearity (a quadratic scan would be 10^10 steps
      // here); the clock bound is loose on purpose, so a loaded machine does not fail it.
      expect(redactionWork.units).toBeLessThanOrEqual(input.length * 12);
      expect(elapsed).toBeLessThan(1_500);
    }
    redactionWork.units = 0;
    const started = performance.now();
    await applyPrivacyModeToEntry(
      entry({ errorMessage: input, reason: input, details: { text: input } }),
      { mode: 'full', secret: 's' }
    );
    expect(redactionWork.units).toBeLessThanOrEqual(input.length * 40);
    expect(performance.now() - started).toBeLessThan(2_500);
  });

  it('cuts a text over the length limit with a marker and keeps the result bounded', async () => {
    const result = await protectDiagnosticEntry(
      entry({ errorMessage: `${'word '.repeat(40_000)} tail-secret` })
    );
    const message = (result as unknown as { errorMessage: string }).errorMessage;
    expect(message.endsWith('[TRUNCATED]')).toBe(true);
    expect(message.length).toBeLessThanOrEqual(65_536);
    expect(message).not.toContain('tail-secret');
  });

  it('replaces what an entry-wide budget cannot cover, never passing it through', async () => {
    const big = 'x'.repeat(60_000);
    const details: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) details[`k${i}`] = `${big} secret-marker-${i}`;
    const result = (await protectDiagnosticEntry(entry({ details }))) as unknown as {
      details: Record<string, string>;
    };
    const values = Object.values(result.details);
    expect(values.some((value) => value === '[TRUNCATED]')).toBe(true);
    for (const value of values) {
      expect(value === '[TRUNCATED]' || value.length > 1000).toBe(true);
    }
  });

  it('turns secrets beyond the fingerprint budget into a marker', async () => {
    const details: Record<string, string> = {};
    for (let i = 0; i < 2500; i += 1) details[`a${i}_password`] = `raw-${i}`;
    const result = (await protectDiagnosticEntry(entry({ details }))) as unknown as {
      details: Record<string, string>;
    };
    const values = Object.values(result.details);
    expect(JSON.stringify(values)).not.toMatch(/raw-\d/);
    expect(values.filter((value) => value === '[SECRET_REDACTED]').length).toBeGreaterThan(0);
  });
});

describe('personal data in free text', () => {
  it.each([
    ['call 2025550199 2025550188 now', 'call [PHONE_REDACTED] [PHONE_REDACTED] now'],
    ['090-1234-5678 090-1234-5679', '[PHONE_REDACTED] [PHONE_REDACTED]'],
    ['+81 90 1234 5678', '[PHONE_REDACTED]'],
    ['090\n1234\n5678', '[PHONE_REDACTED]'],
    ['０９０－１２３４－５６７８', '[PHONE_REDACTED]'],
    ['tel ０９０ １２３４ ５６７８.', 'tel [PHONE_REDACTED].'],
  ])('redacts every number in %j', (input, expected) => {
    expect(redactPII(input)).toBe(expected);
  });

  it.each([
    ['ユーザー@example.com', '[EMAIL_REDACTED]'],
    ['mail user@例え.テスト please', 'mail [EMAIL_REDACTED] please'],
    ['ｕｓｅｒ＠ｅｘａｍｐｌｅ．ｃｏｍ', '[EMAIL_REDACTED]'],
    ['a@b@c.com', 'a@[EMAIL_REDACTED]'],
    ['name@sub.exämple.de.', '[EMAIL_REDACTED].'],
  ])('redacts the email in %j', (input, expected) => {
    expect(redactPII(input)).toBe(expected);
  });

  it('maps the matches back to the original text, leaving the rest untouched', () => {
    expect(redactPII('前 ０９０－１２３４－５６７８ 後 ユーザー@example.com 終')).toBe(
      '前 [PHONE_REDACTED] 後 [EMAIL_REDACTED] 終'
    );
  });

  it('leaves what is not personal data', () => {
    for (const text of [
      'plain text',
      '2026-04-21T10:30:00Z',
      '1700000000123',
      '203.0.113.42',
      'user@localhost',
      'a@b',
    ]) {
      expect(redactPII(text), text).toBe(text);
    }
  });
});

describe('personal data keys, in any spelling', () => {
  it.each([
    'givenName',
    'familyName',
    'displayName',
    'given-name',
    'Family_Name',
    'preferredUsername',
    'full_name',
    'nickName',
  ])('full: %s is masked', async (key) => {
    const result = await inMode('full', entry({ details: { claims: { [key]: '田中太郎' } } }));
    expect(JSON.stringify(result)).not.toContain('田中');
  });

  it.each(['ipAddress', 'clientIp', 'remoteAddr', 'X-Forwarded-For', 'x_real_ip'])(
    'full: %s is masked to its network',
    async (key) => {
      const result = await inMode('full', entry({ details: { [key]: '203.0.113.42' } }));
      expect(JSON.stringify(result)).not.toContain('203.0.113.42');
    }
  );

  it.each(['streetAddress', 'postal_code', 'zipCode', 'birthDate', 'dateOfBirth', 'gender'])(
    'full: %s is redacted',
    async (key) => {
      const result = await inMode('full', entry({ details: { claims: { [key]: 'raw-value' } } }));
      expect(JSON.stringify(result)).not.toContain('raw-value');
    }
  );

  it('full: phoneNumber and emailAddress are masked', async () => {
    const result = await inMode(
      'full',
      entry({
        details: { claims: { phoneNumber: '+81 90-1234-5678', emailAddress: 'jane@example.com' } },
      })
    );
    expect(JSON.stringify(result)).not.toMatch(/90-1234|jane@/);
    expect(result.details.claims.phoneNumber).toMatch(/^\*\*\*-\*\*\*-5678 \(hmac:/);
  });

  it('shows them only when the PII filter is explicitly off', async () => {
    const result = await inMode(
      'full',
      entry({ details: { claims: { givenName: 'Jane', ipAddress: '203.0.113.42' } } }),
      false
    );
    expect(JSON.stringify(result)).toContain('Jane');
    expect(JSON.stringify(result)).toContain('203.0.113.42');
  });
});

describe('short names are not shown by a partial mask', () => {
  it.each(['田中', '田中太', 'Li', 'Alice', 'Jonathan'])(
    '%s keeps nothing but its HMAC',
    async (name) => {
      for (const mode of ['full', 'masked'] as const) {
        const claims = { name, family_name: name };
        const result = await inMode(
          mode,
          entry({ step: 'userinfo-response', details: { claims } })
        );
        const shown = JSON.stringify(result.details.claims);
        expect(shown, `${mode} ${name}`).not.toContain(name);
        expect(shown).not.toContain(name.slice(0, 1));
        expect(shown).toMatch(/hmac:[0-9a-f]{12}/);
      }
    }
  );

  it('keeps a small fraction of a long name', async () => {
    const result = await inMode(
      'full',
      entry({ details: { claims: { name: 'Bartholomew Winchester' } } })
    );
    expect(result.details.claims.name).toMatch(/^Ba\.\.\.r \(hmac:/);
  });
});

describe('object keys are protected', () => {
  it('replaces a key that holds an email, a phone number or a secret, keeping the value', async () => {
    const result = await inMode(
      'full',
      entry({
        details: {
          'jane@example.com': { status: 'ok' },
          '090-1234-5678': 'busy',
          [JWT]: 'jwt-key',
          'Bearer abc.def-123': 'bearer-key',
          'access_token=abc123': 'param-key',
          safe_key: 'kept',
        },
      })
    );
    const text = JSON.stringify(result);
    for (const raw of ['jane@example.com', '090-1234-5678', JWT, 'abc.def-123', 'abc123']) {
      expect(text, raw).not.toContain(raw);
    }
    expect(Object.values(result.details)).toEqual(
      expect.arrayContaining([{ status: 'ok' }, 'busy', 'jwt-key', 'bearer-key', 'kept'])
    );
    // a key that names a secret (access_token) hides its value too
    expect(text).not.toContain('param-key');
    expect(result.details.safe_key).toBe('kept');
  });

  it('keeps the values of keys that collide once replaced, suffixing the key', async () => {
    const long = 'k'.repeat(300);
    const result = (await protectDiagnosticEntry(
      entry({ details: { [`${long}1`]: 'one', [`${long}2`]: 'two' } })
    )) as unknown as { details: Record<string, string> };
    // keys too long to inspect are secrets: both values are kept apart as fingerprints
    expect(Object.keys(result.details)).toHaveLength(2);
    const values = Object.values(result.details);
    expect(values).toHaveLength(2);
    expect(new Set(values).size).toBe(2);
    expect(JSON.stringify(values)).not.toMatch(/one|two/);
  });

  it('suffixes a key that collides with a replaced one, losing no value', async () => {
    const taken = await fingerprint('jane@example.com');
    const result = await inMode(
      'full',
      entry({ details: { [taken]: 'already here', 'jane@example.com': 'moved' } })
    );
    expect(Object.keys(result.details).sort()).toEqual([taken, `${taken}~2`]);
    expect(result.details[taken]).toBe('already here');
    expect(result.details[`${taken}~2`]).toBe('moved');
  });

  it('leaves email keys alone in full mode when the PII filter is off', async () => {
    const result = await inMode('full', entry({ details: { 'jane@example.com': 'x' } }), false);
    expect(Object.keys(result.details)).toEqual(['jane@example.com']);
  });

  it('protects unknown top-level field names of an entry too', async () => {
    const result = await protectDiagnosticEntry(entry({ 'jane@example.com': 'x' }), {
      redactEmailsInFreeText: true,
    });
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
  });
});

describe('protecting twice changes nothing', () => {
  const corpus: unknown[] = [
    'plain',
    '?code=abc&access_token=def',
    '{"password":"x","a":{"client_secret":"y"}}',
    'Bearer abc123 and Basic YTph',
    'jane@example.com (hmac:abcdef12)',
    '(hmac:abcdef12) jane@example.com',
    'sha256:0123456789ab jane@example.com',
    '090-1234-5678 2025550199 2025550188',
    '０９０－１２３４－５６７８ ユーザー@example.com',
    JWT,
    `x ${JWT}.`,
    '"',
    '\\"',
    '{"a":"\\"',
    '====&&&&;;;;',
    '2001:db8:abcd:1::1',
    '[SECRET_REDACTED]]',
    '?code=[SECRET_REDACTED]',
    'a'.repeat(70_000),
    `${'word '.repeat(14_000)}tail`,
  ];

  it.each(MODES)('%s: over a corpus of ordinary and adversarial strings', async (mode) => {
    for (const filterPii of [true, false]) {
      for (const text of corpus) {
        const e = entry({
          errorMessage: text,
          reason: text,
          requestId: text,
          tokenHash: text,
          clientId: text,
          path: text,
          remoteAddress: text,
          details: {
            text,
            access_token: text,
            claims: { name: text, email: text },
            [String(text).slice(0, 40)]: 1,
          },
          headers: { authorization: text, 'x-forwarded-for': text },
        });
        const once = await inMode(mode, e, filterPii);
        const twice = await inMode(mode, once as unknown as DiagnosticLogEntry, filterPii);
        expect(twice, `${mode} ${filterPii} ${String(text).slice(0, 30)}`).toEqual(once);
      }
    }
  });

  it('keeps a corrected token hash canonical', async () => {
    const once = await protectDiagnosticEntry(entry({ tokenHash: 'not a hash!' }));
    const twice = await protectDiagnosticEntry(once);
    expect(twice).toEqual(once);
    expect((once as unknown as { tokenHash: string }).tokenHash).toMatch(/^sha256:[0-9a-f]{12}$/);
  });
});

describe('hostile values', () => {
  it('survives a circular structure, and says so', async () => {
    const loop: Record<string, unknown> = { name: 'loop' };
    loop.self = loop;
    loop.list = [loop];
    const result = await protectDiagnosticEntry(entry({ details: loop }));
    expect(JSON.stringify(result)).toContain('[CIRCULAR]');
  });

  it('cuts an extremely deep structure before anything is stringified', async () => {
    let deep: Record<string, unknown> = { leaf: 'raw' };
    for (let i = 0; i < 200_000; i += 1) deep = { next: deep };
    const result = await protectDiagnosticEntry(entry({ details: deep }));
    expect(JSON.stringify(result)).toContain('[TRUNCATED]');
    let deepArray: unknown[] = ['x'];
    for (let i = 0; i < 200_000; i += 1) deepArray = [deepArray];
    expect(() => safeSnapshot({ a: deepArray })).not.toThrow();
  });

  it('cuts a structure deeper than the bound, and what is beyond it is not copied', async () => {
    let deep: Record<string, unknown> = { leaf: 'raw-deep-leaf', client_secret: 'raw-deep-secret' };
    for (let i = 0; i < 30; i += 1) deep = { next: deep };
    const text = JSON.stringify(await protectDiagnosticEntry(entry({ details: deep })));
    expect(text).toContain('[TRUNCATED]');
    expect(text).not.toMatch(/raw-deep/);
  });

  it('converts Maps and Sets, protects toJSON output, and survives a throwing getter or toJSON', async () => {
    const hostile = {
      map: new Map([['refresh_token', 'raw-map-secret']]),
      set: new Set(['a', 'b']),
      date: new Date(0),
      toJsonOwner: { toJSON: () => ({ client_secret: 'raw-tojson-secret' }) },
      throwingToJson: {
        toJSON() {
          throw new Error('boom');
        },
      },
      get explosive(): string {
        throw new Error('getter');
      },
      fn: () => 'x',
      sym: Symbol('s'),
      big: 10n,
      nan: Number.NaN,
    };
    const result = (await protectDiagnosticEntry(entry({ details: hostile }))) as unknown as {
      details: Record<string, any>;
    };
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/raw-map-secret|raw-tojson-secret/);
    expect(result.details.set).toEqual(['a', 'b']);
    expect(result.details.throwingToJson).toBe('[UNREADABLE]');
    expect(result.details.explosive).toBe('[UNREADABLE]');
    expect(result.details.date).toBe('1970-01-01T00:00:00.000Z');
    expect(result.details.big).toBe('10');
    expect(result.details.nan).toBeNull();
    expect(result.details).not.toHaveProperty('fn');
  });

  it('does not let a __proto__ key change the prototype of the result', async () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
    const result = (await protectDiagnosticEntry(entry({ details: parsed }))) as unknown as {
      details: Record<string, unknown>;
    };
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result.details)).toBe(Object.prototype);
    expect(result.details.ok).toBe(1);
  });
});
