import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseAdapter } from '../../db/adapter';
import { ClientRepository } from '../core/client';
import { sqliteAdapter } from './sqlite-core-schema';

const baseClient = {
  client_name: 'Payroll',
  redirect_uris: ['https://app.example.com/callback'],
  grant_types: ['authorization_code'],
  response_types: ['code'],
};

describe('client minimum IAL in the real schema', () => {
  let db: DatabaseSync;
  let adapter: DatabaseAdapter;
  let repository: ClientRepository;

  beforeEach(() => {
    ({ db, adapter } = sqliteAdapter());
    repository = new ClientRepository(adapter, 'tenant-a');
  });

  it('has no minimum unless one is set', async () => {
    const created = await repository.create({ ...baseClient, client_id: 'c1' });
    expect(created.minimum_ial ?? null).toBeNull();
    expect((await repository.findByClientId('c1'))?.minimum_ial ?? null).toBeNull();
  });

  it('records the minimum on create and reads it back', async () => {
    await repository.create({ ...baseClient, client_id: 'c2', minimum_ial: 'IAL2' });
    expect((await repository.findByClientId('c2'))?.minimum_ial).toBe('IAL2');
  });

  it('sets, changes and clears the minimum on update', async () => {
    await repository.create({ ...baseClient, client_id: 'c3' });
    await repository.update('c3', { minimum_ial: 'IAL3' });
    expect((await repository.findByClientId('c3'))?.minimum_ial).toBe('IAL3');
    await repository.update('c3', { client_name: 'Renamed' });
    expect((await repository.findByClientId('c3'))?.minimum_ial).toBe('IAL3');
    await repository.update('c3', { minimum_ial: null });
    expect((await repository.findByClientId('c3'))?.minimum_ial ?? null).toBeNull();
  });

  it('refuses a value that is not an IAL', async () => {
    await repository.create({ ...baseClient, client_id: 'c4' });
    expect(() =>
      db.prepare(`UPDATE oauth_clients SET minimum_ial = 'IAL9' WHERE client_id = 'c4'`).run()
    ).toThrow();
  });
});
