/** Dedicated synthetic browser SP. Never import this module from production serving entries. */
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { Hono } from 'hono';
import { handle, type LambdaContext, type LambdaEvent } from 'hono/aws-lambda';
import { SAML_NAMESPACES as NS, NAMEID_FORMATS } from '../../../ar-saml/src/common/constants';
import { verifyXmlSignatureAndGetReferences } from '../../../ar-saml/src/common/signature';
import { parseSAMLXml, type XMLDocument } from '../../../ar-saml/src/common/xml-utils';
import { extractSAMLResponseIds } from '../../../ar-saml/src/idp/signing';
import type { TransientStateStore } from '../storage/state-ports';

const TENANT = 'tenant-a';
const EMAIL = 'user-tenant-a@example.test';
const COOKIE = '__Host-authrim_test_sp';
const CHALLENGE_TYPE = 'synthetic-browser-sp';
const TTL_MS = 10 * 60_000;
const MAX_BODY = 128 * 1024;
type Element = NonNullable<XMLDocument['documentElement']>;
type Store = Pick<TransientStateStore, 'storeChallenge' | 'consumeChallenge'>;

export interface SyntheticBrowserSpConfig {
  syntheticOnly: true;
  environmentName: 'aws-browser-rehearsal';
  origin: string;
  tenantId: 'tenant-a';
  certificatePem: string;
  certificateDerSha256: string;
}

function check(value: unknown): asserts value {
  if (!value) throw new Error('synthetic_browser_sp_invalid');
}

export function assertSyntheticBrowserSpConfig(config: SyntheticBrowserSpConfig): void {
  check(
    config.syntheticOnly === true &&
      config.environmentName === 'aws-browser-rehearsal' &&
      config.tenantId === TENANT &&
      /^https:\/\/[a-z0-9]{10}\.execute-api\.ap-northeast-1\.amazonaws\.com$/u.test(
        config.origin
      ) &&
      /^[a-f0-9]{64}$/u.test(config.certificateDerSha256)
  );
  const certificate = new X509Certificate(config.certificatePem);
  check(createHash('sha256').update(certificate.raw).digest('hex') === config.certificateDerSha256);
}

function child(element: Element, namespace: string, name: string): Element {
  const matches = Array.from(element.childNodes).filter(
    (node) =>
      node.nodeType === 1 &&
      (node as Element).namespaceURI === namespace &&
      (node as Element).localName === name
  ) as unknown as Element[];
  check(matches.length === 1);
  return matches[0];
}

function instant(value: string | null): number {
  check(value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value));
  const parsed = Date.parse(value);
  check(Number.isFinite(parsed));
  return parsed;
}

/** Interpret only the XML reference covered by the independently pinned response signature. */
export function verifySyntheticBrowserSamlResponse(input: {
  xml: string;
  requestId: string;
  config: SyntheticBrowserSpConfig;
  now: number;
}): void {
  const { xml, requestId, config, now } = input;
  check(xml.length <= MAX_BODY && /^_browser_[a-f0-9-]{36}$/u.test(requestId));
  const responseId = extractSAMLResponseIds(xml).responseId;
  const references = verifyXmlSignatureAndGetReferences(xml, {
    certificateOrKey: config.certificatePem,
    expectedId: responseId,
    strictXswProtection: true,
  }).filter((reference) => reference.uri === `#${responseId}`);
  check(references.length === 1);
  const response = parseSAMLXml(references[0].xml).documentElement;
  check(response?.namespaceURI === NS.SAML2P && response.localName === 'Response');
  const issuer = `${config.origin}/saml/idp/metadata`;
  const acs = `${config.origin}/test-sp/acs`;
  check(response.getAttribute('Version') === '2.0');
  check(response.getAttribute('Destination') === acs);
  check(response.getAttribute('InResponseTo') === requestId);
  check(child(response, NS.SAML2, 'Issuer').textContent === issuer);
  check(
    child(child(response, NS.SAML2P, 'Status'), NS.SAML2P, 'StatusCode').getAttribute('Value') ===
      'urn:oasis:names:tc:SAML:2.0:status:Success'
  );
  const assertion = child(response, NS.SAML2, 'Assertion');
  check(assertion.getAttribute('Version') === '2.0');
  check(child(assertion, NS.SAML2, 'Issuer').textContent === issuer);
  for (const element of [response, assertion]) {
    const issued = instant(element.getAttribute('IssueInstant'));
    check(issued <= now + 30_000 && issued >= now - TTL_MS);
  }
  const subject = child(assertion, NS.SAML2, 'Subject');
  const nameId = child(subject, NS.SAML2, 'NameID');
  check(nameId.getAttribute('Format') === NAMEID_FORMATS.EMAIL && nameId.textContent === EMAIL);
  const confirmation = child(subject, NS.SAML2, 'SubjectConfirmation');
  check(confirmation.getAttribute('Method') === 'urn:oasis:names:tc:SAML:2.0:cm:bearer');
  const data = child(confirmation, NS.SAML2, 'SubjectConfirmationData');
  check(data.getAttribute('Recipient') === acs && data.getAttribute('InResponseTo') === requestId);
  check(!data.hasAttribute('NotBefore'));
  const conditions = child(assertion, NS.SAML2, 'Conditions');
  const notBefore = instant(conditions.getAttribute('NotBefore'));
  const notAfter = instant(conditions.getAttribute('NotOnOrAfter'));
  const subjectExpiry = instant(data.getAttribute('NotOnOrAfter'));
  check(notBefore <= now + 30_000 && notBefore < notAfter);
  check(notAfter > now && notAfter <= now + TTL_MS);
  check(subjectExpiry > now && subjectExpiry <= now + TTL_MS);
  const authentication = child(assertion, NS.SAML2, 'AuthnStatement');
  const authenticatedAt = instant(authentication.getAttribute('AuthnInstant'));
  check(authenticatedAt <= now + 30_000 && authenticatedAt >= now - TTL_MS);
  const sessionExpiry = authentication.getAttribute('SessionNotOnOrAfter');
  if (sessionExpiry) check(instant(sessionExpiry) > now);
  check(
    child(child(conditions, NS.SAML2, 'AudienceRestriction'), NS.SAML2, 'Audience').textContent ===
      `${config.origin}/test-sp/metadata`
  );
  const statement = child(assertion, NS.SAML2, 'AttributeStatement');
  const mail = Array.from(statement.childNodes).filter(
    (node) =>
      node.nodeType === 1 &&
      (node as Element).namespaceURI === NS.SAML2 &&
      (node as Element).localName === 'Attribute' &&
      (node as Element).getAttribute('Name') === 'urn:oid:0.9.2342.19200300.100.1.3'
  ) as unknown as Element[];
  check(mail.length === 1 && child(mail[0], NS.SAML2, 'AttributeValue').textContent === EMAIL);
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function page(content: string): string {
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authrim AWS SAML接続試験</title><main><h1>Authrim AWS SAML接続試験</h1><p>開発用の合成データを使うテストです。</p>${content}</main></html>`;
}

async function formBody(request: Request): Promise<URLSearchParams> {
  check(
    request.headers.get('content-type')?.split(';')[0].trim() ===
      'application/x-www-form-urlencoded'
  );
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null)
    check(/^\d+$/u.test(declaredLength) && Number(declaredLength) <= MAX_BODY);
  const reader = request.body?.getReader();
  check(reader);
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      check(size <= MAX_BODY);
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(body));
}

export function createSyntheticBrowserSp(input: {
  config: SyntheticBrowserSpConfig;
  store: Store;
  now?: () => number;
}) {
  assertSyntheticBrowserSpConfig(input.config);
  const { config, store } = input;
  const now = input.now ?? Date.now;
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    // Preserve the Origin on our same-origin start form; do not leak referrers cross-origin.
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    );
    if (new URL(c.req.url).origin !== config.origin) return c.text('接続先が一致しません。', 400);
    const requestOrigin = c.req.header('Origin');
    // The IdP's existing no-referrer POST binding can produce literal Origin: null. This
    // exception is ACS-only: its signed response and one-use Strict cookie remain mandatory.
    const opaqueSamlPost = c.req.path === '/test-sp/acs' && requestOrigin === 'null';
    if (c.req.method === 'POST' && requestOrigin !== config.origin && !opaqueSamlPost)
      return c.text('この操作は試験ページから開始してください。', 403);
    await next();
  });
  app.onError(
    () =>
      new Response('試験を完了できませんでした。開始画面からやり直してください。', {
        status: 400,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      })
  );
  const startPage = page(
    '<form action="/test-sp/start" method="post"><button type="submit" data-testid="saml-login-start">パスキーでSAMLログインを試す</button></form>'
  );
  app.get('/test-sp/start', (c) => c.html(startPage));
  app.get('/test-sp/metadata', (c) => {
    c.header('Content-Type', 'application/samlmetadata+xml');
    return c.body(
      `<md:EntityDescriptor xmlns:md="${NS.MD}" entityID="${config.origin}/test-sp/metadata"><md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="false" protocolSupportEnumeration="${NS.SAML2P}"><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${config.origin}/test-sp/acs" index="0" isDefault="true"/></md:SPSSODescriptor></md:EntityDescriptor>`
    );
  });
  app.post('/test-sp/start', async (c) => {
    const requestId = `_browser_${randomUUID()}`;
    const cookie = b64url(randomBytes(32));
    check(
      await store.storeChallenge({
        tenantId: TENANT,
        id: `browser-sp:${requestId}`,
        type: CHALLENGE_TYPE,
        userId: 'user-tenant-a',
        challenge: createHash('sha256').update(cookie).digest('hex'),
        ttlMs: TTL_MS,
      })
    );
    const request = `<samlp:AuthnRequest xmlns:samlp="${NS.SAML2P}" xmlns:saml="${NS.SAML2}" ID="${requestId}" Version="2.0" IssueInstant="${new Date(now()).toISOString()}" Destination="${config.origin}/saml/idp/sso" AssertionConsumerServiceURL="${config.origin}/test-sp/acs" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" ForceAuthn="true"><saml:Issuer>${config.origin}/test-sp/metadata</saml:Issuer></samlp:AuthnRequest>`;
    const nonce = b64url(randomBytes(24));
    c.header(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`
    );
    c.header(
      'Set-Cookie',
      `${COOKIE}=${cookie}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`
    );
    return c.html(
      page(
        `<form id="saml-request" action="/saml/idp/sso" method="post"><input type="hidden" name="SAMLRequest" value="${btoa(request)}"><input type="hidden" name="RelayState" value="${requestId}"><button type="submit">ログイン画面へ進む</button></form><script nonce="${nonce}">document.getElementById('saml-request').submit()</script>`
      )
    );
  });
  app.post('/test-sp/acs', async (c) => {
    const form = await formBody(c.req.raw);
    check(form.getAll('SAMLResponse').length === 1 && form.getAll('RelayState').length === 1);
    check([...form.keys()].every((key) => key === 'SAMLResponse' || key === 'RelayState'));
    const requestId = form.get('RelayState') ?? '';
    const encoded = form.get('SAMLResponse') ?? '';
    check(/^_browser_[a-f0-9-]{36}$/u.test(requestId));
    check(
      encoded.length > 0 && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
    );
    const cookieValues = (c.req.header('Cookie') ?? '')
      .split(';')
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${COOKIE}=`));
    check(cookieValues.length === 1);
    const cookie = cookieValues[0].slice(COOKIE.length + 1);
    check(/^[A-Za-z0-9_-]{43}$/u.test(cookie));
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(encoded), (value) => value.charCodeAt(0))
    );
    verifySyntheticBrowserSamlResponse({ xml, requestId, config, now: now() });
    const consumed = await store.consumeChallenge({
      tenantId: TENANT,
      id: `browser-sp:${requestId}`,
      type: CHALLENGE_TYPE,
      challenge: createHash('sha256').update(cookie).digest('hex'),
    });
    check(consumed?.userId === 'user-tenant-a');
    c.header('Set-Cookie', `${COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return c.html(
      page(
        '<h2 data-testid="saml-login-success">SAMLログインに成功しました</h2><p>署名・宛先・要求との対応・有効期限・合成ユーザーの属性を確認しました。</p><a href="/test-sp/start">もう一度試す</a>'
      )
    );
  });
  const invoke = handle(app);
  const handler = async (event: LambdaEvent, context?: LambdaContext) => {
    const host = new URL(config.origin).host;
    if (
      !('version' in event) ||
      event.version !== '2.0' ||
      !('http' in event.requestContext) ||
      event.requestContext.domainName !== host ||
      event.headers.host !== host ||
      !isIP(event.requestContext.http.sourceIp)
    )
      return {
        statusCode: 400,
        body: 'untrusted_ingress',
        headers: { 'cache-control': 'no-store' },
        isBase64Encoded: false,
      };
    return invoke(event, context);
  };
  return { app, handler };
}
