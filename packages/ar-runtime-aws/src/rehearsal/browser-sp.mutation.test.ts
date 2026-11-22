/* eslint-disable @typescript-eslint/no-non-null-assertion -- fakes and deliberately malformed inputs are intentionally untyped */
import { createHash, X509Certificate } from 'node:crypto';
import type { LambdaEvent } from 'hono/aws-lambda';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSAMLResponse, type SAMLResponseOptions } from '../../../ar-saml/src/idp/assertion';
import { applySAMLResponseSigningPolicy } from '../../../ar-saml/src/idp/signing';
import { sourceSigningBundle } from './synthetic-fixture';
import {
  assertSyntheticBrowserSpConfig,
  createSyntheticBrowserSp,
  verifySyntheticBrowserSamlResponse,
  type SyntheticBrowserSpConfig,
} from './browser-sp';

const origin = 'https://abcdefghij.execute-api.ap-northeast-1.amazonaws.com';
const host = origin.slice(8);
const now = Date.parse('2026-05-01T12:00:00.000Z');
const TTL = 10 * 60_000;
const MAX_BODY = 128 * 1024;
const EMAIL = 'user-tenant-a@example.test';
const REQUEST_ID = '_browser_00000000-0000-4000-8000-000000000000';
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

const iso = (ms: number) => new Date(ms).toISOString();
function signed(
  requestId = REQUEST_ID,
  overrides: Partial<SAMLResponseOptions> = {},
  edit: (xml: string) => string = (xml) => xml,
  policy = { signResponses: true, signAssertions: false }
): string {
  const xml = buildSAMLResponse({
    responseId: '_response',
    assertionId: '_assertion',
    issueInstant: iso(now),
    issuer: `${origin}/saml/idp/metadata`,
    destination: `${origin}/test-sp/acs`,
    recipientUrl: `${origin}/test-sp/acs`,
    inResponseTo: requestId,
    audienceRestriction: `${origin}/test-sp/metadata`,
    nameId: EMAIL,
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    authnInstant: iso(now),
    notBefore: iso(now - 30_000),
    notOnOrAfter: iso(now + 300_000),
    authnContextClassRef: 'urn:test:passkey',
    attributes: [{ name: 'urn:oid:0.9.2342.19200300.100.1.3', values: [EMAIL] }],
    ...overrides,
  });
  return applySAMLResponseSigningPolicy(edit(xml), policy, {
    certificate: signing.certificate,
    privateKeyPem: signing.bundle.keys[0].privateKeyPem,
  });
}
const verify = (xml: string, requestId = REQUEST_ID, at = now) =>
  verifySyntheticBrowserSamlResponse({ xml, requestId, config, now: at });
const accepts = (xml: string, requestId = REQUEST_ID) =>
  expect(() => verify(xml, requestId)).not.toThrow();
const rejects = (xml: string, requestId = REQUEST_ID) =>
  expect(() => verify(xml, requestId)).toThrow('synthetic_browser_sp_invalid');
const editSubjectExpiry = (value: string) => (xml: string) =>
  xml.replace(
    /(<saml:SubjectConfirmationData[^>]*?NotOnOrAfter=")[^"]+/u,
    (_m, prefix: string) => `${prefix}${value}`
  );

describe('verifySyntheticBrowserSamlResponse (mutation hardening)', () => {
  it('accepts the baseline response', () => {
    accepts(signed());
  });

  it('bounds the XML size inclusively and requires a well-formed request ID', () => {
    const xml = signed();
    accepts(xml + ' '.repeat(MAX_BODY - xml.length));
    rejects(xml + ' '.repeat(MAX_BODY - xml.length + 1));
    for (const bad of [
      '',
      '_browser_',
      `x${REQUEST_ID}`,
      `${REQUEST_ID}x`,
      `${REQUEST_ID}\n`,
      REQUEST_ID.slice(0, -1),
      `${REQUEST_ID}0`,
      REQUEST_ID.replace('_browser_', 'browser_'),
      REQUEST_ID.replace('0000-4000', '0000_4000'),
    ])
      rejects(signed(bad), bad);
  });

  it('requires the signature to cover the response itself', () => {
    expect(() =>
      verify(signed(REQUEST_ID, {}, (x) => x, { signResponses: false, signAssertions: true }))
    ).toThrow();
  });

  it('requires exactly one of each structural child', () => {
    rejects(
      signed(REQUEST_ID, {}, (xml) =>
        xml.replace(/(<saml:Issuer[^>]*>[^<]*<\/saml:Issuer>)/u, '$1$1')
      )
    );
    rejects(
      signed(REQUEST_ID, {}, (xml) =>
        xml.replace(/<saml:AuthnStatement[\s\S]*?<\/saml:AuthnStatement>/u, '')
      )
    );
    rejects(
      signed(REQUEST_ID, {}, (xml) =>
        xml.replace(/(<saml:AttributeStatement[\s\S]*?<\/saml:AttributeStatement>)/u, '$1$1')
      )
    );
  });

  it('requires exactly one mail attribute carrying the synthetic address', () => {
    const attribute = { name: 'urn:oid:0.9.2342.19200300.100.1.3', values: [EMAIL] };
    rejects(signed(REQUEST_ID, { attributes: [attribute, attribute] }));
    rejects(signed(REQUEST_ID, { attributes: [] }));
    rejects(
      signed(REQUEST_ID, {
        attributes: [{ name: 'urn:oid:0.9.2342.19200300.100.1.3', values: ['x@example.test'] }],
      })
    );
    accepts(
      signed(REQUEST_ID, {
        attributes: [attribute, { name: 'urn:other', values: ['value'] }],
      })
    );
  });

  it('enforces validity windows at their exact boundaries', () => {
    const at = (overrides: Partial<SAMLResponseOptions>, edit?: (xml: string) => string) =>
      signed(REQUEST_ID, overrides, edit);
    // Conditions NotBefore: up to 30s of skew, and it must be strictly before NotOnOrAfter
    accepts(at({ notBefore: iso(now + 30_000), notOnOrAfter: iso(now + 60_000) }));
    rejects(at({ notBefore: iso(now + 30_001), notOnOrAfter: iso(now + 60_000) }));
    rejects(at({ notBefore: iso(now + 10_000), notOnOrAfter: iso(now + 10_000) }));
    accepts(at({ notBefore: iso(now + 10_000), notOnOrAfter: iso(now + 10_001) }));
    // NotOnOrAfter is exclusive of now and bounded by the 10 minute TTL
    rejects(at({ notOnOrAfter: iso(now) }));
    accepts(at({ notOnOrAfter: iso(now + 1) }));
    accepts(at({ notOnOrAfter: iso(now + TTL) }));
    rejects(at({ notOnOrAfter: iso(now + TTL + 1) }));
    // SubjectConfirmationData expiry follows the same window
    rejects(at({}, editSubjectExpiry(iso(now))));
    accepts(at({}, editSubjectExpiry(iso(now + 1))));
    accepts(at({}, editSubjectExpiry(iso(now + TTL))));
    rejects(at({}, editSubjectExpiry(iso(now + TTL + 1))));
    // issue and authentication instants: 30s future skew, 10 minutes past
    for (const key of ['issueInstant', 'authnInstant'] as const) {
      accepts(at({ [key]: iso(now + 30_000) }));
      rejects(at({ [key]: iso(now + 30_001) }));
      accepts(at({ [key]: iso(now - TTL) }));
      rejects(at({ [key]: iso(now - TTL - 1) }));
    }
  });

  it('checks the optional session expiry only when present', () => {
    accepts(signed(REQUEST_ID, { sessionNotOnOrAfter: null }));
    accepts(signed(REQUEST_ID, { sessionNotOnOrAfter: iso(now + 1) }));
    rejects(signed(REQUEST_ID, { sessionNotOnOrAfter: iso(now) }));
    rejects(signed(REQUEST_ID, { sessionNotOnOrAfter: iso(now - 1) }));
    const without = signed(REQUEST_ID, {}, (xml) =>
      xml.replace(/\sSessionNotOnOrAfter="[^"]*"/u, '')
    );
    expect(without).not.toContain('SessionNotOnOrAfter');
    accepts(without);
  });

  it('rejects malformed instants', () => {
    for (const bad of [
      '2026-05-01T12:00:00',
      '2026-05-01 12:00:00Z',
      'nope',
      '2026-05-01T12:00:00.1234Z',
      '2026-13-45T25:61:61Z',
    ])
      rejects(signed(REQUEST_ID, { notBefore: bad }));
    accepts(signed(REQUEST_ID, { notBefore: '2026-05-01T11:59:30Z' }));
    accepts(signed(REQUEST_ID, { notBefore: '2026-05-01T11:59:30.5Z' }));
    rejects(signed(REQUEST_ID, { notBefore: '2026-05-01T11:59:30.Z' }));
    rejects(signed(REQUEST_ID, { notBefore: ' 2026-05-01T11:59:30Z' }));
    rejects(signed(REQUEST_ID, { notBefore: '2026-05-01T11:59:30Z ' }));
  });
});

describe('assertSyntheticBrowserSpConfig (mutation hardening)', () => {
  it('requires every pin', () => {
    expect(() => assertSyntheticBrowserSpConfig(config)).not.toThrow();
    const bad: Array<Partial<SyntheticBrowserSpConfig>> = [
      { syntheticOnly: false as never },
      { environmentName: 'production' as never },
      { tenantId: 'tenant-b' as never },
      { origin: origin.replace('https', 'http') },
      { origin: `${origin}/` },
      { origin: `x${origin}` },
      { origin: origin.replace('ap-northeast-1', 'us-east-1') },
      { origin: origin.replace('abcdefghij', 'abcdefghi') },
      { origin: origin.replace('abcdefghij', 'abcdefghijk') },
      { origin: origin.replace('abcdefghij', 'ABCDEFGHIJ') },
      { certificateDerSha256: 'F'.repeat(64) },
      { certificateDerSha256: config.certificateDerSha256.slice(1) },
      { certificateDerSha256: `${config.certificateDerSha256}0` },
      { certificateDerSha256: `${config.certificateDerSha256}\n` },
      { certificateDerSha256: `x${config.certificateDerSha256}` },
    ];
    for (const patch of bad)
      expect(() => assertSyntheticBrowserSpConfig({ ...config, ...patch })).toThrow(
        'synthetic_browser_sp_invalid'
      );
  });
});

type Store = Parameters<typeof createSyntheticBrowserSp>[0]['store'];
type Stored = Parameters<Store['storeChallenge']>[0];
function world() {
  const requests = new Map<string, Stored>();
  const store: Store = {
    storeChallenge: vi.fn(async (value: Stored) => {
      requests.set(value.id, value);
      return true;
    }),
    consumeChallenge: vi.fn(async (value: Parameters<Store['consumeChallenge']>[0]) => {
      const saved = requests.get(value.id);
      if (!saved || saved.challenge !== value.challenge) return null;
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
    const html = await response.text();
    const requestId = html.match(/name="RelayState" value="([^"]+)"/u)![1];
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    return { requestId, cookie, response, html };
  };
  const acs = (
    cookie: string,
    body: string,
    headers: Record<string, string> = {},
    requestOrigin: string | null = origin
  ) =>
    sp.app.request(`${origin}/test-sp/acs`, {
      method: 'POST',
      headers: {
        ...(requestOrigin === null ? {} : { Origin: requestOrigin }),
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      body,
    });
  return { sp, store, requests, start, acs };
}
const formBody = (requestId: string, xml: string) =>
  `RelayState=${requestId}&SAMLResponse=${encodeURIComponent(btoa(xml))}`;

describe('synthetic browser SP HTTP surface (mutation hardening)', () => {
  it('serves exact fixed refusal texts', async () => {
    const test = world();
    const foreign = await test.sp.app.request('https://foreign.example/test-sp/start');
    expect(foreign.status).toBe(400);
    expect(await foreign.text()).toBe('接続先が一致しません。');
    const crossOrigin = await test.sp.app.request(`${origin}/test-sp/start`, {
      method: 'POST',
      headers: { Origin: 'https://foreign.example' },
    });
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.text()).toBe('この操作は試験ページから開始してください。');
    const failure = await test.acs('', 'nonsense');
    expect(failure.status).toBe(400);
    expect(failure.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(failure.headers.get('cache-control')).toBe('no-store');
    expect(await failure.text()).toBe(
      '試験を完了できませんでした。開始画面からやり直してください。'
    );
  });

  it('serves the SP metadata with its media type and pinned endpoints', async () => {
    const test = world();
    const response = await test.sp.app.request(`${origin}/test-sp/metadata`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/samlmetadata+xml');
    const xml = await response.text();
    expect(xml).toContain(`entityID="${origin}/test-sp/metadata"`);
    expect(xml).toContain('AuthnRequestsSigned="false" WantAssertionsSigned="false"');
    expect(xml).toContain('Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"');
    expect(xml).toContain(`Location="${origin}/test-sp/acs" index="0" isDefault="true"`);
    expect(xml).toMatch(/^<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"/u);
    expect(xml).toContain('protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"');
  });

  it('sets the standard hardening headers and a strict CSP on every response', async () => {
    const test = world();
    const home = await test.sp.app.request(`${origin}/test-sp/start`);
    expect(home.headers.get('cache-control')).toBe('no-store');
    expect(home.headers.get('x-content-type-options')).toBe('nosniff');
    expect(home.headers.get('content-security-policy')).toBe(
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    );
    const started = await test.start();
    expect(started.response.headers.get('content-security-policy')).toMatch(
      /^default-src 'none'; script-src 'nonce-[A-Za-z0-9_-]{32}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'$/u
    );
    expect(started.cookie).toMatch(/^__Host-authrim_test_sp=[A-Za-z0-9_-]{43}$/u);
    expect(started.response.headers.get('set-cookie')).toMatch(/; Max-Age=600$/u);
    const stored = [...test.requests.values()][0];
    expect(stored).toMatchObject({
      tenantId: 'tenant-a',
      type: 'synthetic-browser-sp',
      userId: 'user-tenant-a',
      ttlMs: 600_000,
      id: `browser-sp:${started.requestId}`,
    });
    expect(stored.challenge).toBe(
      createHash('sha256').update(started.cookie.split('=')[1]).digest('hex')
    );
  });

  it('refuses ACS submissions whose Content-Length is absent-of-digits or too large', async () => {
    const accept = async (headers: Record<string, string>) => {
      const test = world();
      const { requestId, cookie } = await test.start();
      return test.acs(cookie, formBody(requestId, signed(requestId)), headers);
    };
    expect((await accept({})).status).toBe(200);
    expect((await accept({ 'Content-Length': '1234' })).status).toBe(200);
    expect((await accept({ 'Content-Length': '7' })).status).toBe(200);
    expect((await accept({ 'Content-Length': String(MAX_BODY) })).status).toBe(200);
    for (const bad of [String(MAX_BODY + 1), 'abc', '12a', 'a12', '-5', '1e3', '1 2', '+5'])
      expect((await accept({ 'Content-Length': bad })).status, bad).toBe(400);
  });

  it('accepts a body of exactly 128 KiB and rejects one byte more', async () => {
    // Trailing '&' separators pad the body without changing any parsed form field.
    const build = (requestId: string, extra: number) => {
      const base = formBody(requestId, signed(requestId));
      expect(base.length).toBeLessThan(MAX_BODY);
      return base + '&'.repeat(MAX_BODY + extra - base.length);
    };
    const exact = world();
    const first = await exact.start();
    const exactBody = build(first.requestId, 0);
    expect(new TextEncoder().encode(exactBody).byteLength).toBe(MAX_BODY);
    expect((await exact.acs(first.cookie, exactBody)).status).toBe(200);
    const over = world();
    const second = await over.start();
    // the extra byte is rejected by the streaming limit even when the body is otherwise valid
    const overBody = build(second.requestId, 1);
    expect(new TextEncoder().encode(overBody).byteLength).toBe(MAX_BODY + 1);
    expect((await over.acs(second.cookie, overBody)).status).toBe(400);
    expect(over.store.consumeChallenge).not.toHaveBeenCalled();
  });

  it('rejects structurally invalid form submissions before consuming state', async () => {
    const test = world();
    const { requestId, cookie } = await test.start();
    const good = btoa(signed(requestId));
    const bodies = [
      `RelayState=${requestId}&SAMLResponse=`,
      `RelayState=${requestId}`,
      `SAMLResponse=${encodeURIComponent(good)}`,
      `RelayState=${requestId}&SAMLResponse=${encodeURIComponent(good)}&extra=1`,
      `RelayState=${requestId}&SAMLResponse=${encodeURIComponent(good)}&SAMLResponse=${encodeURIComponent(good)}`,
      `RelayState=${requestId}&RelayState=${requestId}&SAMLResponse=${encodeURIComponent(good)}`,
      `RelayState=x${requestId}&SAMLResponse=${encodeURIComponent(good)}`,
      `RelayState=${requestId}x&SAMLResponse=${encodeURIComponent(good)}`,
      `RelayState=${requestId}&SAMLResponse=${encodeURIComponent(good.slice(1))}`,
      `RelayState=${requestId}&SAMLResponse=${encodeURIComponent(`${good}$$$$`)}`,
      `RelayState=${requestId}&SAMLResponse=${encodeURIComponent(`$${good.slice(1)}`)}`,
      `RelayState=${requestId}&SAMLResponse=${encodeURIComponent(`${good.slice(0, -4)}====`)}`,
    ];
    for (const body of bodies)
      expect((await test.acs(cookie, body)).status, body.slice(0, 60)).toBe(400);
    const wrongType = await test.sp.app.request(`${origin}/test-sp/acs`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'text/plain' },
      body: formBody(requestId, signed(requestId)),
    });
    expect(wrongType.status).toBe(400);
    const noType = await test.sp.app.request(`${origin}/test-sp/acs`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie },
      body: new Uint8Array(),
    });
    expect(noType.status).toBe(400);
    expect(test.store.consumeChallenge).not.toHaveBeenCalled();
    // content type parameters are tolerated
    const ok = await test.acs(cookie, formBody(requestId, signed(requestId)), {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    });
    expect(ok.status).toBe(200);
  });

  it('requires exactly one well-formed cookie of ours', async () => {
    const test = world();
    const { requestId, cookie } = await test.start();
    const body = formBody(requestId, signed(requestId));
    const value = cookie.split('=')[1];
    for (const header of [
      '',
      'other=1',
      `${cookie}; ${cookie}`,
      `__Host-authrim_test_sp=${value.slice(1)}`,
      `__Host-authrim_test_sp=${value}x`,
      `__Host-authrim_test_sp=${value.slice(1)}!`,
      `x__Host-authrim_test_sp=${value}`,
    ])
      expect((await test.acs(header, body)).status, header).toBe(400);
    expect(test.store.consumeChallenge).not.toHaveBeenCalled();
    expect((await test.acs(`other=1; ${cookie}; another=2`, body)).status).toBe(200);
  });

  it('consumes with the digest of the cookie and returns the success page', async () => {
    const test = world();
    const { requestId, cookie } = await test.start();
    const response = await test.acs(cookie, formBody(requestId, signed(requestId)));
    expect(response.status).toBe(200);
    expect(test.store.consumeChallenge).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      id: `browser-sp:${requestId}`,
      type: 'synthetic-browser-sp',
      challenge: createHash('sha256').update(cookie.split('=')[1]).digest('hex'),
    });
    expect(response.headers.get('set-cookie')).toBe(
      '__Host-authrim_test_sp=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
    );
    const html = await response.text();
    expect(html).toContain('data-testid="saml-login-success"');
    expect(html).toContain('href="/test-sp/start"');
  });

  it('rejects when the persisted request belongs to another user', async () => {
    const test = world();
    const { requestId, cookie } = await test.start();
    vi.mocked(test.store.consumeChallenge).mockResolvedValue({
      userId: 'someone-else',
    } as never);
    expect((await test.acs(cookie, formBody(requestId, signed(requestId)))).status).toBe(400);
    vi.mocked(test.store.storeChallenge).mockResolvedValue(false);
    const refused = await test.sp.app.request(`${origin}/test-sp/start`, {
      method: 'POST',
      headers: { Origin: origin },
    });
    expect(refused.status).toBe(400);
  });
});

describe('synthetic browser SP Lambda ingress (mutation hardening)', () => {
  const event = (over: Record<string, unknown> = {}) =>
    ({
      version: '2.0',
      routeKey: '$default',
      rawPath: '/test-sp/start',
      rawQueryString: '',
      headers: { host },
      requestContext: {
        domainName: host,
        http: {
          method: 'GET',
          path: '/test-sp/start',
          sourceIp: '203.0.113.9',
          protocol: 'HTTP/1.1',
          userAgent: 'x',
        },
      },
      isBase64Encoded: false,
      ...over,
    }) as unknown as LambdaEvent;
  const UNTRUSTED = {
    statusCode: 400,
    body: 'untrusted_ingress',
    headers: { 'cache-control': 'no-store' },
    isBase64Encoded: false,
  };

  it('serves trusted API Gateway events and rejects untrusted ones with a fixed response', async () => {
    const { handler } = world().sp;
    const ok = await handler(event());
    expect(ok).toMatchObject({ statusCode: 200 });
    expect((ok as { body: string }).body).toContain('data-testid="saml-login-start"');
    const sourceV6 = event({
      requestContext: {
        domainName: host,
        http: { method: 'GET', path: '/test-sp/start', sourceIp: '2001:db8::1' },
      },
    });
    expect(await handler(sourceV6)).toMatchObject({ statusCode: 200 });
    const bad: Array<[string, unknown]> = [
      ['no version', { headers: { host }, requestContext: event().requestContext }],
      ['version 1.0', event({ version: '1.0' })],
      ['no http context', event({ requestContext: { domainName: host } })],
      [
        'domain',
        event({ requestContext: { domainName: 'x.example', http: { sourceIp: '203.0.113.9' } } }),
      ],
      ['host header', event({ headers: { host: 'x.example' } })],
      ['source ip', event({ requestContext: { domainName: host, http: { sourceIp: 'bad' } } })],
      ['empty source ip', event({ requestContext: { domainName: host, http: { sourceIp: '' } } })],
    ];
    for (const [name, evt] of bad)
      expect(await handler(evt as LambdaEvent), name).toEqual(UNTRUSTED);
  });
});
