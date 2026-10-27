import { createHash, X509Certificate } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const credential = await softwarePasskey();
  probe = {
    issuer: origin,
    tenantId: 'tenant-a',
    spEntityId: 'https://sp.example.test/entity',
    userId: 'user-tenant-a',
    credential,
    expectedCertificateDerSha256: createHash('sha256')
      .update(new X509Certificate(signing.certificate).raw)
      .digest('hex'),
  };
});

function scriptedApp(
  options: {
    responseOverrides?: Partial<SAMLResponseOptions>;
    tamper?: boolean;
    rejectWithCookie?: boolean;
    acceptReplay?: boolean;
  } = {}
) {
  let requestId = '';
  let finishCalls = 0;
  let ssoCalls = 0;
  const metadata = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${entity}"><md:IDPSSODescriptor><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${btoa(String.fromCharCode(...new X509Certificate(signing.certificate).raw))}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor></md:IDPSSODescriptor></md:EntityDescriptor>`;
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
      if (finishCalls === 3 || (finishCalls === 4 && options.acceptReplay))
        return Response.json({ direct_auth_artifact: 'sensitive-artifact' });
      return Response.json(
        { error: 'rejected' },
        {
          status: 400,
          headers: options.rejectWithCookie ? { 'set-cookie': 'authrim_session=unexpected' } : {},
        }
      );
    }
    if (url.pathname.endsWith('/direct/session'))
      return Response.json(
        {},
        { headers: { 'set-cookie': 'authrim_session=sensitive-cookie; Secure' } }
      );
    if (url.pathname.endsWith('/submit'))
      return Response.json({
        completed: true,
        output: { protocol_continuation: { protocol: 'saml', saml_request_id: 'stored' } },
      });
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
      let signed = applySAMLResponseSigningPolicy(
        xml,
        { signResponses: true, signAssertions: false },
        {
          certificate: signing.certificate,
          privateKeyPem: signing.bundle.keys[0].privateKeyPem,
        }
      );
      if (options.tamper)
        signed = signed.replace('user-tenant-a@example.test', 'attacker@example.test');
      return new Response(
        `<form action="${acs}"><input name="SAMLResponse" value="${btoa(signed)}"/><input name="RelayState" value="synthetic-aws-rehearsal"/></form>`
      );
    }
    throw new Error('unexpected_test_route');
  });
}

beforeEach(() => {
  mocks.request.mockReset();
});

describe('synthetic login probe safety and evidence', () => {
  it.each([
    { issuer: 'https://production.example.com' },
    { tenantId: 'tenant-b' },
    { spEntityId: 'https://external.example.com/entity' },
    { userId: 'another-user' },
  ])('refuses a non-fixture identity before requesting anything: %j', async (override) => {
    await expect(
      runSyntheticSamlLoginProbe({ runtime, probe: { ...probe, ...override }, counter: 1 })
    ).rejects.toThrow('aws_synthetic_saml_probe_failed:configuration');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 0x100000000])(
    'rejects invalid counter %s before requesting anything',
    async (counter) => {
      await expect(runSyntheticSamlLoginProbe({ runtime, probe, counter })).rejects.toThrow(
        'aws_synthetic_saml_probe_failed:configuration'
      );
      expect(mocks.request).not.toHaveBeenCalled();
    }
  );

  it('fails before login if metadata certificate differs from the independently pinned certificate', async () => {
    scriptedApp();
    await expect(
      runSyntheticSamlLoginProbe({
        runtime,
        probe: { ...probe, expectedCertificateDerSha256: '0'.repeat(64) },
        counter: 1,
      })
    ).rejects.toThrow('aws_synthetic_saml_probe_failed:metadata_certificate');
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it('returns only nonsecret evidence after cryptographic and semantic verification', async () => {
    scriptedApp();
    const report = await runSyntheticSamlLoginProbe({ runtime, probe, counter: 1 });
    expect(report).toMatchObject({
      signatureVerified: true,
      metadataCertificatePinned: true,
      nameIdVerified: true,
      inResponseToVerified: true,
      audienceVerified: true,
      replayRejected: true,
    });
    for (const secret of [
      'sensitive-artifact',
      'sensitive-cookie',
      probe.credential.id,
      probe.credential.privateJwk.d ?? '',
    ])
      expect(JSON.stringify(report)).not.toContain(secret);
  });

  it.each([
    { destination: 'https://wrong.example.test/acs' },
    { recipientUrl: 'https://wrong.example.test/acs' },
    { audienceRestriction: 'https://wrong.example.test/entity' },
    { inResponseTo: '_wrong-request' },
    { issuer: 'https://wrong.example.test/metadata' },
    { nameId: 'another-user@example.test' },
    { attributes: [] },
    { notOnOrAfter: '2000-01-01T00:00:00.000Z' },
  ])(
    'rejects a correctly signed response with mismatched claims: %j',
    async (responseOverrides) => {
      scriptedApp({ responseOverrides });
      await expect(runSyntheticSamlLoginProbe({ runtime, probe, counter: 1 })).rejects.toThrow(
        'aws_synthetic_saml_probe_failed:signed_claims'
      );
    }
  );

  it('rejects tampered assertion contents even when the response has a valid-looking Signature element', async () => {
    scriptedApp({ tamper: true });
    await expect(runSyntheticSamlLoginProbe({ runtime, probe, counter: 1 })).rejects.toThrow(
      'aws_synthetic_saml_probe_failed:signed_claims'
    );
  });

  it('does not count a failed login that sets a session cookie as a successful negative check', async () => {
    scriptedApp({ rejectWithCookie: true });
    await expect(runSyntheticSamlLoginProbe({ runtime, probe, counter: 1 })).rejects.toThrow(
      'aws_synthetic_saml_probe_failed:bad-origin'
    );
  });

  it('fails if the completed passkey challenge accepts a replay', async () => {
    scriptedApp({ acceptReplay: true });
    await expect(runSyntheticSamlLoginProbe({ runtime, probe, counter: 1 })).rejects.toThrow(
      'aws_synthetic_saml_probe_failed:passkey_replay'
    );
  });

  it('redacts upstream diagnostics rather than leaking keys, cookies or response bodies', async () => {
    mocks.request.mockRejectedValue(
      new Error('sensitive-cookie sensitive-private-key <Assertion>')
    );
    await expect(runSyntheticSamlLoginProbe({ runtime, probe, counter: 1 })).rejects.toThrow(
      /^aws_synthetic_saml_probe_failed:metadata_certificate$/u
    );
  });
});
