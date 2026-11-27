/**
 * readTokenRevocationState: the fail-closed revocation read (the Check API's self contract).
 * Where isTokenRevoked answers "not revoked" because it could not find out, this answers
 * `unavailable`.
 */
import { describe, expect, it } from 'vitest';
import { readTokenRevocationState } from '../kv';
import type { Env } from '../../types/env';

const TENANT = 'tenant-a';
const JTI = 'plain-jti-1';
const LEGACY_NAME = 'tenant:tenant-a:token-revocation';

type Handler = () => Promise<Response> | Response;

function envWith(shard: Handler, legacy: Handler = () => Response.json({ revoked: false })): Env {
  return {
    TOKEN_REVOCATION_STORE: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async () => (name === LEGACY_NAME ? legacy() : shard()),
      }),
    },
  } as unknown as Env;
}

describe('readTokenRevocationState', () => {
  it('is unavailable without the binding', async () => {
    expect(await readTokenRevocationState({} as Env, JTI, TENANT)).toBe('unavailable');
  });

  it('reads revoked and active answers', async () => {
    expect(
      await readTokenRevocationState(
        envWith(() => Response.json({ revoked: true })),
        JTI,
        TENANT
      )
    ).toBe('revoked');
    expect(
      await readTokenRevocationState(
        envWith(() => Response.json({ revoked: false })),
        JTI,
        TENANT
      )
    ).toBe('active');
    expect(
      await readTokenRevocationState(
        envWith(
          () => Response.json({ revoked: false }),
          () => Response.json({ revoked: true })
        ),
        JTI,
        TENANT
      )
    ).toBe('revoked');
  });

  it.each([
    ['a non-2xx answer', () => Response.json({ revoked: false }, { status: 500 })],
    ['an answer without revoked', () => Response.json({})],
    [
      'a network error',
      () => {
        throw new Error('network');
      },
    ],
  ])('is unavailable for %s (shard or legacy store)', async (_label, failing) => {
    expect(await readTokenRevocationState(envWith(failing), JTI, TENANT)).toBe('unavailable');
    expect(
      await readTokenRevocationState(
        envWith(() => Response.json({ revoked: false }), failing),
        JTI,
        TENANT
      )
    ).toBe('unavailable');
  });
});
