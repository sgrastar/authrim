import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import {
  OIDCIdentityMappingRuntimeError,
  toOidcIdentityMappingRuntimeError,
} from '../oidc-identity-mapping';
import { PLATFORM_MAPPING_TENANT_ID } from '../identity-mapping-owner';
import { resolveOidcIdentityMappingBinding } from '../identity-mapping-resolution';
import { IdentityMappingSelectionError } from '../identity-mapping-selection';
import { IdentityMappingResolutionError } from '../identity-mapping-set-binding';
import { openAdminDatabase, seedMapping, sqliteAdapter } from './identity-mapping-sqlite-fixture';

/**
 * Selecting and reading in one step. The real selection, effective-settings reader, set lookup and
 * resolver run here; the databases are SQLite with the real Admin baseline.
 */

const KEY = 'identity_mapping.oidc_default_set_id';

function kv(documents: Record<string, unknown>): KVNamespace {
  return {
    get: async (key: string) => (key in documents ? JSON.stringify(documents[key]) : null),
  } as unknown as KVNamespace;
}

const TENANT_DEFAULT = { 'settings:tenant:tenant-a:identity-mapping': { [KEY]: 'set-own' } };
const PLATFORM_DEFAULT = { 'settings:platform:identity-mapping': { [KEY]: 'set-plat' } };

function seeded() {
  const db = openAdminDatabase();
  seedMapping(db, { owner: 'tenant-a', id: 'own' });
  seedMapping(db, { owner: PLATFORM_MAPPING_TENANT_ID, id: 'plat' });
  return sqliteAdapter(db);
}

/** An adapter with every method, as `DB_ADMIN` of a Worker is taken for one. */
function complete(adapter: DatabaseAdapter) {
  return Object.assign(adapter, {
    execute: async () => ({ success: true, rowsAffected: 0 }),
    transaction: async () => undefined,
    batch: async () => [],
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'test' }),
    getType: () => 'test',
    close: async () => undefined,
  });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a failure');
    },
    (error: unknown) => error
  );
}

describe('resolveOidcIdentityMappingBinding', () => {
  it('reads the tenant default’s set under the Admin database', async () => {
    const { selection, binding } = await resolveOidcIdentityMappingBinding({
      env: { SETTINGS: kv(TENANT_DEFAULT) },
      tenantId: 'tenant-a',
      clientId: 'client-a',
      clientSelector: null,
      adminAdapter: seeded(),
    });

    expect(selection).toMatchObject({ kind: 'bound', tier: 'tenant_default', setId: 'set-own' });
    expect(binding).toMatchObject({ fieldMappingSetId: 'set-own', tenantId: 'tenant-a' });
  });

  it('reads the platform default’s set under the platform as owner', async () => {
    const { selection, binding } = await resolveOidcIdentityMappingBinding({
      env: { SETTINGS: kv(PLATFORM_DEFAULT) },
      tenantId: 'tenant-a',
      clientSelector: undefined,
      adminAdapter: seeded(),
    });

    expect(selection).toMatchObject({ tier: 'platform_default', setId: 'set-plat' });
    expect(binding).toMatchObject({
      fieldMappingSetId: 'set-plat',
      tenantId: PLATFORM_MAPPING_TENANT_ID,
    });
  });

  it('reads an app’s own set, pinned to the version it names', async () => {
    const adapter = seeded();
    const { selection, binding } = await resolveOidcIdentityMappingBinding({
      env: { SETTINGS: kv(PLATFORM_DEFAULT) },
      tenantId: 'tenant-a',
      clientSelector: { fieldMappingSetId: 'set-own', fieldMappingVersionId: 'ver-own' },
      adminAdapter: adapter,
    });
    expect(selection).toMatchObject({ tier: 'client', setId: 'set-own' });
    expect(binding?.fieldMappingVersionId).toBe('ver-own');

    const pinnedElsewhere = await failure(
      resolveOidcIdentityMappingBinding({
        env: { SETTINGS: kv({}) },
        tenantId: 'tenant-a',
        clientSelector: { fieldMappingSetId: 'set-own', fieldMappingVersionId: 'ver-other' },
        adminAdapter: adapter,
      })
    );
    expect(pinnedElsewhere).toBeInstanceOf(IdentityMappingResolutionError);
  });

  it('reads DB_ADMIN of the environment when no adapter is handed in', async () => {
    const { binding } = await resolveOidcIdentityMappingBinding({
      env: { SETTINGS: kv(TENANT_DEFAULT), DB_ADMIN: complete(seeded()) as never },
      tenantId: 'tenant-a',
      clientSelector: null,
    });
    expect(binding?.fieldMappingSetId).toBe('set-own');
  });

  describe('a selection of none', () => {
    it.each([
      ['no default', {}, null],
      [
        'the tenant opting out',
        { 'settings:tenant:tenant-a:identity-mapping': { [KEY]: 'none' }, ...PLATFORM_DEFAULT },
        null,
      ],
      ['the app opting out', { ...TENANT_DEFAULT }, { mode: 'none' }],
    ])('succeeds without a database for %s', async (_name, documents, clientSelector) => {
      const result = await resolveOidcIdentityMappingBinding({
        // No DB_ADMIN, no adapter: nothing to read.
        env: { SETTINGS: kv(documents) },
        tenantId: 'tenant-a',
        clientSelector,
      });
      expect(result.binding).toBeNull();
      expect(result.selection.kind).toBe('none');
    });
  });

  describe('a selection of a set', () => {
    it.each([
      ['the tenant default', TENANT_DEFAULT, null],
      ['the platform default', PLATFORM_DEFAULT, null],
      ['the app', {}, { fieldMappingSetId: 'set-own' }],
    ])(
      'fails with admin_database_unavailable for %s when DB_ADMIN is not bound',
      async (_name, documents, clientSelector) => {
        const error = await failure(
          resolveOidcIdentityMappingBinding({
            env: { SETTINGS: kv(documents) },
            tenantId: 'tenant-a',
            clientSelector,
          })
        );
        expect(error).toBeInstanceOf(IdentityMappingResolutionError);
        expect(error).toMatchObject({
          code: 'admin_database_unavailable',
          reasonCode: 'admin_database_not_configured',
        });
      }
    );

    it('does not fall back to the Core database', async () => {
      // A Core database answers every query with nothing: reading it would look like "no set".
      const reads: string[] = [];
      const core = {
        query: async (sql: string) => {
          reads.push(sql);
          return [];
        },
        queryOne: async (sql: string) => {
          reads.push(sql);
          return null;
        },
      };
      const error = await failure(
        resolveOidcIdentityMappingBinding({
          env: { SETTINGS: kv(TENANT_DEFAULT), DB: core } as never,
          tenantId: 'tenant-a',
          clientSelector: null,
        })
      );
      expect(error).toMatchObject({ code: 'admin_database_unavailable' });
      expect(reads).toEqual([]);
    });

    it.each([
      ['a set that does not exist', { fieldMappingSetId: 'set-nope' }, 'set_missing'],
      ['a set another tenant owns', { fieldMappingSetId: 'set-other' }, 'set_missing'],
    ])('fails for %s, as the tier it was chosen at', async (_name, clientSelector, code) => {
      const db = openAdminDatabase();
      seedMapping(db, { owner: 'tenant-b', id: 'other' });
      const error = await failure(
        resolveOidcIdentityMappingBinding({
          env: { SETTINGS: kv({}) },
          tenantId: 'tenant-a',
          clientSelector,
          adminAdapter: sqliteAdapter(db),
        })
      );
      expect(error).toMatchObject({ name: 'IdentityMappingResolutionError', code, tier: 'client' });
    });

    it('fails for a platform default that names a tenant’s set (the platform tier is the platform’s)', async () => {
      const error = await failure(
        resolveOidcIdentityMappingBinding({
          env: { SETTINGS: kv({ 'settings:platform:identity-mapping': { [KEY]: 'set-own' } }) },
          tenantId: 'tenant-a',
          clientSelector: null,
          adminAdapter: seeded(),
        })
      );
      expect(error).toMatchObject({ code: 'set_missing', tier: 'platform_default' });
    });

    it('fails for a set that is not active', async () => {
      const db = openAdminDatabase();
      seedMapping(db, { owner: 'tenant-a', id: 'own', setState: 'draft' });
      const error = await failure(
        resolveOidcIdentityMappingBinding({
          env: { SETTINGS: kv(TENANT_DEFAULT) },
          tenantId: 'tenant-a',
          clientSelector: null,
          adminAdapter: sqliteAdapter(db),
        })
      );
      expect(error).toMatchObject({ code: 'set_inactive', tier: 'tenant_default' });
    });

    it('fails for a set that points at more than one Destination Profile', async () => {
      const db = openAdminDatabase();
      seedMapping(db, { owner: 'tenant-a', id: 'own', profiles: ['profile-1', 'profile-2'] });
      const error = await failure(
        resolveOidcIdentityMappingBinding({
          env: { SETTINGS: kv(TENANT_DEFAULT) },
          tenantId: 'tenant-a',
          clientSelector: null,
          adminAdapter: sqliteAdapter(db),
        })
      );
      expect(error).toMatchObject({ code: 'destination_profile_invalid' });
    });
  });

  it('lets a failure of the selection through: an unusable default is not read around', async () => {
    const error = await failure(
      resolveOidcIdentityMappingBinding({
        env: {
          SETTINGS: kv({
            'settings:tenant:tenant-a:identity-mapping': { [KEY]: '' },
            ...PLATFORM_DEFAULT,
          }),
        },
        tenantId: 'tenant-a',
        clientSelector: null,
        adminAdapter: seeded(),
      })
    );
    expect(error).toBeInstanceOf(IdentityMappingSelectionError);
    expect(error).toMatchObject({ code: 'default_setting_invalid', tier: 'tenant_default' });
  });
});

describe('toOidcIdentityMappingRuntimeError', () => {
  const resolution = (code: IdentityMappingResolutionError['code']) =>
    new IdentityMappingResolutionError(code, 'tenant_default', 'set-own', 'd1_error');

  it.each([
    ['set_missing', 'policy.missing_identity_mapping_binding'],
    ['set_inactive', 'policy.missing_identity_mapping_binding'],
    ['destination_profile_invalid', 'policy.invalid_destination_profile_binding'],
  ] as const)('answers %s as the error the 400 comes from (%s)', (code, detail) => {
    const converted = toOidcIdentityMappingRuntimeError(resolution(code), { clientId: 'client-a' });
    expect(converted).toBeInstanceOf(OIDCIdentityMappingRuntimeError);
    expect((converted as OIDCIdentityMappingRuntimeError).details).toEqual({
      code: detail,
      fieldMappingSetId: 'set-own',
      clientId: 'client-a',
    });
  });

  it('leaves a database that cannot be read as it is: the 500', () => {
    const error = resolution('admin_database_unavailable');
    expect(toOidcIdentityMappingRuntimeError(error)).toBe(error);
  });

  it.each([
    ['default_setting_invalid', 'tenant_default', 'policy.invalid_default_identity_mapping'],
    ['client_selector_invalid', 'client', 'policy.invalid_client_identity_mapping'],
  ] as const)('answers %s as the 400', (code, tier, detail) => {
    const converted = toOidcIdentityMappingRuntimeError(
      new IdentityMappingSelectionError(code, tier, undefined),
      { clientId: 'client-a' }
    );
    expect(converted).toBeInstanceOf(OIDCIdentityMappingRuntimeError);
    expect((converted as OIDCIdentityMappingRuntimeError).details).toMatchObject({
      code: detail,
      clientId: 'client-a',
    });
  });

  it('leaves unreadable settings and every other error as they are: the 500', () => {
    for (const error of [
      new IdentityMappingSelectionError('settings_unreadable', undefined, undefined, 'd1_error'),
      new Error('boom'),
      'text',
    ]) {
      expect(toOidcIdentityMappingRuntimeError(error)).toBe(error);
    }
  });

  it('carries no value, row or reason of the underlying failure into the wrapped error', () => {
    const converted = toOidcIdentityMappingRuntimeError(resolution('set_missing')) as Error;
    expect(JSON.stringify(converted) + converted.message).not.toContain('d1_error');
  });
});
