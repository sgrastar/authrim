import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { PLATFORM_MAPPING_TENANT_ID } from '../identity-mapping-owner';
import {
  IdentityMappingResolutionError,
  identityMappingResolutionReasonCode,
  loadMappingBindingBySetId,
  type IdentityMappingTier,
  type LoadMappingBindingBySetIdInput,
} from '../identity-mapping-set-binding';
import { openAdminDatabase, seedMapping, sqliteAdapter } from './identity-mapping-sqlite-fixture';

function input(
  adapter: DatabaseAdapter | null | undefined,
  overrides: Partial<LoadMappingBindingBySetIdInput> = {}
): LoadMappingBindingBySetIdInput {
  return {
    adapter,
    tenantId: 'tenant-a',
    setId: 'set-plat',
    tier: 'tenant_default',
    protocol: 'oidc',
    role: 'op',
    ...overrides,
  };
}

/** The error carries nothing of the underlying failure: no cause, and no secret in any view of it. */
function expectNoTrace(error: IdentityMappingResolutionError, secrets: string[]): void {
  expect(error.cause).toBeUndefined();
  const views = [
    error.message,
    error.stack ?? '',
    JSON.stringify(error),
    inspect(error, { depth: 10, showHidden: true }),
    JSON.stringify(Object.getOwnPropertyNames(error)),
  ].join('\n');
  for (const secret of secrets) expect(views).not.toContain(secret);
}

async function failure(promise: Promise<unknown>): Promise<IdentityMappingResolutionError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(IdentityMappingResolutionError);
  return error as IdentityMappingResolutionError;
}

describe('loadMappingBindingBySetId', () => {
  it.each<IdentityMappingTier>(['platform_default', 'tenant_default', 'client'])(
    'binds a platform-owned set for the %s tier, under the platform as owner',
    async (tier) => {
      const db = openAdminDatabase();
      seedMapping(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat' });

      const binding = await loadMappingBindingBySetId(input(sqliteAdapter(db), { tier }));

      expect(binding).toMatchObject({
        id: 'act-plat',
        tenantId: PLATFORM_MAPPING_TENANT_ID,
        fieldMappingSetId: 'set-plat',
        destinationProfileId: 'profile-plat',
      });
      expect(binding.edges.map((edge) => edge.id)).toEqual(['edge-plat-0']);
    }
  );

  it.each<IdentityMappingTier>(['tenant_default', 'client'])(
    'binds the calling tenant’s own set for the %s tier',
    async (tier) => {
      const db = openAdminDatabase();
      seedMapping(db, { owner: 'tenant-a', id: 'own' });

      await expect(
        loadMappingBindingBySetId(input(sqliteAdapter(db), { tier, setId: 'set-own' }))
      ).resolves.toMatchObject({ id: 'act-own', tenantId: 'tenant-a' });
    }
  );

  it('refuses the calling tenant’s own set for the platform tier', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-a', id: 'own' });

    const error = await failure(
      loadMappingBindingBySetId(
        input(sqliteAdapter(db), { tier: 'platform_default', setId: 'set-own' })
      )
    );

    expect(error).toMatchObject({
      code: 'set_missing',
      tier: 'platform_default',
      setId: 'set-own',
    });
  });

  it.each<IdentityMappingTier>(['platform_default', 'tenant_default', 'client'])(
    'answers a missing set and another tenant’s set alike for the %s tier',
    async (tier) => {
      const db = openAdminDatabase();
      seedMapping(db, { owner: 'tenant-b', id: 'other' });
      const adapter = sqliteAdapter(db);

      const other = await failure(
        loadMappingBindingBySetId(input(adapter, { tier, setId: 'set-other' }))
      );
      const missing = await failure(
        loadMappingBindingBySetId(input(adapter, { tier, setId: 'set-nothing' }))
      );

      expect(other).toMatchObject({ code: 'set_missing', tier, setId: 'set-other' });
      expect(missing).toMatchObject({ code: 'set_missing', tier, setId: 'set-nothing' });
      expect(other.message).toBe(missing.message);
      expect(`${other.message} ${JSON.stringify(other)}`).not.toContain('tenant-b');
    }
  );

  it('treats a tenant whose ID only resembles the owner’s as a stranger', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: 'tenant-b', id: 'other' });

    const error = await failure(
      loadMappingBindingBySetId(
        input(sqliteAdapter(db), { tenantId: 'tenant-b-2', setId: 'set-other' })
      )
    );

    expect(error.code).toBe('set_missing');
  });

  it('reads a reference by fieldKey, nodeId and profile_id as the shared readers do', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat' });
    db.prepare('UPDATE mapping_rule_edges SET source_ref_json = ?, target_ref_json = ?').run(
      JSON.stringify({ side: 'source', namespace: 'authrim.profile', fieldKey: 'email' }),
      JSON.stringify({
        side: 'destination',
        namespace: 'oidc.claim',
        nodeId: 'email',
        profile_id: 'profile-plat',
        catalog_entry_id: 'entry-plat',
      })
    );

    const binding = await loadMappingBindingBySetId(input(sqliteAdapter(db)));

    expect(binding.edges[0].sourceRef.path).toBe('email');
    expect(binding.edges[0].targetRef).toMatchObject({
      path: 'email',
      catalogEntryId: 'entry-plat',
    });
    expect(binding.destinationProfileIds).toEqual(['profile-plat']);
    expect(binding.destinationProfileId).toBe('profile-plat');
  });

  it('reports a set that is not active as set_inactive', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat', setState: 'draft' });

    await expect(
      failure(loadMappingBindingBySetId(input(sqliteAdapter(db))))
    ).resolves.toMatchObject({ code: 'set_inactive', tier: 'tenant_default', setId: 'set-plat' });
  });

  it('reports an active set with no active activation for the caller as set_inactive', async () => {
    const db = openAdminDatabase();
    seedMapping(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat', activationState: 'revoked' });
    seedMapping(db, {
      owner: PLATFORM_MAPPING_TENANT_ID,
      id: 'scoped',
      scope: { kind: 'tenant', tenantId: 'tenant-z' },
    });

    await expect(
      failure(loadMappingBindingBySetId(input(sqliteAdapter(db))))
    ).resolves.toMatchObject({ code: 'set_inactive' });
    await expect(
      failure(loadMappingBindingBySetId(input(sqliteAdapter(db), { setId: 'set-scoped' })))
    ).resolves.toMatchObject({ code: 'set_inactive' });
  });

  it('reports a mapping with two Destination Profiles as destination_profile_invalid', async () => {
    const db = openAdminDatabase();
    seedMapping(db, {
      owner: PLATFORM_MAPPING_TENANT_ID,
      id: 'plat',
      profiles: ['profile-one', 'profile-two'],
    });

    await expect(
      failure(loadMappingBindingBySetId(input(sqliteAdapter(db))))
    ).resolves.toMatchObject({ code: 'destination_profile_invalid', setId: 'set-plat' });
  });

  it('does not let the activation scope pick one of two Destination Profiles', async () => {
    const db = openAdminDatabase();
    seedMapping(db, {
      owner: PLATFORM_MAPPING_TENANT_ID,
      id: 'plat',
      scope: { kind: 'tenant', destinationProfileId: 'profile-one' },
      profiles: ['profile-one', 'profile-two'],
    });

    await expect(
      failure(loadMappingBindingBySetId(input(sqliteAdapter(db))))
    ).resolves.toMatchObject({ code: 'destination_profile_invalid' });
  });

  it('passes the version and the app on to the resolution', async () => {
    const db = openAdminDatabase();
    seedMapping(db, {
      owner: PLATFORM_MAPPING_TENANT_ID,
      id: 'plat',
      scope: { kind: 'tenant', clientId: 'client-1' },
    });
    const adapter = sqliteAdapter(db);

    await expect(
      loadMappingBindingBySetId(
        input(adapter, { tier: 'client', clientId: 'client-1', versionId: 'ver-plat' })
      )
    ).resolves.toMatchObject({ id: 'act-plat' });
    await expect(
      failure(loadMappingBindingBySetId(input(adapter, { clientId: 'client-2' })))
    ).resolves.toMatchObject({ code: 'set_inactive' });
    await expect(
      failure(
        loadMappingBindingBySetId(input(adapter, { clientId: 'client-1', versionId: 'ver-x' }))
      )
    ).resolves.toMatchObject({ code: 'set_inactive' });
  });

  it('reports a failing Admin database as admin_database_unavailable, keeping nothing of the failure but a code', async () => {
    const secret = 'secret-detail tenant-b row-value';
    const dbError = Object.assign(
      new Error(`D1_ERROR: no such table: field_mapping_sets ${secret}`),
      {
        tenant: 'tenant-b',
      }
    );
    const lookupFails = {
      queryOne: async () => {
        throw dbError;
      },
      query: async () => [],
    } as unknown as DatabaseAdapter;
    const error = await failure(loadMappingBindingBySetId(input(lookupFails)));

    expect(error).toMatchObject({
      code: 'admin_database_unavailable',
      setId: 'set-plat',
      reasonCode: 'no_such_table',
    });
    expectNoTrace(error, ['secret-detail', 'tenant-b', 'row-value']);

    const resolutionFails = {
      queryOne: async () => ({ tenant_id: PLATFORM_MAPPING_TENANT_ID, lifecycle_state: 'active' }),
      query: async () => {
        throw new Error(`D1_ERROR: timeout ${secret}`);
      },
    } as unknown as DatabaseAdapter;
    const second = await failure(loadMappingBindingBySetId(input(resolutionFails)));
    expect(second).toMatchObject({ code: 'admin_database_unavailable', reasonCode: 'd1_error' });
    expectNoTrace(second, ['secret-detail', 'tenant-b', 'row-value']);
  });

  it('has no fallback when the Admin database is not bound', async () => {
    for (const adapter of [undefined, null]) {
      await expect(failure(loadMappingBindingBySetId(input(adapter)))).resolves.toMatchObject({
        code: 'admin_database_unavailable',
        reasonCode: 'admin_database_not_configured',
        tier: 'tenant_default',
        setId: 'set-plat',
      });
    }
  });
});

describe('identityMappingResolutionReasonCode', () => {
  it.each([
    ['no_such_table', new Error('D1_ERROR: no such table: x')],
    ['no_such_column', new Error('no such column: y')],
    ['d1_error', new Error('D1_ERROR: something')],
    ['database_timeout', new Error('query timed out')],
    ['database_unavailable', new Error('connection overloaded')],
    ['admin_database_not_configured', new Error('DB_ADMIN is not configured')],
    ['no_such_table', Object.assign(new Error('x'), { code: 'no_such_table' })],
    ['d1_error', Object.assign(new Error('x'), { code: 'd1_error' })],
  ])('classifies as %s', (expected, error) => {
    expect(identityMappingResolutionReasonCode(error)).toBe(expected);
  });

  it.each([
    ['an own code naming a tenant', Object.assign(new Error('boom'), { code: 'tenant-b' })],
    ['a custom name', Object.assign(new Error('boom'), { name: 'tenant-b-row-7' })],
    ['an own code of another kind', Object.assign(new Error('boom'), { code: 'SQLITE_BUSY' })],
    ['a non-error value', 'tenant-b'],
    ['nothing', undefined],
  ])('reports %s as unknown', (_name, error) => {
    expect(identityMappingResolutionReasonCode(error)).toBe('unknown');
  });

  it('classifies from the message when the own code is not one of the fixed codes', () => {
    const error = Object.assign(new Error('D1_ERROR: no such table: t'), { code: 'tenant-b' });

    expect(identityMappingResolutionReasonCode(error)).toBe('no_such_table');
  });

  it('keeps an own code naming a tenant out of the resolution error and its views', async () => {
    const dbError = Object.assign(new Error('boom'), { code: 'tenant-b', name: 'tenant-b-row-7' });
    const adapter = {
      queryOne: async () => {
        throw dbError;
      },
      query: async () => [],
    } as unknown as DatabaseAdapter;

    const error = await failure(loadMappingBindingBySetId(input(adapter)));

    expect(error.reasonCode).toBe('unknown');
    expectNoTrace(error, ['tenant-b', 'row-7']);
  });
});
