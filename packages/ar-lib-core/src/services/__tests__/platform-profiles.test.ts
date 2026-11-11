import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readMigrationSource } from '../../../../../test/helpers/migration-source.mjs';
import type { DatabaseAdapter } from '../../db/adapter';
import type { Env } from '../../types/env';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import {
  AuthenticationMethodProfileRepository,
  SessionProfileRepository,
} from '../../repositories/admin/authentication-method-profile';
import { PlatformProfileRepository } from '../../repositories/admin/platform-profile';

const state = vi.hoisted(
  (): { adapter: unknown; switches: Record<string, unknown>; switchesFail: boolean } => ({
    adapter: null,
    switches: {},
    switchesFail: false,
  })
);
vi.mock('../admin-database-adapter', () => ({
  requireDedicatedAdminDatabaseAdapter: () => state.adapter,
}));
vi.mock('../effective-settings', () => ({
  resolvePlatformSettingsWithSources: async () => {
    if (state.switchesFail) throw new Error('settings unavailable');
    return { values: state.switches, sources: {} };
  },
}));

const { resolveNamedProfile, readProfileSwitch } = await import('../platform-profiles');
const { readSessionProfile } = await import('../session-profile');
const { readAuthenticationProfile } = await import('../registration/authentication-profile');
const { findPlatformProfileReferences, flowsNameProfile } =
  await import('../platform-profile-references');

const ADMIN_MIGRATIONS = new URL('../../../../../migrations/admin/d1/', import.meta.url);
const env = {} as Env;

function profileSchema(): DatabaseAdapter {
  const fixture = sqliteAdapter('admin');
  for (const file of [
    '013_authentication_method_profiles.sql',
    '014_session_profiles.sql',
    '015_platform_profiles.sql',
  ]) {
    fixture.db.exec(
      renderPortableMigrationSql(readMigrationSource(ADMIN_MIGRATIONS, file), 'sqlite')
    );
  }
  return fixture.adapter;
}

describe('what a named profile holds for a tenant', () => {
  let adapter: DatabaseAdapter;
  let platformId: string;
  let copyId: string;
  beforeEach(async () => {
    adapter = profileSchema();
    state.adapter = adapter;
    state.switches = {};
    state.switchesFail = false;
    const created = await new PlatformProfileRepository(adapter, 'session').create(
      { name: 'Short', values: { 'session.ttl': 600 } },
      null
    );
    if (created.status !== 'created') throw new Error('not created');
    platformId = created.profile.id;
    const copy = await new SessionProfileRepository(adapter).saveOverride(
      't1',
      { id: platformId, name: 'Short', version: 1 },
      { 'session.ttl': 300 },
      null,
      null
    );
    if (copy.status !== 'saved') throw new Error('not saved');
    copyId = copy.override.id;
  });

  it('is the tenant’s copy while changes are allowed and it is not locked', async () => {
    const resolved = await resolveNamedProfile(env, 't1', 'session', platformId);
    expect(resolved).toMatchObject({
      kind: 'platform',
      values: { 'session.ttl': 300 },
      overrideApplies: true,
    });
    // A tenant without a copy gets the platform's values.
    expect(await resolveNamedProfile(env, 't2', 'session', platformId)).toMatchObject({
      values: { 'session.ttl': 600 },
      overrideApplies: false,
    });
  });

  it('is the platform’s values, the copy kept, when changes are not allowed or it is locked', async () => {
    state.switches = { 'profiles.session.tenant_change_allowed': false };
    expect(await resolveNamedProfile(env, 't1', 'session', platformId)).toMatchObject({
      values: { 'session.ttl': 600 },
      overrideApplies: false,
      override: { values: { 'session.ttl': 300 } },
    });
    state.switches = {};
    await new PlatformProfileRepository(adapter, 'session').setLocked(platformId, true, 1);
    expect(await resolveNamedProfile(env, 't1', 'session', platformId)).toMatchObject({
      values: { 'session.ttl': 600 },
      overrideApplies: false,
    });
    // The method switch does not touch session profiles.
    state.switches = { 'profiles.method.tenant_change_allowed': false };
    await new PlatformProfileRepository(adapter, 'session').setLocked(platformId, false, 2);
    expect((await resolveNamedProfile(env, 't1', 'session', platformId)).kind).toBe('platform');
    expect(
      (await resolveNamedProfile(env, 't1', 'session', platformId)) as { overrideApplies: boolean }
    ).toMatchObject({ overrideApplies: true });
  });

  it('is still read once the platform deletes it (unlisted), and nothing once its row is gone', async () => {
    const repo = new PlatformProfileRepository(adapter, 'session');
    expect(await repo.claimDeleting(platformId, 'op')).toBe(true);
    expect(await repo.finishDeleting(platformId, 'op')).toBe(true);
    expect(await resolveNamedProfile(env, 't1', 'session', platformId)).toMatchObject({
      kind: 'platform',
      values: { 'session.ttl': 300 },
    });
    // A copy carried into an environment without its platform profile does not outlive it.
    await adapter.execute('DELETE FROM platform_session_profiles WHERE id = ?', [platformId]);
    expect(await resolveNamedProfile(env, 't1', 'session', platformId)).toEqual({
      kind: 'missing',
      id: platformId,
    });
    expect(await readSessionProfile(env, 't1', platformId)).toEqual({
      kind: 'missing',
      id: platformId,
    });
  });

  it('never reaches a copy by its own id', async () => {
    expect(await resolveNamedProfile(env, 't1', 'session', copyId)).toEqual({
      kind: 'missing',
      id: copyId,
    });
  });

  it('reads the tenant’s own profiles as before, and fails closed when the switch is unreadable', async () => {
    const own = await new AuthenticationMethodProfileRepository(adapter).create(
      't1',
      { name: 'Mine', values: { 'authentication-methods.passkey.login_enabled': false } },
      null
    );
    if (own.status !== 'created') throw new Error('not created');
    expect(await readAuthenticationProfile(env, 't1', own.profile.id)).toEqual({
      kind: 'profile',
      values: { 'authentication-methods.passkey.login_enabled': false },
    });
    expect(await readAuthenticationProfile(env, 't2', own.profile.id)).toEqual({ kind: 'missing' });
    state.switchesFail = true;
    // With a copy to decide on, an unreadable switch is not guessed at: the profile is unusable.
    expect(await readSessionProfile(env, 't1', platformId)).toEqual({
      kind: 'missing',
      id: platformId,
    });
    await expect(readProfileSwitch(env, 'session', 'tenant_change_allowed')).rejects.toThrow();
  });
});

describe('where a platform profile is named across tenants', () => {
  /** A Core database answering the Flow search for the tenants that name the profile. */
  const core = (named: boolean): DatabaseAdapter =>
    ({
      queryOne: vi.fn(async () => (named ? { hit: 1 } : null)),
    }) as unknown as DatabaseAdapter;

  it('lists the tenants that name it and the ones it could not read', async () => {
    const scan = await findPlatformProfileReferences({
      profileId: 'psp_1',
      listTenantIds: async () => ['a', 'b', 'c', 'd'],
      resolveCoreAdapter: async (tenantId) => {
        if (tenantId === 'c') return null;
        if (tenantId === 'd') throw new Error('routing');
        return core(tenantId === 'b');
      },
    });
    expect(scan.tenants).toEqual(['b']);
    expect(scan.unscanned).toEqual([
      { tenantId: 'c', reason: 'core_database_unavailable' },
      { tenantId: 'd', reason: 'core_database_unavailable' },
    ]);
  });

  it('reports a tenant directory it cannot read, or too many tenants, as incomplete', async () => {
    expect(
      (
        await findPlatformProfileReferences({
          profileId: 'psp_1',
          listTenantIds: async () => {
            throw new Error('down');
          },
          resolveCoreAdapter: async () => core(false),
        })
      ).unscanned
    ).toEqual([{ reason: 'tenant_directory_unavailable' }]);
    const many = await findPlatformProfileReferences({
      profileId: 'psp_1',
      tenantLimit: 2,
      listTenantIds: async (limit) => ['a', 'b', 'c'].slice(0, limit),
      resolveCoreAdapter: async () => core(false),
    });
    expect(many.unscanned).toEqual([{ reason: 'tenant_limit_exceeded' }]);
  });

  it('looks at drafts, published versions and running interactions’ versions, as text', async () => {
    const queryOne = vi.fn(async () => null);
    await flowsNameProfile({ queryOne } as unknown as DatabaseAdapter, 't1', 'psp_a%b', 100);
    const [sql, params] = queryOne.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('draft_editor_json LIKE');
    expect(sql).toContain('published_version_id');
    expect(sql).toContain('flow_interactions');
    // The id's LIKE wildcards are escaped.
    expect(params[1]).toBe('%psp\\_a\\%b%');
  });
});
