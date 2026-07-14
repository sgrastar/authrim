import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlStorageCursor, SqlStorageValue } from '@cloudflare/workers-types';
/* eslint-disable @typescript-eslint/no-base-to-string */
import { CredentialOfferStore, type CreateCredentialOfferInput } from '../CredentialOfferStore';

type Row = Record<string, SqlStorageValue>;

function cursor(rows: Row[] = [], rowsWritten = 0): SqlStorageCursor<Row> {
  return {
    columnNames: rows.length ? Object.keys(rows[0]) : [],
    rowsRead: rows.length,
    rowsWritten,
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) throw new Error('Expected one row');
      return rows[0];
    },
    raw: () => rows.map((row) => Object.values(row)),
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  } as unknown as SqlStorageCursor<Row>;
}

class MemoryVciSql {
  offers = new Map<string, Row>();
  nonces = new Map<string, Row>();

  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...p: SqlStorageValue[]
  ): SqlStorageCursor<T> {
    const q = query.replace(/\s+/g, ' ').trim();
    if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) return cursor() as never;
    if (q.startsWith('INSERT INTO credential_offers')) {
      const [id, tenant, user, configuration, claims, codeHash, txHash, max, created, expires] = p;
      if (this.offers.has(String(id))) throw new Error('duplicate');
      this.offers.set(String(id), {
        id,
        tenant_id: tenant,
        user_id: user,
        credential_configuration_id: configuration,
        claims_json: claims,
        code_hash: codeHash,
        tx_code_hash: txHash,
        status: 'pending',
        failed_attempts: 0,
        max_attempts: max,
        reservation_id: null,
        lease_expires_at: null,
        created_at: created,
        expires_at: expires,
      });
      return cursor([], 1) as never;
    }
    if (q.startsWith('SELECT * FROM credential_offers')) {
      const row = this.offers.get(String(p[0]));
      return cursor(row && row.tenant_id === p[1] ? [row] : []) as never;
    }
    if (q.startsWith('SELECT MIN(')) {
      const source = q.includes('FROM credential_offers')
        ? this.offers.values()
        : this.nonces.values();
      const now = Number(p[0]);
      const retention = Number(p[1]);
      const candidates = [...source]
        .map((row) => {
          const expiresAt = Number(row.expires_at);
          return expiresAt > now ? expiresAt : expiresAt + retention;
        })
        .filter((value) => value > now);
      return cursor([{ next_at: candidates.length ? Math.min(...candidates) : null }]) as never;
    }
    if (q.includes('SET failed_attempts = ?, status = ?')) {
      const row = this.offers.get(String(p[2]));
      if (!row || row.tenant_id !== p[3] || row.status !== 'pending') return cursor() as never;
      row.failed_attempts = p[0];
      row.status = p[1];
      return cursor([], 1) as never;
    }
    if (q.includes("SET status = 'processing', reservation_id = ?")) {
      const row = this.offers.get(String(p[2]));
      if (
        !row ||
        row.tenant_id !== p[3] ||
        row.status !== 'pending' ||
        Number(row.expires_at) <= Number(p[4])
      )
        return cursor() as never;
      row.status = 'processing';
      row.reservation_id = p[0];
      row.lease_expires_at = p[1];
      return cursor([], 1) as never;
    }
    if (q.includes("credential_offers SET status = 'consumed'")) {
      const row = this.offers.get(String(p[1]));
      if (
        !row ||
        row.tenant_id !== p[2] ||
        row.status !== 'processing' ||
        row.reservation_id !== p[3]
      )
        return cursor() as never;
      row.status = 'consumed';
      row.reservation_id = null;
      row.lease_expires_at = null;
      row.expires_at = p[0];
      return cursor([], 1) as never;
    }
    if (q.includes("credential_offers SET status = 'pending'")) {
      const idIndex = q.includes('WHERE id = ?') ? (p.length === 4 ? 0 : 2) : 0;
      const row = this.offers.get(String(p[idIndex]));
      if (!row) return cursor() as never;
      row.status = 'pending';
      row.reservation_id = null;
      row.lease_expires_at = null;
      return cursor([], 1) as never;
    }
    if (q.includes("credential_offers SET status = 'expired'")) {
      if (q.includes('WHERE id = ?')) {
        const row = this.offers.get(String(p[0]));
        if (row && row.tenant_id === p[1]) row.status = 'expired';
      } else {
        for (const row of this.offers.values()) {
          if (
            (row.status === 'pending' || row.status === 'processing') &&
            Number(row.expires_at) <= Number(p[0])
          ) {
            row.status = 'expired';
          }
        }
      }
      return cursor([], 1) as never;
    }
    if (q.startsWith('INSERT INTO proof_nonces')) {
      const [id, tenant, nonceHash, created, expires] = p;
      this.nonces.set(String(id), {
        id,
        tenant_id: tenant,
        nonce_hash: nonceHash,
        status: 'issued',
        proof_fingerprint: null,
        access_token_jti: null,
        reservation_id: null,
        lease_expires_at: null,
        created_at: created,
        expires_at: expires,
      });
      return cursor([], 1) as never;
    }
    if (q.startsWith('SELECT * FROM proof_nonces')) {
      const row = this.nonces.get(String(p[0]));
      return cursor(row && row.tenant_id === p[1] ? [row] : []) as never;
    }
    if (q.startsWith('SELECT id FROM proof_nonces')) {
      const found = [...this.nonces.values()].find(
        (row) => row.proof_fingerprint === p[0] && row.id !== p[1]
      );
      return cursor(found ? [{ id: found.id }] : []) as never;
    }
    if (q.includes("proof_nonces SET status = 'processing'")) {
      const row = this.nonces.get(String(p[4]));
      if (
        !row ||
        row.tenant_id !== p[5] ||
        row.status !== 'issued' ||
        Number(row.expires_at) <= Number(p[6])
      )
        return cursor() as never;
      row.status = 'processing';
      row.proof_fingerprint = p[0];
      row.access_token_jti = p[1];
      row.reservation_id = p[2];
      row.lease_expires_at = p[3];
      return cursor([], 1) as never;
    }
    if (q.includes("proof_nonces SET status = 'consumed'")) {
      const row = this.nonces.get(String(p[0]));
      if (
        !row ||
        row.tenant_id !== p[1] ||
        row.status !== 'processing' ||
        row.reservation_id !== p[2]
      )
        return cursor() as never;
      row.status = 'consumed';
      row.reservation_id = null;
      row.lease_expires_at = null;
      return cursor([], 1) as never;
    }
    if (q.includes("SET claims_json = '{}'")) {
      for (const row of this.offers.values()) {
        if (row.status === 'consumed' && Number(row.expires_at) <= Number(p[0]))
          row.claims_json = '{}';
      }
      return cursor([], 1) as never;
    }
    if (q.startsWith('DELETE') || q.startsWith('UPDATE proof_nonces')) return cursor() as never;
    throw new Error(`Unhandled SQL: ${q}`);
  }
}

function stateWith(
  sql: MemoryVciSql,
  setAlarm: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)
): DurableObjectState {
  const storage = {
    sql,
    getAlarm: vi.fn().mockResolvedValue(null),
    setAlarm,
  } as unknown as DurableObjectStorage;
  return {
    storage,
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
  } as unknown as DurableObjectState;
}

describe('CredentialOfferStore security state machine', () => {
  let sql: MemoryVciSql;
  let store: CredentialOfferStore;
  const offer = (
    id: string,
    overrides: Partial<CreateCredentialOfferInput> = {}
  ): CreateCredentialOfferInput => ({
    id,
    tenantId: 'tenant-a',
    userId: 'user-a',
    credentialConfigurationId: 'AuthrimIdentityCredential',
    claims: { given_name: 'Alice' },
    preAuthorizedCodeHash: `hash-${id}`,
    createdAt: 1_000,
    expiresAt: 20_000,
    ...overrides,
  });

  beforeEach(() => {
    sql = new MemoryVciSql();
    store = new CredentialOfferStore(stateWith(sql), {} as never);
  });

  it('keeps multiple offers in the same shard without overwriting them', () => {
    store.createOfferRpc(offer('offer-a'));
    store.createOfferRpc(offer('offer-b', { userId: 'user-b' }));
    expect(store.getOfferRpc({ id: 'offer-a', tenantId: 'tenant-a', now: 2_000 })?.userId).toBe(
      'user-a'
    );
    expect(store.getOfferRpc({ id: 'offer-b', tenantId: 'tenant-a', now: 2_000 })?.userId).toBe(
      'user-b'
    );
  });

  it('reschedules cleanup for the next retained offer after an alarm', async () => {
    vi.useFakeTimers();
    const now = 10_000;
    const alarmSql = new MemoryVciSql();
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const alarmStore = new CredentialOfferStore(stateWith(alarmSql, setAlarm), {} as never);
    alarmStore.createOfferRpc(offer('offer-a', { createdAt: now - 1_000, expiresAt: now + 5_000 }));
    alarmStore.createOfferRpc(
      offer('offer-b', { createdAt: now - 1_000, expiresAt: now + 10_000 })
    );

    try {
      vi.runAllTicks();
      setAlarm.mockClear();
      vi.setSystemTime(now);
      await alarmStore.alarm();
      expect(setAlarm).toHaveBeenCalledWith(now + 5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('grants exactly one reservation and rejects replay', () => {
    store.createOfferRpc(offer('offer-a'));
    const first = store.reserveOfferRpc({
      id: 'offer-a',
      tenantId: 'tenant-a',
      preAuthorizedCodeHash: 'hash-offer-a',
      now: 2_000,
    });
    const replay = store.reserveOfferRpc({
      id: 'offer-a',
      tenantId: 'tenant-a',
      preAuthorizedCodeHash: 'hash-offer-a',
      now: 2_001,
    });
    expect(first.reserved).toBe(true);
    expect(replay).toEqual({ reserved: false, reason: 'unavailable' });
    if (first.reserved) {
      expect(
        store.completeOfferRpc({
          id: 'offer-a',
          tenantId: 'tenant-a',
          reservationId: first.reservationId,
          claimsExpiresAt: Date.now() + 60_000,
        })
      ).toBe(true);
    }
  });

  it('locks a PIN-protected offer after its attempt budget', () => {
    store.createOfferRpc(offer('offer-a', { txCodeHash: 'pin-ok', maxAttempts: 2 }));
    for (let i = 0; i < 2; i++) {
      expect(
        store.reserveOfferRpc({
          id: 'offer-a',
          tenantId: 'tenant-a',
          preAuthorizedCodeHash: 'hash-offer-a',
          txCodeHash: 'pin-bad',
          now: 2_000 + i,
        })
      ).toEqual({ reserved: false, reason: 'invalid_tx_code' });
    }
    expect(store.getOfferRpc({ id: 'offer-a', tenantId: 'tenant-a', now: 3_000 })?.status).toBe(
      'locked'
    );
  });

  it('does not expose an offer across tenants', () => {
    store.createOfferRpc(offer('offer-a'));
    expect(store.getOfferRpc({ id: 'offer-a', tenantId: 'tenant-b', now: 2_000 })).toBeNull();
  });

  it('scrubs offer claims when the access-token lookup window expires', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    store.createOfferRpc(offer('offer-a', { createdAt: now - 1_000, expiresAt: now + 10_000 }));
    const reserved = store.reserveOfferRpc({
      id: 'offer-a',
      tenantId: 'tenant-a',
      preAuthorizedCodeHash: 'hash-offer-a',
      now,
    });
    expect(reserved.reserved).toBe(true);
    if (!reserved.reserved) return;
    store.completeOfferRpc({
      id: 'offer-a',
      tenantId: 'tenant-a',
      reservationId: reserved.reservationId,
      claimsExpiresAt: now + 1_000,
    });

    try {
      vi.setSystemTime(now + 2_000);
      await store.alarm();
      expect(store.getOfferRpc({ id: 'offer-a', tenantId: 'tenant-a' })?.claims).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('reserves and consumes a proof nonce only once', () => {
    store.createProofNonceRpc({
      id: 'nonce-a',
      tenantId: 'tenant-a',
      nonceHash: 'nonce-hash',
      createdAt: 1_000,
      expiresAt: 20_000,
    });
    const first = store.reserveProofNonceRpc({
      id: 'nonce-a',
      tenantId: 'tenant-a',
      nonceHash: 'nonce-hash',
      proofFingerprint: 'proof-a',
      accessTokenJti: 'token-a',
      now: 2_000,
    });
    expect(first.reserved).toBe(true);
    if (first.reserved)
      expect(
        store.completeProofNonceRpc({
          id: 'nonce-a',
          tenantId: 'tenant-a',
          reservationId: first.reservationId,
        })
      ).toBe(true);
    expect(
      store.reserveProofNonceRpc({
        id: 'nonce-a',
        tenantId: 'tenant-a',
        nonceHash: 'nonce-hash',
        proofFingerprint: 'proof-a',
        accessTokenJti: 'token-a',
        now: 2_001,
      })
    ).toEqual({ reserved: false, reason: 'unavailable' });
  });
});
