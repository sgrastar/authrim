import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, PreparedStatement } from '../../db/adapter';
import { renderPortableMigrationSql } from '../../migrations/sql-portability';
import { TombstoneRepository } from '../../repositories/pii/tombstone';
import type { Env } from '../../types/env';
import {
  createTombstoneEmailIndexForDeletion,
  findActiveEmailTombstone,
  checkEmailRegistration,
  resolveAccountTombstonePolicy,
} from '../account-tombstone';
import {
  createLookupBlindIndex,
  createTombstoneEmailIndex,
  tombstoneEmailIndexGeneration,
  type LookupBlindIndexKey,
} from '../lookup-directory/blind-index';
import {
  loadTombstoneHmacKeysFromEnv,
  parseTombstoneHmacKeyring,
  type TombstoneHmacKeys,
} from '../tombstone-hmac-keyring';

const PII_MIGRATIONS = new URL('../../../../../migrations/pii/d1/', import.meta.url);
const KEY_1: LookupBlindIndexKey = { generation: 1, secret: 'k'.repeat(32) };
const KEY_2: LookupBlindIndexKey = { generation: 2, secret: 'z'.repeat(32) };
const DAY_MS = 24 * 60 * 60 * 1000;

type SqlValue = string | number | null;
const values = (params: unknown[] = []) =>
  params.map((value): SqlValue => (value === undefined ? null : (value as SqlValue)));

/** A PII store with the executable D1 schema, so a query naming a missing column fails here. */
function piiStore(): DatabaseAdapter {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(PII_MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(
      renderPortableMigrationSql(readFileSync(new URL(file, PII_MIGRATIONS), 'utf8'), 'sqlite')
    );
  }
  const run = (statement: PreparedStatement) => ({
    success: true,
    rowsAffected: Number(db.prepare(statement.sql).run(...values(statement.params)).changes),
  });
  return {
    async query(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...values(params));
    },
    async queryOne(sql: string, params?: unknown[]) {
      return db.prepare(sql).get(...values(params)) ?? null;
    },
    async execute(sql: string, params?: unknown[]) {
      return run({ sql, params });
    },
    async batch(statements: PreparedStatement[]) {
      return statements.map(run);
    },
  } as unknown as DatabaseAdapter;
}

/** A keyring reading `readKeys`, writing with the first of them (or `writeKey`). */
function keys(
  readKeys: LookupBlindIndexKey[],
  writeKey: LookupBlindIndexKey = readKeys[0]
): () => TombstoneHmacKeys {
  return () => ({ writeKey, readKeys });
}

async function tombstone(
  store: DatabaseAdapter,
  input: { id: string; tenantId?: string; email: string; key?: LookupBlindIndexKey; days?: number }
) {
  await new TombstoneRepository(store).createTombstone(
    {
      id: input.id,
      tenant_id: input.tenantId ?? 'tenant-a',
      email_blind_index: await createTombstoneEmailIndex(input.email, input.key ?? KEY_1),
      deleted_by: 'admin',
      deletion_reason: 'admin_action',
      retention_days: input.days ?? 90,
    },
    store
  );
}

function settingsKv(document: Record<string, unknown> | null): KVNamespace {
  return {
    get: vi.fn(async (key: string) =>
      key === 'settings:tenant:tenant-a:account-lifecycle' && document
        ? JSON.stringify(document)
        : null
    ),
  } as unknown as KVNamespace;
}

describe('tombstone email index', () => {
  it('is keyed, versioned and carries its key generation', async () => {
    const value = await createTombstoneEmailIndex('Person@Example.com ', KEY_2);
    expect(value).toMatch(/^tombstone_email:v1:g2:[a-f0-9]{64}$/u);
    expect(tombstoneEmailIndexGeneration(value)).toBe(2);
    // Normalized as the lookup directory normalizes an address.
    expect(await createTombstoneEmailIndex('person@example.com', KEY_2)).toBe(value);
    // Another key gives another value: without the key, the value cannot be made from a guess.
    expect(await createTombstoneEmailIndex('person@example.com', KEY_1)).not.toBe(
      value.replace(':g2:', ':g1:')
    );
  });

  it('cannot be joined with the lookup directory email index of the same address', async () => {
    const tombstoneValue = await createTombstoneEmailIndex('person@example.com', KEY_1);
    const lookup = await createLookupBlindIndex('email_exact', 'person@example.com', KEY_1);
    expect(tombstoneValue.endsWith(lookup.digest)).toBe(false);
  });

  it("is made with the keyring's current key, and is null without a usable address", async () => {
    const env = {} as Env;
    const loadKeys = keys([KEY_2, KEY_1]);
    expect(
      tombstoneEmailIndexGeneration(
        await createTombstoneEmailIndexForDeletion(env, 'person@example.com', { loadKeys })
      )
    ).toBe(2);
    expect(await createTombstoneEmailIndexForDeletion(env, null, { loadKeys })).toBeNull();
    expect(await createTombstoneEmailIndexForDeletion(env, 'not-an-address', { loadKeys })).toBe(
      null
    );
  });

  it('is made with the keyring in the environment', async () => {
    const env = {
      TOMBSTONE_HMAC_KEYRING: JSON.stringify({
        current: 2,
        keys: { 1: KEY_1.secret, 2: KEY_2.secret },
      }),
    } as unknown as Env;
    expect(await createTombstoneEmailIndexForDeletion(env, 'person@example.com')).toBe(
      await createTombstoneEmailIndex('person@example.com', KEY_2)
    );
  });

  it('fails the deletion preparation when the keys cannot be loaded', async () => {
    await expect(
      createTombstoneEmailIndexForDeletion({} as Env, 'person@example.com', {
        loadKeys: () => loadTombstoneHmacKeysFromEnv({}),
      })
    ).rejects.toThrow('tombstone_hmac_keyring_unavailable');
  });
});

describe('tombstone keyring', () => {
  const ring = (value: unknown) => JSON.stringify(value);

  it('writes with the current generation and reads every one, current first', () => {
    expect(
      parseTombstoneHmacKeyring(ring({ current: 2, keys: { 1: KEY_1.secret, 2: KEY_2.secret } }))
    ).toEqual({ writeKey: KEY_2, readKeys: [KEY_2, KEY_1] });
  });

  it.each([
    ['not JSON', '{'],
    ['no keys', ring({ current: 1, keys: {} })],
    ['a current generation it does not hold', ring({ current: 3, keys: { 1: KEY_1.secret } })],
    ['a short key', ring({ current: 1, keys: { 1: 'short' } })],
    ['the same key twice', ring({ current: 1, keys: { 1: KEY_1.secret, 2: KEY_1.secret } })],
    ['a bad generation', ring({ current: 1, keys: { 1: KEY_1.secret, x: KEY_2.secret } })],
    ['an unknown member', ring({ current: 1, keys: { 1: KEY_1.secret }, extra: true })],
  ])('refuses a keyring with %s', (_case, value) => {
    expect(() => parseTombstoneHmacKeyring(value)).toThrow('tombstone_hmac_keyring_invalid');
  });

  it('is unavailable when the secret is missing', () => {
    expect(() => loadTombstoneHmacKeysFromEnv({})).toThrow('tombstone_hmac_keyring_unavailable');
  });
});

describe('findActiveEmailTombstone', () => {
  it("finds a deletion in any of the tenant's PII stores, by any key generation still read", async () => {
    const [first, second] = [piiStore(), piiStore()];
    await tombstone(second, { id: 'user-old', email: 'person@example.com', key: KEY_1 });
    const found = await findActiveEmailTombstone(
      {} as Env,
      { tenantId: 'tenant-a', email: 'PERSON@example.com' },
      { loadKeys: keys([KEY_2, KEY_1]), resolvePiiStores: async () => [first, second] }
    );
    expect(found?.retention_until).toBeGreaterThan(Date.now() + 89 * DAY_MS);
  });

  it('does not find another tenant, another address, or a key no longer read', async () => {
    const store = piiStore();
    await tombstone(store, { id: 'user-b', tenantId: 'tenant-b', email: 'person@example.com' });
    await tombstone(store, { id: 'user-c', email: 'other@example.com' });
    await tombstone(store, { id: 'user-d', email: 'rotated@example.com', key: KEY_2 });
    const find = (email: string) =>
      findActiveEmailTombstone(
        {} as Env,
        { tenantId: 'tenant-a', email },
        { loadKeys: keys([KEY_1]), resolvePiiStores: async () => [store] }
      );
    expect(await find('person@example.com')).toBeNull();
    expect(await find('rotated@example.com')).toBeNull();
    expect(await find('other@example.com')).not.toBeNull();
  });

  it('does not find a deletion past its retention', async () => {
    const store = piiStore();
    await tombstone(store, { id: 'user-old', email: 'person@example.com' });
    const later = Date.now() + 91 * DAY_MS;
    const now = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect(
        await findActiveEmailTombstone(
          {} as Env,
          { tenantId: 'tenant-a', email: 'person@example.com' },
          { loadKeys: keys([KEY_1]), resolvePiiStores: async () => [store] }
        )
      ).toBeNull();
    } finally {
      now.mockRestore();
    }
  });
});

describe('resolveAccountTombstonePolicy', () => {
  it('defaults to 90 days and no re-registration block', async () => {
    await expect(resolveAccountTombstonePolicy({}, 'tenant-a')).resolves.toEqual({
      retentionDays: 90,
      blockReregistration: false,
    });
  });

  it('takes the environment, and the tenant setting over it', async () => {
    const env = {
      ACCOUNT_TOMBSTONE_RETENTION_DAYS: '30',
      ACCOUNT_TOMBSTONE_BLOCK_REREGISTRATION: 'true',
    } as unknown as Pick<Env, 'SETTINGS'>;
    await expect(resolveAccountTombstonePolicy(env, 'tenant-a')).resolves.toEqual({
      retentionDays: 30,
      blockReregistration: true,
    });
    await expect(
      resolveAccountTombstonePolicy(
        {
          ...env,
          SETTINGS: settingsKv({
            'account-lifecycle.deletion.tombstone_retention_days': 400,
            'account-lifecycle.deletion.block_reregistration': false,
          }),
        },
        'tenant-a'
      )
    ).resolves.toEqual({ retentionDays: 400, blockReregistration: false });
  });
});

describe('checkEmailRegistration', () => {
  const blockingEnv = () =>
    ({
      SETTINGS: settingsKv({ 'account-lifecycle.deletion.block_reregistration': true }),
    }) as unknown as Env;

  it('blocks an address deleted within the retention period where the tenant blocks', async () => {
    const store = piiStore();
    await tombstone(store, { id: 'user-old', email: 'person@example.com' });
    const deps = { loadKeys: keys([KEY_1]), resolvePiiStores: async () => [store] };
    await expect(
      checkEmailRegistration(
        blockingEnv(),
        { tenantId: 'tenant-a', email: 'person@example.com' },
        deps
      )
    ).resolves.toBe('blocked');
    await expect(
      checkEmailRegistration(
        blockingEnv(),
        { tenantId: 'tenant-a', email: 'new@example.com' },
        deps
      )
    ).resolves.toBe('allowed');
  });

  it('does not look for deletions where the tenant does not block (the default)', async () => {
    const resolvePiiStores = vi.fn(async () => [piiStore()]);
    await expect(
      checkEmailRegistration(
        { SETTINGS: settingsKv(null) } as unknown as Env,
        { tenantId: 'tenant-a', email: 'person@example.com' },
        { loadKeys: keys([KEY_1]), resolvePiiStores }
      )
    ).resolves.toBe('allowed');
    expect(resolvePiiStores).not.toHaveBeenCalled();
  });

  it('is unavailable (not allowed) when the check cannot be made, once the tenant blocks', async () => {
    await expect(
      checkEmailRegistration(
        blockingEnv(),
        { tenantId: 'tenant-a', email: 'person@example.com' },
        {
          loadKeys: keys([KEY_1]),
          resolvePiiStores: async () => {
            throw new Error('missing_registry_row');
          },
        }
      )
    ).resolves.toBe('unavailable');
  });

  it('is unavailable when the policy cannot be read', async () => {
    const SETTINGS = {
      get: vi.fn(async () => {
        throw new Error('kv_down');
      }),
    } as unknown as KVNamespace;
    await expect(
      checkEmailRegistration({ SETTINGS } as unknown as Env, {
        tenantId: 'tenant-a',
        email: 'person@example.com',
      })
    ).resolves.toBe('unavailable');
  });

  it('allows an account without an email', async () => {
    await expect(
      checkEmailRegistration(blockingEnv(), { tenantId: 'tenant-a', email: null })
    ).resolves.toBe('allowed');
  });
});
