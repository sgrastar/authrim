/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-non-null-assertion -- fakes and deliberately malformed inputs are intentionally untyped */
import { createHash, webcrypto, X509Certificate } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSAMLResponse, type SAMLResponseOptions } from '../../../ar-saml/src/idp/assertion';
import { applySAMLResponseSigningPolicy } from '../../../ar-saml/src/idp/signing';
import type { AwsTenantRuntime } from '../http-runtime';
import { runSyntheticSamlLoginProbe, type SyntheticSamlLoginProbeConfig } from './saml-login-probe';
import { sourceSigningBundle, softwarePasskey } from './synthetic-fixture';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../http-runtime', () => ({
  createAwsSamlRuntime: () => ({ app: { request: mocks.request } }),
}));

const origin = 'https://tenant-a.example.test';
const entity = `${origin}/saml/idp/metadata`;
const acs = 'https://sp.example.test/acs';
const runtime = { tenantId: 'tenant-a', origin } as AwsTenantRuntime;
let signing: Awaited<ReturnType<typeof sourceSigningBundle>>;
let probe: SyntheticSamlLoginProbeConfig;

beforeAll(async () => {
  signing = await sourceSigningBundle();
  probe = {
    issuer: origin,
    tenantId: 'tenant-a',
    spEntityId: 'https://sp.example.test/entity',
    userId: 'user-tenant-a',
    credential: await softwarePasskey(),
    expectedCertificateDerSha256: createHash('sha256')
      .update(new X509Certificate(signing.certificate).raw)
      .digest('hex'),
  };
});
beforeEach(() => {
  mocks.request.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

interface Script {
  responseOverrides?: Partial<SAMLResponseOptions>;
  /** Responses for successive submit calls; defaults to a single completed step. */
  submits?: unknown[];
  finish: unknown[][];
  submitBodies: unknown[];
  submitHeaders: unknown[];
}
function scripted(
  options: { responseOverrides?: Partial<SAMLResponseOptions>; submits?: unknown[] } = {}
) {
  const script: Script = { ...options, finish: [], submitBodies: [], submitHeaders: [] };
  let requestId = '';
  let finishCalls = 0;
  let ssoCalls = 0;
  let submitCalls = 0;
  const metadata = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entity}"><md:IDPSSODescriptor><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${btoa(String.fromCharCode(...new X509Certificate(signing.certificate).raw))}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor></md:IDPSSODescriptor></md:EntityDescriptor>`;
  const completed = {
    completed: true,
    output: { protocol_continuation: { protocol: 'saml', saml_request_id: 'stored' } },
  };
  mocks.request.mockImplementation(async (urlString: string, init?: RequestInit) => {
    const url = new URL(urlString);
    if (url.pathname === '/saml/idp/metadata') return new Response(metadata);
    if (url.pathname === '/saml/idp/sso' && init?.method === 'POST') {
      const xml = atob(
        new URLSearchParams(typeof init.body === 'string' ? init.body : '').get('SAMLRequest') ?? ''
      );
      requestId = xml.match(/ ID="([^"]+)"/u)?.[1] ?? '';
      return new Response(null, {
        status: 302,
        headers: { Location: `${origin}/login?saml_request_id=stored` },
      });
    }
    if (url.pathname.endsWith('/interactions/start'))
      return Response.json({
        interaction: { id: 'flow', current_step_id: 'auth:step' },
        contract_hash: 'contract',
        signature: 'flow-signature',
      });
    if (url.pathname.endsWith('/login/start'))
      return Response.json({
        challenge_id: 'challenge',
        options: { challenge: 'challenge-data', rpId: 'tenant-a.example.test' },
      });
    if (url.pathname.endsWith('/login/finish')) {
      finishCalls += 1;
      script.finish.push([JSON.parse(init!.body as string)]);
      if (finishCalls === 3) return Response.json({ direct_auth_artifact: 'artifact' });
      return Response.json({ error: 'rejected' }, { status: 400 });
    }
    if (url.pathname.endsWith('/direct/session'))
      return Response.json({}, { headers: { 'set-cookie': 'authrim_session=cookie; Secure' } });
    if (url.pathname.endsWith('/submit')) {
      script.submitBodies.push(JSON.parse(init!.body as string));
      script.submitHeaders.push(init!.headers);
      const next = (options.submits ?? [completed])[submitCalls++];
      return Response.json(next ?? completed);
    }
    if (url.pathname === '/saml/idp/sso') {
      ssoCalls += 1;
      if (ssoCalls > 1) return Response.json({ error: 'replayed_request' }, { status: 400 });
      const now = new Date().toISOString();
      const xml = buildSAMLResponse({
        responseId: '_response',
        assertionId: '_assertion',
        issueInstant: now,
        issuer: entity,
        destination: acs,
        recipientUrl: acs,
        inResponseTo: requestId,
        audienceRestriction: probe.spEntityId,
        nameId: 'user-tenant-a@example.test',
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
        authnInstant: now,
        notBefore: new Date(Date.now() - 30_000).toISOString(),
        notOnOrAfter: new Date(Date.now() + 300_000).toISOString(),
        authnContextClassRef: 'urn:test:passkey',
        attributes: [
          { name: 'urn:oid:0.9.2342.19200300.100.1.3', values: ['user-tenant-a@example.test'] },
        ],
        ...options.responseOverrides,
      });
      const signed = applySAMLResponseSigningPolicy(
        xml,
        { signResponses: true, signAssertions: false },
        { certificate: signing.certificate, privateKeyPem: signing.bundle.keys[0].privateKeyPem }
      );
      return new Response(
        `<form action="${acs}"><input name="SAMLResponse" value="${btoa(signed)}"/><input name="RelayState" value="synthetic-aws-rehearsal"/></form>`
      );
    }
    throw new Error('unexpected_test_route');
  });
  return script;
}
const run = (counter = 1) => runSyntheticSamlLoginProbe({ runtime, probe, counter });

describe('synthetic SAML login probe (mutation hardening)', () => {
  it('accepts the largest 32-bit counter and rejects the next value', async () => {
    const script = scripted();
    const report = await run(0xffffffff);
    expect(report.counter).toBe(0xffffffff);
    expect(script.finish).toHaveLength(4);
    mocks.request.mockReset();
    await expect(run(0x100000000)).rejects.toThrow('aws_synthetic_saml_probe_failed:configuration');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('requires exactly one mail attribute with the synthetic address', async () => {
    const other = { name: 'urn:other', values: ['x'] };
    const mail = {
      name: 'urn:oid:0.9.2342.19200300.100.1.3',
      values: ['user-tenant-a@example.test'],
    };
    for (const attributes of [
      [other],
      [{ ...mail, values: ['other@example.test'] }],
      [mail, mail],
    ]) {
      scripted({ responseOverrides: { attributes } });
      await expect(run()).rejects.toThrow('aws_synthetic_saml_probe_failed:signed_claims');
    }
    scripted({ responseOverrides: { attributes: [other, mail] } });
    await expect(run()).resolves.toMatchObject({ attributeVerified: true });
  });

  it('accepts a not-yet-completed authentication step only when it is the completion step', async () => {
    const completed = {
      completed: true,
      output: { protocol_continuation: { protocol: 'saml', saml_request_id: 'stored' } },
    };
    const script = scripted({
      submits: [{ completed: false, step: { component: 'completion' } }, completed],
    });
    await expect(run()).resolves.toMatchObject({ replayRejected: true });
    expect(script.submitBodies).toEqual([
      {
        step_id: 'auth:step',
        node_id: 'auth',
        selected_handle: 'passkey',
        contract_hash: 'contract',
        signature: 'flow-signature',
      },
      {
        step_id: 'complete:step',
        node_id: 'complete',
        selected_handle: 'completed',
        contract_hash: 'contract',
        signature: 'flow-signature',
      },
    ]);
    expect(
      script.submitHeaders.every(
        (h) => (h as Record<string, string>).Cookie === 'authrim_session=cookie'
      )
    ).toBe(true);

    for (const step of [{ component: 'other' }, undefined]) {
      scripted({ submits: [{ completed: false, step }, completed] });
      await expect(run()).rejects.toThrow('aws_synthetic_saml_probe_failed:interaction_complete');
    }
    for (const second of [
      { completed: false, step: { component: 'completion' } },
      {
        completed: true,
        output: { protocol_continuation: { protocol: 'oidc', saml_request_id: 'stored' } },
      },
      {
        completed: true,
        output: { protocol_continuation: { protocol: 'saml', saml_request_id: 'another' } },
      },
      { completed: true },
    ]) {
      scripted({ submits: [{ completed: false, step: { component: 'completion' } }, second] });
      await expect(run()).rejects.toThrow('aws_synthetic_saml_probe_failed:interaction_complete');
    }
  });

  it('encodes the ECDSA signature as minimal DER, stripping leading zeros and padding high bits', async () => {
    const encode = (raw: number[]) => {
      vi.spyOn(webcrypto.subtle, 'sign').mockResolvedValue(new Uint8Array(raw).buffer);
      return raw;
    };
    const captured = async (raw: number[]) => {
      encode(raw);
      const script = scripted();
      await run().catch(() => undefined);
      const credential = (
        script.finish[0][0] as { credential: { response: { signature: string } } }
      ).credential;
      return Array.from(
        Uint8Array.from(
          atob(credential.response.signature.replace(/-/gu, '+').replace(/_/gu, '/')),
          (c) => c.charCodeAt(0)
        )
      );
    };
    const r = (...bytes: number[]) => [...bytes, ...Array(32 - bytes.length).fill(0x11)];
    // plain: no leading zero, no high bit
    expect(await captured([...r(0x01), ...r(0x02)])).toEqual([
      0x30,
      68,
      2,
      32,
      ...r(0x01),
      2,
      32,
      ...r(0x02),
    ]);
    // high bit set requires one 0x00 pad
    expect(await captured([...r(0x81), ...r(0x02)])).toEqual([
      0x30,
      69,
      2,
      33,
      0,
      ...r(0x81),
      2,
      32,
      ...r(0x02),
    ]);
    expect(await captured([...r(0x01), ...r(0xff)])).toEqual([
      0x30,
      69,
      2,
      32,
      ...r(0x01),
      2,
      33,
      0,
      ...r(0xff),
    ]);
    // leading zero bytes are stripped; a high bit after stripping is padded again
    const zeros = (n: number, ...rest: number[]) => [
      ...Array(n).fill(0),
      ...rest,
      ...Array(32 - n - rest.length).fill(0x22),
    ];
    expect(await captured([...zeros(2, 0x05), ...r(0x02)])).toEqual([
      0x30,
      66,
      2,
      30,
      0x05,
      ...Array(29).fill(0x22),
      2,
      32,
      ...r(0x02),
    ]);
    expect(await captured([...zeros(1, 0x90), ...r(0x02)])).toEqual([
      0x30,
      68,
      2,
      32,
      0,
      0x90,
      ...Array(30).fill(0x22),
      2,
      32,
      ...r(0x02),
    ]);
    // a zero integer keeps its single byte
    expect(await captured([...Array(32).fill(0), ...r(0x02)])).toEqual([
      0x30,
      37,
      2,
      1,
      0,
      2,
      32,
      ...r(0x02),
    ]);
    expect(await captured([...r(0x01), ...Array(32).fill(0)])).toEqual([
      0x30,
      37,
      2,
      32,
      ...r(0x01),
      2,
      1,
      0,
    ]);
  });

  it('refuses a raw signature that is not exactly 64 bytes', async () => {
    for (const length of [63, 65, 0]) {
      vi.spyOn(webcrypto.subtle, 'sign').mockResolvedValueOnce(new Uint8Array(length).buffer);
      scripted();
      await expect(run()).rejects.toThrow('aws_synthetic_saml_probe_failed:bad-origin');
    }
  });
});
