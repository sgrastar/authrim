/** Exercises the actual AWS composition over isolated imported PostgreSQL copies. */
import { generateKeyPairSync, randomUUID, webcrypto } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { Client, Pool } from 'pg';
import { PostgresAdapter } from '../../../ar-lib-core/src/db/adapters/postgres-adapter';
import { renderPortableMigrationSql } from '../../../ar-lib-core/src/migrations/sql-portability';
import {
  createLookupBlindIndex,
  encodeCanonicalSensitiveValueRef,
  passkeyCredentialLookupSubject,
  type LookupIdentifierRow,
} from '@authrim/ar-lib-core';
import type { SAMLRuntimeImportedSPRelease } from '@authrim/ar-lib-core/types/saml-runtime-ports';
import { generateSelfSignedCertificate } from '../../../ar-saml/src/common/key-utils';
import { verifyXmlSignatureAndGetReferences } from '../../../ar-saml/src/common/signature';
import { SAML_NAMESPACES } from '../../../ar-saml/src/common/constants';
import { parseXml } from '../../../ar-saml/src/common/xml-utils';
import { extractSAMLResponseIds } from '../../../ar-saml/src/idp/signing';
import { createAwsSamlTenant } from '../bootstrap';
import { createAwsSamlRuntime } from '../http-runtime';
import { bootstrapFreshAwsRuntimeSchema } from '../import/aws-schema-bootstrap';
import { createPostgresAuditRuntimePorts } from '../storage/postgres-audit';
import { PostgresAccountAuthStateStore } from '../storage/postgres-account-auth-state';
import type { PostgresQueryClient } from '../storage/postgres-transient-state';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
const useBundledRuntime = process.env.AUTHRIM_AWS_TEST_BUNDLE === 'true';
const postgresIt = databaseUrl ? it : it.skip;
const SP = 'https://sp.example.test/entity';
const MAIL_ATTRIBUTE = 'urn:oid:0.9.2342.19200300.100.1.3';
const now = () => Date.now();
const lookupReadKey = { generation: 1, secret: 'lookup-secret-with-at-least-thirty-two-bytes' };

function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

function fromBase64url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/gu, '+').replace(/_/gu, '/'));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (part: Uint8Array) => {
    const bytes = Array.from(part);
    while (bytes.length > 1 && bytes[0] === 0) bytes.shift();
    if (bytes[0] & 0x80) bytes.unshift(0);
    return [2, bytes.length, ...bytes];
  };
  const content = [...integer(raw.slice(0, 32)), ...integer(raw.slice(32))];
  return new Uint8Array([0x30, content.length, ...content]);
}

async function softwarePasskey(tenantId: string) {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  if (!jwk.x || !jwk.y) throw new Error('passkey_coordinates_missing');
  const id = base64url(webcrypto.getRandomValues(new Uint8Array(32)));
  const publicKey = new Uint8Array([
    0xa5,
    1,
    2,
    3,
    0x26,
    0x20,
    1,
    0x21,
    0x58,
    32,
    ...fromBase64url(jwk.x),
    0x22,
    0x58,
    32,
    ...fromBase64url(jwk.y),
  ]);
  async function sign(challenge: string, origin: string, userId: string) {
    const rpId = new URL(origin).hostname;
    const clientData = new TextEncoder().encode(
      JSON.stringify({
        type: 'webauthn.get',
        challenge,
        origin,
        crossOrigin: false,
      })
    );
    const rpHash = new Uint8Array(
      await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId))
    );
    const authData = new Uint8Array([...rpHash, 5, 0, 0, 0, 1]);
    const clientHash = new Uint8Array(await webcrypto.subtle.digest('SHA-256', clientData));
    const rawSignature = new Uint8Array(
      await webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keys.privateKey,
        new Uint8Array([...authData, ...clientHash])
      )
    );
    return {
      id,
      rawId: id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: base64url(clientData),
        authenticatorData: base64url(authData),
        signature: base64url(derSignature(rawSignature)),
        userHandle: base64url(new TextEncoder().encode(userId)),
      },
      clientExtensionResults: {},
    };
  }
  return { id, publicKey, tenantId, sign };
}

async function lookupRow(
  tenantId: string,
  accountId: string,
  kind: 'account_id' | 'external_subject',
  identifier: string | { issuer: string; subject: string }
): Promise<LookupIdentifierRow> {
  const index = await createLookupBlindIndex(kind, identifier, lookupReadKey);
  const route = {
    schemaVersion: 1,
    accountRouteGeneration: 1,
    residencyPolicyId: 'default',
    targets: [
      {
        dataRole: 'tenant_core/users',
        residencyPartition: 'global',
        shardId: 'core-1',
        bindingRef: 'TEST_CORE',
        requiredBindingRouteGeneration: 1,
      },
      {
        dataRole: 'tenant_pii',
        residencyPartition: 'global',
        shardId: 'pii-1',
        bindingRef: 'TEST_PII',
        requiredBindingRouteGeneration: 1,
      },
    ],
  };
  return {
    virtual_bucket: index.virtualBucket,
    index_kind: index.indexKind,
    normalization_version: index.normalizationVersion,
    hmac_key_generation: index.hmacKeyGeneration,
    identifier_blind_digest: index.digest,
    tenant_id: tenantId,
    account_id: accountId,
    route_schema_version: 1,
    account_route_generation: 1,
    required_binding_route_generation: 1,
    residency_policy_id: 'default',
    route_projection_json: JSON.stringify(route),
    tenant_lifecycle_state: 'active',
    runtime_route_status: 'active',
    lifecycle_state: 'active',
  };
}

async function seedAccount(
  core: Client,
  pii: Client,
  tenantId: string,
  credential: Awaited<ReturnType<typeof softwarePasskey>>,
  origin: string
) {
  const createdAt = now();
  const userId = `user-${tenantId}`;
  const accountId = `account:${userId}`;
  const subjectId = `subject-${tenantId}`;
  await core.query(
    `INSERT INTO identity_subjects
       (id,tenant_id,subject_type,lifecycle_state,display_label,primary_account_id,created_at,updated_at)
     VALUES ($1,$2,'person','active',$3,$4,$5,$5)`,
    [subjectId, tenantId, `User ${tenantId}`, accountId, createdAt]
  );
  await core.query(
    `INSERT INTO identity_accounts
       (id,tenant_id,account_type,lifecycle_state,legacy_user_id,primary_subject_id,
        directory_publication_state,registration_state,created_at,updated_at)
     VALUES ($1,$2,'user','active',$3,$4,'active','registered',$5,$5)`,
    [accountId, tenantId, userId, subjectId, createdAt]
  );
  await core.query(
    `INSERT INTO passkeys
       (id,tenant_id,user_id,credential_id,public_key,counter,created_at,rp_id)
     VALUES ($1,$2,$3,$4,$5,0,$6,$7)`,
    [
      `passkey-${tenantId}`,
      tenantId,
      userId,
      credential.id,
      base64url(credential.publicKey),
      createdAt,
      new URL(origin).hostname,
    ]
  );
  await core.query(
    `INSERT INTO users_core (id,tenant_id,created_at,updated_at) VALUES ($1,$2,$3,$3)`,
    [userId, tenantId, createdAt]
  );
  await pii.query(
    `INSERT INTO users_pii (id,tenant_id,email,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$4)`,
    [userId, tenantId, `${userId}@example.test`, createdAt]
  );
  await pii.query(
    `INSERT INTO identity_sensitive_values
       (id,tenant_id,owner_type,owner_id,value_key,value_json,created_at,updated_at)
     VALUES ($1,$2,'runtime_user',$3,'email',$4::jsonb,$5,$5)`,
    [`sensitive-${tenantId}`, tenantId, userId, JSON.stringify(`${userId}@example.test`), createdAt]
  );
  await core.query(
    `INSERT INTO contact_points
       (id,tenant_id,subject_id,account_id,contact_type,value_storage_ref,is_primary,
        verification_state,lifecycle_state,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'email',$5,TRUE,'verified','active',$6,$6)`,
    [
      `contact-${tenantId}`,
      tenantId,
      subjectId,
      accountId,
      encodeCanonicalSensitiveValueRef({ tenantId, userId, field: 'email' }),
      createdAt,
    ]
  );
  const passkeySubject = passkeyCredentialLookupSubject({
    rpId: new URL(origin).hostname,
    credentialId: credential.id,
  });
  return {
    userId,
    accountId,
    createdAt,
    lookupRows: [
      await lookupRow(tenantId, accountId, 'account_id', accountId),
      await lookupRow(tenantId, accountId, 'external_subject', passkeySubject),
    ],
  };
}

function dbUrl(name: string): string {
  if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL required');
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function migrate(db: Client, directory: URL): Promise<void> {
  for (const file of (await readdir(directory))
    .filter((name) => /^\d+.*\.sql$/u.test(name))
    .sort()) {
    await db.query('SET search_path TO public');
    await db.query(
      renderPortableMigrationSql(await readFile(new URL(file, directory), 'utf8'), 'postgres')
    );
  }
  await db.query('SET search_path TO public');
}

async function signingBundle(tenantId: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const certificate = await generateSelfSignedCertificate(
    publicKey.export({ format: 'jwk' }),
    privateKeyPem
  );
  return {
    tenantId,
    keys: [
      { keyRef: `tenant:${tenantId}:saml:idp:signing`, kid: 'key-1', privateKeyPem, certificate },
    ],
  };
}

function settingsReader(tenantIds: string[]) {
  const values = new Map<string, string>();
  for (const tenantId of tenantIds) {
    values.set(
      `settings:tenant:${tenantId}:authentication-methods`,
      JSON.stringify({
        'authentication-methods.passkey.login_enabled': true,
        'authentication-methods.passkey.reauth_enabled': true,
        'authentication-methods.email_otp.login_enabled': false,
        'authentication-methods.email_otp.reauth_enabled': false,
        'authentication-methods.totp.login_enabled': false,
        'authentication-methods.totp.reauth_enabled': false,
        'authentication-methods.directory_password.enabled': false,
        'authentication-methods.guest.login_enabled': false,
        'authentication-methods.external_provider_usage': [],
      })
    );
  }
  return { get: async (key: string) => values.get(key) ?? null };
}

function importedMailRelease(tenantId: string, origin: string): SAMLRuntimeImportedSPRelease {
  const fieldMappingSetId = `mapping-set-${tenantId}`;
  const fieldMappingVersionId = `mapping-version-${tenantId}`;
  const destinationProfileId = `destination-profile-${tenantId}`;
  const destinationProfileVersionId = `destination-version-${tenantId}`;
  const sourceSelector = {
    fieldMappingSetId,
    fieldMappingVersionId,
    destinationProfileId,
    destinationFieldPolicies: { [MAIL_ATTRIBUTE]: 'required' as const },
  };
  return {
    tenantId,
    entityId: SP,
    sourceSelector,
    sourceBindingRef: {
      activationId: `activation-${tenantId}`,
      fieldMappingSetId,
      fieldMappingVersionId,
      mappingSnapshotHash: `snapshot-hash-${tenantId}`,
      destinationProfileId,
      destinationProfileVersionId,
    },
    binding: {
      id: `activation-${tenantId}`,
      role: 'idp',
      tenantId,
      localEntityId: `${origin}/saml/idp/metadata`,
      partnerEntityId: SP,
      fieldMappingSetId,
      fieldMappingVersionId,
      mappingSnapshotHash: `snapshot-hash-${tenantId}`,
      destinationProfileId,
      destinationProfileIds: [destinationProfileId],
      destinationFieldPolicies: sourceSelector.destinationFieldPolicies,
      catalog: {
        identity: {
          id: `catalog-${tenantId}`,
          version: '1',
          contentHash: `catalog-hash-${tenantId}`,
          compatibilityRange: '*',
        },
        entries: [
          {
            id: 'source.email',
            namespace: 'authrim.profile',
            path: 'email',
            valueType: 'string',
            cardinality: 'single',
            classification: 'pii',
            targetType: 'canonical',
          },
          {
            id: 'destination.mail',
            namespace: 'saml.attribute',
            path: MAIL_ATTRIBUTE,
            valueType: 'string',
            cardinality: 'single',
            classification: 'pii',
            targetType: 'destination-only',
          },
        ],
      },
      edges: [
        {
          id: `edge-mail-${tenantId}`,
          sourceRef: {
            side: 'source',
            namespace: 'authrim.profile',
            path: 'email',
            catalogEntryId: 'source.email',
          },
          targetRef: {
            side: 'destination',
            namespace: 'saml.attribute',
            path: MAIL_ATTRIBUTE,
            catalogEntryId: 'destination.mail',
          },
          edgeKind: 'direct',
        },
      ],
      transforms: [],
      validationRules: [],
      fieldMappingSet: { id: fieldMappingVersionId, rules: [] },
    },
    destinationProfile: {
      profileId: destinationProfileId,
      profileVersionId: destinationProfileVersionId,
      destinationType: 'saml',
      fields: [
        {
          key: MAIL_ATTRIBUTE,
          label: 'mail',
          required: false,
          nullable: false,
          classification: 'pii',
          surfaces: [],
          requiredScopes: [],
          valueType: 'string',
          valueMultiplicity: 'single',
          allowedValues: [],
        },
      ],
    },
  };
}

async function seedMetadata(core: Client, tenantId: string, origin: string): Promise<void> {
  const createdAt = now();
  await core.query(
    `INSERT INTO tenants (id, tenant_code, tenant_key, name, is_default, created_at, updated_at)
     VALUES ($1,$1,$1,$1,FALSE,$2,$2)`,
    [tenantId, createdAt]
  );
  await core.query(
    `INSERT INTO oauth_clients
       (tenant_id, client_id, client_name, redirect_uris, grant_types, response_types,
        application_type, allowed_channels, created_at, updated_at)
     VALUES ($1,'login-ui','Login UI','[]','["authorization_code"]','["code"]',
             'web','["browser"]',$2,$2)`,
    [tenantId, createdAt]
  );
  await core.query(
    `INSERT INTO web_origin_registry
       (id, tenant_id, client_id, origin, handoff_allowed, created_at, updated_at)
     VALUES ($1,$2,'login-ui',$3,1,$4,$4)`,
    [`origin-${tenantId}`, tenantId, origin, createdAt]
  );
  await core.query(
    `INSERT INTO identity_providers
       (id, tenant_id, name, provider_type, config_json, enabled, created_at, updated_at)
     VALUES ($1,$2,'SP','saml_sp',$3,1,$4,$4)`,
    [
      `provider-${tenantId}`,
      tenantId,
      JSON.stringify({
        entityId: SP,
        acsUrl: 'https://sp.example.test/acs',
        acsUrls: ['https://sp.example.test/acs'],
        allowedBindings: ['post'],
        authnRequestSignaturePolicy: 'optional',
        signResponses: true,
        signAssertions: false,
        identityMapping: importedMailRelease(tenantId, origin).sourceSelector,
      }),
      createdAt,
    ]
  );
  await core.query(
    `INSERT INTO client_trust_policies
       (id, tenant_id, name, display_name, target_type, target_id, trusted,
        skip_authorization_consent, is_active, created_at, updated_at)
     VALUES ($1,$2,'Imported SP','Imported SP','saml_sp',$3,1,1,1,$4,$4)`,
    [`trust-${tenantId}`, tenantId, SP, createdAt]
  );
  const flowId = `flow-${tenantId}`;
  const versionId = `version-${tenantId}`;
  const runtime = {
    flow_kind: 'login',
    ui: {
      steps: [
        {
          id: 'auth:step',
          source_node_id: 'auth',
          component: 'authentication_method_selector',
          render: true,
          config: { output_handles: ['passkey'] },
        },
        { id: 'complete:step', source_node_id: 'complete', component: 'completion', render: true },
      ],
    },
  };
  await core.query(
    `INSERT INTO flows
       (id, tenant_id, name, created_at, updated_at, status, published_version_id)
     VALUES ($1,$2,'SAML Passkey',$3,$3,'published',$4)`,
    [flowId, tenantId, createdAt, versionId]
  );
  await core.query(
    `INSERT INTO flow_versions
       (id, tenant_id, flow_id, version_number, schema_version, runtime_snapshot_json,
        validation_result_json, published_at, created_at)
     VALUES ($1,$2,$3,1,'1',$4,'{}',$5,$5)`,
    [versionId, tenantId, flowId, JSON.stringify(runtime), createdAt]
  );
  await core.query(
    `INSERT INTO flow_assignments
       (id, tenant_id, target_type, target_id, flow_kind, flow_id, enabled, created_at, updated_at)
     VALUES ($1,$2,'saml_sp',$3,'login',$4,TRUE,$5,$5)`,
    [`assignment-${tenantId}`, tenantId, SP, flowId, createdAt]
  );
}

// Includes loading the large built artifact and creating/migrating two disposable databases.
postgresIt(
  'runs two restored SAML passkey tenants through real AWS readiness',
  { timeout: 30_000 },
  async () => {
    if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL required');
    const factories = useBundledRuntime
      ? ((await import(new URL('../../dist/index.mjs', import.meta.url).href)) as unknown as {
          createAwsSamlTenant: typeof createAwsSamlTenant;
          createAwsSamlRuntime: typeof createAwsSamlRuntime;
        })
      : { createAwsSamlTenant, createAwsSamlRuntime };
    const externalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('aws_test_external_fetch_forbidden');
    });
    const suffix = randomUUID().replaceAll('-', '');
    const names = [`aws_e2e_core_${suffix}`, `aws_e2e_pii_${suffix}`];
    const admin = new Client({ connectionString: databaseUrl });
    const core = new Client({ connectionString: dbUrl(names[0]) });
    const pii = new Client({ connectionString: dbUrl(names[1]) });
    const coreRuntimePool = new Pool({ connectionString: dbUrl(names[0]), max: 4 });
    const piiRuntimePool = new Pool({ connectionString: dbUrl(names[1]), max: 4 });
    let adminConnected = false;
    let coreConnected = false;
    let piiConnected = false;
    let created = 0;
    try {
      await admin.connect();
      adminConnected = true;
      for (const name of names) {
        await admin.query(`CREATE DATABASE "${name}"`);
        created += 1;
      }
      await core.connect();
      coreConnected = true;
      await pii.connect();
      piiConnected = true;
      await migrate(core, new URL('../../../../migrations/core/postgresql/', import.meta.url));
      await migrate(pii, new URL('../../../../migrations/pii/postgresql/', import.meta.url));
      await bootstrapFreshAwsRuntimeSchema(core as unknown as PostgresQueryClient);
      const tenants = ['tenant-a', 'tenant-b'];
      const settings = settingsReader(tenants);
      const configuration = { get: async (_key: string) => null };
      const coreAdapter = new PostgresAdapter({
        connectionString: dbUrl(names[0]),
        clientFactory: () => coreRuntimePool as never,
      });
      const piiAdapter = new PostgresAdapter({
        connectionString: dbUrl(names[1]),
        clientFactory: () => piiRuntimePool as never,
      });
      const runtimeTenants = [];
      const passkeys = new Map<string, Awaited<ReturnType<typeof softwarePasskey>>>();
      const signingCertificates = new Map<string, string>();
      for (const tenantId of tenants) {
        const origin = `https://${tenantId}.example.test`;
        await seedMetadata(core, tenantId, origin);
        const passkey = await softwarePasskey(tenantId);
        passkeys.set(tenantId, passkey);
        const account = await seedAccount(core, pii, tenantId, passkey, origin);
        const bundle = await signingBundle(tenantId);
        signingCertificates.set(tenantId, bundle.keys[0].certificate);
        await new PostgresAccountAuthStateStore(
          coreRuntimePool as unknown as PostgresQueryClient
        ).initializeAccountStateRpc(
          tenantId,
          account.userId,
          account.accountId,
          'active',
          account.createdAt
        );
        runtimeTenants.push(
          factories.createAwsSamlTenant({
            tenantId,
            origin,
            environmentName: 'aws-e2e',
            inventory: {
              tenantId,
              allocationScope: 'shared_pool',
              metadataCoreDb: coreAdapter,
              accountCoreByBindingRef: { TEST_CORE: coreAdapter },
              accountPiiByBindingRef: { TEST_PII: piiAdapter },
              lookupRows: account.lookupRows,
              coreAccountRouteGenerations: { [account.accountId]: 1 },
              lookupReadKeys: [lookupReadKey],
            },
            stateDb: coreRuntimePool as unknown as PostgresQueryClient,
            auditPorts: createPostgresAuditRuntimePorts(
              coreRuntimePool as unknown as PostgresQueryClient,
              tenants
            ),
            settings,
            configuration,
            signingBundle: bundle,
            pairwiseSecret: {
              tenantId,
              secretRef: `tenant:${tenantId}:saml:pairwise-nameid`,
              active: { kid: 'salt-1', value: 'imported-secret', createdAt: 1234 },
              updatedAt: 1234,
            },
            spEntityIds: [SP],
            identityMappings: [importedMailRelease(tenantId, origin)],
            consentIpSalt: 'consent-salt-with-at-least-thirty-two-bytes',
            flowRuntimeHmacSecret: 'flow-secret-with-at-least-thirty-two-bytes',
            assertSnapshotReady: async () => undefined,
          })
        );
      }
      const runtime = factories.createAwsSamlRuntime({ tenants: runtimeTenants });
      for (const tenantId of tenants) {
        await runtimeTenants.find((item) => item.tenantId === tenantId)?.assertReady();
        const ready = await runtime.app.request(`https://${tenantId}.example.test/health/ready`);
        expect(ready.status).toBe(200);
        const origin = `https://${tenantId}.example.test`;
        const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${tenantId}-request" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${origin}/saml/idp/sso" AssertionConsumerServiceURL="https://sp.example.test/acs" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>${SP}</saml:Issuer></samlp:AuthnRequest>`;
        const response = await runtime.app.request(
          `${origin}/saml/idp/sso`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SAMLRequest: btoa(xml),
              RelayState: `relay-${tenantId}`,
            }).toString(),
          },
          { requestContext: { http: { sourceIp: '203.0.113.8' } } }
        );
        expect(response.status).toBe(302);
        const location = response.headers.get('Location');
        expect(location).toContain(`${origin}/login`);
        if (!location) throw new Error('saml_login_location_missing');
        const search = new URL(location).searchParams;
        const flowResponse = await runtime.app.request(
          `${origin}/api/v1/login/interactions/start`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: origin },
            body: JSON.stringify({
              flow_kind: 'login',
              target_type: 'saml_sp',
              target_id: SP,
              saml_sp_id: SP,
              saml_request_id: search.get('saml_request_id'),
              saml_sp_entity_id: SP,
              return_to: 'saml_sso',
            }),
          },
          { requestContext: { http: { sourceIp: '203.0.113.8' } } }
        );
        const flowText = await flowResponse.text();
        expect(flowResponse.status, flowText).toBe(200);
        const flow = JSON.parse(flowText) as {
          interaction: { id: string; current_step_id: string };
          contract_hash: string;
          signature: string;
          contract: { ui: { steps: Array<{ config?: unknown; content?: unknown }> } };
        };
        expect(flow.interaction.current_step_id).toBe('auth:step');
        expect(flow.contract.ui.steps[0]).toMatchObject({
          config: { output_handles: ['passkey'] },
          content: { authentication_profile: { id: 'default', output_handles: ['passkey'] } },
        });
        const verifier = base64url(webcrypto.getRandomValues(new Uint8Array(32)));
        const challenge = base64url(
          new Uint8Array(
            await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
          )
        );
        const passkeyStart = await runtime.app.request(
          `${origin}/api/v1/auth/direct/passkey/login/start`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: origin,
              'X-Authrim-Interaction-Id': flow.interaction.id,
            },
            body: JSON.stringify({
              client_id: 'login-ui',
              code_challenge: challenge,
              code_challenge_method: 'S256',
              channel: 'browser',
            }),
          },
          { requestContext: { http: { sourceIp: '203.0.113.8' } } }
        );
        const passkeyStartText = await passkeyStart.text();
        expect(passkeyStart.status, passkeyStartText).toBe(200);
        const start = JSON.parse(passkeyStartText) as {
          challenge_id: string;
          options: { challenge: string; rpId: string };
        };
        expect(start.options.rpId).toBe(new URL(origin).hostname);
        const credential = passkeys.get(tenantId);
        if (!credential) throw new Error('passkey_fixture_missing');
        const assertion = await credential.sign(
          start.options.challenge,
          origin,
          `user-${tenantId}`
        );
        const otherTenantId = tenantId === 'tenant-a' ? 'tenant-b' : 'tenant-a';
        const wrongTenantFinish = await runtime.app.request(
          `https://${otherTenantId}.example.test/api/v1/auth/direct/passkey/login/finish`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: `https://${otherTenantId}.example.test`,
            },
            body: JSON.stringify({
              challenge_id: start.challenge_id,
              credential: assertion,
              code_verifier: verifier,
              channel: 'browser',
            }),
          },
          { requestContext: { http: { sourceIp: '203.0.113.8' } } }
        );
        expect(wrongTenantFinish.status).not.toBe(200);
        await wrongTenantFinish.body?.cancel();
        const finishResponse = await runtime.app.request(
          `${origin}/api/v1/auth/direct/passkey/login/finish`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: origin },
            body: JSON.stringify({
              challenge_id: start.challenge_id,
              credential: assertion,
              code_verifier: verifier,
              channel: 'browser',
            }),
          },
          { requestContext: { http: { sourceIp: '203.0.113.8' } } }
        );
        const finishText = await finishResponse.text();
        expect(finishResponse.status, finishText).toBe(200);
        const finish = JSON.parse(finishText) as { direct_auth_artifact: string };
        const replayFinish = await runtime.app.request(
          `${origin}/api/v1/auth/direct/passkey/login/finish`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: origin },
            body: JSON.stringify({
              challenge_id: start.challenge_id,
              credential: assertion,
              code_verifier: verifier,
              channel: 'browser',
            }),
          },
          { requestContext: { http: { sourceIp: '203.0.113.8' } } }
        );
        expect(replayFinish.status).not.toBe(200);
        await replayFinish.body?.cancel();
        const sessionResponse = await runtime.app.request(
          `${origin}/api/v1/auth/direct/session`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: origin },
            body: JSON.stringify({
              direct_auth_artifact: finish.direct_auth_artifact,
              client_id: 'login-ui',
              code_verifier: verifier,
              channel: 'browser',
              defer_authorization_continuation: true,
            }),
          },
          { requestContext: { http: { sourceIp: '203.0.113.8' } } }
        );
        const sessionText = await sessionResponse.text();
        expect(sessionResponse.status, sessionText).toBe(200);
        const session = JSON.parse(sessionText) as { ok: boolean };
        expect(session.ok).toBe(true);
        const cookieHeader = sessionResponse.headers.get('set-cookie');
        const sessionCookie = cookieHeader?.match(/authrim_session=[^;,]+/u)?.[0] ?? '';
        expect(sessionCookie).toBeTruthy();
        if (!sessionCookie) throw new Error('managed_session_cookie_missing');
        async function submit(stepId: string, nodeId: string, handle: string) {
          const submitted = await runtime.app.request(
            `${origin}/api/v1/login/interactions/${encodeURIComponent(flow.interaction.id)}/submit`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Origin: origin,
                Cookie: sessionCookie,
              },
              body: JSON.stringify({
                step_id: stepId,
                node_id: nodeId,
                selected_handle: handle,
                contract_hash: flow.contract_hash,
                signature: flow.signature,
              }),
            },
            { requestContext: { http: { sourceIp: '203.0.113.8' } } }
          );
          const body = await submitted.text();
          expect(submitted.status, body).toBe(200);
          return JSON.parse(body) as {
            completed: boolean;
            step?: { id: string; source_node_id: string; component: string };
            output?: { protocol_continuation?: { protocol: string; saml_request_id: string } };
          };
        }
        const authStep = await submit('auth:step', 'auth', 'passkey');
        if (!authStep.completed) expect(authStep.step?.component).toBe('completion');
        const complete = authStep.completed
          ? authStep
          : await submit('complete:step', 'complete', 'completed');
        expect(complete.completed).toBe(true);
        expect(complete.output?.protocol_continuation?.protocol).toBe('saml');
        expect(complete.output?.protocol_continuation?.saml_request_id).toBe(
          search.get('saml_request_id')
        );
        const resume = new URL('/saml/idp/sso', origin);
        resume.searchParams.set('saml_request_id', search.get('saml_request_id') ?? '');
        resume.searchParams.set('saml_sp_entity_id', SP);
        resume.searchParams.set('return_to', 'saml_sso');
        const samlResponse = await runtime.app.request(
          resume.toString(),
          { headers: { Cookie: sessionCookie } },
          { requestContext: { http: { sourceIp: '203.0.113.8' } } }
        );
        const html = await samlResponse.text();
        expect(samlResponse.status, html).toBe(200);
        const encoded = html.match(/name="SAMLResponse"[^>]*value="([^"]+)"/u)?.[1];
        expect(encoded).toBeTruthy();
        if (!encoded) throw new Error('saml_response_missing');
        const signedXml = new TextDecoder().decode(
          fromBase64url(encoded.replace(/\+/gu, '-').replace(/\//gu, '_'))
        );
        const certificate = signingCertificates.get(tenantId);
        if (!certificate) throw new Error('saml_certificate_missing');
        const responseId = extractSAMLResponseIds(signedXml).responseId;
        const references = verifyXmlSignatureAndGetReferences(signedXml, {
          certificateOrKey: certificate,
          expectedId: responseId,
          strictXswProtection: true,
        });
        expect(references.some((reference) => reference.uri === `#${responseId}`)).toBe(true);
        expect(signedXml).toContain(`InResponseTo="_${tenantId}-request"`);
        expect(signedXml).toContain('Destination="https://sp.example.test/acs"');
        expect(signedXml).toContain(`<saml:Audience>${SP}</saml:Audience>`);
        expect(signedXml).toContain(`user-${tenantId}@example.test`);
        expect(signedXml).not.toContain(`user-${otherTenantId}@example.test`);
        const attributes = parseXml(signedXml).getElementsByTagNameNS(
          SAML_NAMESPACES.SAML2,
          'Attribute'
        );
        const mailValues: string[] = [];
        for (let attributeIndex = 0; attributeIndex < attributes.length; attributeIndex += 1) {
          const attribute = attributes.item(attributeIndex);
          if (attribute?.getAttribute('Name') !== MAIL_ATTRIBUTE) continue;
          const values = attribute.getElementsByTagNameNS(SAML_NAMESPACES.SAML2, 'AttributeValue');
          for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
            const value = values.item(valueIndex)?.textContent;
            if (value) mailValues.push(value);
          }
        }
        expect(mailValues).toEqual([`user-${tenantId}@example.test`]);
        const wrongCertificate = signingCertificates.get(otherTenantId);
        if (!wrongCertificate) throw new Error('other_saml_certificate_missing');
        expect(() =>
          verifyXmlSignatureAndGetReferences(signedXml, {
            certificateOrKey: wrongCertificate,
            expectedId: responseId,
            strictXswProtection: true,
          })
        ).toThrow();
      }
      expect(externalFetch).not.toHaveBeenCalled();
    } finally {
      externalFetch.mockRestore();
      await piiRuntimePool.end();
      await coreRuntimePool.end();
      if (piiConnected) await pii.end();
      if (coreConnected) await core.end();
      for (const name of names.slice(0, created).reverse())
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      if (adminConnected) await admin.end();
    }
  }
);
