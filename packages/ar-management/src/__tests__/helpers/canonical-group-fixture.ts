import { vi } from 'vitest';
import type { SQLInputValue } from '../test-sqlite';
import { openCoreStore } from './core-schema-sqlite';

const CANONICAL_GROUP_SQL = /"groups"|\bgroup_memberships\b|\bgroup_role_assignments\b/u;

export interface CanonicalGroupFixture {
  readonly db: ReturnType<typeof openCoreStore>['db'];
  /** The `groups` rows by id, each with `name` (its display name) as SCIM shows it. */
  groups(): Map<string, Record<string, unknown>>;
  memberships(): Array<Record<string, unknown>>;
  seedGroup(input: {
    id: string;
    displayName: string;
    externalId?: string | null;
    kind?: string;
    parentGroupId?: string | null;
    createdAt?: number;
  }): void;
  seedMembership(input: {
    groupId: string;
    subjectId: string;
    source?: string;
    sourceRef?: string;
    state?: string;
  }): void;
  close(): void;
}

/**
 * Real canonical group tables (migration 015) behind a D1 binding fake: statements naming
 * `groups`, `group_memberships` or `group_role_assignments` run against SQLite, every other
 * statement keeps the fake's own behavior.
 */
export function installCanonicalGroupFixture(
  binding: D1Database,
  tenantId = 'default'
): CanonicalGroupFixture {
  // The baseline seeds the default tenant itself; the store's own seed tenant is not used.
  const { db } = openCoreStore('canonical-group-fixture');
  const prepare = vi.spyOn(binding, 'prepare');
  const prepareOriginal = prepare.getMockImplementation();
  if (!prepareOriginal) throw new Error('core_prepare_fixture_missing');
  prepare.mockImplementation((sql) => {
    if (!CANONICAL_GROUP_SQL.test(sql)) return prepareOriginal.call(binding, sql);
    const statement = (params: unknown[] = []): D1PreparedStatement => {
      const values = params.map((value): SQLInputValue => {
        if (value === undefined) throw new Error(`D1_TYPE_ERROR: undefined bind value for ${sql}`);
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        )
          return value;
        if (typeof value === 'boolean') return value ? 1 : 0;
        throw new Error('canonical_group_fixture_parameter_invalid');
      });
      return {
        bind: (...next: unknown[]) => statement(next),
        first: async () => db.prepare(sql).get(...values) ?? null,
        all: async () => ({ success: true, results: db.prepare(sql).all(...values) }),
        run: async () => ({
          success: true,
          results: [],
          meta: { changes: Number(db.prepare(sql).run(...values).changes) },
        }),
      } as unknown as D1PreparedStatement;
    };
    return statement();
  });
  return {
    db,
    groups() {
      const rows = db.prepare('SELECT * FROM "groups" WHERE tenant_id = ?').all(tenantId) as Array<
        Record<string, unknown>
      >;
      return new Map(rows.map((row) => [String(row.id), { ...row, name: row.display_name }]));
    },
    memberships() {
      return db
        .prepare('SELECT * FROM group_memberships ORDER BY subject_id, group_id, source_ref')
        .all() as Array<Record<string, unknown>>;
    },
    seedGroup(input) {
      const createdAt = input.createdAt ?? Date.now();
      db.prepare(
        `INSERT INTO "groups" (id, tenant_id, group_key, display_name, parent_group_id, kind,
           external_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.id,
        tenantId,
        `${input.kind ?? 'scim'}:${input.id}`,
        input.displayName,
        input.parentGroupId ?? null,
        input.kind ?? 'scim',
        input.externalId ?? null,
        createdAt,
        createdAt
      );
    },
    seedMembership(input) {
      db.prepare(
        `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source,
           source_ref, lifecycle_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`
      ).run(
        crypto.randomUUID(),
        tenantId,
        input.groupId,
        input.subjectId,
        input.source ?? 'scim',
        input.sourceRef ?? 'scim',
        input.state ?? 'active'
      );
    },
    close() {
      db.close();
    },
  };
}
