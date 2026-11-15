import { describe, expect, it } from 'vitest';
import {
  loadRuntimeMappingGraph,
  resolveRuntimeIdentityMappingBinding,
} from '../identity-mapping-runtime-resolver';
import { openAdminDatabase, seedMapping, sqliteAdapter } from './identity-mapping-sqlite-fixture';

describe('a transform step that takes no input edge', () => {
  it('is read with no input edge and the output target it names itself', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'a' });
    const target = { side: 'destination', namespace: 'oidc.claim', path: 'sub' };
    db.prepare(
      `INSERT INTO mapping_transform_steps (id, tenant_id, rule_id, edge_id, step_order, operation, parameters_json, target_ref_json, created_at, updated_at)
       VALUES ('step-identifier', 'tenant-a', 'rule-a', NULL, 1, 'persistent_identifier', '{}', ?, 1, 1)`
    ).run(JSON.stringify(target));

    const graph = await loadRuntimeMappingGraph(sqliteAdapter(db), 'tenant-a', 'ver-a');
    const identifier = graph.transforms.find((step) => step.id === 'step-identifier');
    expect(identifier).toMatchObject({
      operation: 'persistent_identifier',
      inputEdgeIds: [],
      outputTargetRef: target,
    });
    // A step on an edge still writes where its edge does.
    const trim = graph.transforms.find((step) => step.operation === 'trim');
    expect(trim?.inputEdgeIds).toHaveLength(1);
    expect(trim?.outputTargetRef.path).not.toBe('sub');
  });

  it('counts the Destination Profile a step names as its own output target', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'a' });
    // The version's only output is the identifier step: no edge, no other step.
    db.exec(`DELETE FROM mapping_transform_steps; DELETE FROM mapping_rule_edges;`);
    db.prepare(
      `INSERT INTO mapping_transform_steps (id, tenant_id, rule_id, edge_id, step_order, operation, parameters_json, target_ref_json, created_at, updated_at)
       VALUES ('step-identifier', 'tenant-a', 'rule-a', NULL, 0, 'persistent_identifier', '{}', ?, 1, 1)`
    ).run(
      JSON.stringify({
        side: 'destination',
        profileId: 'profile-a',
        namespace: 'oidc.claim',
        path: 'sub',
      })
    );
    const adapter = sqliteAdapter(db);
    const base = { tenantId: 'tenant-a', protocol: 'oidc', role: 'op' } as const;
    // Found by the profile it releases into, and the profile is the one binding the release.
    const byProfile = await resolveRuntimeIdentityMappingBinding(adapter, {
      ...base,
      destinationProfileId: 'profile-a',
    });
    expect(byProfile?.destinationProfileIds).toEqual(['profile-a']);
    expect(byProfile?.destinationProfileId).toBe('profile-a');
    expect(byProfile?.transforms.map((step) => step.id)).toEqual(['step-identifier']);
    // Named directly: the same single profile, not "no profile".
    const named = await resolveRuntimeIdentityMappingBinding(adapter, {
      ...base,
      fieldMappingSetId: 'set-a',
    });
    expect(named?.destinationProfileIds).toEqual(['profile-a']);
  });
});
