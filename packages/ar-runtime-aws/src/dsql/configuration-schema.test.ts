import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createDsqlConfigurationSchemaPlan,
  dsqlConfigurationTableName,
  initializeDsqlConfigurationSchema,
} from './configuration-schema';
import type { DsqlIdentitySchemaDatabase, DsqlIdentitySchemaProgress } from './identity-schema';

const schema = `authrim_dsql_configuration_${'a'.repeat(32)}`;
const root = resolve(import.meta.dirname, '../../../..');
const clean = (sql: string) => sql.replace(/\s+/gu, ' ').trim();

describe('DSQL configuration schema contract', () => {
  it('preserves the PostgreSQL columns, checks, unique keys, foreign keys and indexes', () => {
    const plan = createDsqlConfigurationSchemaPlan(schema);
    for (const table of plan.tables) {
      const sp = table.name === 'identity_providers';
      const source = readFileSync(
        resolve(
          root,
          'migrations/core/postgresql',
          sp
            ? '013_saml_passkey_configuration_and_route_generation.sql'
            : '001_0_4_0_core_baseline.sql'
        ),
        'utf8'
      );
      const body = source.match(
        new RegExp(`CREATE TABLE ${sp ? '' : 'public\\.'}${table.name} \\(([\\s\\S]*?)\\n\\);`)
      );
      if (!body) throw new Error('missing_source_table');
      const constraints = [
        ...source.matchAll(
          new RegExp(`ALTER TABLE ONLY public\\.${table.name}\\s+ADD ([^;]+);`, 'gu')
        ),
      ].map((match) =>
        match[1].replace('REFERENCES public.flows', `REFERENCES "${schema}"."flows"`)
      );
      const sql = `CREATE TABLE "${schema}"."${table.name}" (${body[1].trim()}${constraints.length ? ', ' + constraints.join(', ') : ''})`;
      expect(clean(table.sql)).toBe(clean(sql));
      const sourceIndexes = [
        ...source.matchAll(
          new RegExp(
            `CREATE (UNIQUE )?INDEX ([a-z_]+)\\s+ON ${sp ? '' : 'public\\.'}${table.name}(?: USING btree)?\\s*(\\([^;]+);`,
            'gu'
          )
        ),
      ]
        .map((m) =>
          clean(`CREATE ${m[1] ?? ''}INDEX ASYNC "${m[2]}" ON "${schema}"."${table.name}" ${m[3]}`)
        )
        .sort();
      expect(
        plan.indexes
          .filter((item) => item.table === table.name)
          .map((item) => clean(item.sql))
          .sort()
      ).toEqual(sourceIndexes);
      // Later schema changes and trigger protections require explicit evaluation;
      // the isolated snapshot must not silently become a claim about a newer schema.
      const directory = resolve(root, 'migrations/core/postgresql');
      for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql'))) {
        const migration = readFileSync(resolve(directory, filename), 'utf8');
        expect(migration).not.toMatch(
          new RegExp(`CREATE TRIGGER[^;]+ ON (?:public\\.)?${table.name}\\b`, 'u')
        );
        if (
          [
            '001_0_4_0_core_baseline.sql',
            '013_saml_passkey_configuration_and_route_generation.sql',
          ].includes(filename)
        )
          continue;
        expect(migration).not.toMatch(
          new RegExp(
            `(?:ALTER TABLE(?: ONLY)? (?:public\\.)?${table.name}\\b|CREATE (?:UNIQUE )?INDEX[^;]+ ON (?:public\\.)?${table.name}\\b)`,
            'u'
          )
        );
      }
    }
    expect(plan).toMatchObject({
      fullRuntimeReady: false,
      scope: 'configuration-staging-experiment',
    });
    expect(plan.sourceContractFingerprint).toBe(
      createDsqlConfigurationSchemaPlan(`authrim_dsql_configuration_${'b'.repeat(32)}`)
        .sourceContractFingerprint
    );
  });

  it('rejects serving or identity namespaces and injected table names', () => {
    for (const name of ['public', `authrim_dsql_identity_${'a'.repeat(32)}`, `${schema}"`]) {
      expect(() => createDsqlConfigurationSchemaPlan(name)).toThrow(
        'dsql_configuration_schema_invalid'
      );
    }
    expect(() => dsqlConfigurationTableName(schema, 'flows; DROP TABLE x' as 'flows')).toThrow(
      'dsql_configuration_table_invalid'
    );
  });

  it('waits for every async index and records confirmed readiness without weakening rejected DDL', async () => {
    const plan = createDsqlConfigurationSchemaPlan(schema);
    const progress: DsqlIdentitySchemaProgress[] = [];
    const jobs = new Map<string, (typeof plan.indexes)[number]>();
    const db: DsqlIdentitySchemaDatabase = {
      execute: vi.fn(async () => ({ success: true, rowsAffected: 0 })),
      async queryOne<T>(sql: string, values: unknown[] = []): Promise<T | null> {
        if (sql.startsWith('CREATE')) {
          const job = `job-${jobs.size}`;
          jobs.set(job, plan.indexes[jobs.size]);
          return { job_id: job } as T;
        }
        if (sql.includes('sys.jobs')) {
          const item = jobs.get(String(values[0]));
          return {
            job_id: values[0],
            status: 'completed',
            job_type: 'INDEX_BUILD',
            object_name: `${schema}.${item?.name}`,
          } as T;
        }
        return {
          is_valid: true,
          is_unique: plan.indexes.find((item) => item.name === values[1])?.unique,
        } as T;
      },
    };
    await expect(
      initializeDsqlConfigurationSchema(db, schema, { onProgress: (event) => progress.push(event) })
    ).resolves.toEqual(plan);
    expect(progress.filter((event) => event.status === 'ready')).toHaveLength(plan.indexes.length);
    expect(db.execute).toHaveBeenCalledTimes(5);
    const rejected = {
      ...db,
      execute: vi.fn(async () => {
        throw Object.assign(new Error('private SQL contents'), { code: '0A000' });
      }),
    };
    await expect(initializeDsqlConfigurationSchema(rejected, schema)).rejects.toMatchObject({
      message: 'dsql_configuration_schema_initialization_failed',
      code: '0A000',
    });
    expect(rejected.execute).toHaveBeenCalledTimes(1);
  });
});
