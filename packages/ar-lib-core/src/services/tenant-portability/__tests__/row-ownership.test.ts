import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import { renderPortableMigrationSql } from '../../../migrations/sql-portability';
import { backupOwnershipPredicate, type BackupRowOwnership } from '../row-ownership';
import { requireBackupOwnership, TENANT_BACKUP_OWNERSHIP_RULES } from '../ownership-registry';

const identity = { tenantId: 'tenant-a', tenantKey: 'opaque-a' };

describe('backup row ownership', () => {
  it('selects indirect children without importing another tenant or an orphan', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE object_catalog (id TEXT PRIMARY KEY, tenant_id TEXT);
        CREATE TABLE object_catalog_objects (id TEXT PRIMARY KEY, catalog_id TEXT);
        INSERT INTO object_catalog VALUES ('a','tenant-a'),('b','tenant-b');
        INSERT INTO object_catalog_objects VALUES ('owned','a'),('foreign','b'),('orphan','absent');`);
      const predicate = backupOwnershipPredicate(
        requireBackupOwnership('core', 'object_catalog_objects'),
        identity
      );
      const rows = db
        .prepare(`SELECT id FROM object_catalog_objects AS backup_row WHERE ${predicate.sql}`)
        .all(...predicate.params);
      expect(rows).toEqual([{ id: 'owned' }]);
    } finally {
      db.close();
    }
  });

  it('uses every composite parent-key component when the same ID has multiple versions', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE plans (id TEXT, version INTEGER, tenant_id TEXT, PRIMARY KEY (id,version));
        CREATE TABLE steps (id TEXT, plan_id TEXT, plan_version INTEGER);
        INSERT INTO plans VALUES ('p',1,'tenant-a'),('p',2,'tenant-b');
        INSERT INTO steps VALUES ('owned','p',1),('foreign','p',2);`);
      const predicate = backupOwnershipPredicate(
        {
          kind: 'parent',
          table: 'plans',
          keys: [
            { child: 'plan_id', parent: 'id' },
            { child: 'plan_version', parent: 'version' },
          ],
          ownership: { kind: 'tenant', column: 'tenant_id', identity: 'tenantId' },
        },
        identity
      );
      expect(
        db
          .prepare(`SELECT id FROM steps AS backup_row WHERE ${predicate.sql}`)
          .all(...predicate.params)
      ).toEqual([{ id: 'owned' }]);
    } finally {
      db.close();
    }
  });

  it('separates platform defaults, tenant scopes and opaque log identities', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(`CREATE TABLE items (id TEXT, scope_type TEXT, scope_id TEXT, tenant_key TEXT);
        INSERT INTO items VALUES ('owned','tenant','tenant-a','opaque-a'),
          ('foreign','tenant','tenant-b','opaque-b'), ('platform','platform','tenant-a',NULL);`);
      for (const rule of [
        requireBackupOwnership('admin', 'admin_destinations'),
        requireBackupOwnership('core', 'log_object_catalog'),
      ]) {
        const predicate = backupOwnershipPredicate(rule, identity);
        expect(
          db
            .prepare(`SELECT id FROM items AS backup_row WHERE ${predicate.sql}`)
            .all(...predicate.params)
        ).toEqual([{ id: 'owned' }]);
      }
    } finally {
      db.close();
    }
  });

  it('binds hostile tenant IDs as data and rejects unsafe schema identifiers', () => {
    const rule: BackupRowOwnership = { kind: 'tenant', column: 'tenant_id', identity: 'tenantId' };
    const tenantId = "a' OR 1=1 --";
    const predicate = backupOwnershipPredicate(rule, { ...identity, tenantId });
    expect(predicate.sql).not.toContain(tenantId);
    expect(predicate.params).toEqual([tenantId]);
    expect(() =>
      backupOwnershipPredicate({ ...rule, column: 'id; DROP TABLE items' }, identity)
    ).toThrow('invalid_identifier');
    expect(() => requireBackupOwnership('core', 'unknown_table')).toThrow('ownership_unresolved');
    expect(() => backupOwnershipPredicate(rule, { ...identity, tenantKey: '' })).toThrow(
      'missing_identity'
    );
  });

  it('rejects empty joins, duplicate joins, cycles and alias collisions', () => {
    const rule: BackupRowOwnership = {
      kind: 'parent',
      table: 'parents',
      keys: [],
      ownership: { kind: 'tenant', column: 'tenant_id', identity: 'tenantId' },
    };
    expect(() => backupOwnershipPredicate(rule, identity)).toThrow('invalid_parent_keys');
    rule.keys = [
      { child: 'parent_id', parent: 'id' },
      { child: 'parent_id', parent: 'other' },
    ];
    expect(() => backupOwnershipPredicate(rule, identity)).toThrow('invalid_parent_keys');
    rule.keys = [{ child: 'parent_id', parent: 'id' }];
    expect(() => backupOwnershipPredicate(rule, identity, 'backup_parent_0')).toThrow(
      'alias_collision'
    );
    rule.ownership = rule;
    expect(() => backupOwnershipPredicate(rule, identity)).toThrow('depth_exceeded');
  });

  it('validates every registered selector against actual manifest-selected schemas', () => {
    const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
    const inventory = inventoryBackupSchemas(root);
    const names = TENANT_BACKUP_OWNERSHIP_RULES.map((rule) => `${rule.family}:${rule.table}`);
    expect(new Set(names).size).toBe(names.length);
    for (const stream of inventory.inspectedStreams) {
      const rules = TENANT_BACKUP_OWNERSHIP_RULES.filter(
        (rule) => stream.id === `${rule.family}-d1`
      );
      if (!rules.length) continue;
      const db = new DatabaseSync(':memory:');
      try {
        for (const migration of stream.migrations)
          db.exec(
            renderPortableMigrationSql(readFileSync(`${root}${migration.file}`, 'utf8'), 'sqlite')
          );
        for (const rule of rules) {
          const predicate = backupOwnershipPredicate(rule.ownership, identity);
          expect(
            () =>
              db
                .prepare(`SELECT 1 FROM "${rule.table}" AS backup_row WHERE ${predicate.sql}`)
                .all(...predicate.params),
            `${rule.family}:${rule.table}`
          ).not.toThrow();
        }
      } finally {
        db.close();
      }
    }
  });
});
