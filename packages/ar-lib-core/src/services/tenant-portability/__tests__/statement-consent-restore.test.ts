import { afterEach, describe, expect, it } from 'vitest';
import { sqliteAdapter } from '../../../repositories/__tests__/sqlite-core-schema';
import { applyStatementConsentTransition } from '../../statement-consent-transitions';
import {
  transitionFixture,
  transitionInput,
} from '../../__tests__/statement-consent-transition-fixture';
import { SqliteRestoreTarget } from '../sqlite-restore-target';
import { phase8RestoreHoldReason } from '../phase8-restore-holds';
import { planTenantDiscard, runTenantDiscardPage } from '../restore-target-discard';
import { readBackupSqliteSchema } from '../sqlite-schema-reader';
import type { SqliteDatasetInspectionPolicy } from '../sqlite-dataset-inspector';
import type { TenantBundleManifest } from '../bundle-manifest';

const closed: (() => void)[] = [];
afterEach(() => {
  for (const close of closed.splice(0)) close();
});
const portable = (row: Record<string, unknown>) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value === null
          ? ['null', null]
          : typeof value === 'number'
            ? ['integer', String(value)]
            : ['text', value],
      ])
    )
  );

describe('statement consent restore target rebinding', () => {
  it.each(['empty', 'source-bound'])(
    'seals only a safe %s target without creating premature authority',
    async (kind) => {
      const target = sqliteAdapter('core');
      closed.push(() => target.db.close());
      if (kind === 'source-bound')
        target.db.exec(`INSERT INTO statement_consent_key_states
      (tenant_id,user_id,statement_id,account_id,physical_id,restore_epoch,revision,withdrawal_generation,updated_at)
      VALUES('tenant-a','u','s','source','source','source',0,0,1)`);
      if (kind === 'empty')
        target.db
          .exec(`INSERT INTO consent_statements(id,tenant_id,slug,is_active,definition_generation,closed_generation,created_at,updated_at)
      VALUES('retired','tenant-a','retired',0,3,2,1,1)`);
      const restorer = await SqliteRestoreTarget.open({
        database: target.adapter,
        identity: {
          id: 'target',
          tenantId: 'tenant-a',
          operationId: 'import',
          resourceId: 'target-db',
          planDigest: 'a'.repeat(64),
          seedFingerprint: 'b'.repeat(64),
        },
        lease: { owner: 'restorer', fencingToken: 1, expiresAt: Date.now() + 600000 },
        now: () => Date.now(),
        authorize: async () => {},
        readSeedFingerprint: async () => 'b'.repeat(64),
      });
      if (kind === 'empty') await restorer.seal();
      else
        await expect(restorer.seal()).rejects.toThrow('statement_consent_restore_rebind_required');
      expect(await target.adapter.query('SELECT * FROM statement_consent_guards')).toEqual([]);
      if (kind === 'empty')
        expect(
          await target.adapter.queryOne(
            'SELECT statement_id,definition_generation,closed_generation,mode,targets_json,cursor_binding_ref FROM statement_consent_projection_jobs'
          )
        ).toEqual({
          statement_id: 'retired',
          definition_generation: 3,
          closed_generation: 2,
          mode: 'closed',
          targets_json: null,
          cursor_binding_ref: null,
        });
      expect(
        await target.adapter.queryOne('SELECT state FROM tenant_backup_restore_targets')
      ).toEqual({ state: kind === 'empty' ? 'sealed' : 'loading' });
      if (kind === 'empty') {
        await target.adapter
          .execute(`INSERT INTO statement_consent_projection_jobs(tenant_id,statement_id,definition_generation,closed_generation,mode,updated_at)
          VALUES('other-tenant','retired',3,2,'closed',1)`);
        const schema = await Promise.all(
          ['consent_statements', 'statement_consent_projection_jobs'].map((name) =>
            readBackupSqliteSchema(target.adapter, name)
          )
        );
        const columns = await target.adapter.query<{ name: string }>(
          'PRAGMA table_info(consent_statements)'
        );
        const plan = planTenantDiscard({
          family: 'core',
          schema,
          identity: { tenantId: 'tenant-a', tenantKey: 'tenant-a' },
          datasets: [
            {
              id: 'core.consent_statements',
              kind: 'settings',
              referenceOnly: false,
              deferredColumns: [],
              capture: {
                table: 'consent_statements',
                columns: columns.map((c) => c.name),
                primaryKey: ['id'],
                uniqueKeys: [],
                tenantColumn: 'tenant_id',
              },
            },
          ],
        });
        expect(
          await runTenantDiscardPage({
            database: target.adapter,
            plan,
            authorize: async () => {},
            signal: new AbortController().signal,
          })
        ).toEqual({ done: true });
        expect(
          await target.adapter.query('SELECT tenant_id FROM statement_consent_projection_jobs')
        ).toEqual([{ tenant_id: 'other-tenant' }]);
      }
    }
  );
  it('rebinds portable rows on insertion and readback, rebuilds guard, and fences source operations', async () => {
    const source = transitionFixture();
    closed.push(() => source.close());
    await source.seed();
    const input = transitionInput();
    await applyStatementConsentTransition(source.capability, input);
    const target = sqliteAdapter('core');
    closed.push(() => target.db.close());
    const tables = [
      'user_consent_records',
      'consent_item_history',
      'statement_consent_key_states',
      'statement_consent_operations',
    ];
    const policies: SqliteDatasetInspectionPolicy[] = [];
    for (const table of tables) {
      const cols = await target.adapter.query<{ name: string; pk: number }>(
        `PRAGMA table_info(${table})`
      );
      policies.push({
        dataset: {
          id: `core.${table}`,
          module: 'consent',
          kind: table === 'consent_item_history' ? 'history' : 'users',
          store: 'database',
          disposition: 'include',
          schemaVersion: 1,
        },
        schema: {
          table,
          columns: cols.map((c) => c.name),
          primaryKey: cols
            .filter((c) => c.pk)
            .sort((a, b) => a.pk - b.pk)
            .map((c) => c.name),
          uniqueKeys: [],
          tenantColumn: 'tenant_id',
        },
        async inspectRow() {
          return [];
        },
      });
    }
    const manifest: TenantBundleManifest = {
      formatVersion: 1,
      bundleId: 'a'.repeat(32),
      source: { tenantId: 'tenant-a', issuer: 'https://fixture.example', productVersion: '0.4.2' },
      selection: {
        settings: false,
        users: true,
        admin: false,
        artifacts: false,
        logs: { audit: false, other: true, sensitive: false, period: 'all' },
      },
      snapshotId: 'snapshot',
      boundaryUnixMs: Date.now(),
      inventoryDigestSha256: 'b'.repeat(64),
      datasets: policies.map((p) => p.dataset),
    };
    const open = (mode: 'write' | 'seal' | 'verify' = 'write') =>
      SqliteRestoreTarget.open({
        database: target.adapter,
        identity: {
          id: 'target',
          tenantId: 'tenant-a',
          operationId: 'new-import',
          resourceId: 'new-physical',
          planDigest: 'a'.repeat(64),
          seedFingerprint: 'b'.repeat(64),
        },
        lease: { owner: 'restorer', fencingToken: 1, expiresAt: Date.now() + 600000 },
        now: () => Date.now(),
        authorize: async () => {},
        readSeedFingerprint: async () => 'b'.repeat(64),
        mode,
      });
    const restorer = await open();
    for (const policy of policies) {
      const rows = await source.adapter.query<Record<string, unknown>>(
        `SELECT * FROM ${policy.schema.table}`
      );
      const encoded = rows.map(portable);
      await restorer.writeRows(policy, manifest, encoded);
      await restorer.writeRows(policy, manifest, encoded); // a lost page acknowledgement is idempotent
      await restorer.verifyRows(policy, manifest, encoded);
    }
    const binding = {
      account_id: 'restore:new-physical',
      physical_id: 'new-physical',
      restore_epoch: 'new-import',
    };
    for (const table of ['statement_consent_key_states', 'statement_consent_operations'])
      expect(
        await target.adapter.queryOne(`SELECT account_id,physical_id,restore_epoch FROM ${table}`)
      ).toEqual(binding);
    expect(await target.adapter.query('SELECT * FROM statement_consent_guards')).toEqual([]);
    await restorer.seal();
    expect(
      await target.adapter.queryOne(
        'SELECT account_id,physical_id,restore_epoch FROM statement_consent_guards'
      )
    ).toEqual(binding);
    const verifier = await open('verify');
    for (const policy of policies)
      await verifier.verifyRows(
        policy,
        manifest,
        (
          await source.adapter.query<Record<string, unknown>>(
            `SELECT * FROM ${policy.schema.table}`
          )
        ).map(portable)
      );
    const capability = {
      ...source.capability,
      readOperation: (sql: string, params: unknown[]) =>
        target.adapter.queryOne<unknown>(sql, params),
      executeStatementConsentBatch: async (
        statements: Parameters<typeof target.adapter.batch>[0]
      ) => {
        await target.adapter.batch(statements);
      },
    };
    await expect(applyStatementConsentTransition(capability, input)).rejects.toThrow(
      'statement_consent_operation_conflict'
    );
    const inFlight = transitionInput('tenant-a', 'c'.repeat(64));
    expect(await applyStatementConsentTransition(capability, inFlight)).toEqual({
      outcome: 'rejected',
    });
    expect(
      await target.adapter.queryOne('SELECT revision FROM statement_consent_key_states')
    ).toEqual({ revision: 1 });
    expect(await target.adapter.queryOne('SELECT COUNT(*) AS n FROM consent_item_history')).toEqual(
      { n: 1 }
    );
    expect(
      phase8RestoreHoldReason(
        'core.statement_consent_operations',
        JSON.stringify({ status: ['text', 'executing'] })
      )
    ).toBe('source_consent_operation');
    expect(phase8RestoreHoldReason('core.statement_consent_admissions', '{}')).toBe(
      'source_consent_admission'
    );
    await expect(
      target.adapter.execute(
        "INSERT OR REPLACE INTO statement_consent_operations SELECT * FROM statement_consent_operations WHERE status='applied'"
      )
    ).rejects.toThrow('operation_insert_guard');
  });
});
