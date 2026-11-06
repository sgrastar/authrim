import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reserveCredentialStatusSlot } from '../credential-status-reservation';
import { bitOrderForFormat, encodeStatusListBytes, writeStatusEntry } from '../status-list-codec';
import { createStatusTestDb, type StatusTestDb } from './status-test-db';

const TENANT = 'tenant-1';
const base = {
  tenantId: TENANT,
  userId: 'admin-1',
  credentialType: 'https://issuer.example/credentials/admin',
  format: 'dc+sd-jwt',
};

describe('reserveCredentialStatusSlot', () => {
  let db: StatusTestDb;

  async function insertList(
    id: string,
    options: {
      capacity?: number;
      used?: number;
      format?: string;
      bits?: number;
      entries?: Record<number, number>;
    } = {}
  ) {
    const { capacity = 8, used = 0, format = 'ietf_tsl_v1', bits = 2, entries = {} } = options;
    const listFormat = format === 'ietf_tsl_v1' ? 'ietf_tsl_v1' : 'w3c_bitstring_v1';
    const bytes = new Uint8Array((capacity * bits) / 8);
    for (const [index, value] of Object.entries(entries)) {
      writeStatusEntry(bytes, Number(index), bits, bitOrderForFormat(listFormat), value);
    }
    const encoded = await encodeStatusListBytes(bytes, listFormat);
    db.sqlite
      .prepare(
        `INSERT INTO status_lists (internal_id, public_id, tenant_id, purpose, encoded_list,
           capacity, used_count, format, bits) VALUES (?, ?, ?, 'revocation', ?, ?, ?, ?, ?)`
      )
      .run(`${id}-internal`, id, TENANT, encoded, capacity, used, format, bits);
  }

  const usedCount = (id: string) =>
    (
      db.sqlite.prepare('SELECT used_count FROM status_lists WHERE public_id = ?').get(id) as {
        used_count: number;
      }
    ).used_count;
  const listState = (id: string) =>
    db.sqlite.prepare('SELECT state, sealed_at FROM status_lists WHERE public_id = ?').get(id) as {
      state: string;
      sealed_at: string | null;
    };

  beforeEach(() => {
    db = createStatusTestDb();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a Token Status List when none exists and records a pending credential', async () => {
    const slot = await reserveCredentialStatusSlot(db.adapter, {
      ...base,
      holderBinding: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      expiresAt: 1_900_000_000,
      now: 1_800_000_000_000,
    });

    expect(slot.index).toBeGreaterThanOrEqual(0);
    expect(slot.index).toBeLessThan(131072);
    const list = db.sqlite
      .prepare('SELECT * FROM status_lists WHERE public_id = ?')
      .get(slot.listId) as Record<string, unknown>;
    expect(list).toMatchObject({
      format: 'ietf_tsl_v1',
      bits: 2,
      capacity: 131072,
      used_count: 1,
      state: 'active',
      internal_id: slot.listInternalId,
    });
    expect(list.last_operation_id).toEqual(expect.any(String));
    const row = db.sqlite
      .prepare('SELECT * FROM issued_credentials WHERE public_id = ?')
      .get(slot.credentialId) as Record<string, unknown>;
    expect(row).toMatchObject({
      tenant_id: TENANT,
      user_id: 'admin-1',
      status: 'pending',
      status_list_id: slot.listId,
      status_list_internal_id: slot.listInternalId,
      status_list_index: slot.index,
      expires_at: '1900000000',
      created_at: 1_800_000_000_000,
    });
    expect(JSON.parse(row.holder_binding as string)).toMatchObject({ kty: 'EC' });
  });

  it('draws unpredictable indices (not sequential)', async () => {
    await insertList('big', { capacity: 131072 });
    const indices: number[] = [];
    for (let i = 0; i < 8; i++) {
      indices.push((await reserveCredentialStatusSlot(db.adapter, base)).index);
    }
    expect(new Set(indices).size).toBe(8);
    expect(indices).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(usedCount('big')).toBe(8);
  });

  it('never allocates from a legacy W3C list', async () => {
    await insertList('legacy', { capacity: 64, format: 'w3c_bitstring_v1', bits: 1 });
    const slot = await reserveCredentialStatusSlot(db.adapter, base);
    expect(slot.listId).not.toBe('legacy');
    expect(usedCount('legacy')).toBe(0);
  });

  it('retries an index collision with a new index and leaves the counter at one increment', async () => {
    await insertList('small', { capacity: 8 });
    const draws = [3, 3, 5];
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint32Array) => {
      array[0] = draws.shift() ?? 0;
      return array;
    }) as never);

    const first = await reserveCredentialStatusSlot(db.adapter, base);
    expect(first.index).toBe(3);
    expect(usedCount('small')).toBe(1);

    const second = await reserveCredentialStatusSlot(db.adapter, base);
    // Drew 3 again: the unique index failed the batch, which rolled the counter increment back.
    expect(second.index).toBe(5);
    expect(usedCount('small')).toBe(2);
    expect(db.batches).toHaveLength(3);
    const rows = db.sqlite
      .prepare('SELECT status_list_index FROM issued_credentials ORDER BY status_list_index')
      .all();
    expect(rows).toEqual([{ status_list_index: 3 }, { status_list_index: 5 }]);
  });

  it('never hands out an entry that already carries a status (partial restore)', async () => {
    // Entries 3 (revoked) and 4 (suspended) belong to credentials whose rows did not come back.
    await insertList('restored', { capacity: 8, entries: { 3: 1, 4: 2 } });
    const draws = [3, 4, 6];
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint32Array) => {
      array[0] = draws.shift() ?? 0;
      return array;
    }) as never);

    const slot = await reserveCredentialStatusSlot(db.adapter, base);

    expect(slot.index).toBe(6);
    expect(usedCount('restored')).toBe(1);
    expect(db.batches).toHaveLength(1);
  });

  it('seals a list at half capacity and moves to a new one', async () => {
    await insertList('half', { capacity: 8, used: 3 });
    const draws = [0, 1];
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((array: Uint32Array) => {
      array[0] = draws.shift() ?? 2;
      return array;
    }) as never);

    const last = await reserveCredentialStatusSlot(db.adapter, base);
    expect(last.listId).toBe('half');
    expect(usedCount('half')).toBe(4); // exactly capacity / 2

    const next = await reserveCredentialStatusSlot(db.adapter, base);
    expect(next.listId).not.toBe('half');
    expect(listState('half').state).toBe('sealed');
    expect(listState('half').sealed_at).toEqual(expect.any(String));
    expect(usedCount('half')).toBe(4);
    expect(usedCount(next.listId)).toBe(1);
  });

  it('enforces half capacity in the SQL even when the list was read as usable', async () => {
    await insertList('racy', { capacity: 8, used: 3 });
    // Another issuer takes the last usable slot after this one read the list.
    db.beforeBatch = () => {
      db.beforeBatch = undefined;
      db.sqlite.exec("UPDATE status_lists SET used_count = 4 WHERE public_id = 'racy'");
    };
    const slot = await reserveCredentialStatusSlot(db.adapter, base);
    expect(slot.listId).not.toBe('racy');
    expect(usedCount('racy')).toBe(4);
    expect(listState('racy').state).toBe('sealed');
    // The rejected batch inserted nothing into the full list.
    expect(
      db.sqlite
        .prepare("SELECT COUNT(*) AS n FROM issued_credentials WHERE status_list_id = 'racy'")
        .get()
    ).toEqual({ n: 0 });
  });

  it('is idempotent when a committed batch is reported as a constraint error', async () => {
    await insertList('list', { capacity: 8 });
    // Simulate a lost response: the batch commits, the caller sees an error and retries.
    const original = db.adapter.batch.bind(db.adapter);
    let lost = true;
    db.adapter.batch = async (statements) => {
      const results = await original(statements);
      if (lost) {
        lost = false;
        throw new Error('D1_ERROR: UNIQUE constraint failed: issued_credentials.public_id');
      }
      return results;
    };
    const slot = await reserveCredentialStatusSlot(db.adapter, base);
    const rows = db.sqlite
      .prepare('SELECT public_id, status_list_index FROM issued_credentials')
      .all();
    expect(rows).toEqual([{ public_id: slot.credentialId, status_list_index: slot.index }]);
    expect(usedCount('list')).toBe(1);
  });

  it('returns its own committed slot when a re-executed batch reports (0, 0) after the list filled up', async () => {
    await insertList('list', { capacity: 8 });
    // The batch commits, its response is lost, other reservations fill the list to half capacity,
    // and the adapter's re-execution then affects no rows.
    const original = db.adapter.batch.bind(db.adapter);
    let first = true;
    db.adapter.batch = async (statements) => {
      if (!first) return original(statements);
      first = false;
      await original(statements);
      db.sqlite
        .prepare("UPDATE status_lists SET used_count = 4, last_operation_id = 'other'")
        .run();
      return original(statements);
    };
    const slot = await reserveCredentialStatusSlot(db.adapter, base);

    const row = db.sqlite
      .prepare(
        'SELECT status_list_id, status_list_internal_id, status_list_index FROM issued_credentials WHERE public_id = ?'
      )
      .get(slot.credentialId) as {
      status_list_id: string;
      status_list_internal_id: string;
      status_list_index: number;
    };
    // Everything returned comes from the stored row, so the signed URI points at the real slot.
    expect(slot).toMatchObject({
      listId: 'list',
      listInternalId: 'list-internal',
      index: row.status_list_index,
    });
    expect(row.status_list_id).toBe('list');
    expect(
      (db.sqlite.prepare('SELECT COUNT(*) AS n FROM status_lists').get() as { n: number }).n
    ).toBe(1);
  });
});
