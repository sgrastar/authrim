import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PostgresAdapter } from '../../../ar-lib-core/src/db/adapters/postgres-adapter';
import { assertPasskeyOnlySamlFlowReady } from './passkey-flow-profile';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
const postgresIt = databaseUrl ? it : it.skip;

describe('AWS passkey Flow readiness against PostgreSQL', () => {
  postgresIt('resolves an imported SAML assignment with native boolean columns', async () => {
    if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL required');
    const client = new Client({ connectionString: databaseUrl });
    const schema = `aws_flow_${randomUUID().replace(/-/gu, '')}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`
        CREATE TABLE flow_assignments (
          tenant_id text NOT NULL, target_type text NOT NULL, target_id text,
          flow_kind text NOT NULL, enabled boolean NOT NULL, flow_id text NOT NULL
        );
        CREATE TABLE flows (
          tenant_id text NOT NULL, id text NOT NULL, status text NOT NULL,
          deleted_at bigint, published_version_id text
        );
        CREATE TABLE flow_versions (
          tenant_id text NOT NULL, flow_id text NOT NULL, id text NOT NULL,
          runtime_snapshot_json text NOT NULL, editor_snapshot_json text
        );
        CREATE TABLE oauth_clients (
          tenant_id text NOT NULL, client_id text NOT NULL,
          application_type text, allowed_channels text, client_secret_hash text
        );
        CREATE TABLE web_origin_registry (
          tenant_id text NOT NULL, client_id text NOT NULL, origin text NOT NULL,
          handoff_allowed integer NOT NULL, is_active integer NOT NULL
        );
      `);
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
            {
              id: 'complete:step',
              source_node_id: 'complete',
              component: 'completion',
              render: true,
            },
          ],
        },
      };
      await client.query(
        `INSERT INTO flows (tenant_id,id,status,published_version_id)
         VALUES ($1,$2,'published',$3)`,
        ['tenant-a', 'flow-1', 'v-1']
      );
      await client.query(
        `INSERT INTO flow_assignments
           (tenant_id,target_type,target_id,flow_kind,enabled,flow_id)
         VALUES ($1,'saml_sp',$2,'login',TRUE,$3)`,
        ['tenant-a', 'https://sp.example.test', 'flow-1']
      );
      await client.query(
        `INSERT INTO flow_versions
           (tenant_id,flow_id,id,runtime_snapshot_json,editor_snapshot_json)
         VALUES ($1,$2,$3,$4,NULL)`,
        ['tenant-a', 'flow-1', 'v-1', JSON.stringify(runtime)]
      );
      await client.query(
        `INSERT INTO oauth_clients
           (tenant_id,client_id,application_type,allowed_channels)
         VALUES ($1,'login-ui','web',$2)`,
        ['tenant-a', '["browser"]']
      );
      await client.query(
        `INSERT INTO web_origin_registry
           (tenant_id,client_id,origin,handoff_allowed,is_active)
         VALUES ($1,'login-ui',$2,1,1)`,
        ['tenant-a', 'https://login.example.test']
      );
      const db = new PostgresAdapter({
        connectionString: databaseUrl,
        clientFactory: () => client as never,
      });
      await expect(
        assertPasskeyOnlySamlFlowReady(
          db,
          'tenant-a',
          ['https://sp.example.test'],
          'https://login.example.test'
        )
      ).resolves.toBeUndefined();
      await client.query(`UPDATE flow_assignments SET enabled = FALSE`);
      await expect(
        assertPasskeyOnlySamlFlowReady(
          db,
          'tenant-a',
          ['https://sp.example.test'],
          'https://login.example.test'
        )
      ).rejects.toThrow('aws_login_flow_assignment_missing');
    } finally {
      await client.query('SET search_path TO public').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }
  });
});
