/**
 * The protection every diagnostic log entry gets in every storage mode, whatever its step:
 * secrets by key (any spelling, nesting and value type) and in text, validated identifiers,
 * compact JWT recognition, IP masking, phone detection, and the forms that count as protected.
 */

import { describe, it, expect } from 'vitest';
import {
  isCompactJwt,
  isProtectedForm,
  maskIpAddress,
  protectDiagnosticEntry,
  redactCompactJwts,
  redactPhoneNumbers,
  redactSecretsInText,
} from '../diagnostic-redaction';
import { applyPrivacyModeToEntry, maskIp, redactPII } from '../diagnostic-security';
import type { DiagnosticLogEntry } from '../../services/diagnostic/types';

const SECRET = 'test-secret';
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
  const result = await applyPrivacyModeToEntry(
    { ...e, storageMode: mode },
    { mode, secret: SECRET, filterPii }
  );
  return result as unknown as Record<string, any>;
}

describe('secrets by key, in every mode and step', () => {
  it.each(MODES)('%s: a nested secret under an arbitrary step is not stored', async (mode) => {
    const result = await inMode(
      mode,
      entry({
        step: 'issuer-check',
        details: {
          client_secret: 'raw-client-secret',
          nested: [{ refresh_token: 'raw-refresh' }, { deeper: { accessToken: 'raw-access' } }],
          'Access-Token': 'raw-kebab',
          IdToken: 'raw-camel',
          expires_in: 3600,
        },
      })
    );
    const text = JSON.stringify(result);
    for (const raw of [
      'raw-client-secret',
      'raw-refresh',
      'raw-access',
      'raw-kebab',
      'raw-camel',
    ]) {
      expect(text, raw).not.toContain(raw);
    }
    expect(result.details.client_secret).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(result.details.nested[0].refresh_token).toMatch(/^sha256:/);
    expect(result.details.nested[1].deeper.accessToken).toMatch(/^sha256:/);
    expect(result.details['Access-Token']).toMatch(/^sha256:/);
    expect(result.details.IdToken).toMatch(/^sha256:/);
    // not a secret: stays
    if (mode === 'full') expect(result.details.expires_in).toBe(3600);
  });

  it.each(MODES)(
    '%s: a secret key with a value that is not a string never passes',
    async (mode) => {
      const result = await inMode(
        mode,
        entry({
          details: {
            refresh_token: { value: 'raw-object', more: ['raw-array'] },
            access_token: ['raw-in-array'],
            password: 123456,
            client_secret: { a: { b: 'raw-deep' } },
          },
        })
      );
      const text = JSON.stringify(result);
      for (const raw of ['raw-object', 'raw-array', 'raw-in-array', '123456', 'raw-deep']) {
        expect(text, raw).not.toContain(raw);
      }
      expect(result.details.refresh_token).toBe('[SECRET_REDACTED]');
      expect(result.details.password).toBe('[SECRET_REDACTED]');
    }
  );

  it('keeps a boolean flag about a token (has_access_token) and the token type', async () => {
    const result = await inMode(
      'full',
      entry({
        tokenType: 'access_token',
        details: { has_access_token: true, token_type: 'Bearer' },
      })
    );
    expect(result.details.has_access_token).toBe(true);
    expect(result.details.token_type).toBe('Bearer');
    expect(result.tokenType).toBe('access_token');
  });

  it('treats a `code` as a secret wherever it is a key, a number too; status names stay', async () => {
    const result = await inMode(
      'full',
      entry({
        details: { code: 'auth-code-1' },
        metadata: { code: 'E42', status_code: 'E43', statusCode: 404, error: { code: 404 } },
      })
    );
    expect(result.details.code).toMatch(/^sha256:/);
    expect(result.metadata.code).toMatch(/^sha256:/);
    expect(result.metadata.status_code).toBe('E43');
    expect(result.metadata.statusCode).toBe(404);
    // a number named `code` is a secret too (a PIN, a one-time code): no status shape excuses it
    expect(result.metadata.error.code).toBe('[SECRET_REDACTED]');
  });

  it('cuts nesting beyond the bound with a marker instead of copying it', async () => {
    let nested: Record<string, unknown> = { refresh_token: 'raw-deep-secret' };
    for (let i = 0; i < 200; i += 1) nested = { next: nested };
    const result = await protectDiagnosticEntry(entry({ details: nested }));
    const text = JSON.stringify(result);
    expect(text).not.toContain('raw-deep-secret');
    expect(text).toContain('[TRUNCATED]');
  });
});

describe('secrets in headers', () => {
  it.each(MODES)('%s: credential headers are fingerprinted whole', async (mode) => {
    const result = await inMode(
      mode,
      entry({
        category: 'http-request',
        method: 'GET',
        path: '/userinfo',
        headers: {
          Authorization: 'Bearer opaque-access-token-value',
          'PROXY-AUTHORIZATION': 'Basic dXNlcjpwYXNz',
          cookie: 'sid=abc123; theme=dark',
          'Set-Cookie': 'sid=abc123; HttpOnly',
          'X-API-Key': 'key-123456',
          'x-auth-token': 'tok-1',
          'content-type': 'application/json',
        },
      })
    );
    const text = JSON.stringify(result.headers);
    for (const raw of [
      'opaque-access-token-value',
      'dXNlcjpwYXNz',
      'abc123',
      'key-123456',
      'tok-1',
    ]) {
      expect(text, raw).not.toContain(raw);
    }
    if (mode !== 'minimal') {
      expect(result.headers.Authorization).toMatch(/^sha256:/);
      expect(result.headers.cookie).toMatch(/^sha256:/);
      expect(result.headers['content-type']).toBe('application/json');
    }
  });
});

describe('secrets in text', () => {
  it('replaces the values of secret parameters in URLs, query strings and form bodies', () => {
    const redacted = redactSecretsInText(
      'GET https://rp.example.com/cb?code=abc123&state=keep-me&access_token=at-1#id_token=it-1 ' +
        'body: grant_type=authorization_code&client_secret=cs-1&code_verifier=cv-1&redirect_uri=https%3A%2F%2Frp'
    );
    for (const raw of ['abc123', 'at-1', 'it-1', 'cs-1', 'cv-1']) {
      expect(redacted, raw).not.toContain(raw);
    }
    expect(redacted).toContain('state=keep-me');
    expect(redacted).toContain('grant_type=authorization_code');
    expect(redacted).toContain('code=[SECRET_REDACTED]');
  });

  it('recognises percent-encoded and camelCase parameter names', () => {
    const redacted = redactSecretsInText('?access%5Ftoken=a1&refreshToken=r1&Client-Secret=c1');
    for (const raw of ['a1', 'r1', 'c1']) expect(redacted, raw).not.toContain(raw);
  });

  it('replaces secret members of JSON text', () => {
    const redacted = redactSecretsInText(
      '{"access_token":"at-9","scope":"openid","password": "pw-9"}'
    );
    expect(redacted).not.toContain('at-9');
    expect(redacted).not.toContain('pw-9');
    expect(redacted).toContain('"scope":"openid"');
  });

  it('replaces a bearer credential in free text, not the word', () => {
    expect(redactSecretsInText('sent Bearer abc.def-123 to the API')).toBe(
      'sent Bearer [TOKEN_REDACTED] to the API'
    );
    expect(redactSecretsInText('bearer authentication is required')).toBe(
      'bearer authentication is required'
    );
  });

  it.each(MODES)('%s: secrets in URLs inside any string field of an entry', async (mode) => {
    const result = await inMode(
      mode,
      entry({
        errorMessage: 'redirect https://rp.example.com/cb?code=abc123&state=s',
        metadata: { url: 'https://rp.example.com/cb?access_token=at-1' },
        details: { body: 'a=1&refresh_token=rt-1' },
      })
    );
    const text = JSON.stringify(result);
    for (const raw of ['abc123', 'at-1', 'rt-1']) expect(text, raw).not.toContain(raw);
  });
});

describe('compact JWT recognition', () => {
  it('finds a JWS by its decoded header, including a header with spaces (eyAi...)', () => {
    const spaced = `${b64url('{ "alg" : "none" }')}.${b64url('{"a":1}')}.`;
    expect(spaced.startsWith('eyAi')).toBe(true);
    expect(redactCompactJwts(`token ${spaced} end`)).toBe('token [JWT_REDACTED] end');
    expect(redactCompactJwts(`token ${JWT} end`)).toBe('token [JWT_REDACTED] end');
  });

  it('finds a JWS with a detached (empty) payload', () => {
    const detached = `${b64url('{"alg":"ES256","b64":false}')}..c2ln`;
    expect(isCompactJwt(detached)).toBe(true);
    expect(redactCompactJwts(detached)).toBe('[JWT_REDACTED]');
  });

  it('finds a JWE of five segments', () => {
    const jwe = `${b64url('{"alg":"RSA-OAEP","enc":"A128GCM"}')}.ZW5jcnlwdGVk.aXY.Y2lwaGVy.dGFn`;
    expect(isCompactJwt(jwe)).toBe(true);
  });

  it('finds a JWS by its payload when the header says nothing', () => {
    const odd = `${b64url('{"x":1}')}.${b64url('{"sub":"u"}')}.c2ln`;
    expect(isCompactJwt(odd)).toBe(true);
  });

  it('does not take look-alikes that do not decode', () => {
    expect(isCompactJwt('eyJfoo.bar.baz')).toBe(false);
    expect(redactCompactJwts('see eyJfoo.bar.baz here')).toBe('see eyJfoo.bar.baz here');
    expect(isCompactJwt('eyJ!!.b.c')).toBe(false);
    expect(redactCompactJwts('version 1.2.3 and host a.b.c')).toBe('version 1.2.3 and host a.b.c');
    // decodes, but to an array / a string / no object
    expect(isCompactJwt(`${b64url('[1,2]')}.${b64url('"x"')}.sig`)).toBe(false);
    // two segments, four segments
    expect(isCompactJwt(`${b64url('{"alg":"x"}')}.sig`)).toBe(false);
    expect(isCompactJwt(`${b64url('{"alg":"x"}')}.a.b.c`)).toBe(false);
  });

  it('handles a long text with several candidates and a sentence-ending dot', () => {
    const text = `first ${JWT}. then eyJfoo.bar.baz, then (${JWT}) and ${'x'.repeat(5000)} ${JWT}.`;
    const out = redactCompactJwts(text);
    expect(out).toBe(
      `first [JWT_REDACTED]. then eyJfoo.bar.baz, then ([JWT_REDACTED]) and ${'x'.repeat(5000)} [JWT_REDACTED].`
    );
  });

  it.each(MODES)('%s: removed with the PII filter on or off', async (mode) => {
    for (const filterPii of [true, false]) {
      const result = await inMode(mode, entry({ errorMessage: `bad ${JWT} rejected` }), filterPii);
      expect(JSON.stringify(result), `${mode} ${filterPii}`).not.toContain(JWT);
    }
  });

  it('redactPII removes it too', () => {
    expect(redactPII(`x ${JWT}`)).toBe('x [JWT_REDACTED]');
  });
});

describe('IP masking', () => {
  it.each([
    ['203.0.113.42', '203.0.113.0/24'],
    ['203.0.113.42:8443', '203.0.113.0/24'],
    ['2001:db8:abcd:1::1', '2001:db8:abcd::/48'],
    ['2001:0db8:0000:0000:0000:ff00:0042:8329', '2001:db8:0::/48'],
    ['2001:db8::', '2001:db8:0::/48'],
    ['::1', '0:0:0::/48'],
    ['fe80::1%eth0', 'fe80:0:0::/48'],
    ['[2001:db8:abcd:12::5]', '2001:db8:abcd::/48'],
    ['::ffff:192.0.2.128', '192.0.2.0/24'],
    ['2001:db8:1:2:3:4:192.0.2.33', '2001:db8:1::/48'],
    ['ABCD:EF01:2345:6789::1', 'abcd:ef01:2345::/48'],
  ])('masks %s as %s', (ip, masked) => {
    expect(maskIp(ip)).toBe(masked);
    expect(maskIpAddress(ip)).toBe(masked);
  });

  it('never leaves the host part of an address in the output', () => {
    expect(maskIp('2001:db8:abcd:1:2:3:4:5')).not.toMatch(/:1:2|:4:5/);
    expect(maskIp('2001:db8:abcd:1::dead:beef')).not.toContain('beef');
    expect(maskIp('203.0.113.42')).not.toContain('42');
  });

  it('turns an address it cannot parse into a marker, and leaves a non-address alone', () => {
    for (const bad of [
      ':::',
      '1:2:3:4:5:6:7:8:9',
      '2001:db8::1::2',
      'gggg::1',
      '1.2.3.999',
      '[::1',
    ]) {
      expect(maskIp(bad), bad).toBe('[IP_REDACTED]');
    }
    expect(maskIp('invalid')).toBe('invalid');
  });

  it('is idempotent', () => {
    for (const ip of ['203.0.113.42', '2001:db8:abcd:1::1', '::ffff:192.0.2.128']) {
      expect(maskIp(maskIp(ip))).toBe(maskIp(ip));
    }
  });
});

describe('phone numbers in free text', () => {
  it.each([
    '090-1234-5678',
    '+81 90-1234-5678',
    '+1 (202) 555-0199',
    '(03) 1234-5678',
    '0120-123-456',
    '202.555.0199',
    '2025550199',
    '123-456-7890',
    '+442071838750',
    '09012345678',
  ])('redacts %s', (phone) => {
    expect(redactPhoneNumbers(`call ${phone} now`)).toBe('call [PHONE_REDACTED] now');
    expect(redactPII(`call ${phone}.`)).toBe('call [PHONE_REDACTED].');
  });

  it.each([
    ['1700000000123', 'epoch milliseconds'],
    ['2026-04-21 10:30:00', 'a timestamp'],
    ['2026-04-21T10:30:00Z', 'an ISO timestamp'],
    ['203.0.113.42', 'an IPv4 address'],
    ['550e8400-e29b-41d4-a716-446655440000', 'a UUID'],
    ['a1b2c3d4-1234-5678-9012-abcdef012345', 'a UUID with digit groups'],
    ['order 12345', 'a short number'],
    ['req-2025550199', 'an identifier glued to a hyphen'],
    ['id_2025550199', 'an identifier glued to an underscore'],
    ['v1.2.3', 'a version'],
    ['123456789012345678901234', 'a long number'],
  ])('leaves %s (%s) alone', (text) => {
    expect(redactPhoneNumbers(text)).toBe(text);
  });

  it('redacts a number with separators that is not a phone number: the bias is toward redaction', () => {
    expect(redactPhoneNumbers('ref 1234 567 8901')).toBe('ref [PHONE_REDACTED]');
  });

  it('keeps card and social security numbers to their own markers', () => {
    expect(redactPII('4111 1111 1111 1111')).toBe('[CC_REDACTED]');
    expect(redactPII('SSN 123-45-6789')).toBe('SSN [SSN_REDACTED]');
  });
});

describe('identifiers and labels are validated, not trusted', () => {
  it.each(MODES)(
    '%s: an identifier that is not a plain identifier is fingerprinted',
    async (mode) => {
      const result = await inMode(
        mode,
        entry({
          category: 'http-request',
          method: 'GET',
          path: '/x',
          headers: {},
          requestId: 'jane@example.com',
          flowId: 'x'.repeat(300),
          diagnosticSessionId: 'session a',
          anonymizedUserId: { nested: 'jane@example.com' },
          tokenHash: 'jane@example.com',
        })
      );
      const text = JSON.stringify(result);
      expect(text).not.toContain('jane@example.com');
      expect(result.requestId).toMatch(/^sha256:[0-9a-f]{12}$/);
      expect(result.flowId).toMatch(/^sha256:/);
      expect(result.diagnosticSessionId).toMatch(/^sha256:/);
      expect(result.anonymizedUserId).toBe('[INVALID]');
      expect(result.tokenHash).toMatch(/^sha256:/);
    }
  );

  it('keeps ordinary identifiers and a real token hash', async () => {
    const result = await inMode(
      'full',
      entry({
        requestId: 'req-1',
        flowId: 'flow-a',
        diagnosticSessionId: 'session-a:1',
        tokenHash: 'abcdef012345',
      })
    );
    expect(result).toMatchObject({
      id: 'entry-1',
      requestId: 'req-1',
      flowId: 'flow-a',
      diagnosticSessionId: 'session-a:1',
      tokenHash: 'abcdef012345',
    });
  });

  it('takes an email out of the free-text fields of an entry (path, clientId), and secrets in the path', async () => {
    const result = await inMode(
      'masked',
      entry({
        category: 'http-request',
        method: 'GET',
        clientId: 'jane@example.com',
        path: '/users/jane@example.com/cb?code=abc123',
      })
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain('jane@example.com');
    expect(text).not.toContain('abc123');
    expect(result.path.startsWith('/users/')).toBe(true);
  });

  it('replaces labels and numbers that are not what they should be', async () => {
    const result = await protectDiagnosticEntry(
      entry({
        level: 'jane@example.com',
        storageMode: { a: 1 },
        method: 'GET jane@example.com',
        status: 'jane@example.com',
        durationMs: 'x',
        timestamp: 'jane@example.com',
      })
    );
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
    expect(result.level).toBe('[INVALID]');
    expect(result.timestamp).toBe(0);
    expect(result).not.toHaveProperty('status');
  });
});

describe('what counts as already protected', () => {
  it('accepts only a whole string in one of our own forms', () => {
    for (const form of [
      'sha256:0123456789ab',
      'hmac:0123456789ab',
      '[EMAIL_REDACTED]',
      '[SECRET_REDACTED]',
      '[TRUNCATED]',
      'abc...xyz (hmac:0123456789ab)',
      'j***@example.com (hmac:0123456789ab)',
      '***-***-5678 (hmac:0123456789ab)',
      '203.0.113.0/24',
      '2001:db8:abcd::/48',
    ]) {
      expect(isProtectedForm(form), form).toBe(true);
    }
    for (const notForm of [
      'jane@example.com (hmac:abcdef12)',
      '(hmac:abcdef12) jane@example.com',
      'jane@example.com sha256:0123456789ab',
      'sha256:0123456789ab jane@example.com',
      'call 090-1234-5678 [PHONE_REDACTED]',
      '[EMAIL_REDACTED] jane@example.com',
      'jane@example.com... (hmac:abcdef12)',
    ]) {
      expect(isProtectedForm(notForm), notForm).toBe(false);
    }
  });

  it.each(['full'] as const)(
    '%s: a sender-supplied marker does not make PII or a secret pass',
    async (mode) => {
      const result = await inMode(
        mode,
        entry({
          errorMessage: 'jane@example.com (hmac:abcdef12)',
          reason: '(hmac:abcdef12) jane@example.com',
          details: {
            note: 'call 090-1234-5678 sha256:0123456789ab',
            claims: { email: 'jane@example.com (hmac:abcdef12)', name: 'Jane Doe (hmac:abcdef12)' },
            access_token: 'raw-token (hmac:abcdef12)',
          },
        })
      );
      const text = JSON.stringify(result);
      for (const raw of ['jane@example.com', '090-1234-5678', 'Jane Doe', 'raw-token']) {
        expect(text, raw).not.toContain(raw);
      }
    }
  );

  it('is idempotent for everything it writes', async () => {
    const once = await inMode(
      'full',
      entry({
        errorMessage: 'jane@example.com 090-1234-5678',
        remoteAddress: '2001:db8:abcd:1::1',
        details: {
          access_token: 'raw',
          claims: { email: 'jane@example.com', phone_number: '+81 90-1234-5678', name: 'Jane' },
        },
      })
    );
    const twice = await inMode('full', once as unknown as DiagnosticLogEntry);
    expect(twice).toEqual(once);
  });
});
