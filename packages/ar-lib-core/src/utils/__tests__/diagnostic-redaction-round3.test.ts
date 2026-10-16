/**
 * Third round of hardening: JWT recognition without a prefix shortcut, the cut of long texts,
 * key handling at scale, labels, personal-data keys of the wrong type, the node budget, long key
 * names, Unicode masks and the cap after transformation.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_TEXT_LENGTH,
  capLength,
  KeyAllocator,
  isCompactJwt,
  maskIpOrMarker,
  protectDiagnosticEntry,
  redactCompactJwts,
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

describe('a JWT whose JSON starts with whitespace', () => {
  const spacedHeader = `${b64url(' {"alg":"HS256"}')}.${b64url('{"sub":"u"}')}.c2ln`;
  const spacedPayloadOnly = `${b64url('{"x":1}')}.${b64url('\n{"sub":"u"}')}.c2ln`;

  it('is recognised by decoding, whatever its first characters are', () => {
    expect(spacedHeader.startsWith('IH')).toBe(true);
    expect(isCompactJwt(spacedHeader)).toBe(true);
    expect(redactCompactJwts(`token ${spacedHeader} end`)).toBe('token [JWT_REDACTED] end');
    expect(isCompactJwt(spacedPayloadOnly)).toBe(true);
    expect(redactSecretsInText(`x ${spacedPayloadOnly}`)).toBe('x [JWT_REDACTED]');
  });

  it('is recognised when it is too long to inspect', () => {
    const big = `${b64url(' {"alg":"RS256"}')}.${b64url(JSON.stringify({ blob: 'q'.repeat(17_000) }))}.c2ln`;
    expect(redactCompactJwts(`token ${big} end`)).toBe('token [JWT_REDACTED] end');
  });

  it('does not take text that is not JSON for a JWT', () => {
    expect(isCompactJwt(`${b64url('  not json')}.${b64url('also not')}.sig`)).toBe(false);
    const text = 'ab.cd.ef and IHxx.yy.zz';
    expect(redactCompactJwts(text)).toBe(text);
  });
});

describe('the cut of a long text', () => {
  it('protects the whole text before cutting: no part of a JWT with personal claims is left', async () => {
    const jwt = `${b64url('{"alg":"RS256"}')}.${b64url(
      JSON.stringify({ email: 'jane.doe@example.com', name: 'Jane Doe', pad: 'p'.repeat(1200) })
    )}.c2lnbmF0dXJl`;
    // The raw text is cut inside the JWT (at 65,525 characters) if it is cut before protection.
    const text = `${'word '.repeat(13_080)}${jwt} tail`;
    expect(text.length).toBeGreaterThan(MAX_TEXT_LENGTH);
    for (const run of [
      async () =>
        ((await protectDiagnosticEntry(entry({ errorMessage: text }))) as any).errorMessage,
      async () => (await inMode('full', entry({ errorMessage: text }))).errorMessage,
    ]) {
      const message: string = await run();
      expect(message).not.toContain(jwt.slice(0, 60));
      expect(message).not.toContain(jwt.slice(20, 80));
      expect(message).toContain('[JWT_REDACTED]');
      expect(message.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    }
  });

  it('never cuts inside a long run: the run is dropped whole', async () => {
    const text = `${'ab '.repeat(21_000)}${'Q'.repeat(10_000)} end`;
    const message: string = ((await protectDiagnosticEntry(entry({ errorMessage: text }))) as any)
      .errorMessage;
    expect(message.endsWith('ab[TRUNCATED]')).toBe(true);
    expect(message).not.toContain('QQQ');
    expect(message.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
  });

  it('drops a text with no delimiter before the cut whole', () => {
    expect(capLength('Z'.repeat(MAX_TEXT_LENGTH + 10))).toBe('[TRUNCATED]');
  });

  it('never cuts inside a marker', () => {
    const filler = 'w '.repeat(32_700);
    for (let shift = 0; shift < 20; shift += 1) {
      const text = `${filler}${'x'.repeat(shift)} code=[SECRET_REDACTED] [EMAIL_REDACTED] done`;
      const cut = capLength(`${text}${' y'.repeat(MAX_TEXT_LENGTH)}`);
      expect(cut.length, String(shift)).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
      expect(cut).not.toMatch(/\[[A-Z_]*$/);
      expect(cut).not.toMatch(/\[[A-Z_]+(?!\w|\])$/);
    }
  });
});

describe('many keys', () => {
  it.each([6_000, 50_000])('handles %i email-shaped keys in linear time', async (count) => {
    const context: Record<string, number> = {};
    for (let i = 0; i < count; i += 1) context[`user${i}@example.com`] = i;
    redactionWork.units = 0;
    const started = performance.now();
    const result = (await protectDiagnosticEntry(
      entry({ category: 'auth-decision', decision: 'allow', reason: 'x', context }),
      { redactEmailsInFreeText: true }
    )) as any;
    const elapsed = performance.now() - started;
    const text = JSON.stringify(result);
    expect(text).not.toContain('@example.com');
    expect(Object.keys(result.context).length).toBeLessThanOrEqual(2_002);
    expect(result.context['[KEYS_REDACTED]']).toBeGreaterThan(0);
    // Count the keys beyond the fingerprint budget: they are one aggregate key, not enumerated
    expect(Object.keys(result.context).filter((key) => key.startsWith('sha256:')).length).toBe(
      2_000
    );
    expect(elapsed).toBeLessThan(5_000);
    expect(redactionWork.units).toBeLessThanOrEqual(count * 400);
  });

  it('keeps every value of keys that fingerprint alike without a quadratic search', async () => {
    const context: Record<string, number> = {};
    for (let i = 0; i < 1_500; i += 1) context[`${'k'.repeat(300)}${i}`] = i;
    redactionWork.units = 0;
    const started = performance.now();
    const result = (await protectDiagnosticEntry(
      entry({ category: 'auth-decision', decision: 'allow', reason: 'x', context })
    )) as any;
    expect(redactionWork.units).toBeLessThanOrEqual(3_000_000);
    expect(Object.keys(result.context)).toHaveLength(1_500);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('collapses the keys of a second object once the fingerprint budget is spent', async () => {
    const first: Record<string, number> = {};
    for (let i = 0; i < 2_100; i += 1) first[`a${i}@example.com`] = i;
    const result = (await protectDiagnosticEntry(
      entry({
        category: 'auth-decision',
        decision: 'allow',
        reason: 'x',
        context: { first, second: { 'late@example.com': 1, status: 'ok' } },
      }),
      { redactEmailsInFreeText: true }
    )) as any;
    expect(result.context.second).toEqual({ status: 'ok', '[KEYS_REDACTED]': 1 });
  });
});

describe('key allocation', () => {
  it('hands out suffixes in constant time per collision', () => {
    const allocator = new KeyAllocator();
    redactionWork.units = 0;
    const taken = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) taken.add(allocator.take('same'));
    expect(taken.size).toBe(20_000);
    expect(taken.has('same')).toBe(true);
    expect(taken.has('same~2')).toBe(true);
    expect(taken.has('same~20000')).toBe(true);
    expect(redactionWork.units).toBeLessThanOrEqual(20_000 * 3);
  });

  it('skips a suffix that a key already uses', () => {
    const allocator = new KeyAllocator();
    expect(allocator.take('a~2')).toBe('a~2');
    expect(allocator.take('a')).toBe('a');
    expect(allocator.take('a')).toBe('a~3');
  });
});

describe('labels', () => {
  it.each(MODES)('%s: a label that is an unsecured JWT or a token is invalid', async (mode) => {
    const jwt = `${b64url('{"alg":"none"}')}.${b64url('{}')}.`;
    expect(jwt.length).toBeLessThanOrEqual(64);
    const result = await inMode(
      mode,
      entry({
        level: jwt,
        result: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4',
        decision: 'jane@example.com',
        source: jwt,
      })
    );
    expect(result.level).toBe('[INVALID]');
    expect(result.result).toBe('[INVALID]');
    expect(result.decision).toBe('[INVALID]');
    expect(result.source).toBe('[INVALID]');
    expect(JSON.stringify(result)).not.toContain(jwt.slice(0, 20));
  });

  it('keeps ordinary labels', async () => {
    const result = await inMode(
      'full',
      entry({ category: 'auth-decision', level: 'warn', decision: 'deny', reason: 'r' })
    );
    expect(result).toMatchObject({ category: 'auth-decision', level: 'warn', decision: 'deny' });
    expect(result.storageMode).toBe('full');
  });
});

describe('personal data keys with a value of the wrong type or format', () => {
  it('redacts a number, a structure and an array under a personal data key', async () => {
    const result = await inMode(
      'full',
      entry({
        details: {
          claims: {
            phoneNumber: 12025550199,
            name: { first: 'Jane', last: 'Doe' },
            email: ['jane@example.com', 5],
            ip: 3405803818,
            gender: true,
          },
        },
      })
    );
    const text = JSON.stringify(result);
    for (const raw of ['12025550199', 'Jane', 'Doe', 'jane@example.com', '3405803818']) {
      expect(text, raw).not.toContain(raw);
    }
    expect(result.details.claims.phoneNumber).toBe('[PII_REDACTED]');
    expect(result.details.claims.name).toBe('[PII_REDACTED]');
    expect(result.details.claims.gender).toBe(true);
  });

  it.each(['203.0.113.42/32', '0313.0.113.42', '3405803818', '203.0.113', 'not an address'])(
    'masks an address written as %s to a network or a marker',
    async (ip) => {
      const result = await inMode('full', entry({ details: { ipAddress: ip } }));
      expect(JSON.stringify(result)).not.toContain(ip);
      expect(maskIpOrMarker(ip)).toMatch(/^(?:\[IP_REDACTED\]|[\d.]+\.0\/24)$/);
    }
  );

  it('masks an address with a prefix length like the address', () => {
    expect(maskIpOrMarker('203.0.113.42/32')).toBe('203.0.113.0/24');
    expect(maskIpOrMarker('2001:db8:abcd:1::1/64')).toBe('2001:db8:abcd::/48');
  });

  it('masked mode does the same for userinfo claims', async () => {
    const result = await inMode(
      'masked',
      entry({
        step: 'userinfo-response',
        details: {
          claims: { phoneNumber: 12025550199, name: { a: 'Jane' }, ipAddress: '1.2.3.4/32' },
        },
      })
    );
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/12025550199|Jane|1\.2\.3\.4\//);
  });
});

describe('the node budget counts every value', () => {
  it('cuts a long array of numbers', () => {
    const numbers = Array.from({ length: 50_010 }, (_, i) => i);
    const copy = safeSnapshot({ numbers }) as { numbers: unknown[] };
    expect(copy.numbers.length).toBeLessThanOrEqual(50_001);
    expect(copy.numbers[copy.numbers.length - 1]).toBe('[TRUNCATED]');
  });

  it('cuts a Set and a Map lazily', () => {
    let visited = 0;
    const lazy = {
      *[Symbol.iterator]() {
        for (let i = 0; i < 10_000_000; i += 1) {
          visited += 1;
          yield i;
        }
      },
    };
    const set = new Set<number>();
    Object.defineProperty(set, Symbol.iterator, { value: lazy[Symbol.iterator] });
    const copy = safeSnapshot({ set }) as { set: unknown[] };
    expect(copy.set[copy.set.length - 1]).toBe('[TRUNCATED]');
    expect(visited).toBeLessThanOrEqual(50_010);
    const map = new Map(Array.from({ length: 60_000 }, (_, i) => [`k${i}`, i] as const));
    const mapCopy = safeSnapshot({ map }) as { map: Record<string, unknown> };
    expect(Object.keys(mapCopy.map).length).toBeLessThanOrEqual(50_002);
    expect(mapCopy.map['[TRUNCATED]']).toBe('[TRUNCATED]');
  });
});

describe('a long key name', () => {
  const longName = `client${'_'.repeat(1_100)}secret`;

  it('is still a secret in JSON text', () => {
    const out = redactSecretsInText(`{"${longName}":"hidden-value","a":1}`);
    expect(out).not.toContain('hidden-value');
    expect(out).toContain('"a":1');
  });

  it('is still a secret as a parameter name and as an object key', async () => {
    expect(redactSecretsInText(`?${longName}=hidden-value&x=1`)).not.toContain('hidden-value');
    const result = await protectDiagnosticEntry(entry({ details: { [longName]: 'hidden-value' } }));
    expect(JSON.stringify(result)).not.toContain('hidden-value');
  });

  it('redacts the value of a name too long to inspect, even one that does not look secret', () => {
    const out = redactSecretsInText(`?${'a'.repeat(400)}=hidden-value`);
    expect(out).not.toContain('hidden-value');
  });
});

describe('Unicode masks are recognised as the masks they are', () => {
  it.each([
    'user@例え.テスト',
    'ユーザー@example.com',
    '田中@例え.jp',
    '𠮷野@example.com',
    'a@b-c.example.org',
  ])('protecting %s twice changes nothing', async (email) => {
    for (const mode of MODES) {
      const e = entry({
        step: 'userinfo-response',
        details: { claims: { sub: 'user-1', email } },
        errorMessage: email,
      });
      const once = await inMode(mode, e);
      const twice = await inMode(mode, once as unknown as DiagnosticLogEntry);
      expect(twice, `${mode} ${email}`).toEqual(once);
      expect(JSON.stringify(once)).not.toContain(email);
    }
  });

  it('shows the Unicode domain of a masked email', async () => {
    const result = await inMode('full', entry({ details: { email: 'user@例え.テスト' } }));
    expect(result.details.email).toMatch(/^u\*\*\*@例え\.テスト \(hmac:[0-9a-f]{12}\)$/u);
  });
});

describe('astral characters in text', () => {
  it('redacts an email whose local part has characters outside the BMP as a whole', () => {
    expect(redactPII('𠮷野@example.com')).toBe('[EMAIL_REDACTED]');
    expect(redactPII('mail 𠮷野𠮷@例え.テスト.')).toBe('mail [EMAIL_REDACTED].');
  });
});

describe('the cap holds after transformation', () => {
  const growing = [
    'code=x '.repeat(10_000),
    'tel 1234567890 '.repeat(4_000),
    'a@b.co '.repeat(9_000),
    `${'password=p '.repeat(8_000)}end`,
    `{"password":1,"a":2}`.repeat(4_000),
  ];

  it.each(growing.map((text, index) => [index, text] as const))(
    'text %i: protected once it is within the cap, and protecting again changes nothing',
    async (_index, text) => {
      for (const mode of MODES) {
        const once = await protectDiagnosticEntry(
          entry({ errorMessage: text, details: { text } }),
          {
            redactEmailsInFreeText: true,
          }
        );
        const message = (once as any).errorMessage as string;
        expect(message.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
        expect((once as any).details.text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
        const twice = await protectDiagnosticEntry(once, { redactEmailsInFreeText: true });
        expect(twice, mode).toEqual(once);
        const viaMode = await inMode(mode, entry({ errorMessage: text, details: { text } }));
        expect(viaMode.errorMessage.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
        expect(await inMode(mode, viaMode as unknown as DiagnosticLogEntry)).toEqual(viaMode);
      }
    }
  );

  it('redactPII and the secrets pass are capped too', () => {
    expect(redactSecretsInText('code=x '.repeat(10_000)).length).toBeLessThanOrEqual(
      MAX_TEXT_LENGTH
    );
    expect(redactPII('1234567890 '.repeat(10_000)).length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
  });
});
