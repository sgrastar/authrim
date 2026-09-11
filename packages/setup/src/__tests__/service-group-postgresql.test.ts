import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { renderPortableMigrationSql } from '../../../ar-lib-core/src/migrations/sql-portability';

it('applies service group PostgreSQL migrations and invalidates committed inputs on writes', async () => {
  const container = `authrim-service-groups-test-${process.pid}`;
  const docker = (args: string[], input?: string) =>
    execFileSync('docker', args, {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const sql = (database: string, input: string) =>
    docker(
      [
        'exec',
        '-i',
        container,
        'psql',
        '-U',
        'postgres',
        '-d',
        database,
        '-XAt',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      input
    );
  docker([
    'run',
    '--rm',
    '-d',
    '--name',
    container,
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    'postgres:17-alpine',
  ]);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        sql('postgres', 'SELECT 1');
        break;
      } catch (error) {
        if (attempt >= 100) throw error;
        await setTimeout(100);
      }
    }
    const streams = {
      core: [
        '001_0_4_0_core_baseline.sql',
        '002_guest_account_lifecycle.sql',
        '003_account_registration_state.sql',
        '005_account_webhook_outbox.sql',
        '006_webhook_payload_fields.sql',
        '007_service_dynamic_groups.sql',
      ],
      pii: [
        '001_0_4_0_pii_baseline.sql',
        '003_account_webhook_outbox.sql',
        '004_account_webhook_snapshots.sql',
        '005_service_dynamic_groups.sql',
      ],
    };
    for (const [family, files] of Object.entries(streams)) {
      sql('postgres', `CREATE DATABASE ${family}`);
      for (const file of files) {
        sql(
          family,
          renderPortableMigrationSql(
            readFileSync(
              new URL(`../../../../migrations/${family}/postgresql/${file}`, import.meta.url),
              'utf8'
            ),
            'postgres'
          )
        );
      }
      sql(
        family,
        "INSERT INTO service_group_write_boundaries VALUES ('boundary', 'tenant', 'user', 'test', 'writing', 1)"
      );
      expect(
        sql(
          family,
          "SELECT revision FROM service_group_inputs WHERE tenant_id = 'tenant' AND user_id = 'user'"
        )
      ).toBe('1');
      sql(family, "DELETE FROM service_group_write_boundaries WHERE id = 'boundary'");
      expect(
        sql(
          family,
          "SELECT revision FROM service_group_inputs WHERE tenant_id = 'tenant' AND user_id = 'user'"
        )
      ).toBe('2');
      expect(
        sql(family, "SELECT count(*) FROM service_group_inputs WHERE tenant_id = 'other'")
      ).toBe('0');
    }
    sql('core', "INSERT INTO service_group_manual VALUES ('tenant', 'user', 'group')");
    expect(
      sql(
        'core',
        "SELECT revision FROM service_group_inputs WHERE tenant_id = 'tenant' AND user_id = 'user'"
      )
    ).toBe('3');
    sql('core', 'BEGIN; DELETE FROM service_group_manual; ROLLBACK;');
    expect(
      sql(
        'core',
        "SELECT revision FROM service_group_inputs WHERE tenant_id = 'tenant' AND user_id = 'user'"
      )
    ).toBe('3');
    sql('core', 'DELETE FROM service_group_manual');
    expect(
      sql(
        'core',
        "SELECT revision FROM service_group_inputs WHERE tenant_id = 'tenant' AND user_id = 'user'"
      )
    ).toBe('4');
    sql(
      'pii',
      `INSERT INTO identity_sensitive_values(id, tenant_id, owner_type, owner_id, value_key, value_json, classification, lifecycle_state, created_at, updated_at) VALUES ('country', 'tenant', 'runtime_user', 'user', 'address_country', '"JP"', 'sensitive', 'active', 1, 1)`
    );
    expect(
      sql(
        'pii',
        "SELECT revision FROM service_group_inputs WHERE tenant_id = 'tenant' AND user_id = 'user'"
      )
    ).toBe('3');
    sql('pii', `UPDATE identity_sensitive_values SET value_json = '"US"' WHERE id = 'country'`);
    expect(
      sql(
        'pii',
        "SELECT revision FROM service_group_inputs WHERE tenant_id = 'tenant' AND user_id = 'user'"
      )
    ).toBe('4');
    sql('pii', "DELETE FROM identity_sensitive_values WHERE id = 'country'");
    expect(
      sql(
        'pii',
        "SELECT revision FROM service_group_inputs WHERE tenant_id = 'tenant' AND user_id = 'user'"
      )
    ).toBe('5');
  } finally {
    docker(['rm', '-f', container]);
  }
}, 60_000);
