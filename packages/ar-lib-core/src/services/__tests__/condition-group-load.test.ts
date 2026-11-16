import { describe, expect, it } from 'vitest';
import { evaluateMappingRule } from '@authrim/ar-lib-field-mapping/authoring';
import { loadRuntimeMappingGraph } from '../identity-mapping-runtime-resolver';
import { openAdminDatabase, seedMapping, sqliteAdapter } from './identity-mapping-sqlite-fixture';

function storedGroup(match: unknown) {
  const db = openAdminDatabase();
  seedMapping(db, { owner: 'tenant-a', id: 'a' });
  db.prepare(
    `UPDATE mapping_transform_steps SET operation='conditional', parameters_json=? WHERE id='transform-a'`
  ).run(
    JSON.stringify({
      condition: JSON.stringify({
        kind: 'group',
        match,
        children: [{ kind: 'rule', field: 'department', operator: 'eq', value: 'Engineering' }],
      }),
      valueType: 'as_text',
      thenValue: 'member',
      elseMode: 'fixed',
      elseValue: 'not-member',
    })
  );
  db.exec(`UPDATE mapping_transform_step_inputs SET name='value' WHERE step_id='transform-a';
    INSERT INTO mapping_transform_step_inputs (tenant_id,step_id,position,edge_id,name)
    VALUES ('tenant-a','transform-a',1,'edge-a-0','field:department');`);
  return db;
}

describe('stored condition group match validation', () => {
  it.each(
    [['all'], ['any'], ['none'], [['all']], [], null, 0, true, {}, { match: 'all' }].map(
      (match) => ({ match })
    )
  )('refuses non-string group match $match on load', async ({ match }) => {
    const db = storedGroup(match);
    try {
      await expect(loadRuntimeMappingGraph(sqliteAdapter(db), 'tenant-a', 'ver-a')).rejects.toThrow(
        'invalid_transform: stored graph is invalid'
      );
    } finally {
      db.close();
    }
  });

  it.each([
    { match: 'all', expected: 'member' },
    { match: 'any', expected: 'member' },
    { match: 'none', expected: 'not-member' },
  ])('loads and evaluates valid $match', async ({ match, expected }) => {
    const db = storedGroup(match);
    try {
      const loaded = await loadRuntimeMappingGraph(sqliteAdapter(db), 'tenant-a', 'ver-a');
      const graph = loaded.graphRules[0];
      const evaluated = evaluateMappingRule({
        rule: graph,
        sourceValues: [{ sourceRef: graph.edges[0].sourceRef, value: 'Engineering' }],
      });
      expect(evaluated.reasons).toEqual([]);
      expect(evaluated.output).toMatchObject({ kind: 'value', envelope: { value: expected } });
    } finally {
      db.close();
    }
  });
});
