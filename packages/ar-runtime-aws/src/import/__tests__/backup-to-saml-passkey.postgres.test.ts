/** Encrypted source backup through the offline restore coordinator and real SAML handlers. */
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { createDynamoStateClient, DynamoStateTable } from '../../storage/dynamodb-state';
import type { AwsAuthStateDependencies } from '../selected-auth-state';
import { expect, it, vi } from 'vitest';
import { verifyXmlSignatureAndGetReferences } from '../../../../ar-saml/src/common/signature';
import { extractSAMLResponseIds } from '../../../../ar-saml/src/idp/signing';
import { createAwsSamlRuntime } from '../../http-runtime';
import { loadActivatedAwsSamlTenant } from '../../startup/load-activated-tenant';
import { restoreEvidenceDigest } from '../restore-evidence';
import type { AwsRuntimeUiConfig } from '../../ui/runtime-ui-config';
import {
  restoreOfflineAwsSamlTenant,
  type RestoreOfflineAwsSamlTenantInput,
} from '../restore-offline';
import {
  TENANT,
  ORIGIN,
  SP,
  base64url,
  fromBase64url,
  migrate,
  softwarePasskey,
  sourceSigningBundle,
  seedSource,
  buildBackupFiles,
} from '../../rehearsal/synthetic-fixture';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
const useBundledRuntime = process.env.AUTHRIM_AWS_TEST_BUNDLE === 'true';
const postgresIt = databaseUrl ? it : it.skip;
const useDynamo = process.env.AUTHRIM_AWS_TEST_AUTH_STATE === 'dynamodb';
const dynamoEndpoint = process.env.AUTHRIM_AWS_TEST_DYNAMODB_ENDPOINT;

function urlFor(name: string): string {
  if (!databaseUrl) throw new Error('test_database_missing');
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

postgresIt.each(['legacy', 'external', 'disabled'] as const)(
  `restores encrypted backup and issues a signed SAML response with %s UI on ${useDynamo ? 'DynamoDB' : 'PostgreSQL'} after a real passkey login`,
  { timeout: 120_000 },
  async (uiMode) => {
    const browserOrigin = uiMode === 'external' ? `${ORIGIN}:8443` : ORIGIN;
    const destinationUi: AwsRuntimeUiConfig | undefined =
      uiMode === 'external'
        ? {
            components: { loginUi: false, adminUi: false },
            ui: {
              login: {
                mode: 'external',
                baseUrl: browserOrigin,
                clientId: 'login-ui',
                paths: { login: '/login', reauth: '/reauth' },
              },
              admin: { mode: 'disabled' },
            },
          }
        : uiMode === 'disabled'
          ? {
              components: { loginUi: false, adminUi: false },
              ui: {
                login: { mode: 'disabled' },
                admin: { mode: 'external', baseUrl: 'https://admin.example.test' },
              },
            }
          : undefined;
    if (!databaseUrl) throw new Error('test_database_missing');
    const suffix = randomUUID().replaceAll('-', '');
    const names = {
      sourceCore: `aws_src_core_${suffix}`,
      sourcePii: `aws_src_pii_${suffix}`,
      core: `aws_dst_core_${suffix}`,
      pii: `aws_dst_pii_${suffix}`,
      state: `aws_dst_state_${suffix}`,
    };
    const admin = new Client({ connectionString: databaseUrl });
    const connections = Object.fromEntries(
      Object.entries(names).map(([role, name]) => [
        role,
        new Client({ connectionString: urlFor(name) }),
      ])
    ) as Record<keyof typeof names, Client>;
    let adminConnected = false;
    const connected: Client[] = [];
    let created: string[] = [];
    let restored: Awaited<ReturnType<typeof restoreOfflineAwsSamlTenant>> | null = null;
    let restarted: Awaited<ReturnType<typeof loadActivatedAwsSamlTenant>> | null = null;
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'authrim-aws-backup-e2e-'));
    const baseFactories = useBundledRuntime
      ? ((await import(new URL('../../../dist/index.mjs', import.meta.url).href)) as unknown as {
          restoreOfflineAwsSamlTenant: typeof restoreOfflineAwsSamlTenant;
          loadActivatedAwsSamlTenant: typeof loadActivatedAwsSamlTenant;
          createAwsSamlRuntime: typeof createAwsSamlRuntime;
        })
      : { restoreOfflineAwsSamlTenant, loadActivatedAwsSamlTenant, createAwsSamlRuntime };
    const restoreId = randomUUID();
    const tableName = `authrim-e2e-${suffix}`;
    let tableArn = '';
    let tableCreated = false;
    if (useDynamo && (!dynamoEndpoint || useBundledRuntime))
      throw new Error('DynamoDB local source test requires an explicit local endpoint');
    const makeClient = () => {
      const client = createDynamoStateClient({
        region: 'ap-northeast-1',
        endpoint: dynamoEndpoint,
        credentials: { accessKeyId: 'localtest', secretAccessKey: 'localtest' },
      });
      const send = client.send.bind(client);
      // DynamoDB Local uses a synthetic region in DescribeTable metadata only.
      vi.spyOn(client, 'send').mockImplementation((async (command: unknown) => {
        const result = await send(command as never);
        if (command instanceof DescribeTableCommand && 'Table' in result && result.Table)
          result.Table.TableArn = tableArn;
        return result;
      }) as never);
      return client;
    };
    const dynamoAdmin = useDynamo ? makeClient() : undefined;
    const dependencies: AwsAuthStateDependencies = useDynamo
      ? { createDynamoClient: makeClient }
      : {};
    const factories = {
      ...baseFactories,
      restoreOfflineAwsSamlTenant: (input: RestoreOfflineAwsSamlTenantInput) =>
        baseFactories.restoreOfflineAwsSamlTenant(input, dependencies),
      loadActivatedAwsSamlTenant: (input: Parameters<typeof loadActivatedAwsSamlTenant>[0]) =>
        baseFactories.loadActivatedAwsSamlTenant(input, dependencies),
    };
    const authorityCounters = async () => {
      if (!dynamoAdmin)
        return (
          await connections.state.query<{ counter: string }>(
            'SELECT counter FROM authrim_aws_passkey_counters WHERE tenant_id=$1',
            [TENANT]
          )
        ).rows;
      const empty = await connections.state.query('SELECT * FROM authrim_aws_passkey_counters');
      expect(empty.rows).toEqual([]); // SQL audit storage must never become a second auth authority.
      const table = new DynamoStateTable({ client: dynamoAdmin, tableName, namespace: restoreId });
      const row = await dynamoAdmin.send(
        new GetItemCommand({
          TableName: tableName,
          ConsistentRead: true,
          Key: {
            ...table.accountKey(TENANT, 'user-tenant-a'),
            sk: { S: `COUNTER#${createHash('sha256').update('passkey-a').digest('hex')}` },
          },
        })
      );
      return row.Item ? [{ counter: row.Item.counter.N }] : [];
    };
    const externalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('aws_test_external_fetch_forbidden');
    });
    try {
      if (dynamoAdmin) {
        const table = await dynamoAdmin.send(
          new CreateTableCommand({
            TableName: tableName,
            BillingMode: 'PAY_PER_REQUEST',
            AttributeDefinitions: [
              { AttributeName: 'pk', AttributeType: 'S' },
              { AttributeName: 'sk', AttributeType: 'S' },
            ],
            KeySchema: [
              { AttributeName: 'pk', KeyType: 'HASH' },
              { AttributeName: 'sk', KeyType: 'RANGE' },
            ],
          })
        );
        tableCreated = true;
        tableArn =
          table.TableDescription?.TableArn?.replace(':ddblocal:', ':ap-northeast-1:') ?? '';
      }
      await admin.connect();
      adminConnected = true;
      for (const name of Object.values(names)) {
        await admin.query(`CREATE DATABASE "${name}"`);
        created.push(name);
      }
      for (const client of Object.values(connections)) {
        await client.connect();
        connected.push(client);
      }
      await migrate(
        connections.sourceCore,
        new URL('../../../../../migrations/core/postgresql/', import.meta.url)
      );
      await migrate(
        connections.sourcePii,
        new URL('../../../../../migrations/pii/postgresql/', import.meta.url)
      );
      await migrate(
        connections.core,
        new URL('../../../../../migrations/core/postgresql/', import.meta.url)
      );
      await migrate(
        connections.pii,
        new URL('../../../../../migrations/pii/postgresql/', import.meta.url)
      );
      const credential = await softwarePasskey();
      await seedSource(connections.sourceCore, connections.sourcePii, credential);
      const signing = await sourceSigningBundle();
      if (uiMode === 'external') {
        signing.bundle.settings.interactiveLoginUrlPolicy = 'ui_base_url';
        await connections.sourceCore.query(
          'UPDATE web_origin_registry SET origin=$1 WHERE tenant_id=$2',
          [browserOrigin, TENANT]
        );
      }
      if (uiMode === 'disabled') {
        await connections.sourceCore.query('DELETE FROM web_origin_registry WHERE tenant_id=$1', [
          TENANT,
        ]);
        await connections.sourceCore.query(
          "DELETE FROM oauth_clients WHERE tenant_id=$1 AND client_id='login-ui'",
          [TENANT]
        );
      }
      const files = await buildBackupFiles({
        sourceCore: connections.sourceCore,
        sourcePii: connections.sourcePii,
        signing,
        credential,
        directory,
        ...(uiMode === 'disabled'
          ? { sourceLoginUi: { mode: 'disabled' as const }, sourceFlowRuntimeEnabled: false }
          : {}),
      });
      const coreTargetId = randomUUID();
      const piiTargetId = randomUUID();
      const restoreInput: RestoreOfflineAwsSamlTenantInput = {
        backup: files.backup,
        supplement: files.supplement,
        restoreId,
        ...(useDynamo
          ? {
              authState: {
                backend: 'dynamodb' as const,
                region: 'ap-northeast-1',
                tableArn,
                namespace: restoreId,
              },
            }
          : {}),
        core: {
          connectionString: urlFor(names.core),
          targetId: coreTargetId,
          bindingRefs: ['TEST_CORE'],
        },
        pii: {
          connectionString: urlFor(names.pii),
          targetId: piiTargetId,
          bindingRefs: ['TEST_PII'],
        },
        state: { connectionString: urlFor(names.state), initializeEmptySchema: true },
        environmentName: 'aws-backup-e2e',
        ...(destinationUi === undefined ? {} : { destinationUi }),
        spEntityIds: [SP],
        allocationScope: 'shared_pool',
        awsFlowRuntimeHmacSecret: 'aws-flow-hmac-with-at-least-thirty-two-bytes',
        awsLookupReadKeys: [
          { generation: 1, secret: 'aws-lookup-hmac-with-at-least-thirty-two-bytes' },
        ],
      };
      restored = await factories.restoreOfflineAwsSamlTenant(restoreInput);
      expect(restored.evidence.tenantId).toBe(TENANT);
      const runtime = factories.createAwsSamlRuntime({ tenants: [restored.runtime] });
      const ready = await runtime.app.request(`${ORIGIN}/health/ready`);
      expect(ready.status, await ready.text()).toBe(200);
      const context = { requestContext: { http: { sourceIp: '203.0.113.8' } } };
      if (uiMode === 'external') {
        expect((await runtime.app.request(`${ORIGIN}/login`)).status).toBe(404);
        const preflight = await runtime.app.request(
          `${ORIGIN}/api/v1/auth/direct/passkey/login/start`,
          {
            method: 'OPTIONS',
            headers: {
              Origin: browserOrigin,
              'Access-Control-Request-Method': 'POST',
              'Access-Control-Request-Headers': 'Content-Type,X-Authrim-Interaction-Id',
            },
          },
          context
        );
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-origin')).toBe(browserOrigin);
        expect(preflight.headers.get('access-control-allow-headers')).toContain(
          'X-Authrim-Interaction-Id'
        );
        const denied = await runtime.app.request(
          `${ORIGIN}/api/v1/auth/direct/passkey/login/start`,
          {
            method: 'OPTIONS',
            headers: {
              Origin: 'https://evil.example.test',
              'Access-Control-Request-Method': 'POST',
            },
          },
          context
        );
        expect(denied.headers.get('access-control-allow-origin')).toBeNull();
      }
      if (uiMode === 'disabled') {
        for (const path of [
          '/login',
          '/reauth',
          '/admin',
          '/api/v1/auth/direct/passkey/login/start',
        ]) {
          expect((await runtime.app.request(`${ORIGIN}${path}`)).status).toBe(404);
        }
        expect(
          (
            await connections.core.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM oauth_clients WHERE tenant_id=$1 AND client_id='login-ui'",
              [TENANT]
            )
          ).rows[0].count
        ).toBe(0);
        const evidence = restored.evidence;
        await restored.close();
        restored = null;
        const reload = {
          ...restoreInput,
          evidence,
          state: { connectionString: urlFor(names.state) },
        };
        await expect(
          factories.loadActivatedAwsSamlTenant({ ...reload, destinationUi: undefined })
        ).rejects.toThrow('aws_activated_runtime_load_failed');
        restarted = await factories.loadActivatedAwsSamlTenant(reload);
        expect(restarted.runtime.ui).toEqual(destinationUi);
        const after = factories.createAwsSamlRuntime({ tenants: [restarted.runtime] });
        expect((await after.app.request(`${ORIGIN}/health/ready`)).status).toBe(200);
        expect((await after.app.request(`${ORIGIN}/login`)).status).toBe(404);
        expect(externalFetch).not.toHaveBeenCalled();
        return;
      }
      const requestId = `_backup-${randomUUID()}`;
      const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${requestId}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${ORIGIN}/saml/idp/sso" AssertionConsumerServiceURL="https://sp.example.test/acs" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>${SP}</saml:Issuer></samlp:AuthnRequest>`;
      const sso = await runtime.app.request(
        `${ORIGIN}/saml/idp/sso`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SAMLRequest: btoa(xml),
            RelayState: 'source-relay',
          }).toString(),
        },
        context
      );
      expect(sso.status).toBe(302);
      const location = sso.headers.get('Location');
      expect(location).toContain(`${browserOrigin}/login`);
      if (!location) throw new Error('missing_login_location');
      const samlRequestId = new URL(location).searchParams.get('saml_request_id');
      expect(samlRequestId).toBeTruthy();
      const flowResponse = await runtime.app.request(
        `${ORIGIN}/api/v1/login/interactions/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: browserOrigin },
          body: JSON.stringify({
            flow_kind: 'login',
            target_type: 'saml_sp',
            target_id: SP,
            saml_sp_id: SP,
            saml_request_id: samlRequestId,
            saml_sp_entity_id: SP,
            return_to: 'saml_sso',
          }),
        },
        context
      );
      const flowText = await flowResponse.text();
      expect(flowResponse.status, flowText).toBe(200);
      const flow = JSON.parse(flowText) as {
        interaction: { id: string; current_step_id: string };
        contract_hash: string;
        signature: string;
      };
      expect(flow.interaction.current_step_id).toBe('auth:step');
      const verifier = base64url(webcrypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64url(
        new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
      );
      const passkeyStart = await runtime.app.request(
        `${ORIGIN}/api/v1/auth/direct/passkey/login/start`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: browserOrigin,
            'X-Authrim-Interaction-Id': flow.interaction.id,
          },
          body: JSON.stringify({
            client_id: 'login-ui',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            channel: 'browser',
          }),
        },
        context
      );
      const passkeyStartText = await passkeyStart.text();
      expect(passkeyStart.status, passkeyStartText).toBe(200);
      const started = JSON.parse(passkeyStartText) as {
        challenge_id: string;
        options: { challenge: string; rpId: string };
      };
      expect(started.options.rpId).toBe(new URL(ORIGIN).hostname);
      const assertion = await credential.sign(
        started.options.challenge,
        'user-tenant-a',
        1,
        browserOrigin
      );
      const passkeyFinish = await runtime.app.request(
        `${ORIGIN}/api/v1/auth/direct/passkey/login/finish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: browserOrigin },
          body: JSON.stringify({
            challenge_id: started.challenge_id,
            credential: assertion,
            code_verifier: verifier,
            channel: 'browser',
          }),
        },
        context
      );
      const passkeyFinishText = await passkeyFinish.text();
      expect(passkeyFinish.status, passkeyFinishText).toBe(200);
      const finished = JSON.parse(passkeyFinishText) as { direct_auth_artifact: string };
      const sessionResponse = await runtime.app.request(
        `${ORIGIN}/api/v1/auth/direct/session`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: browserOrigin },
          body: JSON.stringify({
            direct_auth_artifact: finished.direct_auth_artifact,
            client_id: 'login-ui',
            code_verifier: verifier,
            channel: 'browser',
            defer_authorization_continuation: true,
          }),
        },
        context
      );
      const sessionText = await sessionResponse.text();
      expect(sessionResponse.status, sessionText).toBe(200);
      const cookie = sessionResponse.headers
        .get('set-cookie')
        ?.match(/authrim_session=[^;,]+/u)?.[0];
      expect(cookie).toBeTruthy();
      if (!cookie) throw new Error('managed_session_cookie_missing');
      const sessionCookie = cookie;
      async function submit(stepId: string, nodeId: string, handle: string) {
        const response = await runtime.app.request(
          `${ORIGIN}/api/v1/login/interactions/${encodeURIComponent(flow.interaction.id)}/submit`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: browserOrigin,
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
          context
        );
        const body = await response.text();
        expect(response.status, body).toBe(200);
        return JSON.parse(body) as {
          completed: boolean;
          step?: { component: string };
          output?: { protocol_continuation?: { protocol: string; saml_request_id: string } };
        };
      }
      const authStep = await submit('auth:step', 'auth', 'passkey');
      if (!authStep.completed) expect(authStep.step?.component).toBe('completion');
      const complete = authStep.completed
        ? authStep
        : await submit('complete:step', 'complete', 'completed');
      expect(complete.output?.protocol_continuation).toMatchObject({
        protocol: 'saml',
        saml_request_id: samlRequestId,
      });
      const resume = new URL('/saml/idp/sso', ORIGIN);
      resume.searchParams.set('saml_request_id', samlRequestId ?? '');
      resume.searchParams.set('saml_sp_entity_id', SP);
      resume.searchParams.set('return_to', 'saml_sso');
      const response = await runtime.app.request(
        resume.toString(),
        { headers: { Cookie: cookie } },
        context
      );
      const html = await response.text();
      expect(response.status, html).toBe(200);
      const encoded = html.match(/name="SAMLResponse"[^>]*value="([^"]+)"/u)?.[1];
      expect(encoded).toBeTruthy();
      if (!encoded) throw new Error('saml_response_missing');
      const signedXml = new TextDecoder().decode(
        fromBase64url(encoded.replace(/\+/gu, '-').replace(/\//gu, '_'))
      );
      const responseId = extractSAMLResponseIds(signedXml).responseId;
      expect(
        verifyXmlSignatureAndGetReferences(signedXml, {
          certificateOrKey: signing.certificate,
          expectedId: responseId,
          strictXswProtection: true,
        }).some((reference) => reference.uri === `#${responseId}`)
      ).toBe(true);
      expect(signedXml).toContain(`InResponseTo="${requestId}"`);
      expect(signedXml).toContain(`<saml:Audience>${SP}</saml:Audience>`);
      expect(signedXml).toContain('user-tenant-a@example.test');
      expect(externalFetch).not.toHaveBeenCalled();

      // A cold start reads the active receipt and verified inputs; it never imports rows again.
      const evidence = restored.evidence;
      await restored.close();
      restored = null;
      const loadInput = {
        backup: files.backup,
        supplement: files.supplement,
        evidence,
        core: {
          connectionString: urlFor(names.core),
          targetId: coreTargetId,
          bindingRefs: ['TEST_CORE'],
        },
        pii: {
          connectionString: urlFor(names.pii),
          targetId: piiTargetId,
          bindingRefs: ['TEST_PII'],
        },
        state: { connectionString: urlFor(names.state) },
        ...(restoreInput.authState ? { authState: restoreInput.authState } : {}),
        environmentName: 'aws-backup-e2e',
        ...(destinationUi === undefined ? {} : { destinationUi }),
        spEntityIds: [SP],
        allocationScope: 'shared_pool' as const,
        awsFlowRuntimeHmacSecret: 'aws-flow-hmac-with-at-least-thirty-two-bytes',
        awsLookupReadKeys: [
          { generation: 1, secret: 'aws-lookup-hmac-with-at-least-thirty-two-bytes' },
        ],
      };
      if (useDynamo) {
        if (restoreInput.authState?.backend !== 'dynamodb') throw new Error('test_state_missing');
        for (const authState of [
          undefined,
          { backend: 'postgresql' as const },
          { ...restoreInput.authState, namespace: randomUUID() },
        ]) {
          await expect(
            factories.loadActivatedAwsSamlTenant({ ...loadInput, authState })
          ).rejects.toThrow('aws_activated_runtime_load_failed');
        }
      }
      await expect(
        factories.loadActivatedAwsSamlTenant({
          ...loadInput,
          destinationUi: {
            components: { loginUi: false, adminUi: false },
            ui: { login: { mode: 'disabled' }, admin: { mode: 'disabled' } },
          },
        })
      ).rejects.toThrow('aws_activated_runtime_load_failed');
      expect(await authorityCounters()).toEqual([{ counter: '1' }]);
      const mirrored = await connections.core.query<{ counter: string }>(
        `SELECT counter FROM passkeys WHERE id='passkey-a' AND tenant_id=$1`,
        [TENANT]
      );
      expect(mirrored.rows).toEqual([{ counter: '1' }]);
      const touchedAccount = await connections.core.query<{ metadata_json: string }>(
        `SELECT metadata_json FROM identity_accounts WHERE id='account:user-tenant-a' AND tenant_id=$1`,
        [TENANT]
      );
      expect(JSON.parse(touchedAccount.rows[0]?.metadata_json ?? '{}')).toHaveProperty(
        'last_login_at',
        expect.any(Number)
      );
      await expect(
        factories.loadActivatedAwsSamlTenant({
          ...loadInput,
          evidence: { ...evidence, tenantId: 'tenant-b' },
        })
      ).rejects.toThrow('aws_activated_runtime_load_failed');
      await expect(
        factories.loadActivatedAwsSamlTenant({
          ...loadInput,
          awsFlowRuntimeHmacSecret: 'different-flow-hmac-with-at-least-thirty-two-bytes',
        })
      ).rejects.toThrow('aws_activated_runtime_load_failed');
      await connections.state.query(
        `UPDATE authrim_aws_restore_activations SET evidence_sha256=$3
         WHERE tenant_id=$1 AND restore_id=$2`,
        [TENANT, evidence.restoreId, '0'.repeat(64)]
      );
      await expect(factories.loadActivatedAwsSamlTenant(loadInput)).rejects.toThrow(
        'aws_activated_runtime_load_failed'
      );
      await connections.state.query(
        `UPDATE authrim_aws_restore_activations SET evidence_sha256=$3
         WHERE tenant_id=$1 AND restore_id=$2`,
        [TENANT, evidence.restoreId, restoreEvidenceDigest(evidence)]
      );
      const provider = await connections.core.query<{ config_json: string }>(
        `SELECT config_json FROM identity_providers WHERE id='provider-a' AND tenant_id=$1`,
        [TENANT]
      );
      if (!provider.rows[0]) throw new Error('source_provider_missing');
      await connections.core.query(
        `UPDATE identity_providers SET config_json='{}' WHERE id='provider-a' AND tenant_id=$1`,
        [TENANT]
      );
      await expect(factories.loadActivatedAwsSamlTenant(loadInput)).rejects.toThrow(
        'aws_activated_runtime_load_failed'
      );
      await connections.core.query(
        `UPDATE identity_providers SET config_json=$2 WHERE id='provider-a' AND tenant_id=$1`,
        [TENANT, provider.rows[0].config_json]
      );
      const account = await connections.core.query<{ metadata_json: string | null }>(
        `SELECT metadata_json FROM identity_accounts WHERE id='account:user-tenant-a' AND tenant_id=$1`,
        [TENANT]
      );
      if (!account.rows[0]) throw new Error('source_account_missing');
      await connections.core.query(
        `UPDATE identity_accounts SET metadata_json=$2 WHERE id='account:user-tenant-a' AND tenant_id=$1`,
        [TENANT, '{"last_login_at":1,"role":"admin"}']
      );
      await expect(factories.loadActivatedAwsSamlTenant(loadInput)).rejects.toThrow(
        'aws_activated_runtime_load_failed'
      );
      await connections.core.query(
        `UPDATE identity_accounts SET metadata_json=$2 WHERE id='account:user-tenant-a' AND tenant_id=$1`,
        [TENANT, account.rows[0].metadata_json]
      );
      const afterSourceAgeLimit = vi
        .spyOn(Date, 'now')
        .mockReturnValue(evidence.boundaryUnixMs + evidence.maxSnapshotAgeMs + 60_000);
      try {
        restarted = await factories.loadActivatedAwsSamlTenant(loadInput);
      } finally {
        afterSourceAgeLimit.mockRestore();
      }
      const restartedRuntime = factories.createAwsSamlRuntime({ tenants: [restarted.runtime] });
      expect((await restartedRuntime.app.request(`${ORIGIN}/health/ready`)).status).toBe(200);

      const secondRequestId = `_restart-${randomUUID()}`;
      const secondXml = xml
        .replace(requestId, secondRequestId)
        .replace(/IssueInstant="[^"]+"/u, `IssueInstant="${new Date().toISOString()}"`);
      const secondSso = await restartedRuntime.app.request(
        `${ORIGIN}/saml/idp/sso`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ SAMLRequest: btoa(secondXml) }).toString(),
        },
        context
      );
      expect(secondSso.status).toBe(302);
      const secondLocation = secondSso.headers.get('Location');
      if (!secondLocation) throw new Error('second_login_location_missing');
      const secondSamlRequestId = new URL(secondLocation).searchParams.get('saml_request_id');
      expect(secondSamlRequestId).toBeTruthy();
      const secondFlowResponse = await restartedRuntime.app.request(
        `${ORIGIN}/api/v1/login/interactions/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: browserOrigin },
          body: JSON.stringify({
            flow_kind: 'login',
            target_type: 'saml_sp',
            target_id: SP,
            saml_sp_id: SP,
            saml_request_id: secondSamlRequestId,
            saml_sp_entity_id: SP,
            return_to: 'saml_sso',
          }),
        },
        context
      );
      expect(secondFlowResponse.status, await secondFlowResponse.clone().text()).toBe(200);
      const secondFlow = JSON.parse(await secondFlowResponse.text()) as typeof flow;
      const secondVerifier = base64url(webcrypto.getRandomValues(new Uint8Array(32)));
      const secondChallenge = base64url(
        new Uint8Array(
          await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(secondVerifier))
        )
      );
      const secondPasskeyStart = await restartedRuntime.app.request(
        `${ORIGIN}/api/v1/auth/direct/passkey/login/start`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: browserOrigin,
            'X-Authrim-Interaction-Id': secondFlow.interaction.id,
          },
          body: JSON.stringify({
            client_id: 'login-ui',
            code_challenge: secondChallenge,
            code_challenge_method: 'S256',
            channel: 'browser',
          }),
        },
        context
      );
      expect(secondPasskeyStart.status, await secondPasskeyStart.clone().text()).toBe(200);
      const secondStarted = JSON.parse(await secondPasskeyStart.text()) as typeof started;
      const secondAssertion = await credential.sign(
        secondStarted.options.challenge,
        'user-tenant-a',
        2,
        browserOrigin
      );
      const secondPasskeyFinish = await restartedRuntime.app.request(
        `${ORIGIN}/api/v1/auth/direct/passkey/login/finish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: browserOrigin },
          body: JSON.stringify({
            challenge_id: secondStarted.challenge_id,
            credential: secondAssertion,
            code_verifier: secondVerifier,
            channel: 'browser',
          }),
        },
        context
      );
      expect(secondPasskeyFinish.status, await secondPasskeyFinish.clone().text()).toBe(200);
      const secondFinished = JSON.parse(await secondPasskeyFinish.text()) as typeof finished;
      const secondSession = await restartedRuntime.app.request(
        `${ORIGIN}/api/v1/auth/direct/session`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: browserOrigin },
          body: JSON.stringify({
            direct_auth_artifact: secondFinished.direct_auth_artifact,
            client_id: 'login-ui',
            code_verifier: secondVerifier,
            channel: 'browser',
            defer_authorization_continuation: true,
          }),
        },
        context
      );
      expect(secondSession.status, await secondSession.clone().text()).toBe(200);
      const secondCookie = secondSession.headers
        .get('set-cookie')
        ?.match(/authrim_session=[^;,]+/u)?.[0];
      if (!secondCookie) throw new Error('restarted_session_cookie_missing');
      const secondSessionCookie: string = secondCookie;
      async function submitRestart(stepId: string, nodeId: string, handle: string) {
        const submitted = await restartedRuntime.app.request(
          `${ORIGIN}/api/v1/login/interactions/${encodeURIComponent(secondFlow.interaction.id)}/submit`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: browserOrigin,
              Cookie: secondSessionCookie,
            },
            body: JSON.stringify({
              step_id: stepId,
              node_id: nodeId,
              selected_handle: handle,
              contract_hash: secondFlow.contract_hash,
              signature: secondFlow.signature,
            }),
          },
          context
        );
        expect(submitted.status, await submitted.clone().text()).toBe(200);
        return JSON.parse(await submitted.text()) as Awaited<ReturnType<typeof submit>>;
      }
      const secondAuthStep = await submitRestart('auth:step', 'auth', 'passkey');
      const secondComplete = secondAuthStep.completed
        ? secondAuthStep
        : await submitRestart('complete:step', 'complete', 'completed');
      expect(secondComplete.output?.protocol_continuation?.saml_request_id).toBe(
        secondSamlRequestId
      );
      const secondResume = new URL('/saml/idp/sso', ORIGIN);
      secondResume.searchParams.set('saml_request_id', secondSamlRequestId ?? '');
      secondResume.searchParams.set('saml_sp_entity_id', SP);
      secondResume.searchParams.set('return_to', 'saml_sso');
      const secondSamlResponse = await restartedRuntime.app.request(
        secondResume.toString(),
        { headers: { Cookie: secondSessionCookie } },
        context
      );
      const secondHtml = await secondSamlResponse.text();
      expect(secondSamlResponse.status, secondHtml).toBe(200);
      const secondEncoded = secondHtml.match(/name="SAMLResponse"[^>]*value="([^"]+)"/u)?.[1];
      if (!secondEncoded) throw new Error('restarted_saml_response_missing');
      const secondSignedXml = new TextDecoder().decode(
        fromBase64url(secondEncoded.replace(/\+/gu, '-').replace(/\//gu, '_'))
      );
      const secondResponseId = extractSAMLResponseIds(secondSignedXml).responseId;
      expect(
        verifyXmlSignatureAndGetReferences(secondSignedXml, {
          certificateOrKey: signing.certificate,
          expectedId: secondResponseId,
          strictXswProtection: true,
        }).some((reference) => reference.uri === `#${secondResponseId}`)
      ).toBe(true);
      expect(secondSignedXml).toContain(`InResponseTo="${secondRequestId}"`);
      expect(await authorityCounters()).toEqual([{ counter: '2' }]);
      if (dynamoAdmin) {
        const table = new DynamoStateTable({
          client: dynamoAdmin,
          tableName,
          namespace: restoreId,
        });
        const key = table.key(TENANT, 'RESTORE', 'seal');
        const original = await dynamoAdmin.send(
          new GetItemCommand({ TableName: tableName, ConsistentRead: true, Key: key })
        );
        if (!original.Item) throw new Error('test_restore_seal_missing');
        // Already-loaded instances must stop issuing assertions when their restore seal changes.
        const mutations: Record<string, AttributeValue>[] = [
          { status: { S: 'staging' } },
          { receiptSha256: { S: '0'.repeat(64) } },
        ];
        for (const mutation of mutations) {
          await dynamoAdmin.send(
            new PutItemCommand({
              TableName: tableName,
              Item: { ...original.Item, ...mutation },
            })
          );
          const ready = await restartedRuntime.app.request(`${ORIGIN}/health/ready`);
          expect(ready.status).toBe(503);
          expect(await ready.json()).toEqual({ error: 'temporarily_unavailable' });
          const rejected = await restartedRuntime.app.request(
            secondResume.toString(),
            { headers: { Cookie: secondSessionCookie } },
            context
          );
          expect(rejected.status).toBe(503);
          expect(await rejected.json()).toEqual({ error: 'temporarily_unavailable' });
          await expect(factories.loadActivatedAwsSamlTenant(loadInput)).rejects.toThrow(
            'aws_activated_runtime_load_failed'
          );
          await dynamoAdmin.send(new PutItemCommand({ TableName: tableName, Item: original.Item }));
          expect((await restartedRuntime.app.request(`${ORIGIN}/health/ready`)).status).toBe(200);
        }
      }
      expect(
        (
          await connections.core.query<{ counter: string }>(
            `SELECT counter FROM passkeys WHERE id='passkey-a' AND tenant_id=$1`,
            [TENANT]
          )
        ).rows[0]?.counter
      ).toBe('2');
      expect(externalFetch).not.toHaveBeenCalled();
    } finally {
      externalFetch.mockRestore();
      if (restarted) await restarted.close();
      if (restored) await restored.close();
      for (const client of connected.reverse()) await client.end();
      if (adminConnected) {
        for (const name of created.reverse())
          await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        await admin.end();
      }
      if (dynamoAdmin) {
        if (tableCreated) await dynamoAdmin.send(new DeleteTableCommand({ TableName: tableName }));
        dynamoAdmin.destroy();
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
);
