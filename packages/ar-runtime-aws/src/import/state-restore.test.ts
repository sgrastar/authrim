import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import type { PostgresQueryClient } from '../storage/postgres-transient-state';
import {
  assertAwsLiveStateCompatible,
  assertVerifiedAwsStateRestored,
  awsStateSupplementPayloadSha256,
  restoreVerifiedAwsState,
  type AwsStateSourceExpectations,
  type VerifiedAwsStateSupplement,
} from './state-restore';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
const postgresIt = databaseUrl ? it : it.skip;
const TENANT = 'tenant-a';
const NOW = 1_700_000_000_000;
const SP = 'https://sp.example.test';
const registryKey = `saml:persistent-nameid:tenant:${TENANT}:sp:${encodeURIComponent(SP)}:subject:user-1`;
const manifest: TenantBundleManifest = {
  formatVersion: 1,
  bundleId: 'a'.repeat(32),
  source: { tenantId: TENANT, issuer: 'https://tenant-a.example.test', productVersion: '0.4.2' },
  snapshotId: 'snapshot-a',
  boundaryUnixMs: NOW,
  inventoryDigestSha256: 'b'.repeat(64),
  selection: {
    settings: true,
    users: true,
    admin: false,
    artifacts: false,
    logs: { audit: false, other: false, sensitive: false, period: 7 },
  },
  datasets: [
    {
      id: 'core.identity_accounts',
      module: 'users',
      kind: 'users',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    },
  ],
};
const expected: AwsStateSourceExpectations = {
  users: [{ userId: 'user-1' }],
  accounts: [{ accountId: 'account:user-1', userId: 'user-1', lifecycle: 'active' }],
  passkeys: [
    { passkeyId: 'passkey-1', userId: 'user-1', credentialId: 'cred-1', sourceCounter: '5' },
  ],
};

function supplement(): VerifiedAwsStateSupplement {
  const valueJson = JSON.stringify({
    version: 1,
    tenantId: TENANT,
    spEntityId: SP,
    subjectId: 'user-1',
    nameId: 'pairwise-user-1',
    createdAt: NOW - 2000,
  });
  const value: VerifiedAwsStateSupplement = {
    receipt: {
      tenantId: TENANT,
      issuer: manifest.source.issuer,
      productVersion: manifest.source.productVersion,
      bundleId: manifest.bundleId,
      snapshotId: manifest.snapshotId,
      inventoryDigestSha256: manifest.inventoryDigestSha256,
      supplementSha256: '',
    },
    accountAuthStates: [
      {
        tenantId: TENANT,
        userId: 'user-1',
        accountId: 'account:user-1',
        lifecycle: 'active',
        lifecycleVersionMs: NOW - 2000,
        lifecycleOperationId: null,
        revokedAfterMs: null,
        lastLoginAtMs: NOW - 1000,
      },
    ],
    passkeyCounters: [
      {
        tenantId: TENANT,
        passkeyId: 'passkey-1',
        userId: 'user-1',
        credentialId: 'cred-1',
        counter: '5',
        updatedAtMs: NOW - 1000,
      },
    ],
    persistentNameIdsComplete: true,
    persistentNameIds: [{ tenantId: TENANT, registryKey, valueJson, createdAtMs: NOW - 2000 }],
  };
  value.receipt.supplementSha256 = awsStateSupplementPayloadSha256(value);
  return value;
}

function repin(value: VerifiedAwsStateSupplement): VerifiedAwsStateSupplement {
  value.receipt.supplementSha256 = awsStateSupplementPayloadSha256(value);
  return value;
}

const openClients: Array<{ client: Client; schema: string }> = [];

async function database(): Promise<{ client: Client; db: PostgresQueryClient }> {
  if (!databaseUrl) throw new Error('test_database_unavailable');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const schema = `aws_state_restore_${randomUUID().replaceAll('-', '')}`;
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  for (const file of ['account-auth-schema.sql', 'persistent-nameid-schema.sql']) {
    await client.query(await readFile(new URL(`../storage/${file}`, import.meta.url), 'utf8'));
  }
  openClients.push({ client, schema });
  return {
    client,
    db: {
      query: async <Row extends Record<string, unknown>>(sql: string, values: unknown[]) => {
        const result = await client.query<Row>(sql, values);
        return { rows: result.rows, rowCount: result.rowCount };
      },
    },
  };
}

afterEach(async () => {
  for (const { client, schema } of openClients.splice(0)) {
    await client.query('SET search_path TO public').catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await client.end();
  }
});

describe('verified AWS durable auth state restore', () => {
  it('rejects missing or extra source identities before opening a transaction', async () => {
    const candidate = supplement();
    candidate.accountAuthStates = [];
    repin(candidate);
    let opened = false;
    await expect(
      restoreVerifiedAwsState({
        manifest,
        supplement: candidate,
        expected,
        connection: {
          withDedicatedConnection: async () => {
            opened = true;
            throw new Error('unexpected_connection');
          },
        },
      })
    ).rejects.toThrow('aws_state_restore_invalid');
    expect(opened).toBe(false);

    const extra = supplement();
    extra.passkeyCounters = [{ ...extra.passkeyCounters[0], credentialId: 'unexpected' }];
    repin(extra);
    await expect(
      restoreVerifiedAwsState({
        manifest,
        supplement: extra,
        expected,
        connection: {
          withDedicatedConnection: async () => {
            opened = true;
            throw new Error('unexpected_connection');
          },
        },
      })
    ).rejects.toThrow('aws_state_restore_invalid');
    expect(opened).toBe(false);
  });

  postgresIt(
    'restores exact source rows on one dedicated PG transaction and preserves another tenant',
    async () => {
      const { client, db } = await database();
      await client.query(
        `INSERT INTO authrim_aws_account_auth_state
       (tenant_id,user_id,account_id,lifecycle,lifecycle_version_ms)
       VALUES ('tenant-b','other','account:other','active',1)`
      );
      const restored = await restoreVerifiedAwsState({
        manifest,
        supplement: supplement(),
        expected,
        connection: { withDedicatedConnection: async (run) => run(db) },
      });
      expect(restored).toMatchObject({
        tenantId: TENANT,
        accountAuthStates: 1,
        passkeyCounters: 1,
        persistentNameIds: 1,
        bundleId: manifest.bundleId,
      });
      expect(
        (
          await client.query<{
            user_id: string;
            lifecycle: string;
            revoked_after_ms: string | null;
          }>(
            `SELECT user_id,lifecycle,revoked_after_ms FROM authrim_aws_account_auth_state
       WHERE tenant_id=$1`,
            [TENANT]
          )
        ).rows
      ).toEqual([{ user_id: 'user-1', lifecycle: 'active', revoked_after_ms: null }]);
      expect(
        (
          await client.query<{ credential_id: string; counter: string }>(
            `SELECT credential_id,counter FROM authrim_aws_passkey_counters WHERE tenant_id=$1`,
            [TENANT]
          )
        ).rows
      ).toEqual([{ credential_id: 'passkey-1', counter: '5' }]);
      expect(
        (
          await client.query<{ count: string }>(
            `SELECT count(*) AS count FROM authrim_aws_passkey_counters
         WHERE tenant_id=$1 AND credential_id='cred-1'`,
            [TENANT]
          )
        ).rows[0].count
      ).toBe('0');
      expect(
        (
          await client.query<{ count: string }>(
            `SELECT count(*) AS count FROM authrim_aws_account_auth_state WHERE tenant_id='tenant-b'`
          )
        ).rows[0].count
      ).toBe('1');
      await assertVerifiedAwsStateRestored({
        manifest,
        supplement: supplement(),
        expected,
        receipt: restored,
        connection: { withDedicatedConnection: async (run) => run(db) },
      });
    }
  );

  postgresIt('blocks activation after a staged account, counter, or NameID changes', async () => {
    const { client, db } = await database();
    const state = supplement();
    const connection = {
      withDedicatedConnection: async <T>(run: (client: PostgresQueryClient) => Promise<T>) =>
        run(db),
    };
    const receipt = await restoreVerifiedAwsState({
      manifest,
      supplement: state,
      expected,
      connection,
    });
    const verify = () =>
      assertVerifiedAwsStateRestored({
        manifest,
        supplement: state,
        expected,
        receipt,
        connection,
      });
    await verify();
    await client.query(
      `UPDATE authrim_aws_account_auth_state SET lifecycle='locked'
       WHERE tenant_id=$1 AND user_id='user-1'`,
      [TENANT]
    );
    await expect(verify()).rejects.toThrow('aws_state_restore_invalid');
    await client.query(
      `UPDATE authrim_aws_account_auth_state SET lifecycle='active'
       WHERE tenant_id=$1 AND user_id='user-1'`,
      [TENANT]
    );
    await client.query(
      `UPDATE authrim_aws_passkey_counters SET counter=6
       WHERE tenant_id=$1 AND credential_id='passkey-1'`,
      [TENANT]
    );
    await expect(verify()).rejects.toThrow('aws_state_restore_invalid');
    await client.query(
      `UPDATE authrim_aws_passkey_counters SET counter=5
       WHERE tenant_id=$1 AND credential_id='passkey-1'`,
      [TENANT]
    );
    await client.query(
      `UPDATE authrim_aws_saml_persistent_nameids SET value_json='{}'
       WHERE tenant_id=$1`,
      [TENANT]
    );
    await expect(verify()).rejects.toThrow('aws_state_restore_invalid');
  });

  postgresIt(
    'accepts live counter and new NameID advances but rejects rollback and state drift',
    async () => {
      const { client, db } = await database();
      const state = supplement();
      const connection = {
        withDedicatedConnection: async <T>(run: (client: PostgresQueryClient) => Promise<T>) =>
          run(db),
      };
      const receipt = await restoreVerifiedAwsState({
        manifest,
        supplement: state,
        expected,
        connection,
      });
      const verify = () =>
        assertAwsLiveStateCompatible({
          manifest,
          supplement: state,
          expected,
          receipt,
          connection,
        });
      await client.query(
        `UPDATE authrim_aws_passkey_counters SET counter=6, updated_at_ms=$2
       WHERE tenant_id=$1 AND credential_id='passkey-1'`,
        [TENANT, NOW + 1000]
      );
      const newSp = 'https://new-sp.example.test';
      const newKey = `saml:persistent-nameid:tenant:${TENANT}:sp:${encodeURIComponent(newSp)}:subject:user-1`;
      const newValue = JSON.stringify({
        version: 1,
        tenantId: TENANT,
        spEntityId: newSp,
        subjectId: 'user-1',
        nameId: 'new-pairwise-id',
        createdAt: NOW + 1000,
      });
      await client.query(
        `INSERT INTO authrim_aws_saml_persistent_nameids
       (tenant_id,registry_key,value_json,created_at_ms) VALUES ($1,$2,$3,$4)`,
        [TENANT, newKey, newValue, NOW + 1000]
      );
      await verify();
      await client.query(
        `UPDATE authrim_aws_passkey_counters SET counter=4
       WHERE tenant_id=$1 AND credential_id='passkey-1'`,
        [TENANT]
      );
      await expect(verify()).rejects.toThrow('aws_state_restore_invalid');
      await client.query(
        `UPDATE authrim_aws_passkey_counters SET counter=6
       WHERE tenant_id=$1 AND credential_id='passkey-1'`,
        [TENANT]
      );
      await client.query(
        `UPDATE authrim_aws_account_auth_state SET lifecycle='locked'
       WHERE tenant_id=$1 AND user_id='user-1'`,
        [TENANT]
      );
      await expect(verify()).rejects.toThrow('aws_state_restore_invalid');
      await client.query(
        `UPDATE authrim_aws_account_auth_state SET lifecycle='active'
       WHERE tenant_id=$1 AND user_id='user-1'`,
        [TENANT]
      );
      await client.query(
        `UPDATE authrim_aws_saml_persistent_nameids SET value_json='{}'
       WHERE tenant_id=$1 AND registry_key=$2`,
        [TENANT, registryKey]
      );
      await expect(verify()).rejects.toThrow('aws_state_restore_invalid');
    }
  );

  postgresIt('rejects duplicate tenant state and leaves the existing row untouched', async () => {
    const { client, db } = await database();
    await client.query(
      `INSERT INTO authrim_aws_account_auth_state
       (tenant_id,user_id,account_id,lifecycle,lifecycle_version_ms)
       VALUES ($1,'user-1','account:user-1','locked',1)`,
      [TENANT]
    );
    await expect(
      restoreVerifiedAwsState({
        manifest,
        supplement: supplement(),
        expected,
        connection: { withDedicatedConnection: async (run) => run(db) },
      })
    ).rejects.toThrow('aws_state_restore_invalid');
    expect(
      (
        await client.query<{ lifecycle: string }>(
          `SELECT lifecycle FROM authrim_aws_account_auth_state WHERE tenant_id=$1`,
          [TENANT]
        )
      ).rows[0].lifecycle
    ).toBe('locked');
    expect(
      (
        await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM authrim_aws_passkey_counters WHERE tenant_id=$1`,
          [TENANT]
        )
      ).rows[0].count
    ).toBe('0');
  });

  postgresIt(
    'rolls back account and counter writes when the NameID record is malformed',
    async () => {
      const { client, db } = await database();
      const candidate = supplement();
      candidate.persistentNameIds = [
        {
          ...candidate.persistentNameIds[0],
          valueJson: JSON.stringify({
            version: 1,
            tenantId: TENANT,
            spEntityId: SP,
            subjectId: 'user-1',
            createdAt: NOW - 2000,
          }),
        },
      ];
      repin(candidate);
      await expect(
        restoreVerifiedAwsState({
          manifest,
          supplement: candidate,
          expected,
          connection: { withDedicatedConnection: async (run) => run(db) },
        })
      ).rejects.toThrow('aws_state_restore_invalid');
      for (const table of [
        'authrim_aws_account_auth_state',
        'authrim_aws_passkey_counters',
        'authrim_aws_saml_persistent_nameids',
      ]) {
        expect(
          (
            await client.query<{ count: string }>(
              `SELECT count(*) AS count FROM ${table} WHERE tenant_id=$1`,
              [TENANT]
            )
          ).rows[0].count
        ).toBe('0');
      }
    }
  );

  postgresIt(
    'rejects below-source counters, cross-tenant rows, invalid lifecycle, and incomplete NameID inventory',
    async () => {
      const { client, db } = await database();
      const cases = [
        (value: VerifiedAwsStateSupplement) => {
          value.passkeyCounters[0].counter = '4';
        },
        (value: VerifiedAwsStateSupplement) => {
          value.accountAuthStates[0].tenantId = 'tenant-b';
        },
        (value: VerifiedAwsStateSupplement) => {
          value.accountAuthStates[0].lifecycle = 'unrecognized' as never;
        },
        (value: VerifiedAwsStateSupplement) => {
          value.persistentNameIdsComplete = false as never;
        },
      ];
      for (const alter of cases) {
        const candidate = supplement();
        alter(candidate);
        repin(candidate);
        await expect(
          restoreVerifiedAwsState({
            manifest,
            supplement: candidate,
            expected,
            connection: { withDedicatedConnection: async (run) => run(db) },
          })
        ).rejects.toThrow('aws_state_restore_invalid');
      }
      expect(
        (
          await client.query<{ count: string }>(
            `SELECT count(*) AS count FROM authrim_aws_account_auth_state WHERE tenant_id=$1`,
            [TENANT]
          )
        ).rows[0].count
      ).toBe('0');
    }
  );
});
