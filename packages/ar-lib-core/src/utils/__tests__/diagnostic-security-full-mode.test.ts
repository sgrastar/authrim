/**
 * Full storage mode keeps the diagnostic detail an operator asked for, but secrets are never stored
 * in clear text in any mode, and personal data is not either while the PII filter is on.
 */

import { describe, it, expect } from 'vitest';
import { applyPrivacyModeToEntry } from '../diagnostic-security';
import type { DiagnosticLogEntry } from '../../services/diagnostic/types';

const SECRET = 'test-secret';
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

function tokenResponse(overrides: Record<string, unknown> = {}): DiagnosticLogEntry {
  return {
    id: 'entry-1',
    tenantId: 't1',
    category: 'token-validation',
    level: 'debug',
    timestamp: 1_700_000_000_000,
    storageMode: 'full',
    step: 'token-response',
    result: 'pass',
    details: {
      access_token: 'raw-access',
      id_token: JWT,
      refresh_token: 'raw-refresh',
      expires_in: 3600,
      scope: 'openid email',
    },
    ...overrides,
  } as DiagnosticLogEntry;
}

async function full(entry: DiagnosticLogEntry, filterPii?: boolean) {
  return applyPrivacyModeToEntry(entry, { mode: 'full', secret: SECRET, filterPii });
}

describe('full mode: secrets', () => {
  it.each([undefined, true, false])(
    'replaces tokens with a SHA-256 fingerprint (PII filter %s)',
    async (filterPii) => {
      const result = (await full(tokenResponse(), filterPii)) as unknown as {
        details: Record<string, unknown>;
      };
      expect(result.details.access_token).toMatch(/^sha256:[0-9a-f]{12}$/);
      expect(result.details.id_token).toMatch(/^sha256:[0-9a-f]{12}$/);
      expect(result.details.refresh_token).toMatch(/^sha256:[0-9a-f]{12}$/);
      // the same token always gives the same fingerprint, so entries still correlate
      const again = (await full(tokenResponse(), filterPii)) as unknown as {
        details: Record<string, unknown>;
      };
      expect(again.details.access_token).toBe(result.details.access_token);
      // what is not a secret stays
      expect(result.details.expires_in).toBe(3600);
      expect(result.details.scope).toBe('openid email');
    }
  );

  it('fingerprints an authorization code and PKCE verifier wherever they are keys', async () => {
    const entry = {
      id: 'e',
      tenantId: 't1',
      category: 'auth-decision',
      level: 'info',
      timestamp: 1,
      decision: 'allow',
      reason: 'ok',
      context: { code: 'auth-code-1', code_verifier: 'verifier-1', state: 'opaque' },
      metadata: { code: 'E42' },
    } as unknown as DiagnosticLogEntry;
    const result = (await full(entry)) as unknown as {
      context: Record<string, string>;
      metadata: Record<string, string>;
    };
    expect(result.context.code).toMatch(/^sha256:/);
    expect(result.context.code_verifier).toMatch(/^sha256:/);
    expect(result.context.state).toBe('opaque');
    expect(result.metadata.code).toMatch(/^sha256:/);
  });

  it('removes a compact JWT from free text even with the PII filter off', async () => {
    const entry = tokenResponse({ errorMessage: `bad token ${JWT} rejected`, details: undefined });
    const result = (await full(entry, false)) as unknown as { errorMessage: string };
    expect(result.errorMessage).toBe('bad token [JWT_REDACTED] rejected');
  });

  it('finds secrets in nested objects and arrays', async () => {
    const entry = tokenResponse({
      details: { responses: [{ tokens: { refresh_token: 'raw-nested' } }] },
    });
    const text = JSON.stringify(await full(entry));
    expect(text).not.toContain('raw-nested');
    // `tokens` is a secret name: the structure under it is replaced as a whole
    expect(text).toContain('[SECRET_REDACTED]');
  });

  it('is idempotent: protecting a protected entry changes nothing', async () => {
    const once = await full(
      tokenResponse({ errorMessage: 'mail jane@example.com', remoteAddress: '203.0.113.42' })
    );
    const twice = await full(once);
    expect(twice).toEqual(once);
  });
});

describe('full mode: personal data', () => {
  function userinfo(): DiagnosticLogEntry {
    return {
      id: 'entry-2',
      tenantId: 't1',
      category: 'token-validation',
      level: 'debug',
      timestamp: 1,
      storageMode: 'full',
      step: 'userinfo-response',
      result: 'pass',
      errorMessage: 'called by jane@example.com from 202-555-0199',
      details: {
        claims: {
          sub: 'sub-1',
          email: 'jane@example.com',
          phone_number: '+81 90-1234-5678',
          name: 'Jane Doe',
          given_name: 'Jane',
          family_name: 'Doe',
          preferred_username: 'janed',
          birthdate: '1990-01-01',
          address: { locality: 'Tokyo' },
          email_verified: true,
        },
      },
    } as unknown as DiagnosticLogEntry;
  }

  it('redacts emails, phone numbers, names, addresses and free text by default', async () => {
    const result = (await full(userinfo())) as unknown as {
      errorMessage: string;
      details: { claims: Record<string, unknown> };
    };
    const claims = result.details.claims;
    expect(claims.sub).toBe('sub-1');
    expect(claims.email_verified).toBe(true);
    expect(String(claims.email)).toMatch(/^j\*\*\*@example\.com \(hmac:[0-9a-f]+\)$/);
    expect(String(claims.phone_number)).toMatch(/^\*\*\*-\*\*\*-5678 \(hmac:/);
    for (const key of ['name', 'given_name', 'family_name', 'preferred_username']) {
      expect(String(claims[key]), key).toMatch(/hmac:[0-9a-f]+/);
    }
    expect(claims.birthdate).toBe('[PII_REDACTED]');
    expect(claims.address).toBe('[PII_REDACTED]');
    expect(result.errorMessage).toBe('called by [EMAIL_REDACTED] from [PHONE_REDACTED]');
    expect(JSON.stringify(result)).not.toMatch(/Jane|Doe|Tokyo|1990|jane@/);
  });

  it('masks addresses of the client wherever the entry carries them', async () => {
    const entry = {
      id: 'e',
      tenantId: 't1',
      category: 'http-request',
      level: 'debug',
      timestamp: 1,
      method: 'GET',
      path: '/authorize',
      headers: { 'x-forwarded-for': '203.0.113.7, 198.51.100.9', 'content-type': 'text/html' },
      remoteAddress: '2001:db8:abcd:1::1',
      metadata: { ip: '203.0.113.42' },
    } as unknown as DiagnosticLogEntry;
    const result = (await full(entry)) as unknown as {
      headers: Record<string, string>;
      remoteAddress: string;
      metadata: Record<string, string>;
      path: string;
    };
    expect(result.remoteAddress).toBe('2001:db8:abcd::/48');
    expect(result.headers['x-forwarded-for']).toBe('203.0.113.0/24, 198.51.100.0/24');
    expect(result.headers['content-type']).toBe('text/html');
    expect(result.metadata.ip).toBe('203.0.113.0/24');
    expect(result.path).toBe('/authorize');
  });

  it('keeps the identifying fields of an entry untouched', async () => {
    const entry = userinfo();
    const result = (await full(entry)) as unknown as Record<string, unknown>;
    for (const field of ['id', 'tenantId', 'category', 'level', 'timestamp', 'step', 'result']) {
      expect(result[field], field).toBe((entry as unknown as Record<string, unknown>)[field]);
    }
  });

  it('shows raw personal data only when the filter is explicitly off', async () => {
    const off = JSON.stringify(await full(userinfo(), false));
    for (const raw of ['jane@example.com', '+81 90-1234-5678', 'Jane Doe', 'Tokyo', '1990-01-01']) {
      expect(off, raw).toContain(raw);
    }
    for (const value of [undefined, true]) {
      const on = JSON.stringify(await full(userinfo(), value));
      expect(on, String(value)).not.toContain('jane@example.com');
    }
  });

  it('stops walking absurdly deep input rather than recursing without bound', async () => {
    let nested: Record<string, unknown> = { email: 'deep@example.com' };
    for (let i = 0; i < 200; i += 1) nested = { next: nested };
    const entry = tokenResponse({ details: nested });
    const text = JSON.stringify(await full(entry));
    expect(text).not.toContain('deep@example.com');
    expect(text).toContain('[TRUNCATED]');
  });
});

describe('masked and minimal modes ignore the PII filter', () => {
  it.each(['masked', 'minimal'] as const)('%s output is the same either way', async (mode) => {
    const entry = tokenResponse({
      errorMessage: 'mail jane@example.com',
      details: { access_token: 'raw-access', claims: { email: 'jane@example.com' } },
    });
    const on = await applyPrivacyModeToEntry(entry, { mode, secret: SECRET, filterPii: true });
    const off = await applyPrivacyModeToEntry(entry, { mode, secret: SECRET, filterPii: false });
    expect(off).toEqual(on);
    expect(JSON.stringify(on)).not.toContain('raw-access');
  });
});
