/** In-process authentication rehearsal for the fixed synthetic fixture, never an external SP. */
import { createHash, randomUUID, webcrypto, X509Certificate } from 'node:crypto';
import { SAML_NAMESPACES as NS, NAMEID_FORMATS } from '../../../ar-saml/src/common/constants';
import { verifyXmlSignatureAndGetReferences } from '../../../ar-saml/src/common/signature';
import { parseSAMLXml, type XMLDocument } from '../../../ar-saml/src/common/xml-utils';
import { extractSAMLResponseIds } from '../../../ar-saml/src/idp/signing';
import { createAwsSamlRuntime, type AwsTenantRuntime } from '../http-runtime';

const ISSUER = 'https://tenant-a.example.test';
const TENANT = 'tenant-a';
const SP = 'https://sp.example.test/entity';
const ACS = 'https://sp.example.test/acs';
const USER = 'user-tenant-a';
const EMAIL = 'user-tenant-a@example.test';
const MAIL = 'urn:oid:0.9.2342.19200300.100.1.3';
const RELAY = 'synthetic-aws-rehearsal';
const ENTITY = `${ISSUER}/saml/idp/metadata`;
type Element = NonNullable<XMLDocument['documentElement']>;

export interface SyntheticSamlLoginProbeConfig {
  issuer: string;
  tenantId: string;
  spEntityId: string;
  userId: string;
  credential: { id: string; privateJwk: JsonWebKey };
  /** Independently pinned in the generated fixture summary, not learned from metadata. */
  expectedCertificateDerSha256: string;
}

export interface SyntheticSamlLoginProbeReport {
  counter: number;
  certificateDerSha256: string;
  metadataCertificatePinned: true;
  signatureVerified: true;
  issuerVerified: true;
  audienceVerified: true;
  acsVerified: true;
  inResponseToVerified: true;
  nameIdVerified: true;
  attributeVerified: true;
  relayStateVerified: true;
  badSignatureRejected: true;
  badOriginRejected: true;
  passkeyReplayRejected: true;
  samlReplayRejected: true;
  replayRejected: true;
}

function check(value: unknown): asserts value {
  if (!value) throw new Error('probe_check_failed');
}

function children(element: Element, namespace: string, name: string): Element[] {
  return Array.from(element.childNodes).filter(
    (node) =>
      node.nodeType === 1 &&
      (node as Element).namespaceURI === namespace &&
      (node as Element).localName === name
  ) as unknown as Element[];
}

function child(element: Element, namespace: string, name: string): Element {
  const found = children(element, namespace, name);
  check(found.length === 1);
  return found[0];
}

function b64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function derSignature(raw: Uint8Array): Uint8Array {
  check(raw.length === 64);
  const integer = (part: Uint8Array) => {
    const bytes = Array.from(part);
    while (bytes.length > 1 && bytes[0] === 0) bytes.shift();
    if (bytes[0] & 0x80) bytes.unshift(0);
    return [2, bytes.length, ...bytes];
  };
  const content = [...integer(raw.slice(0, 32)), ...integer(raw.slice(32))];
  return new Uint8Array([0x30, content.length, ...content]);
}

async function softwareAssertion(
  probe: SyntheticSamlLoginProbeConfig,
  challenge: string,
  counter: number,
  mode: 'valid' | 'bad-origin' | 'bad-signature'
) {
  const privateKey = await webcrypto.subtle.importKey(
    'jwk',
    probe.credential.privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const clientData = new TextEncoder().encode(
    JSON.stringify({
      type: 'webauthn.get',
      challenge,
      origin: mode === 'bad-origin' ? 'https://wrong-origin.example.test' : ISSUER,
      crossOrigin: false,
    })
  );
  const rpHash = createHash('sha256').update(new URL(ISSUER).hostname).digest();
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, counter);
  const authData = new Uint8Array([...rpHash, 5, ...count]);
  const clientHash = createHash('sha256').update(clientData).digest();
  const signature = derSignature(
    new Uint8Array(
      await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        new Uint8Array([...authData, ...clientHash])
      )
    )
  );
  if (mode === 'bad-signature') signature[signature.length - 1] ^= 1;
  return {
    id: probe.credential.id,
    rawId: probe.credential.id,
    type: 'public-key',
    response: {
      clientDataJSON: b64(clientData),
      authenticatorData: b64(authData),
      signature: b64(signature),
      userHandle: b64(new TextEncoder().encode(USER)),
    },
    clientExtensionResults: {},
  };
}

async function rejected(response: Response): Promise<void> {
  check([400, 401, 403].includes(response.status));
  check(!response.headers.has('set-cookie'));
  const body = await response.text();
  check(!body.includes('direct_auth_artifact') && !body.includes('SAMLResponse'));
}

/** Check only the response reference whose digest and signature were actually verified. */
function verifyResponse(xml: string, certificate: string, requestId: string): void {
  const responseId = extractSAMLResponseIds(xml).responseId;
  const references = verifyXmlSignatureAndGetReferences(xml, {
    certificateOrKey: certificate,
    expectedId: responseId,
    strictXswProtection: true,
  }).filter((reference) => reference.uri === `#${responseId}`);
  check(references.length === 1);
  const response = parseSAMLXml(references[0].xml).documentElement;
  check(response?.namespaceURI === NS.SAML2P && response.localName === 'Response');
  check(response.getAttribute('Destination') === ACS);
  check(response.getAttribute('InResponseTo') === requestId);
  check(child(response, NS.SAML2, 'Issuer').textContent === ENTITY);
  check(
    child(child(response, NS.SAML2P, 'Status'), NS.SAML2P, 'StatusCode').getAttribute('Value') ===
      'urn:oasis:names:tc:SAML:2.0:status:Success'
  );
  const assertion = child(response, NS.SAML2, 'Assertion');
  check(child(assertion, NS.SAML2, 'Issuer').textContent === ENTITY);
  const subject = child(assertion, NS.SAML2, 'Subject');
  const nameId = child(subject, NS.SAML2, 'NameID');
  check(nameId.getAttribute('Format') === NAMEID_FORMATS.EMAIL && nameId.textContent === EMAIL);
  const confirmation = child(subject, NS.SAML2, 'SubjectConfirmation');
  check(confirmation.getAttribute('Method') === 'urn:oasis:names:tc:SAML:2.0:cm:bearer');
  const data = child(confirmation, NS.SAML2, 'SubjectConfirmationData');
  check(data.getAttribute('Recipient') === ACS && data.getAttribute('InResponseTo') === requestId);
  check(Date.parse(data.getAttribute('NotOnOrAfter') ?? '') > Date.now());
  const conditions = child(assertion, NS.SAML2, 'Conditions');
  check(Date.parse(conditions.getAttribute('NotOnOrAfter') ?? '') > Date.now());
  check(Date.parse(conditions.getAttribute('NotBefore') ?? '') <= Date.now());
  check(
    child(child(conditions, NS.SAML2, 'AudienceRestriction'), NS.SAML2, 'Audience').textContent ===
      SP
  );
  const attributes = children(
    child(assertion, NS.SAML2, 'AttributeStatement'),
    NS.SAML2,
    'Attribute'
  );
  const mail = attributes.filter((attribute) => attribute.getAttribute('Name') === MAIL);
  check(mail.length === 1 && child(mail[0], NS.SAML2, 'AttributeValue').textContent === EMAIL);
}

/**
 * Runs genuine auth/SAML handlers inside the supplied runtime. The caller independently checks
 * persisted counters/session/audit side effects and repeats this after closing/reloading pools.
 * No response bodies, assertion XML, cookies, credential IDs or keys leave this function.
 */
export async function runSyntheticSamlLoginProbe(input: {
  runtime: AwsTenantRuntime;
  probe: SyntheticSamlLoginProbeConfig;
  counter: number;
}): Promise<SyntheticSamlLoginProbeReport> {
  let stage = 'configuration';
  try {
    const { runtime, probe, counter } = input;
    check(
      probe.issuer === ISSUER &&
        probe.tenantId === TENANT &&
        probe.spEntityId === SP &&
        probe.userId === USER &&
        runtime.origin === ISSUER &&
        runtime.tenantId === TENANT &&
        /^[a-f0-9]{64}$/u.test(probe.expectedCertificateDerSha256) &&
        /^[A-Za-z0-9_-]{43}$/u.test(probe.credential.id) &&
        probe.credential.privateJwk.kty === 'EC' &&
        probe.credential.privateJwk.crv === 'P-256' &&
        typeof probe.credential.privateJwk.d === 'string' &&
        Number.isSafeInteger(counter) &&
        counter >= 1 &&
        counter <= 0xffffffff
    );
    const { app } = createAwsSamlRuntime({ tenants: [runtime] });
    const context = { requestContext: { http: { sourceIp: '203.0.113.8' } } };
    const request = (path: string, init?: RequestInit) =>
      app.request(new URL(path, ISSUER).toString(), init, context);
    const post = (path: string, body: unknown, extraHeaders?: Record<string, string>) =>
      request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ISSUER, ...extraHeaders },
        body: JSON.stringify(body),
      });
    const json = async <T>(response: Response): Promise<T> => {
      check(response.status === 200);
      return (await response.json()) as T;
    };

    stage = 'metadata_certificate';
    const metadataResponse = await request('/saml/idp/metadata');
    check(metadataResponse.status === 200);
    const metadata = parseSAMLXml(await metadataResponse.text()).documentElement;
    check(metadata?.namespaceURI === NS.MD && metadata.localName === 'EntityDescriptor');
    check(metadata.getAttribute('entityID') === ENTITY);
    const descriptors = children(
      child(metadata, NS.MD, 'IDPSSODescriptor'),
      NS.MD,
      'KeyDescriptor'
    ).filter((descriptor) => descriptor.getAttribute('use') === 'signing');
    const matches = descriptors
      .map((descriptor) => {
        const cert = child(
          child(child(descriptor, NS.DS, 'KeyInfo'), NS.DS, 'X509Data'),
          NS.DS,
          'X509Certificate'
        );
        const der = fromBase64((cert.textContent ?? '').replace(/\s/gu, ''));
        const parsed = new X509Certificate(der);
        return {
          certificate: parsed.toString(),
          digest: createHash('sha256').update(parsed.raw).digest('hex'),
        };
      })
      .filter((cert) => cert.digest === probe.expectedCertificateDerSha256);
    check(matches.length === 1);
    const certificate = matches[0].certificate;

    stage = 'saml_request';
    const requestId = `_aws-probe-${randomUUID()}`;
    const authnRequest = `<samlp:AuthnRequest xmlns:samlp="${NS.SAML2P}" xmlns:saml="${NS.SAML2}" ID="${requestId}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${ISSUER}/saml/idp/sso" AssertionConsumerServiceURL="${ACS}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>${SP}</saml:Issuer></samlp:AuthnRequest>`;
    const sso = await request('/saml/idp/sso', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ SAMLRequest: btoa(authnRequest), RelayState: RELAY }).toString(),
    });
    check(sso.status === 302);
    const location = new URL(sso.headers.get('Location') ?? '');
    check(location.origin === ISSUER && location.pathname === '/login');
    const samlRequestId = location.searchParams.get('saml_request_id');
    check(samlRequestId);
    stage = 'interaction_start';
    const flow = await json<{
      interaction: { id: string; current_step_id: string };
      contract_hash: string;
      signature: string;
    }>(
      await post('/api/v1/login/interactions/start', {
        flow_kind: 'login',
        target_type: 'saml_sp',
        target_id: SP,
        saml_sp_id: SP,
        saml_request_id: samlRequestId,
        saml_sp_entity_id: SP,
        return_to: 'saml_sso',
      })
    );
    check(flow.interaction.current_step_id === 'auth:step');

    const start = async () => {
      const verifier = b64(webcrypto.getRandomValues(new Uint8Array(32)));
      const started = await json<{
        challenge_id: string;
        options: { challenge: string; rpId: string };
      }>(
        await post(
          '/api/v1/auth/direct/passkey/login/start',
          {
            client_id: 'login-ui',
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: 'S256',
            channel: 'browser',
          },
          { 'X-Authrim-Interaction-Id': flow.interaction.id }
        )
      );
      check(started.options.rpId === new URL(ISSUER).hostname);
      return { verifier, started };
    };
    for (const mode of ['bad-origin', 'bad-signature'] as const) {
      stage = mode;
      const { verifier, started } = await start();
      await rejected(
        await post('/api/v1/auth/direct/passkey/login/finish', {
          challenge_id: started.challenge_id,
          credential: await softwareAssertion(probe, started.options.challenge, counter, mode),
          code_verifier: verifier,
          channel: 'browser',
        })
      );
    }

    stage = 'passkey_login';
    const { verifier, started } = await start();
    const finishBody = {
      challenge_id: started.challenge_id,
      credential: await softwareAssertion(probe, started.options.challenge, counter, 'valid'),
      code_verifier: verifier,
      channel: 'browser',
    };
    const finished = await json<{ direct_auth_artifact: string }>(
      await post('/api/v1/auth/direct/passkey/login/finish', finishBody)
    );
    check(
      typeof finished.direct_auth_artifact === 'string' && finished.direct_auth_artifact.length > 0
    );
    stage = 'passkey_replay';
    await rejected(await post('/api/v1/auth/direct/passkey/login/finish', finishBody));
    stage = 'session';
    const session = await post('/api/v1/auth/direct/session', {
      direct_auth_artifact: finished.direct_auth_artifact,
      client_id: 'login-ui',
      code_verifier: verifier,
      channel: 'browser',
      defer_authorization_continuation: true,
    });
    check(session.status === 200);
    const cookie = session.headers.get('set-cookie')?.match(/authrim_session=[^;,]+/u)?.[0];
    check(cookie);
    stage = 'interaction_complete';
    const submit = async (stepId: string, nodeId: string, handle: string) =>
      json<{
        completed: boolean;
        step?: { component: string };
        output?: { protocol_continuation?: { protocol: string; saml_request_id: string } };
      }>(
        await post(
          `/api/v1/login/interactions/${encodeURIComponent(flow.interaction.id)}/submit`,
          {
            step_id: stepId,
            node_id: nodeId,
            selected_handle: handle,
            contract_hash: flow.contract_hash,
            signature: flow.signature,
          },
          { Cookie: cookie }
        )
      );
    const authStep = await submit('auth:step', 'auth', 'passkey');
    if (!authStep.completed) check(authStep.step?.component === 'completion');
    const complete = authStep.completed
      ? authStep
      : await submit('complete:step', 'complete', 'completed');
    check(complete.completed && complete.output?.protocol_continuation?.protocol === 'saml');
    check(complete.output.protocol_continuation.saml_request_id === samlRequestId);
    const resume = `/saml/idp/sso?${new URLSearchParams({
      saml_request_id: samlRequestId,
      saml_sp_entity_id: SP,
      return_to: 'saml_sso',
    })}`;
    stage = 'saml_response';
    const response = await request(resume, { headers: { Cookie: cookie } });
    check(response.status === 200);
    const html = await response.text();
    check(html.match(/<form\b[^>]*action="([^"]+)"/u)?.[1] === ACS);
    check(html.match(/name="RelayState"[^>]*value="([^"]+)"/u)?.[1] === RELAY);
    const encoded = html.match(/name="SAMLResponse"[^>]*value="([A-Za-z0-9+/=]+)"/u)?.[1];
    check(encoded);
    stage = 'signed_claims';
    verifyResponse(new TextDecoder().decode(fromBase64(encoded)), certificate, requestId);
    stage = 'saml_replay';
    await rejected(await request(resume, { headers: { Cookie: cookie } }));
    return {
      counter,
      certificateDerSha256: probe.expectedCertificateDerSha256,
      metadataCertificatePinned: true,
      signatureVerified: true,
      issuerVerified: true,
      audienceVerified: true,
      acsVerified: true,
      inResponseToVerified: true,
      nameIdVerified: true,
      attributeVerified: true,
      relayStateVerified: true,
      badSignatureRejected: true,
      badOriginRejected: true,
      passkeyReplayRejected: true,
      samlReplayRejected: true,
      replayRejected: true,
    };
  } catch {
    // Underlying library errors can contain XML, credential material or response bodies.
    throw new Error(`aws_synthetic_saml_probe_failed:${stage}`);
  }
}
