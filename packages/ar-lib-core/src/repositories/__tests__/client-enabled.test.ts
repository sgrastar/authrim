import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClientRepository } from '../core/client';
import { sqliteAdapter } from './sqlite-core-schema';
import { getClient } from '../../utils/kv';
import type { Env } from '../../types/env';

let store: ReturnType<typeof sqliteAdapter>;
let repository: ClientRepository;
beforeEach(() => {
  store = sqliteAdapter();
  Object.assign(store.adapter, {
    getType: () => 'sqlite',
    isHealthy: async () => ({ healthy: true, latencyMs: 0 }),
    close: async () => undefined,
    transaction: async () => {
      throw new Error('not used');
    },
  });
  repository = new ClientRepository(store.adapter, 'default');
});
afterEach(() => store.db.close());

describe('client activation storage and runtime reads', () => {
  it('defaults existing callers to enabled and maps integers to booleans', async () => {
    const client = await repository.create({
      client_id: 'app',
      client_name: 'App',
      redirect_uris: [],
    });
    expect(client.enabled).toBe(true);
    expect((await repository.findByClientId('app'))?.enabled).toBe(true);
    await repository.update('app', { enabled: false });
    expect((await repository.findByClientId('app'))?.enabled).toBe(false);
    expect(
      store.db.prepare('SELECT enabled FROM oauth_clients WHERE client_id = ?').get('app')
    ).toMatchObject({ enabled: 0 });
  });
  it('hides drafts from runtime while allowing explicit administrative reads', async () => {
    await repository.create({
      client_id: 'draft',
      client_name: 'Draft',
      redirect_uris: [],
      enabled: false,
    });
    expect(await getClient({} as Env, 'default', 'draft', store.adapter)).toBeNull();
    expect(
      await getClient({} as Env, 'default', 'draft', store.adapter, { includeDisabled: true })
    ).toMatchObject({ enabled: false });
    await repository.update('draft', { enabled: true });
    expect(await getClient({} as Env, 'default', 'draft', store.adapter)).toMatchObject({
      enabled: true,
    });
  });
  it('does not let a delayed draft edit change a concurrently activated client or its origins', async () => {
    const client = await repository.create({
      client_id: 'draft',
      client_name: 'Draft',
      redirect_uris: [],
      enabled: false,
    });
    const batch = store.adapter.batch.bind(store.adapter);
    store.adapter.batch = async (statements) => {
      await repository.update('draft', { enabled: true }, { expectedUpdatedAt: client.updated_at });
      return batch(statements);
    };
    expect(
      await repository.update(
        'draft',
        { redirect_uris: ['https://loser.example/cb'] },
        {
          expectedUpdatedAt: client.updated_at,
          webOriginRegistry: { origins: ['https://loser.example'] },
        }
      )
    ).toBeNull();
    expect((await repository.findByClientId('draft'))?.redirect_uris).toBe('[]');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM web_origin_registry').get()).toMatchObject({
      n: 0,
    });
  });
});
