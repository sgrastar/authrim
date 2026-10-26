import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDsqlGovernanceSchemaPlan } from './governance-schema';
import { createDsqlGroupBoundarySchemaPlan } from './group-input-mutations';

describe('native protection schema contracts', () => {
  it('preserves all baseline governance constraints and references including cascade semantics', () => {
    const baseline = readFileSync(
      new URL(
        '../../../../migrations/core/postgresql/001_0_4_0_core_baseline.sql',
        import.meta.url
      ),
      'utf8'
    );
    const plan = createDsqlGovernanceSchemaPlan('authrim_core_test', 'authrim_events_test');
    const qualify = (sql: string) =>
      sql.replace(
        /public\.(\w+)/gu,
        (_, name: string) =>
          `"${name === 'legal_hold_events' ? 'authrim_events_test' : 'authrim_core_test'}"."${name}"`
      );
    for (const table of plan.tables.filter(
      (table) => table.name !== 'authrim_governance_mutation_receipts'
    )) {
      const native = baseline.match(
        new RegExp(`CREATE TABLE public\\.${table.name} \\([\\s\\S]*?\\n\\);`, 'u')
      )?.[0];
      expect(native).toBeTruthy();
      const body = native?.slice(native.indexOf('(') + 1, native.lastIndexOf(')')) ?? '';
      expect(table.sql).toContain(qualify(body));
      for (const constraint of baseline.match(
        new RegExp(`ALTER TABLE ONLY public\\.${table.name}\\n    ADD CONSTRAINT [\\s\\S]*?;`, 'gu')
      ) ?? []) {
        expect(table.sql).toContain(
          qualify(constraint.slice(constraint.indexOf('ADD CONSTRAINT ') + 4, -1))
        );
      }
    }
    expect(plan.fullRuntimeReady).toBe(false);
    expect(plan.forbiddenRuntimeEventPrivileges).toContain('DELETE');
    expect(plan.indexes.every((index) => index.sql.includes('INDEX ASYNC'))).toBe(true);
    expect(plan.tables.find((table) => table.name === 'legal_hold_events')?.sql).toContain(
      'ON DELETE CASCADE'
    );
  });
  it('uses supported default physical order for the two nonunique history indexes', () => {
    const plan = createDsqlGovernanceSchemaPlan('authrim_core_test', 'authrim_events_test');
    const history = plan.indexes.filter((index) =>
      ['idx_legal_holds_account_history', 'idx_legal_hold_events_account'].includes(index.name)
    );
    expect(history).toEqual([
      {
        table: 'legal_holds',
        name: 'idx_legal_holds_account_history',
        sql: 'CREATE INDEX ASYNC idx_legal_holds_account_history ON "authrim_core_test"."legal_holds" (tenant_id, subject_id, created_at, id);',
      },
      {
        table: 'legal_hold_events',
        name: 'idx_legal_hold_events_account',
        sql: 'CREATE INDEX ASYNC idx_legal_hold_events_account ON "authrim_events_test"."legal_hold_events" (tenant_id, account_id, created_at, event_id);',
      },
    ]);
  });
  it('preserves every other baseline index key, predicate and uniqueness contract', () => {
    const baseline = readFileSync(
      new URL(
        '../../../../migrations/core/postgresql/001_0_4_0_core_baseline.sql',
        import.meta.url
      ),
      'utf8'
    );
    const plan = createDsqlGovernanceSchemaPlan('authrim_core_test', 'authrim_events_test');
    const others = plan.indexes.filter(
      (index) =>
        !['idx_legal_holds_account_history', 'idx_legal_hold_events_account'].includes(index.name)
    );
    expect(others).toHaveLength(3);
    for (const index of others) {
      const native = baseline.match(
        new RegExp(`CREATE (?:UNIQUE )?INDEX ${index.name} ON [^;]+;`, 'u')
      )?.[0];
      expect(native).toBeTruthy();
      expect(index.sql).toBe(
        native
          ?.replace(' INDEX ', ' INDEX ASYNC ')
          .replace(' USING btree ', ' ')
          .replace(`public.${index.table}`, `"authrim_core_test"."${index.table}"`)
      );
    }
    expect(others.find((index) => index.name === 'idx_legal_holds_one_active_account')?.sql).toBe(
      'CREATE UNIQUE INDEX ASYNC idx_legal_holds_one_active_account ON "authrim_core_test"."legal_holds" (tenant_id, subject_type, subject_id) WHERE (state = \'active\'::text);'
    );
  });
  it('requires separate event ownership and validates schema names', () => {
    expect(() => createDsqlGovernanceSchemaPlan('authrim_same', 'authrim_same')).toThrow(
      'event_schema_must_be_separate'
    );
    expect(() => createDsqlGovernanceSchemaPlan('public', 'authrim_events')).toThrow(
      'schema_invalid'
    );
    expect(() => createDsqlGroupBoundarySchemaPlan('authrim_x";DROP SCHEMA public')).toThrow(
      'schema_invalid'
    );
  });
  it('preserves the existing group boundary columns without adding an implicit status', () => {
    const sql = createDsqlGroupBoundarySchemaPlan('authrim_groups').tables[0].sql;
    expect(sql).toContain('status TEXT NOT NULL,created_at BIGINT NOT NULL');
    expect(sql).not.toContain('DEFAULT');
  });
});
