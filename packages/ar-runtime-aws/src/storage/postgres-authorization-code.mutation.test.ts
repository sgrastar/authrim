/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- fake DynamoDB/Postgres command inputs are intentionally untyped */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PostgresAuthorizationCodeStore } from './postgres-authorization-code';
import type { PostgresQueryClient } from './postgres-transient-state';

const CODE = '123e4567-e89b-42d3-a456-426614174000';

function makeDb(rows: unknown[]) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  return { db: { query } as unknown as PostgresQueryClient, query };
}
const future = () => [{ expires_at_ms: Date.now() + 60_000 }];

function request(overrides: Record<string, unknown> = {}) {
  return {
    code: CODE,
    tenantId: 'tenant-a',
    userId: 'user-1',
    clientId: 'client-1',
    redirectUri: 'https://authrim.local/direct-auth/callback',
    codeChallenge: 'challenge',
    codeChallengeMethod: 'S256',
    scope: 'openid',
    ...overrides,
  } as never;
}

const UNSUPPORTED = 'aws_authorization_code_profile_unsupported';

describe('PostgresAuthorizationCodeStore (mutation hardening)', () => {
  it('passes hashed code, payload without the code, and default ttl/max to the database function', async () => {
    const { db, query } = makeDb(future());
    const result = await new PostgresAuthorizationCodeStore(db).store(request());
    expect(result.success).toBe(true);
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('authrim_aws_store_authorization_code');
    expect(values[0]).toBe('tenant-a');
    expect(values[1]).toBe('user-1');
    expect(values[2]).toBe(createHash('sha256').update(CODE).digest('hex'));
    expect(values[3]).toBe('client-1');
    const payload = JSON.parse(values[4] as string);
    expect(payload.code).toBeUndefined();
    expect(payload.scope).toBe('openid');
    expect(values[5]).toBe(60);
    expect(values[6]).toBe(100);
  });

  it('falls back to defaults for zero, negative, fractional and non-number ttl/max', async () => {
    for (const bad of [0, -5, 1.5, Number.NaN, '10']) {
      const { db, query } = makeDb(future());
      await new PostgresAuthorizationCodeStore(db).store(
        request({ ttlSeconds: bad, maxCodesPerUser: bad })
      );
      const values = (query.mock.calls[0] as unknown as [string, unknown[]])[1];
      expect(values[5]).toBe(60);
      expect(values[6]).toBe(100);
    }
  });

  it('uses valid explicit ttl and max values, including the inclusive upper bounds', async () => {
    const { db, query } = makeDb(future());
    const store = new PostgresAuthorizationCodeStore(db);
    await store.store(request({ ttlSeconds: 1, maxCodesPerUser: 1 }));
    await store.store(request({ ttlSeconds: 3600, maxCodesPerUser: 10_000 }));
    const calls = query.mock.calls as unknown as [string, unknown[]][];
    expect(calls[0][1].slice(5)).toEqual([1, 1]);
    expect(calls[1][1].slice(5)).toEqual([3600, 10_000]);
  });

  it('rejects out-of-profile ttl and max values', async () => {
    const { db, query } = makeDb(future());
    const store = new PostgresAuthorizationCodeStore(db);
    await expect(store.store(request({ ttlSeconds: 3601 }))).rejects.toThrow(UNSUPPORTED);
    await expect(store.store(request({ maxCodesPerUser: 10_001 }))).rejects.toThrow(UNSUPPORTED);
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts authorizationServer "default" and subjectType "end_user" only', async () => {
    const { db, query } = makeDb(future());
    const store = new PostgresAuthorizationCodeStore(db);
    await store.store(request({ authorizationServer: 'default', subjectType: 'end_user' }));
    expect(query).toHaveBeenCalledTimes(1);
    await expect(store.store(request({ authorizationServer: 'other' }))).rejects.toThrow(
      UNSUPPORTED
    );
    await expect(store.store(request({ authorizationServer: '' }))).rejects.toThrow(UNSUPPORTED);
    await expect(store.store(request({ subjectType: 'service' }))).rejects.toThrow(UNSUPPORTED);
    await expect(store.store(request({ subjectType: '' }))).rejects.toThrow(UNSUPPORTED);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects other profile violations', async () => {
    const { db, query } = makeDb(future());
    const store = new PostgresAuthorizationCodeStore(db);
    const bad = [
      { tenantId: 'Bad' },
      { code: 'not-a-uuid' },
      { userId: '' },
      { userId: 'u'.repeat(257) },
      { clientId: '' },
      { clientId: 'c'.repeat(257) },
      { redirectUri: 'https://evil.example/cb' },
      { codeChallengeMethod: 'plain' },
      { codeChallenge: '' },
      { codeChallenge: 'x'.repeat(257) },
    ];
    for (const o of bad) {
      await expect(store.store(request(o))).rejects.toThrow(UNSUPPORTED);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects payloads over 64 KiB and accepts ones under', async () => {
    const { db, query } = makeDb(future());
    const store = new PostgresAuthorizationCodeStore(db);
    await expect(store.store(request({ scope: 'a'.repeat(64 * 1024) }))).rejects.toThrow(
      'aws_authorization_code_too_large'
    );
    expect(query).not.toHaveBeenCalled();
    await store.store(request({ scope: 'a'.repeat(60 * 1024) }));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the database returns no expiry', async () => {
    for (const rows of [[], [{ expires_at_ms: null }], [{}]]) {
      await expect(
        new PostgresAuthorizationCodeStore(makeDb(rows).db).store(request())
      ).rejects.toThrow('aws_authorization_code_unavailable');
    }
  });

  it('rejects expiries that are not safe integers in the future', async () => {
    for (const v of [Date.now() - 1000, 'abc', 1.5, Number.MAX_SAFE_INTEGER + 10]) {
      await expect(
        new PostgresAuthorizationCodeStore(makeDb([{ expires_at_ms: v }]).db).store(request())
      ).rejects.toThrow('aws_authorization_code_expiry_invalid');
    }
  });

  it('returns the numeric expiry for string database values', async () => {
    const at = Date.now() + 120_000;
    const result = await new PostgresAuthorizationCodeStore(
      makeDb([{ expires_at_ms: String(at) }]).db
    ).store(request());
    expect(result).toEqual({ success: true, expiresAt: at });
  });
});
