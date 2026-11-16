import { describe, expect, it } from 'vitest';
import { openAdminDatabase, seedMapping } from './identity-mapping-sqlite-fixture';

describe('persisted mapping input constraints', () => {
  it.each(['rule', 'version', 'set'])('cascades input removal when deleting its %s', (parent) => {
    const db = openAdminDatabase();
    try {
      seedMapping(db, { owner: 'tenant-a', id: 'a' });
      db.exec('PRAGMA foreign_keys=ON');
      const table =
        parent === 'rule'
          ? 'mapping_rules'
          : parent === 'version'
            ? 'field_mapping_versions'
            : 'field_mapping_sets';
      const id = parent === 'rule' ? 'rule-a' : parent === 'version' ? 'ver-a' : 'set-a';
      db.prepare(`DELETE FROM ${table} WHERE tenant_id=? AND id=?`).run('tenant-a', id);
      expect(
        db.prepare('SELECT count(*) AS count FROM mapping_transform_step_inputs').get()
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it.each(['edge', 'step', 'tenant'])(
    'refuses imported cross-owner %s references on INSERT and UPDATE',
    (reference) => {
      const db = openAdminDatabase();
      try {
        seedMapping(db, { owner: 'tenant-a', id: 'a' });
        seedMapping(db, { owner: reference === 'tenant' ? 'tenant-b' : 'tenant-a', id: 'b' });
        const edge = reference === 'step' ? null : 'edge-b-0';
        const step = reference === 'step' ? 'transform-b' : null;
        expect(() =>
          db
            .prepare(
              'INSERT INTO mapping_transform_step_inputs (tenant_id,step_id,position,edge_id,input_step_id) VALUES (?,?,1,?,?)'
            )
            .run('tenant-a', 'transform-a', edge, step)
        ).toThrow('same tenant and rule');
        expect(() =>
          db
            .prepare(
              'UPDATE mapping_transform_step_inputs SET edge_id=?,input_step_id=? WHERE tenant_id=? AND step_id=?'
            )
            .run(edge, step, 'tenant-a', 'transform-a')
        ).toThrow('same tenant and rule');
      } finally {
        db.close();
      }
    }
  );
});
