import { describe, expect, it } from 'vitest';
import type { SAMLRequestData } from '@authrim/ar-lib-core';
import { PostgresTransientStateStore, type PostgresQueryClient } from '../postgres-transient-state';

type Stored = {
  tenantId: string;
  kind: string;
  id: string;
  payload: Record<string, unknown>;
  immutable: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
  revocationBoundAt?: number;
};

/**
 * A deterministic stand-in for PostgreSQL's row lock and conditional RETURNING.
 * Each query executes its condition and mutation together before its promise resolves.
 */
class FakePostgres implements PostgresQueryClient {
  readonly records = new Map<string, Stored>();
  readonly accountStates = new Map<string, { lifecycle: string; revokedAfterMs: number | null }>();
  readonly statements: string[] = [];
  nowMs = 1_800_000_000_000;

  private key(tenantId: string, kind: string, id: string): string {
    return `${tenantId}\u0000${kind}\u0000${id}`;
  }

  private returned(record: Stored): Record<string, unknown> {
    return {
      id: record.id,
      payload: record.payload,
      created_at_ms: String(record.createdAt),
      expires_at_ms: String(record.expiresAt),
      revocation_bound_at_ms:
        record.revocationBoundAt === undefined ? null : String(record.revocationBoundAt),
    };
  }

  async query<Row extends Record<string, unknown>>(
    sql: string,
    values: unknown[]
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    this.statements.push(sql);
    const action = sql.match(/\/\* aws-transient:([\w-]+) \*\//)?.[1];
    if (!action) throw new Error('Missing query action');

    const tenantId = values[0] as string;
    const id = values[1] as string;
    const kind = action.includes('session')
      ? 'session'
      : action.includes('challenge')
        ? 'challenge'
        : action.includes('saml-request')
          ? 'saml_request'
          : 'kv';
    const record = this.records.get(this.key(tenantId, kind, id));
    let rows: Record<string, unknown>[] = [];

    switch (action) {
      case 'create-session': {
        const account = this.accountStates.get(`${tenantId}\u0000${String(values[2])}`);
        if (!record && account?.lifecycle === 'active') {
          const created: Stored = {
            tenantId,
            kind,
            id,
            payload: JSON.parse(values[3] as string) as Record<string, unknown>,
            immutable: {},
            createdAt: this.nowMs,
            expiresAt: this.nowMs + (values[4] as number),
            consumedAt: null,
            revocationBoundAt: Math.max(this.nowMs, (account.revokedAfterMs ?? 0) + 1),
          };
          this.records.set(this.key(tenantId, kind, id), created);
          rows = [this.returned(created)];
        }
        break;
      }
      case 'get-session':
        if (record && record.consumedAt === null && record.expiresAt > this.nowMs) {
          const userId = record.payload.userId as string;
          const account = this.accountStates.get(`${tenantId}\u0000${userId}`);
          if (
            account?.lifecycle === 'active' &&
            (account.revokedAfterMs === null ||
              (record.revocationBoundAt ?? 0) > account.revokedAfterMs)
          ) {
            rows = [this.returned(record)];
          }
        }
        break;
      case 'get-challenge':
      case 'get-key':
        if (record && record.consumedAt === null && record.expiresAt > this.nowMs) {
          rows = [this.returned(record)];
        }
        break;
      case 'delete-session':
      case 'delete-challenge':
      case 'delete-key':
        if (record && record.consumedAt === null) {
          record.consumedAt = this.nowMs;
          rows = [this.returned(record)];
        }
        break;
      case 'store-challenge': {
        const deadline = Math.min(
          this.nowMs + (values[3] as number),
          (values[4] as number | null) ?? Number.POSITIVE_INFINITY
        );
        if (
          deadline > this.nowMs &&
          (!record || record.consumedAt !== null || record.expiresAt <= this.nowMs)
        ) {
          const created: Stored = {
            tenantId,
            kind,
            id,
            payload: JSON.parse(values[2] as string) as Record<string, unknown>,
            immutable: {},
            createdAt: this.nowMs,
            expiresAt: deadline,
            consumedAt: null,
          };
          this.records.set(this.key(tenantId, kind, id), created);
          rows = [this.returned(created)];
        }
        break;
      }
      case 'consume-challenge':
        if (
          record &&
          record.consumedAt === null &&
          record.expiresAt > this.nowMs &&
          record.payload.type === values[2] &&
          (values[3] === null || record.payload.challenge === values[3])
        ) {
          record.consumedAt = this.nowMs;
          rows = [this.returned(record)];
        }
        break;
      case 'is-challenge-claim-held':
        if (
          record &&
          record.consumedAt === null &&
          record.payload.challenge === values[2] &&
          record.expiresAt > this.nowMs &&
          record.expiresAt - this.nowMs >= (values[3] as number)
        ) {
          rows = [this.returned(record)];
        }
        break;
      case 'store-saml-request': {
        const payload = JSON.parse(values[2] as string) as Record<string, unknown>;
        const immutable = JSON.parse(values[3] as string) as Record<string, unknown>;
        const expiresAt = values[4] as number;
        if (
          expiresAt > this.nowMs &&
          expiresAt <= this.nowMs + 30 * 60 * 1000 &&
          (!record ||
            (record.expiresAt > this.nowMs &&
              record.payload.spEntityId === payload.spEntityId &&
              JSON.stringify(record.immutable) === JSON.stringify(immutable)))
        ) {
          if (record) {
            record.payload = payload;
            record.consumedAt = null;
            rows = [this.returned(record)];
          } else {
            const created: Stored = {
              tenantId,
              kind,
              id,
              payload,
              immutable,
              createdAt: this.nowMs,
              expiresAt,
              consumedAt: null,
            };
            this.records.set(this.key(tenantId, kind, id), created);
            rows = [this.returned(created)];
          }
        }
        break;
      }
      case 'consume-saml-request':
        if (
          record &&
          record.consumedAt === null &&
          record.expiresAt > this.nowMs &&
          record.payload.spEntityId === values[2] &&
          record.immutable.issuer === values[2]
        ) {
          record.consumedAt = this.nowMs;
          rows = [this.returned(record)];
        }
        break;
      case 'put-key': {
        const created: Stored = {
          tenantId,
          kind,
          id,
          payload: JSON.parse(values[2] as string) as Record<string, unknown>,
          immutable: {},
          createdAt: this.nowMs,
          expiresAt: this.nowMs + (values[3] as number),
          consumedAt: null,
        };
        this.records.set(this.key(tenantId, kind, id), created);
        rows = [this.returned(created)];
        break;
      }
      case 'prune-expired': {
        let remaining = values[0] as number;
        for (const [key, candidate] of this.records) {
          if (remaining > 0 && candidate.expiresAt <= this.nowMs) {
            this.records.delete(key);
            rows.push(this.returned(candidate));
            remaining--;
          }
        }
        break;
      }
      default:
        throw new Error(`Unexpected query action: ${action}`);
    }

    return { rows: rows as Row[], rowCount: rows.length };
  }
}

function request(nowMs: number, overrides: Partial<SAMLRequestData> = {}): SAMLRequestData {
  return {
    requestId: '_authn-1',
    issuer: 'https://sp.example.test/metadata',
    destination: 'https://idp.example.test/sso',
    acsUrl: 'https://sp.example.test/acs',
    binding: 'post',
    type: 'authn_request',
    used: false,
    createdAt: nowMs,
    expiresAt: nowMs + 5 * 60 * 1000,
    relayState: 'browser-state',
    ...overrides,
  };
}

describe('PostgresTransientStateStore', () => {
  it('uses a single tenant-bound conditional UPDATE for each one-use consume', async () => {
    const db = new FakePostgres();
    const store = new PostgresTransientStateStore(db);
    await store.storeChallenge({
      tenantId: 'tenant-a',
      id: 'challenge-1',
      type: 'login',
      userId: 'user-a',
      challenge: 'secret',
      ttlMs: 60_000,
    });
    await store.consumeChallenge({
      tenantId: 'tenant-a',
      id: 'challenge-1',
      type: 'login',
      challenge: 'secret',
    });
    await store.storeSamlRequest({
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.test/metadata',
      request: request(db.nowMs),
    });
    await store.consumeSamlRequest({
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example.test/metadata',
      requestId: '_authn-1',
    });
    for (const sql of db.statements.filter((statement) => statement.includes(':consume-'))) {
      expect(sql).toMatch(/UPDATE authrim_aws_transient_state[\s\S]*tenant_id = \$1/);
      expect(sql).toMatch(/consumed_at_ms IS NULL AND expires_at_ms >/);
      expect(sql).toMatch(/RETURNING/);
    }
  });

  it('rejects challenge replay, wrong tenant, wrong type and wrong value without burning it', async () => {
    const db = new FakePostgres();
    const store = new PostgresTransientStateStore(db);
    const input = {
      tenantId: 'tenant-a',
      id: 'challenge-1',
      type: 'login',
      userId: 'user-a',
      challenge: 'correct-value',
      ttlMs: 60_000,
    };
    expect(await store.storeChallenge(input)).toBe(true);
    expect(
      await store.consumeChallenge({
        tenantId: 'tenant-b',
        id: input.id,
        type: input.type,
        challenge: input.challenge,
      })
    ).toBeNull();
    expect(
      await store.consumeChallenge({
        tenantId: input.tenantId,
        id: input.id,
        type: 'consent',
        challenge: input.challenge,
      })
    ).toBeNull();
    expect(
      await store.consumeChallenge({
        tenantId: input.tenantId,
        id: input.id,
        type: input.type,
        challenge: 'wrong',
      })
    ).toBeNull();
    const [first, second] = await Promise.all([
      store.consumeChallenge({
        tenantId: input.tenantId,
        id: input.id,
        type: input.type,
        challenge: input.challenge,
      }),
      store.consumeChallenge({
        tenantId: input.tenantId,
        id: input.id,
        type: input.type,
        challenge: input.challenge,
      }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(
      await store.consumeChallenge({
        tenantId: input.tenantId,
        id: input.id,
        type: input.type,
        challenge: input.challenge,
      })
    ).toBeNull();
  });

  it('expires challenges by the database clock and allows a fresh challenge after expiry', async () => {
    const db = new FakePostgres();
    const store = new PostgresTransientStateStore(db);
    const input = {
      tenantId: 'tenant-a',
      id: 'challenge-1',
      type: 'login',
      userId: 'user-a',
      challenge: 'first',
      ttlMs: 1000,
    };
    await store.storeChallenge(input);
    expect(await store.storeChallenge({ ...input, challenge: 'second' })).toBe(false);
    db.nowMs += 1000;
    expect(
      await store.consumeChallenge({
        tenantId: input.tenantId,
        id: input.id,
        type: input.type,
        challenge: input.challenge,
      })
    ).toBeNull();
    expect(await store.storeChallenge({ ...input, challenge: 'second' })).toBe(true);
    expect(
      (
        await store.consumeChallenge({
          tenantId: input.tenantId,
          id: input.id,
          type: input.type,
          challenge: 'second',
        })
      )?.challenge
    ).toBe('second');
  });

  it('claims a challenge lease only once and checks its owner and remaining lifetime', async () => {
    const db = new FakePostgres();
    const store = new PostgresTransientStateStore(db);
    const claim = {
      tenantId: 'tenant-a',
      id: 'lease-1',
      type: 'login',
      userId: 'user-a',
      challenge: 'owner-secret',
      ttlMs: 5000,
      notAfterMs: db.nowMs + 3000,
      metadata: { purpose: 'login' },
      email: 'user@example.test',
      redirectUri: 'https://app.example.test/return',
    };
    expect(await store.claimChallenge(claim)).toBe(true);
    expect(await store.claimChallenge(claim)).toBe(false);
    expect(await store.getChallenge({ tenantId: 'tenant-b', id: claim.id })).toBeNull();
    expect(await store.getChallenge({ tenantId: 'tenant-a', id: claim.id })).toMatchObject({
      expiresAt: db.nowMs + 3000,
      metadata: { purpose: 'login' },
      email: claim.email,
      redirectUri: claim.redirectUri,
    });
    expect(
      await store.isChallengeClaimHeld({
        tenantId: 'tenant-a',
        id: claim.id,
        challenge: 'wrong',
        minRemainingMs: 1000,
      })
    ).toBe(false);
    expect(
      await store.isChallengeClaimHeld({
        tenantId: 'tenant-a',
        id: claim.id,
        challenge: claim.challenge,
        minRemainingMs: 3000,
      })
    ).toBe(true);
    db.nowMs += 1;
    expect(
      await store.isChallengeClaimHeld({
        tenantId: 'tenant-a',
        id: claim.id,
        challenge: claim.challenge,
        minRemainingMs: 3000,
      })
    ).toBe(false);
    expect(await store.deleteChallenge({ tenantId: 'tenant-b', id: claim.id })).toBe(false);
    expect(await store.deleteChallenge({ tenantId: 'tenant-a', id: claim.id })).toBe(true);
    expect(await store.getChallenge({ tenantId: 'tenant-a', id: claim.id })).toBeNull();
  });

  it('consumes a SAML request once per trusted re-store without changing original expiry', async () => {
    const db = new FakePostgres();
    const store = new PostgresTransientStateStore(db);
    const spEntityId = 'https://sp.example.test/metadata';
    const initial = request(db.nowMs);
    await store.storeSamlRequest({ tenantId: 'tenant-a', spEntityId, request: initial });
    expect(
      await store.consumeSamlRequest({
        tenantId: 'tenant-b',
        spEntityId,
        requestId: initial.requestId,
      })
    ).toBeNull();
    expect(
      await store.consumeSamlRequest({
        tenantId: 'tenant-a',
        spEntityId: 'https://other.example.test',
        requestId: initial.requestId,
      })
    ).toBeNull();
    const attempt = { tenantId: 'tenant-a', spEntityId, requestId: initial.requestId };
    const [first, second] = await Promise.all([
      store.consumeSamlRequest(attempt),
      store.consumeSamlRequest(attempt),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(first?.used ?? second?.used).toBe(true);
    expect(await store.consumeSamlRequest(attempt)).toBeNull();

    db.nowMs += 10_000;
    await store.storeSamlRequest({
      tenantId: 'tenant-a',
      spEntityId,
      request: request(db.nowMs, {
        context: { reauthentication: { issuedAt: db.nowMs } },
        expiresAt: db.nowMs + 5 * 60 * 1000,
      }),
    });
    const resumed = await store.consumeSamlRequest(attempt);
    expect(resumed?.context?.reauthentication?.issuedAt).toBe(db.nowMs);
    expect(resumed?.createdAt).toBe(initial.createdAt);
    expect(resumed?.expiresAt).toBe(initial.expiresAt);
    expect(await store.consumeSamlRequest(attempt)).toBeNull();
  });

  it('refuses SAML re-store with changed immutable request, SP or expired original request', async () => {
    const db = new FakePostgres();
    const store = new PostgresTransientStateStore(db);
    const spEntityId = 'https://sp.example.test/metadata';
    const initial = request(db.nowMs);
    await store.storeSamlRequest({ tenantId: 'tenant-a', spEntityId, request: initial });
    await store.consumeSamlRequest({
      tenantId: 'tenant-a',
      spEntityId,
      requestId: initial.requestId,
    });
    await expect(
      store.storeSamlRequest({
        tenantId: 'tenant-a',
        spEntityId,
        request: { ...initial, acsUrl: 'https://attacker.example.test/acs' },
      })
    ).rejects.toThrow('binding conflict');
    await expect(
      store.storeSamlRequest({
        tenantId: 'tenant-a',
        spEntityId: 'https://other.example.test',
        request: initial,
      })
    ).rejects.toThrow('Invalid SAML request binding');
    db.nowMs = initial.expiresAt;
    await expect(
      store.storeSamlRequest({
        tenantId: 'tenant-a',
        spEntityId,
        request: { ...initial, expiresAt: db.nowMs + 300_000 },
      })
    ).rejects.toThrow('binding conflict');
    expect(
      await store.consumeSamlRequest({
        tenantId: 'tenant-a',
        spEntityId,
        requestId: initial.requestId,
      })
    ).toBeNull();
  });

  it('keeps sessions tenant-scoped and invalidates them immediately', async () => {
    const db = new FakePostgres();
    const store = new PostgresTransientStateStore(db);
    db.accountStates.set('tenant-a\u0000user-a', { lifecycle: 'active', revokedAfterMs: null });
    const session = await store.createSession({
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      userId: 'user-a',
      ttlMs: 60_000,
      data: { amr: ['pwd'], proven_at: db.nowMs },
    });
    expect(session.userId).toBe('user-a');
    expect(await store.getSession({ tenantId: 'tenant-b', sessionId: 'session-1' })).toBeNull();
    expect(
      (await store.getSession({ tenantId: 'tenant-a', sessionId: 'session-1' }))?.data
    ).toEqual({ amr: ['pwd'], proven_at: db.nowMs });
    await expect(
      store.createSession({
        tenantId: 'tenant-a',
        sessionId: 'session-1',
        userId: 'attacker',
        ttlMs: 60_000,
      })
    ).rejects.toThrow('already exists');
    expect(await store.deleteSession({ tenantId: 'tenant-b', sessionId: 'session-1' })).toBe(false);
    expect(await store.deleteSession({ tenantId: 'tenant-a', sessionId: 'session-1' })).toBe(true);
    expect(await store.getSession({ tenantId: 'tenant-a', sessionId: 'session-1' })).toBeNull();
  });

  it('fails closed for unseeded or inactive accounts and observes later revocation', async () => {
    const db = new FakePostgres();
    const store = new PostgresTransientStateStore(db);
    const input = {
      tenantId: 'tenant-a',
      sessionId: 'session-1',
      userId: 'user-a',
      ttlMs: 60_000,
    };
    await expect(store.createSession(input)).rejects.toThrow('Session unavailable');
    db.accountStates.set('tenant-a\u0000user-a', { lifecycle: 'suspended', revokedAfterMs: null });
    await expect(store.createSession(input)).rejects.toThrow('Session unavailable');
    db.accountStates.set('tenant-a\u0000user-a', { lifecycle: 'active', revokedAfterMs: null });
    const session = await store.createSession(input);
    expect(session.revocationBoundAtMs).toBe(db.nowMs);
    db.accountStates.set('tenant-a\u0000user-a', {
      lifecycle: 'active',
      revokedAfterMs: session.revocationBoundAtMs,
    });
    expect(
      await store.getSession({ tenantId: input.tenantId, sessionId: input.sessionId })
    ).toBeNull();
    db.accountStates.set('tenant-a\u0000user-a', { lifecycle: 'suspended', revokedAfterMs: null });
    expect(
      await store.getSession({ tenantId: input.tenantId, sessionId: input.sessionId })
    ).toBeNull();
  });

  it('scopes transient keys to a tenant and prunes expired rows in bounded batches', async () => {
    const db = new FakePostgres();
    const store = new PostgresTransientStateStore(db);
    await store.putKey({ tenantId: 'tenant-a', key: 'relay', value: 'value-a', ttlMs: 1000 });
    await store.putKey({ tenantId: 'tenant-b', key: 'relay', value: 'value-b', ttlMs: 2000 });
    expect(await store.getKey({ tenantId: 'tenant-a', key: 'relay' })).toBe('value-a');
    expect(await store.getKey({ tenantId: 'tenant-b', key: 'relay' })).toBe('value-b');
    db.nowMs += 1000;
    expect(await store.getKey({ tenantId: 'tenant-a', key: 'relay' })).toBeNull();
    expect(await store.pruneExpired(1)).toBe(1);
    expect(await store.getKey({ tenantId: 'tenant-b', key: 'relay' })).toBe('value-b');
    expect(await store.deleteKey({ tenantId: 'tenant-b', key: 'relay' })).toBe(true);
    expect(await store.getKey({ tenantId: 'tenant-b', key: 'relay' })).toBeNull();
  });
});
