import { describe, expect, it } from 'vitest';
import { findImplicitOidcActivations } from '../identity-mapping-implicit-activations';
import { openAdminDatabase, seedMapping, sqliteAdapter } from './identity-mapping-sqlite-fixture';

/** The activations the OIDC release used to apply to an app naming no Mapping Set. */
describe('findImplicitOidcActivations', () => {
  const find = (db: ReturnType<typeof openAdminDatabase>, clientId?: string) =>
    findImplicitOidcActivations(sqliteAdapter(db), { tenantId: 'tenant-a', clientId });

  it.each([
    [{ kind: 'tenant' }],
    [{}],
    [{ kind: 'tenant', protocol: 'oidc', role: 'op' }],
    [{ kind: 'tenant', tenantId: 'tenant-a' }],
  ])('finds an activation whose scope is %j, with the set’s ID and name only', async (scope) => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'x', scope });

    const found = await find(db);

    expect(found).toEqual([{ activationId: 'act-x', setId: 'set-x', setName: 'Set x' }]);
  });

  it.each([
    [{ kind: 'tenant', protocol: 'saml' }],
    [{ kind: 'tenant', role: 'rp' }],
    [{ kind: 'tenant', tenantId: 'tenant-z' }],
    [{ kind: 'tenant', providerId: 'idp-1' }],
    [{ kind: 'tenant', clientId: 'app-1' }],
  ])('does not find one whose scope is %j when no app is named', async (scope) => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'x', scope });

    expect(await find(db)).toEqual([]);
  });

  it('finds an activation that names an app only for that app', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'x', scope: { kind: 'tenant', clientId: 'app-1' } });

    expect(await find(db, 'app-1')).toHaveLength(1);
    expect(await find(db, 'app-2')).toEqual([]);
  });

  it('reads the rows of the tenant only', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-b', id: 'b' });
    seedMapping(db, { owner: 'platform', id: 'p' });

    expect(await find(db)).toEqual([]);
  });

  it('leaves out an activation that is not active, or without an active compiled snapshot', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'off', activationState: 'inactive' });
    seedMapping(db, { owner: 'tenant-a', id: 'nosnap' });
    db.prepare(
      "UPDATE compiled_mapping_snapshots SET lifecycle_state = 'draft' WHERE id = 'snap-nosnap'"
    ).run();

    expect(await find(db)).toEqual([]);
  });

  it('counts a scope that is not JSON as having none', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'x' });
    db.prepare("UPDATE field_mapping_activations SET activation_scope_json = 'not json'").run();

    expect(await find(db)).toHaveLength(1);
  });

  it('stops at the limit, most recently activated first', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'old' });
    seedMapping(db, { owner: 'tenant-a', id: 'new' });
    db.prepare(
      "UPDATE field_mapping_activations SET activated_at = 500 WHERE id = 'act-new'"
    ).run();

    const found = await findImplicitOidcActivations(sqliteAdapter(db), {
      tenantId: 'tenant-a',
      limit: 1,
    });

    expect(found.map((item) => item.activationId)).toEqual(['act-new']);
  });

  it('fails when the Admin database cannot be read, so the caller can say it could not look', async () => {
    const db = openAdminDatabase();
    db.exec('DROP TABLE field_mapping_activations');

    await expect(find(db)).rejects.toThrow();
  });
});
