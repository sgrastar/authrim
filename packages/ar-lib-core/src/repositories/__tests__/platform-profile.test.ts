import { beforeEach, describe, expect, it } from 'vitest';
import { readMigrationSource } from '../../../../../test/helpers/migration-source.mjs';
import type { DatabaseAdapter } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import {
  AUTHENTICATION_METHOD_PROFILE_LIMIT,
  AuthenticationMethodProfileRepository,
  SessionProfileRepository,
} from '../admin/authentication-method-profile';
import { PlatformProfileRepository, isPlatformProfileId } from '../admin/platform-profile';
import { sqliteAdapter } from './sqlite-core-schema';

const ADMIN_MIGRATIONS = new URL('../../../../../migrations/admin/d1/', import.meta.url);

/** The admin schema with the profile tables as migrations 013–015 leave them. */
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

describe('the platform’s profiles', () => {
  let adapter: DatabaseAdapter;
  beforeEach(() => {
    adapter = profileSchema();
  });

  it('are created with an id of their kind, named once, and changed by version', async () => {
    const repo = new PlatformProfileRepository(adapter, 'session');
    const created = await repo.create({ name: 'Short', values: { 'session.ttl': 600 } }, 'op');
    expect(created.status).toBe('created');
    if (created.status !== 'created') return;
    expect(created.profile.id.startsWith('psp_')).toBe(true);
    expect(isPlatformProfileId('session', created.profile.id)).toBe(true);
    expect(isPlatformProfileId('method', created.profile.id)).toBe(false);
    expect(created.profile).toMatchObject({ locked: false, state: 'active', version: 1 });
    expect((await repo.create({ name: ' short ', values: {} }, null)).status).toBe('name_taken');

    const updated = await repo.update(created.profile.id, { name: 'Shorter', values: {} }, 1);
    expect(updated).toMatchObject({ status: 'updated', profile: { version: 2, name: 'Shorter' } });
    expect(await repo.update(created.profile.id, { name: 'X', values: {} }, 1)).toEqual({
      status: 'conflict',
      currentVersion: 2,
    });
    const locked = await repo.setLocked(created.profile.id, true, 2);
    expect(locked).toMatchObject({ status: 'updated', profile: { locked: true, version: 3 } });
    // A tenant-shaped id is not looked up at all.
    expect(await repo.find('not-a-platform-id')).toBeNull();
  });

  it('are deleted by one operation at a time, and kept (unlisted) once deleted', async () => {
    const repo = new PlatformProfileRepository(adapter, 'method');
    const created = await repo.create({ name: 'Passkeys', values: {} }, null);
    if (created.status !== 'created') throw new Error('not created');
    const id = created.profile.id;
    expect(await repo.finishDeleting(id, 'op-a')).toBe(false);
    expect(await repo.claimDeleting(id, 'op-a')).toBe(true);
    // A second delete meanwhile is refused, and cannot give the first one's claim back.
    expect(await repo.claimDeleting(id, 'op-b')).toBe(false);
    expect(await repo.releaseDeleting(id, 'op-b')).toBe(false);
    expect(await repo.finishDeleting(id, 'op-b')).toBe(false);
    expect(await repo.finishDeleting(id, 'op-a')).toBe(true);
    expect(await repo.list()).toEqual([]);
    // Still read (a Flow that came to name it keeps its profile), and its name is free again.
    expect((await repo.find(id))?.state).toBe('deleted');
    expect((await repo.create({ name: 'Passkeys', values: {} }, null)).status).toBe('created');
  });

  it('are taken over from a delete that has held them too long', async () => {
    const repo = new PlatformProfileRepository(adapter, 'method');
    const created = await repo.create({ name: 'Passkeys', values: {} }, null);
    if (created.status !== 'created') throw new Error('not created');
    const id = created.profile.id;
    const start = 1_000_000;
    expect(await repo.claimDeleting(id, 'died', start)).toBe(true);
    expect(await repo.claimDeleting(id, 'next', start + 60_000)).toBe(false);
    expect(await repo.claimDeleting(id, 'next', start + 16 * 60_000)).toBe(true);
    // The one that died cannot finish what it no longer holds.
    expect(await repo.finishDeleting(id, 'died')).toBe(false);
    expect(await repo.releaseDeleting(id, 'next')).toBe(true);
  });

  it('are given back as active by the operation that claimed them', async () => {
    const repo = new PlatformProfileRepository(adapter, 'method');
    const created = await repo.create({ name: 'Passkeys', values: {} }, null);
    if (created.status !== 'created') throw new Error('not created');
    expect(await repo.claimDeleting(created.profile.id, 'op-a')).toBe(true);
    expect(await repo.releaseDeleting(created.profile.id, 'op-a')).toBe(true);
    expect((await repo.find(created.profile.id))?.state).toBe('active');
  });
});

describe('a tenant’s copy of a platform profile', () => {
  let adapter: DatabaseAdapter;
  let tenantRepo: SessionProfileRepository;
  let base: { id: string; name: string; version: number };
  beforeEach(async () => {
    adapter = profileSchema();
    tenantRepo = new SessionProfileRepository(adapter);
    const created = await new PlatformProfileRepository(adapter, 'session').create(
      { name: 'Short', values: { 'session.ttl': 600 } },
      null
    );
    if (created.status !== 'created') throw new Error('not created');
    base = { id: created.profile.id, name: created.profile.name, version: 1 };
  });

  it('is made once, then changed by its own version', async () => {
    const made = await tenantRepo.saveOverride('t1', base, { 'session.ttl': 300 }, null, 'admin');
    expect(made).toMatchObject({
      status: 'saved',
      override: {
        baseProfileId: base.id,
        baseVersion: 1,
        version: 1,
        values: { 'session.ttl': 300 },
      },
    });
    // Made meanwhile by someone else: a conflict, not a second copy.
    expect(await tenantRepo.saveOverride('t1', base, {}, null, 'admin')).toEqual({
      status: 'conflict',
      currentVersion: 1,
    });
    const changed = await tenantRepo.saveOverride('t1', base, { 'session.ttl': 200 }, 1, 'admin');
    expect(changed).toMatchObject({ status: 'saved', override: { version: 2 } });
    expect(await tenantRepo.saveOverride('t1', base, {}, 1, 'admin')).toEqual({
      status: 'conflict',
      currentVersion: 2,
    });
    expect(await tenantRepo.countOverridingTenants(base.id)).toBe(1);
  });

  it('is never one of the tenant’s own profiles, by any id', async () => {
    const made = await tenantRepo.saveOverride('t1', base, { 'session.ttl': 300 }, null, null);
    if (made.status !== 'saved') throw new Error('not saved');
    const copyId = made.override.id;
    expect(await tenantRepo.list('t1')).toEqual([]);
    expect(await tenantRepo.find('t1', copyId)).toBeNull();
    expect((await tenantRepo.update('t1', copyId, { name: 'Mine', values: {} }, 1)).status).toBe(
      'not_found'
    );
    expect(await tenantRepo.delete('t1', copyId)).toBe(false);
    expect(await tenantRepo.findOverride('t1', base.id)).not.toBeNull();
    // Another tenant has no copy.
    expect(await tenantRepo.findOverride('t2', base.id)).toBeNull();
  });

  it('takes neither the tenant’s names nor its limit', async () => {
    await tenantRepo.saveOverride('t1', base, {}, null, null);
    // A profile of the tenant's own may have the platform profile's name.
    expect((await tenantRepo.create('t1', { name: 'Short', values: {} }, null)).status).toBe(
      'created'
    );
    for (let i = 1; i < AUTHENTICATION_METHOD_PROFILE_LIMIT; i++) {
      await tenantRepo.create('t1', { name: `P${i}`, values: {} }, null);
    }
    expect((await tenantRepo.create('t1', { name: 'One more', values: {} }, null)).status).toBe(
      'limit_reached'
    );
  });

  it('is removed, after which the platform profile has no copy for the tenant', async () => {
    await tenantRepo.saveOverride('t1', base, {}, null, null);
    expect(await tenantRepo.deleteOverride('t1', base.id)).toBe(true);
    expect(await tenantRepo.deleteOverride('t1', base.id)).toBe(false);
    expect(await tenantRepo.findOverride('t1', base.id)).toBeNull();
  });

  it('is kept apart by kind', async () => {
    const methods = new AuthenticationMethodProfileRepository(adapter);
    await tenantRepo.saveOverride('t1', base, {}, null, null);
    expect(await methods.findOverride('t1', base.id)).toBeNull();
  });
});
