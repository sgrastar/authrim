import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqlStorageCursor, SqlStorageValue } from '@cloudflare/workers-types';
/* eslint-disable @typescript-eslint/no-base-to-string */
import { VPRequestStore } from '../VPRequestStore';
import type { VPRequestState } from '../../../types';

type Row = Record<string, SqlStorageValue>;
function cursor(rows: Row[] = [], rowsWritten = 0): SqlStorageCursor<Row> {
  return {
    columnNames: rows.length ? Object.keys(rows[0]) : [],
    rowsRead: rows.length,
    rowsWritten,
    toArray: () => rows,
    one: () => rows[0],
    raw: () => rows.map(Object.values),
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  } as unknown as SqlStorageCursor<Row>;
}

class MemoryVpSql {
  rows = new Map<string, Row>();
  exec<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...p: SqlStorageValue[]
  ): SqlStorageCursor<T> {
    const q = query.replace(/\s+/g, ' ').trim();
    if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) return cursor() as never;
    if (q.startsWith('INSERT INTO vp_requests')) {
      const [
        id,
        tenant,
        client,
        user,
        nonce,
        statusTokenHash,
        pd,
        dcql,
        uri,
        mode,
        created,
        expires,
      ] = p;
      this.rows.set(String(id), {
        id,
        tenant_id: tenant,
        client_id: client,
        user_id: user,
        nonce,
        status_token_hash: statusTokenHash,
        presentation_definition_json: pd,
        dcql_query_json: dcql,
        response_uri: uri,
        response_mode: mode,
        status: 'pending',
        response_fingerprint: null,
        reservation_id: null,
        lease_expires_at: null,
        verified_claims_json: null,
        error_code: null,
        error_description: null,
        created_at: created,
        expires_at: expires,
      });
      return cursor([], 1) as never;
    }
    if (q.startsWith('SELECT * FROM vp_requests')) {
      const row = this.rows.get(String(p[0]));
      const matchesStatusToken = p.length < 3 || row?.status_token_hash === p[2];
      return cursor(row && row.tenant_id === p[1] && matchesStatusToken ? [row] : []) as never;
    }
    if (q.startsWith('SELECT MIN(')) {
      const now = Number(p[0]);
      const retention = Number(p[1]);
      const candidates = [...this.rows.values()]
        .map((row) => {
          const expiresAt = Number(row.expires_at);
          return expiresAt > now ? expiresAt : expiresAt + retention;
        })
        .filter((value) => value > now);
      return cursor([{ next_at: candidates.length ? Math.min(...candidates) : null }]) as never;
    }
    if (q.startsWith('SELECT id FROM vp_requests')) {
      const row = [...this.rows.values()].find(
        (entry) => entry.response_fingerprint === p[0] && entry.id !== p[1]
      );
      return cursor(row ? [{ id: row.id }] : []) as never;
    }
    if (q.includes("SET status = 'processing', response_fingerprint = ?")) {
      const row = this.rows.get(String(p[3]));
      if (
        !row ||
        row.tenant_id !== p[4] ||
        row.status !== 'pending' ||
        Number(row.expires_at) <= Number(p[5])
      )
        return cursor() as never;
      row.status = 'processing';
      row.response_fingerprint = p[0];
      row.reservation_id = p[1];
      row.lease_expires_at = p[2];
      return cursor([], 1) as never;
    }
    if (q.includes("SET status = 'verified'")) {
      const row = this.rows.get(String(p[1]));
      if (
        !row ||
        row.tenant_id !== p[2] ||
        row.status !== 'processing' ||
        row.reservation_id !== p[3]
      )
        return cursor() as never;
      row.status = 'verified';
      row.verified_claims_json = p[0];
      row.reservation_id = null;
      row.lease_expires_at = null;
      return cursor([], 1) as never;
    }
    if (q.includes("SET status = 'failed'")) {
      const row = this.rows.get(String(p[2]));
      if (
        !row ||
        row.tenant_id !== p[3] ||
        row.status !== 'processing' ||
        row.reservation_id !== p[4]
      )
        return cursor() as never;
      row.status = 'failed';
      row.error_code = p[0];
      row.error_description = p[1];
      row.reservation_id = null;
      return cursor([], 1) as never;
    }
    if (q.includes("SET status = 'pending'")) {
      const idIndex = p.length === 4 ? 0 : 0;
      const row = this.rows.get(String(p[idIndex]));
      if (row) {
        row.status = 'pending';
        row.response_fingerprint = null;
        row.reservation_id = null;
        row.lease_expires_at = null;
      }
      return cursor([], row ? 1 : 0) as never;
    }
    if (q.includes("SET status = 'expired'")) {
      if (q.includes('WHERE id = ?')) {
        const row = this.rows.get(String(p[0]));
        if (row && row.tenant_id === p[1]) row.status = 'expired';
      } else
        for (const row of this.rows.values())
          if (Number(row.expires_at) <= Number(p[0])) row.status = 'expired';
      return cursor([], 1) as never;
    }
    if (q.startsWith('DELETE')) return cursor() as never;
    throw new Error(`Unhandled SQL: ${q}`);
  }
}

function createState(
  sql: MemoryVpSql,
  setAlarm: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)
): DurableObjectState {
  return {
    storage: {
      sql,
      getAlarm: vi.fn().mockResolvedValue(null),
      setAlarm,
    } as unknown as DurableObjectStorage,
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
  } as unknown as DurableObjectState;
}

describe('VPRequestStore security state machine', () => {
  let store: VPRequestStore;
  const request = (id: string, overrides: Partial<VPRequestState> = {}): VPRequestState => ({
    id,
    tenantId: 'tenant-a',
    clientId: 'client-a',
    nonce: `nonce-${id}`,
    statusTokenHash: 'status-token-hash',
    responseUri: 'https://issuer.example/vp/response',
    responseMode: 'direct_post',
    status: 'pending',
    createdAt: 1_000,
    expiresAt: 20_000,
    presentationDefinition: {
      id: 'pd',
      input_descriptors: [
        { id: 'identity', constraints: { fields: [{ path: ['$.age_over_18'] }] } },
      ],
    },
    ...overrides,
  });

  beforeEach(() => {
    store = new VPRequestStore(createState(new MemoryVpSql()), {} as never);
  });

  it('keeps multiple requests in one shard', () => {
    store.createRequestRpc(request('request-a'));
    store.createRequestRpc(request('request-b', { clientId: 'client-b' }));
    expect(
      store.getRequestRpc({ id: 'request-a', tenantId: 'tenant-a', now: 2_000 })?.clientId
    ).toBe('client-a');
    expect(
      store.getRequestRpc({ id: 'request-b', tenantId: 'tenant-a', now: 2_000 })?.clientId
    ).toBe('client-b');
  });

  it('reschedules cleanup for the next retained request after an alarm', async () => {
    vi.useFakeTimers();
    const now = 10_000;
    const sql = new MemoryVpSql();
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const alarmStore = new VPRequestStore(createState(sql, setAlarm), {} as never);
    alarmStore.createRequestRpc(
      request('request-a', { createdAt: now - 1_000, expiresAt: now + 5_000 })
    );
    alarmStore.createRequestRpc(
      request('request-b', { createdAt: now - 1_000, expiresAt: now + 10_000 })
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

  it('requires the separate status capability digest for polling', () => {
    store.createRequestRpc(request('request-a'));
    expect(
      store.getStatusRpc({
        id: 'request-a',
        tenantId: 'tenant-a',
        statusTokenHash: 'wrong-hash',
      })
    ).toBeNull();
    expect(
      store.getStatusRpc({
        id: 'request-a',
        tenantId: 'tenant-a',
        statusTokenHash: 'status-token-hash',
        now: 2_000,
      })?.status
    ).toBe('pending');
  });

  it('allows only one response reservation', () => {
    store.createRequestRpc(request('request-a'));
    const first = store.reserveResponseRpc({
      id: 'request-a',
      tenantId: 'tenant-a',
      responseFingerprint: 'response-a',
      now: 2_000,
    });
    const replay = store.reserveResponseRpc({
      id: 'request-a',
      tenantId: 'tenant-a',
      responseFingerprint: 'response-a',
      now: 2_001,
    });
    expect(first.reserved).toBe(true);
    expect(replay).toEqual({ reserved: false, reason: 'replayed' });
  });

  it('requires the matching reservation to complete', () => {
    store.createRequestRpc(request('request-a'));
    const result = store.reserveResponseRpc({
      id: 'request-a',
      tenantId: 'tenant-a',
      responseFingerprint: 'response-a',
      now: 2_000,
    });
    expect(
      store.completeResponseRpc({
        id: 'request-a',
        tenantId: 'tenant-a',
        reservationId: 'attacker',
      })
    ).toBe(false);
    if (result.reserved)
      expect(
        store.completeResponseRpc({
          id: 'request-a',
          tenantId: 'tenant-a',
          reservationId: result.reservationId,
          verifiedClaims: {
            age_over_18: true,
            email: 'unrequested@example.com',
            nested_profile: { secret: 'not-stored' },
          },
        })
      ).toBe(true);
    expect(
      store.getRequestRpc({ id: 'request-a', tenantId: 'tenant-a', now: 3_000 })?.verifiedClaims
    ).toEqual({ age_over_18: true });
  });

  it('expires before reserving and rejects cross-tenant lookup', () => {
    store.createRequestRpc(request('request-a', { expiresAt: 2_000 }));
    expect(
      store.reserveResponseRpc({
        id: 'request-a',
        tenantId: 'tenant-a',
        responseFingerprint: 'response-a',
        now: 2_001,
      })
    ).toEqual({ reserved: false, reason: 'expired' });
    expect(store.getRequestRpc({ id: 'request-a', tenantId: 'tenant-b', now: 1_500 })).toBeNull();
  });
});
