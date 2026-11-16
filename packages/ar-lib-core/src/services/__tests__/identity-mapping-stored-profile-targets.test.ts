import { describe, expect, it } from 'vitest';
import { resolveRuntimeIdentityMappingBinding } from '../identity-mapping-runtime-resolver';
import { openAdminDatabase, seedMapping, sqliteAdapter } from './identity-mapping-sqlite-fixture';

describe.each([
  ['oidc', 'op'],
  ['saml', 'idp'],
  ['vc', 'issuer'],
])('stored profile metadata for %s/%s', (protocol, role) => {
  it.each(['profileId', 'profile_id'])(
    'retains %s on request without changing any executable reference or default binding',
    async (spelling) => {
      const db = openAdminDatabase();
      try {
        seedMapping(db, { owner: 'tenant-a', id: 'profile-metadata' });
        const target = JSON.stringify({
          side: 'destination',
          namespace: 'authrim.profile',
          path: 'email',
          [spelling]: 'profile-profile-metadata',
        });
        db.prepare('UPDATE mapping_rules SET target_ref_json = ?').run(target);
        db.prepare('UPDATE mapping_rule_edges SET target_ref_json = ?').run(target);
        const adapter = sqliteAdapter(db);
        const context = {
          tenantId: 'tenant-a',
          fieldMappingSetId: 'set-profile-metadata',
          protocol,
          role,
        };
        const ordinary = await resolveRuntimeIdentityMappingBinding(adapter, context);
        const inspected = await resolveRuntimeIdentityMappingBinding(adapter, {
          ...context,
          includeStoredProfileTargets: true,
        });
        if (!ordinary || !inspected) throw new Error('Expected active fixture binding');
        expect(ordinary).not.toHaveProperty('storedProfileTargets');
        const { storedProfileTargets, ...executableBinding } = inspected;
        expect(executableBinding).toEqual(ordinary);
        expect(storedProfileTargets).toContainEqual({
          side: 'destination',
          namespace: 'authrim.profile',
          path: 'email',
          catalogEntryId: undefined,
          valueType: undefined,
          profileId: 'profile-profile-metadata',
        });
        for (const rule of inspected.graphRules ?? []) {
          expect(rule.targetRef).not.toHaveProperty('profileId');
          expect(rule.targetRef).not.toHaveProperty('profile_id');
          for (const edge of rule.edges) {
            expect(edge.targetRef).not.toHaveProperty('profileId');
            expect(edge.targetRef).not.toHaveProperty('profile_id');
          }
        }
      } finally {
        db.close();
      }
    }
  );
});
