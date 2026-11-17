import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, exportPKCS8, generateKeyPair } from 'jose';
import { adminAuthMiddleware, RuleEvaluator } from '@authrim/ar-lib-core';
import { generateSelfSignedCertificate } from '@authrim/ar-saml/src/common/key-utils';
import { signXml } from '@authrim/ar-saml/src/common/signature';
import { handleSPACS } from '@authrim/ar-saml/src/sp/acs';
import { buildSAMLRequestBindingCookie } from '@authrim/ar-saml/src/sp/request-browser-binding';
import { handleExternalCallback } from '../../../ar-bridge/src/handlers/callback.ts';
import { getAuthStateCookieName } from '../../../ar-bridge/src/utils/state.ts';
import { decrypt, encrypt } from '../../../ar-bridge/src/utils/crypto.ts';
import {
  getConnectionInboundMapping,
  putConnectionInboundMapping,
  inboundMappingIdempotency,
} from '../connection-inbound-mapping';
import { enforceDeclaredAdminRouteAccess } from '../admin-route-access';
import { setupApp, signIn, TENANT, TENANT_SUPER_ADMIN } from './helpers/admin-authority-fixture';
import { openCoreStore } from './helpers/core-schema-sqlite';
import { insertSamlProvider } from './helpers/core-database';

// The protocols, mapping persistence/compiler/resolver/evaluator and identity handling are real.
// Only OP HTTP, request/replay stores and account/session delivery leave this local fixture.
const seams = vi.hoisted(() => ({
  http: vi.fn(),
  state: vi.fn(),
  provisionOIDC: vi.fn(),
  provisionSAML: vi.fn(),
  publishRoute: vi.fn(),
  accountLookup: vi.fn(),
  accountWrite: vi.fn(),
  customWrite: vi.fn(),
  session: vi.fn(),
  challenge: vi.fn(),
}));
vi.mock('@authrim/ar-lib-core', async (original) => {
  const actual = await original();
  return {
    ...actual,
    createAuthContextFromHono: (c) => ({ coreAdapter: c.env.DB_CORE }),
    resolveAuthCorePersistenceAdapterFromEnv: async (env) => env.DB_CORE,
    resolveTenantUserStoreSourcesFromEnv: async (env) => ({
      coreDb: env.TEST_ACCOUNT,
      piiDb: env.TEST_ACCOUNT,
    }),
    resolveTenantMetadataContext: async (env) => ({ coreDb: env.DB_CORE }),
    resolveCustomClaimRuntimeSourcesFromEnv: async (env) => ({
      schemaDb: env.DB_CORE,
      nonPiiDb: env.DB_CORE,
      piiDb: env.DB_CORE,
    }),
    resolveAccountDataContextByIdentifier: seams.accountLookup,
    persistCustomClaimWrite: seams.customWrite,
    syncUserLifecycleState: async () => undefined,
    getSessionStoreForNewSession: async () => ({
      sessionId: 'synthetic-session',
      stub: { fetch: seams.session },
    }),
    getChallengeStoreByChallengeId: async () => ({ storeChallengeRpc: seams.challenge }),
    safeFetch: seams.http,
    safeFetchJson: async (url) => (await seams.http(url)).json(),
    requireAdminStepUp: async () => null,
    createAuditLogFromContext: async () => undefined,
    createAuditLog: async () => undefined,
    publishEvent: async () => undefined,
    bumpAuthenticationMethodsCacheRevision: async () => undefined,
    createDiagnosticLoggerFromContext: async () => null,
    getUIConfig: async () => ({ baseUrl: 'https://authrim.example.test' }),
    readLiteModeAuthoritative: async () => 'off',
    readExternalProviderUsagePolicy: async () => ({ loginEnabled: true, signupEnabled: true }),
    checkEmailRegistration: async () => 'allowed',
    loadTenantRegistrationPolicy: async () => null,
    resolveProfiledSessionTtl: async () => ({ ttl: { seconds: 3600 }, snapshot: {} }),
    // Only the independent JIT policy store is controlled. Email trust checks remain real.
    resolveEffectiveSettings: async () => ({
      'external_idp.jit_provisioning_enabled': true,
      'external_idp.jit_require_verified_email': false,
      'external_idp.jit_allowed_provider_ids': '',
      'external_idp.jit_default_role_id': '',
      'external_idp.jit_join_all_matching_orgs': false,
      'external_idp.jit_allow_user_without_org': true,
      'external_idp.jit_allow_unverified_domain_mappings': false,
    }),
  };
});
vi.mock('../../../ar-bridge/src/utils/state.ts', async (original) => ({
  ...(await original()),
  consumeAuthState: seams.state,
}));

const { crypto, Response, URL, URLSearchParams, btoa } = globalThis;
const BASE = '/api/admin/identity-mapping/inbound';
const ISSUER = 'https://authrim.example.test';
const OP = 'https://identity.example.test';
const REQUEST_ID = `_${'a'.repeat(32)}`;
const STATE = 'synthetic-oidc-browser-state';
const NAMEID_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
const opened = [];
const pending = [];

beforeEach(() => {
  vi.clearAllMocks();
  // Fail every unexpected fetch locally, including a new protocol request not in the fixture.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected external network');
    })
  );
  seams.accountLookup.mockRejectedValue(new Error('account_data_route_not_found'));
  seams.accountWrite.mockResolvedValue({ success: true, rowsAffected: 1 });
  seams.customWrite.mockResolvedValue(undefined);
  seams.session.mockResolvedValue(Response.json({ success: true }));
  seams.challenge.mockResolvedValue(undefined);
  seams.provisionOIDC.mockResolvedValue({
    status: 202,
    userId: 'synthetic-user',
    accountId: 'account:synthetic-user',
    operationId: 'synthetic-operation',
  });
  seams.provisionSAML.mockResolvedValue({
    status: 201,
    userId: 'synthetic-user',
    accountId: 'account:synthetic-user',
  });
  seams.publishRoute.mockImplementation(async (input) => ({
    ...input,
    status: 201,
  }));
});
afterEach(async () => {
  await Promise.allSettled(pending.splice(0));
  for (const db of opened.splice(0)) db.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture(kind, emailSource = 'mail') {
  const core = openCoreStore(TENANT);
  const keys = await generateKeyPair('RS256', { extractable: true });
  const privateKey = await exportPKCS8(keys.privateKey);
  const certificate = await generateSelfSignedCertificate(
    await exportJWK(keys.publicKey),
    privateKey
  );
  const encryptionKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  core.db
    .prepare(
      `INSERT INTO custom_claim_schemas
    (id, tenant_id, field_key, active_field_key, display_label, field_type, is_pii, created_at, updated_at)
    VALUES ('department-schema', ?, 'department', 'department', 'Department', 'string', 1, 1, 1)`
    )
    .run(TENANT);
  const config = {
    entityId: OP,
    ssoUrl: `${OP}/sso`,
    certificate,
    nameIdFormat: NAMEID_FORMAT,
    attributeMapping: {},
    allowedBindings: ['post'],
    jitEmailLinkingPolicy: 'jit_create_only',
    allowSyntheticEmailFallback: false,
    profileUpdateFields: [],
  };
  insertSamlProvider(core.db, { tenantId: TENANT, id: 'idp', providerType: 'saml_idp', config });
  core.db
    .prepare(
      `INSERT INTO upstream_providers
    (id, tenant_id, name, provider_type, enabled, client_id, client_secret_encrypted, scopes,
    issuer, token_endpoint, userinfo_endpoint, jwks_uri, attribute_mapping, provider_quirks,
    auto_link_email, jit_provisioning, require_email_verified, created_at, updated_at)
    VALUES ('op', ?, 'Synthetic OP', 'oidc', 1, 'synthetic-client', ?, 'openid email profile',
    ?, ?, ?, ?, ?, '{}', 0, 1, 0, 1, 1)`
    )
    .run(
      TENANT,
      await encrypt('synthetic-secret', encryptionKey),
      OP,
      `${OP}/token`,
      `${OP}/userinfo`,
      `${OP}/jwks`,
      JSON.stringify({ name: 'stale_name', 'custom_claims.stale': 'stale_claim' })
    );
  const seenAssertions = new Set();
  const requestStore = {
    idFromName: () => 'synthetic-request-store',
    get: () => ({
      fetch: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.pathname.includes('/assertion/consume')) {
          const body = JSON.parse(init.body);
          const key = JSON.stringify(body);
          if (seenAssertions.has(key)) return Response.json({ success: false }, { status: 409 });
          seenAssertions.add(key);
          return Response.json({ success: true });
        }
        if (url.pathname.includes('/consume/'))
          return Response.json({
            requestId: REQUEST_ID,
            relayState: `${ISSUER}/`,
          });
        throw new Error(`Unexpected SAML store request: ${url.pathname}`);
      },
    }),
  };
  const env = {
    DB_CORE: core.adapter,
    DB: core.adapter,
    TEST_ACCOUNT: {
      ...core.adapter,
      queryOne: async () => null,
      query: async () => [],
      execute: seams.accountWrite,
    },
    AUTHRIM_CONFIG: { get: async () => null },
    SETTINGS: { get: async () => null },
    ISSUER_URL: ISSUER,
    UI_URL: ISSUER,
    RP_TOKEN_ENCRYPTION_KEY: encryptionKey,
    EMAIL_DOMAIN_HASH_SECRET: encryptionKey,
    ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL: 'false',
    SAML_REQUEST_STORE: requestStore,
    EXTERNAL_IDP_ACCOUNT_PROVISIONER: { provisionExternalIdpAccount: seams.provisionOIDC },
    SAML_ACCOUNT_PROVISIONER: {
      provisionAuthAccount: seams.provisionSAML,
      publishExternalIdpRoute: seams.publishRoute,
    },
  };
  let location = null;
  const t = setupApp((app) => {
    app.use('/api/admin/*', adminAuthMiddleware({ plane: 'tenant' }));
    app.use('/api/admin/identity-mapping/*', enforceDeclaredAdminRouteAccess());
    app.get(`${BASE}/:kind/:id`, getConnectionInboundMapping);
    app.put(`${BASE}/:kind/:id`, inboundMappingIdempotency, putConnectionInboundMapping);
    app.get('/auth/external/:provider/callback', async (c) => {
      const response = await handleExternalCallback(c);
      location = response.headers.get('location');
      return response;
    });
    // The normal fixture supplies JSON requests. This small transport adapter uses the real
    // Hono request/parser for ACS's bounded application/x-www-form-urlencoded POST instead.
    app.post('/protocol/saml', async (c) => {
      const { xml } = await c.req.json();
      const form = new URLSearchParams({ SAMLResponse: btoa(xml) });
      return app.request(
        `${ISSUER}/saml/sp/acs`,
        {
          method: 'POST',
          body: form,
          headers: { Cookie: buildSAMLRequestBindingCookie(REQUEST_ID, 300) },
        },
        c.env,
        { waitUntil: (work) => pending.push(work), passThroughOnException() {} }
      );
    });
    app.post('/saml/sp/acs', handleSPACS);
  }, env);
  opened.push(t.db, core.db);
  const cookie = signIn(t.db, TENANT_SUPER_ADMIN).cookie;
  const read = await t.call(cookie, 'GET', `${BASE}/${kind}/${kind}`);
  expect(read.status).toBe(200);
  const namespace = kind === 'op' ? 'oidc.userinfo' : 'saml.attribute';
  const rule = (path, targetNamespace, targetPath) => {
    const sourceRef = { side: 'source', namespace, path };
    const targetRef = { side: 'destination', namespace: targetNamespace, path: targetPath };
    return {
      ruleKey: targetPath,
      ruleKind: 'transform',
      action: 'allow',
      targetRef,
      edges: [{ sourceRef, targetRef }],
      transforms: [{ operation: 'trim', inputs: [{ edgeIndex: 0 }] }],
      output: { stepIndex: 0 },
    };
  };
  const saved = await t.call(
    cookie,
    'PUT',
    `${BASE}/${kind}/${kind}`,
    {
      revision: read.json.revision,
      sources: [emailSource, 'display', 'department'].map((path) => ({
        namespace,
        path,
        cardinality: 'single',
      })),
      rules: [
        rule(emailSource, 'authrim.profile', 'email'),
        rule('display', 'authrim.profile', 'name'),
        rule('department', 'authrim.custom_claims', 'department'),
      ],
    },
    { 'Idempotency-Key': crypto.randomUUID() }
  );
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  core.db.prepare("UPDATE identity_providers SET enabled=1 WHERE id='idp'").run();
  const call = (method, path, body, headers) => t.call('', method, path, body, headers);
  return {
    ...t,
    core,
    keys,
    privateKey,
    certificate,
    encryptionKey,
    call,
    get location() {
      return location;
    },
  };
}

async function oidcCallback(t, claims = {}, signingKey = t.keys.privateKey) {
  const idToken = await new SignJWT({
    nonce: 'synthetic-nonce',
    email: 'original@example.test',
    email_verified: true,
    mail: ' mapped@example.test ',
    display: ' Mapped Person ',
    department: ' Research ',
    stale_name: 'Stale Person',
    stale_claim: 'stale',
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
    .setIssuer(OP)
    .setAudience('synthetic-client')
    .setSubject('signed-provider-subject')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
  const jwk = await exportJWK(t.keys.publicKey);
  seams.http.mockImplementation(async (url) => {
    if (url === `${OP}/token`)
      return Response.json({
        access_token: 'synthetic-access',
        token_type: 'Bearer',
        id_token: idToken,
      });
    if (url === `${OP}/jwks`)
      return Response.json({ keys: [{ ...jwk, kid: 'synthetic-key', alg: 'RS256' }] });
    if (url === `${OP}/.well-known/openid-configuration`)
      return Response.json({
        issuer: OP,
        authorization_endpoint: `${OP}/authorize`,
        token_endpoint: `${OP}/token`,
        jwks_uri: `${OP}/jwks`,
        response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'],
        subject_types_supported: ['public'],
      });
    throw new Error(`Unexpected OP request: ${url}`);
  });
  seams.state.mockResolvedValue({
    id: 'synthetic-state',
    tenantId: TENANT,
    providerId: 'op',
    state: STATE,
    nonce: 'synthetic-nonce',
    codeVerifier: 'synthetic-verifier',
    codeChallenge: 'synthetic-challenge',
    clientId: 'synthetic-app',
    flowId: 'synthetic-flow',
    redirectUri: `${ISSUER}/callback`,
    createdAt: Date.now(),
    expiresAt: Date.now() + 300000,
    enableSso: false,
  });
  return t.call('GET', `/auth/external/op/callback?code=synthetic-code&state=${STATE}`, undefined, {
    Cookie: `${await getAuthStateCookieName(STATE)}=${STATE}`,
  });
}

function signedSAML(t) {
  const now = Date.now();
  const expiry = new Date(now + 300000).toISOString();
  // Same solicited bearer Response shape as acs-attempt-records, signed with a generated key.
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
    xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response" Version="2.0"
    IssueInstant="${new Date(now).toISOString()}" Destination="${ISSUER}/saml/sp/acs" InResponseTo="${REQUEST_ID}">
    <saml:Issuer>${OP}</saml:Issuer>
    <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
    <saml:Assertion ID="_assertion" Version="2.0" IssueInstant="${new Date(now).toISOString()}">
      <saml:Issuer>${OP}</saml:Issuer>
      <saml:Subject><saml:NameID Format="${NAMEID_FORMAT}">signed-nameid</saml:NameID>
        <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
          <saml:SubjectConfirmationData Recipient="${ISSUER}/saml/sp/acs" NotOnOrAfter="${expiry}" InResponseTo="${REQUEST_ID}"/>
        </saml:SubjectConfirmation></saml:Subject>
      <saml:Conditions NotBefore="${new Date(now - 60000).toISOString()}" NotOnOrAfter="${expiry}">
        <saml:AudienceRestriction><saml:Audience>${ISSUER}/saml/sp/metadata</saml:Audience></saml:AudienceRestriction>
      </saml:Conditions>
      <saml:AuthnStatement AuthnInstant="${new Date(now).toISOString()}"><saml:AuthnContext>
        <saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef>
      </saml:AuthnContext></saml:AuthnStatement>
      <saml:AttributeStatement>${[
        ['mail', ' mapped@example.test '],
        ['display', ' Mapped Person '],
        ['department', ' Research '],
      ]
        .map(
          ([name, value]) =>
            `<saml:Attribute Name="${name}"><saml:AttributeValue>${value}</saml:AttributeValue></saml:Attribute>`
        )
        .join('')}
      </saml:AttributeStatement>
    </saml:Assertion></samlp:Response>`;
  return signXml(xml, {
    privateKey: t.privateKey,
    certificate: t.certificate,
    referenceUri: '#_response',
  });
}

describe('saved connection-v1 mappings at signed protocol receiver boundaries', () => {
  it.each([
    ['remapped verified email', 'mail', true],
    ['unchanged unverified email', 'email', false],
    ['unchanged verified email', 'email', true],
  ])(
    'OIDC callback passes transformed claims to account persistence and preserves trust: %s',
    async (_, source, verified) => {
      const t = await fixture('op', source);
      const response = await oidcCallback(t, { email_verified: verified });
      expect(response.status, JSON.stringify(response.json)).toBe(302);
      expect(new URL(t.location).searchParams.get('provisioning_token')).toBeTruthy();
      expect(seams.provisionOIDC).toHaveBeenCalledTimes(1);
      const [request] = seams.provisionOIDC.mock.calls[0];
      expect(request).toMatchObject({
        tenantId: TENANT,
        externalSubject: { issuer: 'op', subject: 'signed-provider-subject' },
        runtimeUser: {
          displayName: 'Mapped Person',
          emailVerified: source === 'email' && verified,
        },
        externalIdentity: {
          providerUserId: 'signed-provider-subject',
          emailVerified: source === 'email' && verified,
        },
      });
      expect(JSON.parse(request.externalIdentity.rawClaimsJson)).toMatchObject({
        sub: 'signed-provider-subject',
        email: 'original@example.test',
        email_verified: verified,
        mail: ' mapped@example.test ',
        display: ' Mapped Person ',
        department: ' Research ',
        stale_name: 'Stale Person',
        stale_claim: 'stale',
      });
      const continuation = JSON.parse(
        await decrypt(seams.challenge.mock.calls[0][0].metadata.encrypted_payload, t.encryptionKey)
      );
      expect(continuation.userInfo).toEqual({
        sub: 'signed-provider-subject',
        email: source === 'mail' ? 'mapped@example.test' : 'original@example.test',
        email_verified: source === 'email' && verified,
        name: 'Mapped Person',
      });
      const plan = JSON.parse(
        await decrypt(request.externalIdentity.profileDataEncrypted, t.encryptionKey)
      );
      expect(plan.customClaimValidation.piiValues).toEqual({ department: 'Research' });
      expect(plan.customClaimValidation.nonPiiValues).toEqual({});
      expect(seams.challenge).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'external_idp_provisioning_resume' })
      );
      expect(seams.session).not.toHaveBeenCalled();
      expect(seams.http).toHaveBeenCalledWith(
        `${OP}/token`,
        expect.objectContaining({ method: 'POST' })
      );
      expect(seams.http).toHaveBeenCalledWith(`${OP}/jwks`);
    }
  );

  it.each(['blocked', 'allowed'])(
    'OIDC JIT policies see validated upstream groups before projection: %s',
    async (group) => {
      const t = await fixture('op');
      t.core.db
        .prepare(
          `INSERT INTO role_assignment_rules
        (id, tenant_id, name, role_id, conditions_json, actions_json, priority, created_at, updated_at)
        VALUES ('deny-blocked', ?, 'Deny blocked upstream group', '', ?, ?, 100, 1, 1)`
        )
        .run(
          TENANT,
          JSON.stringify({
            field: 'idp_claim',
            claim_path: 'groups',
            operator: 'contains',
            value: 'blocked',
          }),
          JSON.stringify([{ type: 'deny', deny_code: 'access_denied' }])
        );
      // A call-through spy inspects the policy boundary; the actual SQL-backed deny rule runs.
      const evaluate = vi.spyOn(RuleEvaluator.prototype, 'evaluate');
      const response = await oidcCallback(t, { groups: [group] });
      expect(response.status).toBe(302);
      expect(evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: TENANT,
          email_verified: false,
          idp_claims: expect.objectContaining({
            sub: 'signed-provider-subject',
            email: 'original@example.test',
            email_verified: true,
            display: ' Mapped Person ',
            groups: [group],
          }),
        })
      );
      expect(await evaluate.mock.results[0].value).toMatchObject({
        denied: group === 'blocked',
        matched_rules: group === 'blocked' ? ['deny-blocked'] : [],
      });
      if (group === 'blocked') {
        expect(new URL(t.location).searchParams.get('error')).toBe('policy_access_denied');
        expect(seams.provisionOIDC).not.toHaveBeenCalled();
        expect(seams.challenge).not.toHaveBeenCalled();
      } else {
        expect(new URL(t.location).searchParams.get('provisioning_token')).toBeTruthy();
        expect(seams.provisionOIDC).toHaveBeenCalledTimes(1);
        const [request] = seams.provisionOIDC.mock.calls[0];
        expect(request).toMatchObject({
          email: 'mapped@example.test',
          externalSubject: { issuer: 'op', subject: 'signed-provider-subject' },
          runtimeUser: { displayName: 'Mapped Person', emailVerified: false },
          externalIdentity: { providerEmail: 'mapped@example.test', emailVerified: false },
        });
        expect(JSON.parse(request.externalIdentity.rawClaimsJson)).toMatchObject({
          groups: ['allowed'],
          display: ' Mapped Person ',
        });
        const plan = JSON.parse(
          await decrypt(request.externalIdentity.profileDataEncrypted, t.encryptionKey)
        );
        expect(plan.customClaimValidation.piiValues).toEqual({ department: 'Research' });
        const continuation = JSON.parse(
          await decrypt(
            seams.challenge.mock.calls[0][0].metadata.encrypted_payload,
            t.encryptionKey
          )
        );
        expect(continuation.userInfo).toEqual({
          sub: 'signed-provider-subject',
          email: 'mapped@example.test',
          email_verified: false,
          name: 'Mapped Person',
        });
      }
      expect(seams.accountWrite).not.toHaveBeenCalled();
      expect(seams.customWrite).not.toHaveBeenCalled();
      expect(seams.session).not.toHaveBeenCalled();
    }
  );

  it.each(['mail', 'email'])(
    'OIDC verified-email policy refuses %s without account/session effects',
    async (source) => {
      const t = await fixture('op', source);
      t.core.db
        .prepare("UPDATE upstream_providers SET require_email_verified=1 WHERE id='op'")
        .run();
      const response = await oidcCallback(t, { email_verified: source === 'mail' });
      expect(response.status).toBe(302);
      expect(new URL(t.location).searchParams.get('error')).toBe('email_not_verified');
      expect(seams.provisionOIDC).not.toHaveBeenCalled();
      expect(seams.accountWrite).not.toHaveBeenCalled();
      expect(seams.challenge).not.toHaveBeenCalled();
      expect(seams.session).not.toHaveBeenCalled();
    }
  );

  it.each(['malformed', 'inactive', 'wrong-tenant', 'invalid-signature'])(
    'OIDC refuses %s before identity or session delivery',
    async (failure) => {
      const t = await fixture('op');
      if (failure === 'malformed')
        t.core.db
          .prepare(
            "UPDATE upstream_providers SET provider_quirks=json_set(provider_quirks, '$.inboundIdentityMapping', json('{}')) WHERE id='op'"
          )
          .run();
      if (failure === 'inactive')
        t.db.prepare("UPDATE field_mapping_activations SET lifecycle_state='inactive'").run();
      if (failure === 'wrong-tenant')
        t.db.prepare("UPDATE field_mapping_activations SET tenant_id='other-tenant'").run();
      const other = failure === 'invalid-signature' ? await generateKeyPair('RS256') : t.keys;
      const response = await oidcCallback(t, {}, other.privateKey);
      expect(response.status).toBe(302);
      expect(new URL(t.location).searchParams.get('error')).toBeTruthy();
      expect(seams.provisionOIDC).not.toHaveBeenCalled();
      expect(seams.provisionSAML).not.toHaveBeenCalled();
      expect(seams.accountLookup).not.toHaveBeenCalled();
      expect(seams.accountWrite).not.toHaveBeenCalled();
      expect(seams.challenge).not.toHaveBeenCalled();
      expect(seams.session).not.toHaveBeenCalled();
    }
  );

  it('SAML ACS verifies/parses the signed response, persists graph outputs and rejects its replay', async () => {
    const t = await fixture('idp');
    const account = {
      legacyUserId: 'synthetic-user',
      accountId: 'account:synthetic-user',
      coreDb: { ...t.core.adapter, execute: seams.accountWrite },
      piiDb: { ...t.core.adapter, execute: seams.accountWrite },
    };
    seams.accountLookup.mockImplementation(async () => {
      if (seams.provisionSAML.mock.calls.length === 0)
        throw new Error('account_data_route_not_found');
      return account;
    });
    const xml = signedSAML(t);
    const response = await t.call('POST', '/protocol/saml', { xml });
    expect(response.status, JSON.stringify(response.json)).toBe(302);
    expect(seams.provisionSAML).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        email: 'mapped@example.test',
        externalSubject: {
          issuer: OP,
          subject: `saml:${encodeURIComponent(NAMEID_FORMAT)}:signed-nameid`,
        },
        runtimeUser: {
          active: true,
          emailVerified: true,
          userType: 'end_user',
          displayName: 'Mapped Person',
          sourceRef: 'auth:saml',
          piiFields: { email: true, name: true },
          sensitiveValues: { email: 'mapped@example.test', name: 'Mapped Person' },
        },
      })
    );
    expect(seams.customWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        userId: 'synthetic-user',
        validation: expect.objectContaining({ piiValues: { department: 'Research' } }),
      })
    );
    expect(seams.accountWrite).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO linked_identities'),
      expect.arrayContaining([
        `saml:${encodeURIComponent(NAMEID_FORMAT)}:signed-nameid`,
        'mapped@example.test',
        'Mapped Person',
      ])
    );
    expect(seams.session).toHaveBeenCalledTimes(1);
    expect(JSON.parse(seams.session.mock.calls[0][1].body)).toMatchObject({
      tenantId: TENANT,
      userId: 'synthetic-user',
      data: { amr: ['saml'] },
    });
    const writes = seams.accountWrite.mock.calls.length;
    const replay = await t.call('POST', '/protocol/saml', { xml });
    expect(replay.status).toBe(400);
    expect(seams.provisionSAML).toHaveBeenCalledTimes(1);
    expect(seams.customWrite).toHaveBeenCalledTimes(1);
    expect(seams.accountWrite).toHaveBeenCalledTimes(writes);
    expect(seams.session).toHaveBeenCalledTimes(1);
  });

  it.each(['invalid-signature', 'inactive', 'wrong-tenant'])(
    'SAML refuses %s before identity or session effects',
    async (failure) => {
      const t = await fixture('idp');
      let xml = signedSAML(t);
      if (failure === 'invalid-signature') xml = xml.replace('signed-nameid', 'tampered-nameid');
      if (failure === 'inactive')
        t.db.prepare("UPDATE field_mapping_activations SET lifecycle_state='inactive'").run();
      if (failure === 'wrong-tenant')
        t.db.prepare("UPDATE field_mapping_activations SET tenant_id='other-tenant'").run();
      const response = await t.call('POST', '/protocol/saml', { xml });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(seams.provisionSAML).not.toHaveBeenCalled();
      expect(seams.accountLookup).not.toHaveBeenCalled();
      expect(seams.accountWrite).not.toHaveBeenCalled();
      expect(seams.customWrite).not.toHaveBeenCalled();
      expect(seams.publishRoute).not.toHaveBeenCalled();
      expect(seams.session).not.toHaveBeenCalled();
    }
  );
});
