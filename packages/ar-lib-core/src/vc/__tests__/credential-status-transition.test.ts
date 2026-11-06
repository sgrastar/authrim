import { beforeEach, describe, expect, it } from 'vitest';
import {
  IETF_TSL_FORMAT,
  W3C_BITSTRING_FORMAT,
  decodeStatusListBytes,
  encodeStatusListBytes,
  readStatusEntry,
  writeStatusEntry,
  bitOrderForFormat,
  type StatusListFormat,
} from '../status-list-codec';
import { transitionCredentialStatus } from '../credential-status-transition';
import { createStatusTestDb, type StatusTestDb } from './status-test-db';

const TENANT = 'tenant-1';

interface ListOptions {
  id?: string;
  format?: StatusListFormat;
  bits?: number;
  capacity?: number;
}

describe('transitionCredentialStatus', () => {
  let db: StatusTestDb;

  async function insertList({
    id = 'list-1',
    format = IETF_TSL_FORMAT,
    bits = 2,
    capacity = 64,
  }: ListOptions = {}) {
    const encoded = await encodeStatusListBytes(new Uint8Array((capacity * bits) / 8), format);
    db.sqlite
      .prepare(
        `INSERT INTO status_lists (internal_id, public_id, tenant_id, purpose, encoded_list,
           capacity, format, bits) VALUES (?, ?, ?, 'revocation', ?, ?, ?, ?)`
      )
      .run(`${id}-internal`, id, TENANT, encoded, capacity, format, bits);
  }

  function insertCredential(
    id: string,
    status: string,
    list: { id: string; index: number } | null = { id: 'list-1', index: 3 }
  ) {
    db.sqlite
      .prepare(
        `INSERT INTO issued_credentials (internal_id, public_id, tenant_id, user_id, credential_type,
           format, claims, status, status_list_id, status_list_internal_id, status_list_index,
           created_at, updated_at) VALUES (?, ?, ?, 'user-1', 'vct', 'dc+sd-jwt', '{}', ?, ?, ?, ?, 1, 1)`
      )
      .run(
        `${id}-internal`,
        id,
        TENANT,
        status,
        list?.id ?? null,
        list ? `${list.id}-internal` : null,
        list?.index ?? null
      );
  }

  async function entry(index: number, listId = 'list-1'): Promise<number> {
    const row = db.sqlite
      .prepare('SELECT encoded_list, format, bits, capacity FROM status_lists WHERE public_id = ?')
      .get(listId) as {
      encoded_list: string;
      format: StatusListFormat;
      bits: number;
      capacity: number;
    };
    const bytes = await decodeStatusListBytes(row.encoded_list, row.format);
    return readStatusEntry(bytes, index, row.bits, bitOrderForFormat(row.format));
  }

  const credentialRow = (id: string) =>
    db.sqlite.prepare('SELECT * FROM issued_credentials WHERE public_id = ?').get(id) as {
      status: string;
      revoked_at: string | null;
      revoked_reason: string | null;
      updated_at: number;
    };
  const listRow = (id = 'list-1') =>
    db.sqlite
      .prepare('SELECT version, last_operation_id FROM status_lists WHERE public_id = ?')
      .get(id) as { version: number; last_operation_id: string | null };

  beforeEach(async () => {
    db = createStatusTestDb();
    await insertList();
  });

  it('revokes an active credential: bit 1, row revoked, version bumped', async () => {
    insertCredential('c1', 'active');
    const result = await transitionCredentialStatus(db.adapter, {
      tenantId: TENANT,
      credentialId: 'c1',
      from: ['pending', 'active', 'suspended'],
      to: 'revoked',
      reason: 'lost device',
      now: 1_800_000_000_000,
    });

    expect(result).toEqual({ outcome: 'changed', previous: 'active' });
    expect(await entry(3)).toBe(0x01);
    expect(credentialRow('c1')).toMatchObject({
      status: 'revoked',
      revoked_reason: 'lost device',
      revoked_at: new Date(1_800_000_000_000).toISOString(),
      updated_at: 1_800_000_000_000,
    });
    expect(listRow().version).toBe(1);
  });

  it('suspends with 0x02 and activates back to 0x00 on a Token Status List', async () => {
    insertCredential('c1', 'active');
    await transitionCredentialStatus(db.adapter, {
      tenantId: TENANT,
      credentialId: 'c1',
      from: ['active'],
      to: 'suspended',
    });
    expect(await entry(3)).toBe(0x02);
    expect(credentialRow('c1').status).toBe('suspended');

    const result = await transitionCredentialStatus(db.adapter, {
      tenantId: TENANT,
      credentialId: 'c1',
      from: ['suspended'],
      to: 'active',
    });
    expect(result).toEqual({ outcome: 'changed', previous: 'suspended' });
    expect(await entry(3)).toBe(0x00);
    expect(listRow().version).toBe(2);
  });

  it('only moves its own entry', async () => {
    insertCredential('c1', 'active', { id: 'list-1', index: 3 });
    insertCredential('c2', 'active', { id: 'list-1', index: 4 });
    await transitionCredentialStatus(db.adapter, {
      tenantId: TENANT,
      credentialId: 'c1',
      from: ['active'],
      to: 'revoked',
    });
    expect([await entry(2), await entry(3), await entry(4), await entry(5)]).toEqual([0, 1, 0, 0]);
    expect(credentialRow('c2').status).toBe('active');
  });

  it('is idempotent: repeating returns unchanged and writes nothing', async () => {
    insertCredential('c1', 'active');
    const input = {
      tenantId: TENANT,
      credentialId: 'c1',
      from: ['active' as const],
      to: 'revoked' as const,
    };
    await transitionCredentialStatus(db.adapter, input);
    const before = listRow();
    const batches = db.batches.length;

    expect(await transitionCredentialStatus(db.adapter, input)).toEqual({ outcome: 'unchanged' });
    expect(listRow()).toEqual(before);
    expect(db.batches).toHaveLength(batches);
  });

  it('reports not_found and not_allowed', async () => {
    insertCredential('c1', 'active');
    expect(
      await transitionCredentialStatus(db.adapter, {
        tenantId: TENANT,
        credentialId: 'missing',
        from: ['active'],
        to: 'revoked',
      })
    ).toEqual({ outcome: 'not_found' });
    expect(
      await transitionCredentialStatus(db.adapter, {
        tenantId: 'other-tenant',
        credentialId: 'c1',
        from: ['active'],
        to: 'revoked',
      })
    ).toEqual({ outcome: 'not_found' });
    expect(
      await transitionCredentialStatus(db.adapter, {
        tenantId: TENANT,
        credentialId: 'c1',
        from: ['suspended'],
        to: 'suspended',
      })
    ).toEqual({ outcome: 'not_allowed', current: 'active' });
    expect(await entry(3)).toBe(0);
  });

  it('never leaves revoked, even when the caller lists it as a source', async () => {
    insertCredential('c1', 'active');
    await transitionCredentialStatus(db.adapter, {
      tenantId: TENANT,
      credentialId: 'c1',
      from: ['active'],
      to: 'revoked',
    });
    for (const to of ['active', 'suspended'] as const) {
      expect(
        await transitionCredentialStatus(db.adapter, {
          tenantId: TENANT,
          credentialId: 'c1',
          from: ['revoked', 'suspended', 'active'],
          to,
        })
      ).toEqual({ outcome: 'not_allowed', current: 'revoked' });
    }
    expect(await entry(3)).toBe(0x01);
    expect(credentialRow('c1').status).toBe('revoked');
  });

  it('abandons a pending credential (pending/active -> revoked)', async () => {
    insertCredential('c1', 'pending');
    const result = await transitionCredentialStatus(db.adapter, {
      tenantId: TENANT,
      credentialId: 'c1',
      from: ['pending', 'active'],
      to: 'revoked',
    });
    expect(result).toEqual({ outcome: 'changed', previous: 'pending' });
    expect(await entry(3)).toBe(0x01);
  });

  it('updates only the row for a credential without a status entry', async () => {
    insertCredential('c1', 'active', null);
    const result = await transitionCredentialStatus(db.adapter, {
      tenantId: TENANT,
      credentialId: 'c1',
      from: ['active'],
      to: 'revoked',
      reason: 'no list',
    });
    expect(result).toEqual({ outcome: 'changed', previous: 'active' });
    expect(credentialRow('c1')).toMatchObject({ status: 'revoked', revoked_reason: 'no list' });
    expect(db.batches).toHaveLength(0);
    expect(
      await transitionCredentialStatus(db.adapter, {
        tenantId: TENANT,
        credentialId: 'c1',
        from: ['active'],
        to: 'suspended',
      })
    ).toEqual({ outcome: 'not_allowed', current: 'revoked' });
  });

  it('writes legacy W3C lists as one MSB-first bit (suspended is set too)', async () => {
    await insertList({ id: 'legacy', format: W3C_BITSTRING_FORMAT, bits: 1, capacity: 64 });
    insertCredential('c1', 'active', { id: 'legacy', index: 9 });
    await transitionCredentialStatus(db.adapter, {
      tenantId: TENANT,
      credentialId: 'c1',
      from: ['active'],
      to: 'suspended',
    });
    const row = db.sqlite
      .prepare("SELECT encoded_list FROM status_lists WHERE public_id = 'legacy'")
      .get() as { encoded_list: string };
    const bytes = await decodeStatusListBytes(row.encoded_list, W3C_BITSTRING_FORMAT);
    // index 9: byte 1, MSB-first bit position 1 -> 0b01000000
    expect(bytes[1]).toBe(0b01000000);
    expect(credentialRow('c1').status).toBe('suspended');
  });

  describe('concurrency', () => {
    it('lost update: two transitions read the same version, exactly one changes row and bit', async () => {
      insertCredential('c1', 'active', { id: 'list-1', index: 3 });
      insertCredential('c2', 'active', { id: 'list-1', index: 4 });

      // c1 has read the list at version 0 and built its bytes; before its batch runs, c2 (which
      // read the same version) commits first.
      const original = db.adapter.batch.bind(db.adapter);
      let intercepted = false;
      db.adapter.batch = async (statements) => {
        if (!intercepted) {
          intercepted = true;
          await transitionCredentialStatus(db.adapter, {
            tenantId: TENANT,
            credentialId: 'c2',
            from: ['active'],
            to: 'revoked',
          });
        }
        return original(statements);
      };

      const result = await transitionCredentialStatus(db.adapter, {
        tenantId: TENANT,
        credentialId: 'c1',
        from: ['active'],
        to: 'revoked',
      });

      // c1's stale batch changed nothing ((0, 0)); it re-read version 1 (c2's bit already set),
      // recomputed and ended consistent: both bits set, no write lost.
      expect(result).toEqual({ outcome: 'changed', previous: 'active' });
      expect(await entry(3)).toBe(1);
      expect(await entry(4)).toBe(1);
      expect(credentialRow('c1').status).toBe('revoked');
      expect(credentialRow('c2').status).toBe('revoked');
      expect(listRow().version).toBe(2);
    });

    it('a stale batch with the wrong version changes neither the list nor the row', async () => {
      insertCredential('c1', 'active');
      // Bump the version behind the transition's back after it read the list.
      db.beforeBatch = () => {
        db.beforeBatch = undefined;
        db.sqlite.exec("UPDATE status_lists SET version = version + 1 WHERE public_id = 'list-1'");
      };
      const result = await transitionCredentialStatus(db.adapter, {
        tenantId: TENANT,
        credentialId: 'c1',
        from: ['active'],
        to: 'revoked',
      });
      // First attempt matched (0, 0); the retry re-read and succeeded against version 1.
      expect(result).toEqual({ outcome: 'changed', previous: 'active' });
      expect(db.batches).toHaveLength(2);
      expect(await entry(3)).toBe(1);
      expect(listRow().version).toBe(2);
    });

    it('a credential revoked meanwhile is not overwritten and no bit moves', async () => {
      insertCredential('c1', 'active');
      db.beforeBatch = () => {
        db.beforeBatch = undefined;
        db.sqlite.exec("UPDATE issued_credentials SET status = 'revoked' WHERE public_id = 'c1'");
      };
      const result = await transitionCredentialStatus(db.adapter, {
        tenantId: TENANT,
        credentialId: 'c1',
        from: ['active'],
        to: 'suspended',
      });
      expect(result).toEqual({ outcome: 'not_allowed', current: 'revoked' });
      expect(await entry(3)).toBe(0);
    });

    it('re-executing a committed batch is harmless and ends unchanged', async () => {
      insertCredential('c1', 'active');
      await transitionCredentialStatus(db.adapter, {
        tenantId: TENANT,
        credentialId: 'c1',
        from: ['active'],
        to: 'revoked',
      });
      const [statements] = db.batches;
      const results = await db.adapter.batch(statements);
      expect(results.map((r) => r.rowsAffected)).toEqual([0, 0]);
      expect(await entry(3)).toBe(1);
      expect(listRow().version).toBe(1);
    });

    it('returns conflict after bounded retries', async () => {
      insertCredential('c1', 'active');
      db.beforeBatch = () => {
        db.sqlite.exec("UPDATE status_lists SET version = version + 1 WHERE public_id = 'list-1'");
      };
      const result = await transitionCredentialStatus(db.adapter, {
        tenantId: TENANT,
        credentialId: 'c1',
        from: ['active'],
        to: 'revoked',
      });
      expect(result).toEqual({ outcome: 'conflict' });
      expect(db.batches).toHaveLength(5);
      expect(credentialRow('c1').status).toBe('active');
    });
  });
});

describe('status entry bit positions', () => {
  it('matches the draft-14 LSB-first layout for bits=2 (hand-computed vector)', () => {
    // statuses [1, 2, 0, 3] -> 0b11_00_10_01
    const bytes = new Uint8Array(1);
    [1, 2, 0, 3].forEach((value, index) => writeStatusEntry(bytes, index, 2, 'lsb', value));
    expect(bytes[0]).toBe(0b11001001);
    expect([0, 1, 2, 3].map((i) => readStatusEntry(bytes, i, 2, 'lsb'))).toEqual([1, 2, 0, 3]);
  });
});
