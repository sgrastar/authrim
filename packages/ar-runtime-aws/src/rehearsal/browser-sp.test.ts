import { createHash, X509Certificate } from 'node:crypto';
import type { LambdaEvent } from 'hono/aws-lambda';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSAMLResponse, type SAMLResponseOptions } from '../../../ar-saml/src/idp/assertion';
import { applySAMLResponseSigningPolicy } from '../../../ar-saml/src/idp/signing';
import { sourceSigningBundle } from './synthetic-fixture';
import { createSyntheticBrowserSp, type SyntheticBrowserSpConfig } from './browser-sp';
import { handler, parseSyntheticBrowserSpSecret } from './browser-sp-lambda';

const origin = 'https://abcdefghij.execute-api.ap-northeast-1.amazonaws.com';
const dbHost = 'browser-test.abc.ap-northeast-1.rds.amazonaws.com';
const now = Date.now();
let signing: Awaited<ReturnType<typeof sourceSigningBundle>>;
let config: SyntheticBrowserSpConfig;

beforeAll(async () => {
  signing = await sourceSigningBundle();
  config = {
    syntheticOnly: true,
    environmentName: 'aws-browser-rehearsal',
    origin,
    tenantId: 'tenant-a',
    certificatePem: signing.certificate,
    certificateDerSha256: createHash('sha256')
      .update(new X509Certificate(signing.certificate).raw)
      .digest('hex'),
  };
});

function world() {
  type Store = Parameters<typeof createSyntheticBrowserSp>[0]['store'];
  type Stored = Parameters<Store['storeChallenge']>[0];
  const requests = new Map<string, Stored>();
  const store: Store = {
    storeChallenge: vi.fn(async (value: Stored) => {
      requests.set(value.id, value);
      return true;
    }),
    consumeChallenge: vi.fn(async (value: Parameters<Store['consumeChallenge']>[0]) => {
      const saved = requests.get(value.id);
      if (
        !saved ||
        saved.tenantId !== value.tenantId ||
        saved.type !== value.type ||
        saved.challenge !== value.challenge
      )
        return null;
      requests.delete(value.id);
      return { ...saved, createdAt: now, expiresAt: now + saved.ttlMs };
    }),
  };
  const sp = createSyntheticBrowserSp({ config, store, now: () => now });
  const start = async () => {
    const response = await sp.app.request(`${origin}/test-sp/start`, {
      method: 'POST',
      headers: { Origin: origin },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    const requestId = html.match(/name="RelayState" value="([^"]+)"/u)?.[1];
    const encoded = html.match(/name="SAMLRequest" value="([^"]+)"/u)?.[1];
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (!requestId || !cookie || !encoded) throw new Error('test_setup_failed');
    const requestXml = atob(encoded);
    expect(requestXml).toContain(`AssertionConsumerServiceURL="${origin}/test-sp/acs"`);
    expect(requestXml).toContain(`>${origin}/test-sp/metadata<`);
    expect(requestXml).toContain('ForceAuthn="true"');
    expect(response.headers.get('set-cookie')).toContain(
      'Secure; HttpOnly; SameSite=Strict; Path=/'
    );
    return { requestId, cookie };
  };
  const responseXml = (requestId: string, overrides: Partial<SAMLResponseOptions> = {}) => {
    const xml = buildSAMLResponse({
      responseId: '_response',
      assertionId: '_assertion',
      issueInstant: new Date(now).toISOString(),
      issuer: `${origin}/saml/idp/metadata`,
      destination: `${origin}/test-sp/acs`,
      recipientUrl: `${origin}/test-sp/acs`,
      inResponseTo: requestId,
      audienceRestriction: `${origin}/test-sp/metadata`,
      nameId: 'user-tenant-a@example.test',
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      authnInstant: new Date(now).toISOString(),
      notBefore: new Date(now - 30_000).toISOString(),
      notOnOrAfter: new Date(now + 300_000).toISOString(),
      authnContextClassRef: 'urn:test:passkey',
      attributes: [
        { name: 'urn:oid:0.9.2342.19200300.100.1.3', values: ['user-tenant-a@example.test'] },
      ],
      ...overrides,
    });
    return applySAMLResponseSigningPolicy(
      xml,
      { signResponses: true, signAssertions: false },
      {
        certificate: signing.certificate,
        privateKeyPem: signing.bundle.keys[0].privateKeyPem,
      }
    );
  };
  const post = (
    requestId: string,
    cookie: string,
    xml = responseXml(requestId),
    requestOrigin: string | null = origin
  ) =>
    sp.app.request(`${origin}/test-sp/acs`, {
      method: 'POST',
      headers: {
        ...(requestOrigin === null ? {} : { Origin: requestOrigin }),
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ RelayState: requestId, SAMLResponse: btoa(xml) }).toString(),
    });
  return { sp, store, requests, start, responseXml, post };
}

describe('dedicated synthetic browser SP', () => {
  it('starts from a Japanese page, verifies a signed response and consumes only its correlated request', async () => {
    const test = world();
    const home = await test.sp.app.request(`${origin}/test-sp/start`);
    expect(home.status).toBe(200);
    expect(home.headers.get('referrer-policy')).toBe('same-origin');
    expect(await home.text()).toContain('data-testid="saml-login-start"');
    expect(test.store.storeChallenge).not.toHaveBeenCalled();
    const { requestId, cookie } = await test.start();
    const result = await test.post(requestId, cookie);
    expect(result.status).toBe(200);
    const html = await result.text();
    expect(html).toContain('data-testid="saml-login-success"');
    expect(html).not.toMatch(/user-tenant-a|SAMLResponse|Assertion|BEGIN CERTIFICATE/u);
    expect(result.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(test.requests.size).toBe(0);
    expect((await test.post(requestId, cookie)).status).toBe(400);
  });

  it('allows only one of two concurrent submissions', async () => {
    const test = world();
    const { requestId, cookie } = await test.start();
    const results = await Promise.all([test.post(requestId, cookie), test.post(requestId, cookie)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
  });

  it.each([
    ['same origin', origin, 200],
    ['opaque origin', 'null', 403],
    ['missing origin', null, 403],
    ['foreign origin', 'https://foreign.example', 403],
  ] as const)('start accepts only the exact origin: %s', async (_name, requestOrigin, expected) => {
    const test = world();
    const result = await test.sp.app.request(`${origin}/test-sp/start`, {
      method: 'POST',
      headers: requestOrigin === null ? {} : { Origin: requestOrigin },
    });
    expect(result.status).toBe(expected);
    expect(test.requests.size).toBe(expected === 200 ? 1 : 0);
    expect(test.store.consumeChallenge).not.toHaveBeenCalled();
    if (expected !== 200) {
      expect(test.store.storeChallenge).not.toHaveBeenCalled();
      expect(result.headers.has('set-cookie')).toBe(false);
    }
  });

  it.each([
    ['same origin', origin, 200],
    ['opaque origin', 'null', 200],
    ['missing origin', null, 403],
    ['foreign origin', 'https://foreign.example', 403],
  ] as const)(
    'ACS verifies correlation and signature for allowed Origin: %s',
    async (_name, requestOrigin, expected) => {
      const test = world();
      const { requestId, cookie } = await test.start();
      const xml = test.responseXml(requestId);
      const result = await test.post(requestId, cookie, xml, requestOrigin);
      expect(result.status).toBe(expected);
      if (expected === 200) {
        expect(test.requests.size).toBe(0);
        expect(await result.text()).toContain('data-testid="saml-login-success"');
        const replay = await test.post(requestId, cookie, xml, requestOrigin);
        expect(replay.status).toBe(400);
        expect(replay.headers.has('set-cookie')).toBe(false);
      } else {
        expect(test.requests.size).toBe(1);
        expect(test.store.consumeChallenge).not.toHaveBeenCalled();
        expect(result.headers.has('set-cookie')).toBe(false);
      }
    }
  );

  it.each(['missing-cookie', 'wrong-cookie', 'tampered-signature'] as const)(
    'opaque-origin ACS still rejects %s without consuming state',
    async (kind) => {
      const test = world();
      const { requestId, cookie } = await test.start();
      const original = test.responseXml(requestId);
      const suppliedCookie =
        kind === 'missing-cookie'
          ? ''
          : kind === 'wrong-cookie'
            ? `__Host-authrim_test_sp=${'z'.repeat(43)}`
            : cookie;
      const xml =
        kind === 'tampered-signature'
          ? original.replace('user-tenant-a@example.test', 'attacker@example.test')
          : original;
      const result = await test.post(requestId, suppliedCookie, xml, 'null');
      expect(result.status).toBe(400);
      expect(result.headers.has('set-cookie')).toBe(false);
      expect(test.requests.size).toBe(1);
      expect((await test.post(requestId, cookie, original, 'null')).status).toBe(200);
    }
  );

  it('rejects another browser cookie without consuming the valid request', async () => {
    const test = world();
    const first = await test.start();
    const second = await test.start();
    expect((await test.post(first.requestId, second.cookie)).status).toBe(400);
    expect((await test.post(first.requestId, first.cookie)).status).toBe(200);
  });

  it.each([
    ['audience', { audienceRestriction: 'https://attacker.example/sp' }],
    ['destination', { destination: 'https://attacker.example/acs' }],
    ['recipient', { recipientUrl: 'https://attacker.example/acs' }],
    ['issuer', { issuer: 'https://attacker.example/idp' }],
    ['request ID', { inResponseTo: '_other' }],
    ['NameID', { nameId: 'other@example.test' }],
    [
      'attribute',
      {
        attributes: [{ name: 'urn:oid:0.9.2342.19200300.100.1.3', values: ['other@example.test'] }],
      },
    ],
    ['expired conditions', { notOnOrAfter: new Date(now - 1).toISOString() }],
    ['future conditions', { notBefore: new Date(now + 60_000).toISOString() }],
    ['excessive lifetime', { notOnOrAfter: new Date(now + 900_000).toISOString() }],
    ['old response', { issueInstant: new Date(now - 900_000).toISOString() }],
    ['old authentication', { authnInstant: new Date(now - 900_000).toISOString() }],
    ['expired authentication session', { sessionNotOnOrAfter: new Date(now - 1).toISOString() }],
  ] satisfies Array<[string, Partial<SAMLResponseOptions>]>)(
    'rejects signed wrong %s before consuming',
    async (_name, overrides) => {
      const test = world();
      const { requestId, cookie } = await test.start();
      const result = await test.post(requestId, cookie, test.responseXml(requestId, overrides));
      expect(result.status).toBe(400);
      expect(test.store.consumeChallenge).not.toHaveBeenCalled();
      expect(await result.text()).not.toContain('other@example.test');
      expect((await test.post(requestId, cookie)).status).toBe(200);
    }
  );

  it('rejects tampered XML and duplicate correlation fields without consuming', async () => {
    const test = world();
    const { requestId, cookie } = await test.start();
    const changed = test
      .responseXml(requestId)
      .replace('user-tenant-a@example.test', 'attacker@example.test');
    expect((await test.post(requestId, cookie, changed)).status).toBe(400);
    const body = new URLSearchParams({
      RelayState: requestId,
      SAMLResponse: btoa(test.responseXml(requestId)),
    });
    body.append('RelayState', requestId);
    const duplicate = await test.sp.app.request(`${origin}/test-sp/acs`, {
      method: 'POST',
      headers: {
        Origin: origin,
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    expect(duplicate.status).toBe(400);
    expect(test.store.consumeChallenge).not.toHaveBeenCalled();
  });

  it('rejects foreign host/origin, missing cookies and oversized bodies', async () => {
    const test = world();
    expect((await test.sp.app.request('https://foreign.example/test-sp/')).status).toBe(400);
    expect(
      (
        await test.sp.app.request(`${origin}/test-sp/start`, {
          method: 'POST',
          headers: { Origin: 'https://foreign.example' },
        })
      ).status
    ).toBe(403);
    expect(test.store.storeChallenge).not.toHaveBeenCalled();
    const { requestId } = await test.start();
    expect((await test.post(requestId, '')).status).toBe(400);
    const oversized = await test.sp.app.request(`${origin}/test-sp/acs`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'x'.repeat(128 * 1024 + 1),
    });
    expect(oversized.status).toBe(400);
    expect(test.store.consumeChallenge).not.toHaveBeenCalled();
  });

  it('rejects expired/missing persisted request and exposes no storage diagnostics', async () => {
    const test = world();
    const { requestId, cookie } = await test.start();
    test.requests.clear();
    expect((await test.post(requestId, cookie)).status).toBe(400);
    vi.mocked(test.store.consumeChallenge).mockRejectedValue(
      new Error('private-database-password')
    );
    const failed = await test.post(requestId, cookie);
    expect(await failed.text()).not.toContain('private-database-password');
  });

  it('rejects a mismatched certificate pin before starting', () => {
    expect(() =>
      createSyntheticBrowserSp({
        config: { ...config, certificateDerSha256: 'f'.repeat(64) },
        store: world().store,
      })
    ).toThrow();
  });
});

function secret() {
  return {
    ...config,
    formatVersion: 1,
    stateDatabaseUrl: `postgresql://authrim_dr_browser_state:private-password@${dbHost}:5432/authrim_dr_browser_state?sslmode=verify-full`,
  };
}

describe('browser SP destination pinning', () => {
  it('accepts only the isolated browser state DB and certificate', () => {
    expect(parseSyntheticBrowserSpSecret(secret(), origin, dbHost).tenantId).toBe('tenant-a');
  });

  it.each([
    ['real environment', { environmentName: 'production' }],
    ['missing synthetic gate', { syntheticOnly: false }],
    ['foreign origin', { origin: 'https://other.example' }],
    ['other tenant', { tenantId: 'customer' }],
    ['extra Core credential', { coreDatabaseUrl: 'private-value' }],
  ])('rejects %s', (_name, change) => {
    expect(() => parseSyntheticBrowserSpSecret({ ...secret(), ...change }, origin, dbHost)).toThrow(
      'synthetic_browser_sp_configuration_invalid'
    );
  });

  it.each([
    [
      'existing rehearsal DB',
      (url: string) => url.replaceAll('authrim_dr_browser_state', 'authrim_dr_rehearsal_state'),
    ],
    ['wrong RDS host', (url: string) => url.replace(dbHost, 'other.rds.amazonaws.com')],
    ['unverified TLS', (url: string) => url.replace('verify-full', 'require')],
    ['extra SSL option', (url: string) => `${url}&sslrootcert=/tmp/other`],
  ])('rejects %s', (_name, change) => {
    const value = secret();
    value.stateDatabaseUrl = change(value.stateDatabaseUrl);
    expect(() => parseSyntheticBrowserSpSecret(value, origin, dbHost)).toThrow(
      'synthetic_browser_sp_configuration_invalid'
    );
  });

  it('rejects absent non-production ingress gate before AWS initialization', async () => {
    vi.stubEnv('AUTHRIM_AWS_BROWSER_SP_ENABLED', '');
    try {
      const response = await handler({ version: '2.0' } as LambdaEvent);
      expect(response.statusCode).toBe(400);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
