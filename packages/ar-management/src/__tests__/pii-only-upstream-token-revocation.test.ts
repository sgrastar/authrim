import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  mergeUpstreamTokenRevocationSummaries,
  revokeUpstreamTokensBeforeErasure,
} from '../pii-only-upstream-token-revocation';

const input = { tenantId: 'tenant-a', userId: 'user-1' };

function pii(hasTokens: boolean) {
  const queryOne = vi.fn(async () => (hasTokens ? { upstream_token_identity: 1 } : null));
  return { adapter: { queryOne } as unknown as DatabaseAdapter, queryOne };
}

function logger() {
  const warnings: unknown[][] = [];
  return { warn: (...args: unknown[]) => warnings.push(args), warnings };
}

function envWith(revoke?: (...args: unknown[]) => unknown, extra: Partial<Env> = {}): Env {
  return {
    ...(revoke
      ? { EXTERNAL_IDP_ADMIN: { fetch: vi.fn(), revokeUserLinkedIdentityTokens: revoke } }
      : {}),
    ...extra,
  } as unknown as Env;
}

describe('revokeUpstreamTokensBeforeErasure', () => {
  afterEach(() => vi.useRealTimers());

  it('makes no call when no active linked identity holds a stored token', async () => {
    const revoke = vi.fn();
    const { adapter, queryOne } = pii(false);

    const result = await revokeUpstreamTokensBeforeErasure(
      envWith(revoke),
      adapter,
      input,
      logger()
    );

    expect(result).toEqual({ status: 'no_tokens', identities: 0, outcomes: {} });
    expect(revoke).not.toHaveBeenCalled();
    // Only the presence of a ciphertext is read, never a token column's value.
    const [sql, params] = queryOne.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/SELECT 1 AS upstream_token_identity FROM linked_identities/u);
    expect(sql).toMatch(/provisioning_state = 'active'/u);
    expect(params).toEqual(['tenant-a', 'user-1']);
  });

  it('asks the bridge with the tenant, the user and the time limit only', async () => {
    const revoke = vi.fn(async () => ({
      schemaVersion: 1,
      identities: [
        { providerId: 'p1', outcome: 'revoked' },
        { providerId: 'p2', outcome: 'revoked' },
      ],
    }));
    const log = logger();

    const result = await revokeUpstreamTokensBeforeErasure(
      envWith(revoke, { EXTERNAL_IDP_TOKEN_REVOCATION_TIMEOUT_MS: '1500' } as Partial<Env>),
      pii(true).adapter,
      input,
      log
    );

    expect(revoke).toHaveBeenCalledWith({
      schemaVersion: 1,
      tenantId: 'tenant-a',
      userId: 'user-1',
      timeoutMs: 1500,
    });
    expect(result).toEqual({ status: 'completed', identities: 2, outcomes: { revoked: 2 } });
    expect(log.warnings).toEqual([]);
  });

  it.each([
    ['9000', 9000],
    ['9000.0', 9000],
    ['9000junk', 3000],
    ['20000', 3000],
  ])(
    'reads the environment variable %s alike whether or not the tenant settings can be read',
    async (raw, expected) => {
      const timeouts: unknown[] = [];
      const revoke = vi.fn(async (request: { timeoutMs: number }) => {
        timeouts.push(request.timeoutMs);
        return { schemaVersion: 1, identities: [] };
      });
      const brokenKv = {
        get: vi.fn(async () => {
          throw new Error('kv unavailable');
        }),
      };
      for (const extra of [{}, { SETTINGS: brokenKv }]) {
        await revokeUpstreamTokensBeforeErasure(
          envWith(
            revoke as never,
            {
              ...extra,
              EXTERNAL_IDP_TOKEN_REVOCATION_TIMEOUT_MS: raw,
            } as unknown as Partial<Env>
          ),
          pii(true).adapter,
          input,
          logger()
        );
      }

      expect(brokenKv.get).toHaveBeenCalled();
      expect(timeouts).toEqual([expected, expected]);
    }
  );

  it('answers incomplete (and warns with counts only) when an identity was not revoked', async () => {
    const revoke = vi.fn(async () => ({
      schemaVersion: 1,
      identities: [
        { providerId: 'p1', outcome: 'revoked' },
        { providerId: 'p2', outcome: 'not_supported' },
        { providerId: 'p3', outcome: 'something_new' },
      ],
    }));
    const log = logger();

    const result = await revokeUpstreamTokensBeforeErasure(
      envWith(revoke),
      pii(true).adapter,
      input,
      log
    );

    expect(result).toEqual({
      status: 'incomplete',
      identities: 3,
      outcomes: { revoked: 1, not_supported: 1, failed: 1 },
    });
    expect(log.warnings).toHaveLength(1);
  });

  it('answers unavailable when the bridge is not bound', async () => {
    const log = logger();

    const result = await revokeUpstreamTokensBeforeErasure(
      envWith(undefined),
      pii(true).adapter,
      input,
      log
    );

    expect(result.status).toBe('unavailable');
    expect(log.warnings).toHaveLength(1);
  });

  it('answers failed, without the error message, when the call fails', async () => {
    const revoke = vi.fn(async () => {
      throw new Error('upstream said: token plain-secret-token');
    });
    const log = logger();

    const result = await revokeUpstreamTokensBeforeErasure(
      envWith(revoke),
      pii(true).adapter,
      input,
      log
    );

    expect(result.status).toBe('failed');
    expect(JSON.stringify(log.warnings)).not.toContain('plain-secret-token');
  });

  it('answers timed_out when the bridge ran out of time before reading the identities', async () => {
    const revoke = vi.fn(async () => {
      throw new Error('user_token_revocation_timed_out');
    });

    const result = await revokeUpstreamTokensBeforeErasure(
      envWith(revoke),
      pii(true).adapter,
      input,
      logger()
    );

    expect(result.status).toBe('timed_out');
  });

  it('answers failed for an answer of another shape', async () => {
    const revoke = vi.fn(async () => ({ schemaVersion: 2 }));

    const result = await revokeUpstreamTokensBeforeErasure(
      envWith(revoke),
      pii(true).adapter,
      input,
      logger()
    );

    expect(result.status).toBe('failed');
  });

  it('stops waiting after the time limit and a grace period', async () => {
    vi.useFakeTimers();
    const revoke = vi.fn(() => new Promise(() => undefined));
    let settled = false;

    const pending = revokeUpstreamTokensBeforeErasure(
      envWith(revoke),
      pii(true).adapter,
      input,
      logger()
    ).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);

    expect((await pending).status).toBe('timed_out');
  });

  it('answers failed when the presence check itself fails', async () => {
    const adapter = {
      queryOne: vi.fn(async () => {
        throw new Error('d1 down');
      }),
    } as unknown as DatabaseAdapter;

    const result = await revokeUpstreamTokensBeforeErasure(
      envWith(vi.fn()),
      adapter,
      input,
      logger()
    );

    expect(result.status).toBe('failed');
  });
});

describe('mergeUpstreamTokenRevocationSummaries', () => {
  const completed = { status: 'completed' as const, identities: 1, outcomes: { revoked: 1 } };
  const none = { status: 'no_tokens' as const, identities: 0, outcomes: {} };

  it('keeps the first pass when the second had nothing to revoke', () => {
    expect(mergeUpstreamTokenRevocationSummaries(completed, none)).toBe(completed);
    expect(mergeUpstreamTokenRevocationSummaries(completed, null)).toBe(completed);
  });

  it('takes the second pass when only it had tokens', () => {
    expect(mergeUpstreamTokenRevocationSummaries(none, completed)).toBe(completed);
  });

  it('adds the counts and keeps the worse status', () => {
    expect(
      mergeUpstreamTokenRevocationSummaries(completed, {
        status: 'incomplete',
        identities: 2,
        outcomes: { revoked: 1, timed_out: 1 },
      })
    ).toEqual({ status: 'incomplete', identities: 3, outcomes: { revoked: 2, timed_out: 1 } });
    expect(
      mergeUpstreamTokenRevocationSummaries(
        { status: 'failed', identities: 0, outcomes: {} },
        completed
      ).status
    ).toBe('failed');
  });
});
