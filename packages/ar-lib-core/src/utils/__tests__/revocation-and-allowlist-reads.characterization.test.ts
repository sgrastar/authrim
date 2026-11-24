/**
 * Characterization of two shared reads (AWS portability design, step P1):
 *
 *  - `isTokenRevoked` normally answers a boolean (a 200 answer of the legacy store without a `revoked`
 *    property yields `undefined`), and answers `false` ("not revoked") in several situations in which it
 *    could not find out: no binding, a non-2xx answer of the shard, a network error, a failing legacy store.
 *    A port-based reader returns `unknown` in those cases; this file records what exists today.
 *  - `loadWalletAllowlist` treats a missing binding and a missing record as the empty list, prefers
 *    `SETTINGS` over `AUTHRIM_CONFIG`, and throws on a record that does not validate.
 *
 * Must pass on unchanged code.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTokenRevoked } from '../kv';
import { loadWalletAllowlist, walletAllowlistKey } from '../../vc/wallet-allowlist-read';
import type { Env } from '../../types/env';

const TENANT = 'tenant-a';
const JTI = 'plain-jti-1'; // not a region-aware id: routed by hash, legacy store consulted as well
// The legacy store's instance name, written out (not read back from the code under test).
const LEGACY_NAME = 'tenant:tenant-a:token-revocation';
const SHARD_NAME = /^tenant:tenant-a:token-revocation:shard-\d+$/;

type Handler = (url: string) => Promise<Response> | Response;

/** A TOKEN_REVOCATION_STORE namespace whose instances answer through `handlers[instanceName]`. */
function revocationNamespace(handlers: Record<string, Handler>, fallback: Handler) {
  const asked: string[] = [];
  const reached: string[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: async (url: string) => {
        asked.push(name);
        const handler = handlers[name];
        if (handler) reached.push(name);
        return (handler ?? fallback)(url);
      },
    }),
  };
  return { namespace, asked, reached };
}

const answer = (revoked: boolean) => () => Response.json({ revoked });
// The body says "revoked" on purpose: a reader that ignored the HTTP status would answer true.
const status = (code: number) => () => Response.json({ revoked: true }, { status: code });
const unreachable = () => {
  throw new Error('network');
};

function envWith(namespace: unknown): Env {
  return { TOKEN_REVOCATION_STORE: namespace } as unknown as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isTokenRevoked (shared reader) today', () => {
  it('answers false and does not look anywhere when the binding is missing', async () => {
    expect(await isTokenRevoked({} as Env, JTI, TENANT)).toBe(false);
  });

  it('answers true when the shard says revoked, without asking the legacy store', async () => {
    const { namespace, asked } = revocationNamespace({}, answer(true));
    expect(await isTokenRevoked(envWith(namespace), JTI, TENANT)).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(SHARD_NAME);
  });

  it('asks the shard first and the legacy store second when the shard says not revoked', async () => {
    const { namespace, asked } = revocationNamespace({}, answer(false));
    expect(await isTokenRevoked(envWith(namespace), JTI, TENANT)).toBe(false);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(SHARD_NAME);
    expect(asked[1]).toBe(LEGACY_NAME);
  });

  it('trusts the legacy store when only it says revoked', async () => {
    const { namespace, reached } = revocationNamespace(
      { [LEGACY_NAME]: answer(true) },
      answer(false)
    );
    expect(await isTokenRevoked(envWith(namespace), JTI, TENANT)).toBe(true);
    expect(reached).toEqual([LEGACY_NAME]);
  });

  it('answers false (not "unknown") when the shard answers a non-2xx status, and does not ask the legacy store', async () => {
    const { namespace, asked } = revocationNamespace({}, status(500));
    expect(await isTokenRevoked(envWith(namespace), JTI, TENANT)).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it('answers false when the shard cannot be reached', async () => {
    const { namespace, asked } = revocationNamespace({}, unreachable);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await isTokenRevoked(envWith(namespace), JTI, TENANT)).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it('answers false when the legacy store answers non-2xx after the shard said not revoked', async () => {
    const { namespace, reached } = revocationNamespace(
      { [LEGACY_NAME]: status(503) },
      answer(false)
    );
    expect(await isTokenRevoked(envWith(namespace), JTI, TENANT)).toBe(false);
    // The failing legacy handler really ran.
    expect(reached).toEqual([LEGACY_NAME]);
  });

  it('answers false when the legacy store cannot be reached after the shard said not revoked', async () => {
    const { namespace, reached } = revocationNamespace(
      { [LEGACY_NAME]: unreachable },
      answer(false)
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await isTokenRevoked(envWith(namespace), JTI, TENANT)).toBe(false);
    expect(reached).toEqual([LEGACY_NAME]);
  });
});

describe('loadWalletAllowlist bindings today', () => {
  const kvWith = (raw: string | null) => ({ get: vi.fn(async () => raw) });
  const validEmpty = JSON.stringify({ version: 1, updatedAt: 1, revision: 4, entries: [] });

  it('is the empty list (revision 0) when there is no KV binding at all', async () => {
    const list = await loadWalletAllowlist({} as Env, TENANT);
    expect(list.entries).toEqual([]);
    expect(list.revision).toBe(0);
  });

  it('prefers SETTINGS and never reads AUTHRIM_CONFIG when SETTINGS exists', async () => {
    const settings = kvWith(validEmpty);
    const config = kvWith(null);
    const list = await loadWalletAllowlist(
      { SETTINGS: settings, AUTHRIM_CONFIG: config } as unknown as Env,
      TENANT
    );
    expect(list.revision).toBe(4);
    expect(settings.get).toHaveBeenCalledWith(walletAllowlistKey(TENANT), 'text');
    expect(config.get).not.toHaveBeenCalled();
  });

  it('does NOT fall back to AUTHRIM_CONFIG when SETTINGS has no record: the list is empty (revision 0)', async () => {
    const settings = kvWith(null);
    const config = kvWith(validEmpty);
    const list = await loadWalletAllowlist(
      { SETTINGS: settings, AUTHRIM_CONFIG: config } as unknown as Env,
      TENANT
    );
    expect(list.revision).toBe(0);
    expect(list.entries).toEqual([]);
    expect(config.get).not.toHaveBeenCalled();
  });

  it('uses AUTHRIM_CONFIG only when SETTINGS is absent', async () => {
    const config = kvWith(validEmpty);
    const list = await loadWalletAllowlist({ AUTHRIM_CONFIG: config } as unknown as Env, TENANT);
    expect(list.revision).toBe(4);
  });

  it('a read failure is an error, not an empty list', async () => {
    const failing = {
      get: vi.fn(async () => {
        throw new Error('kv down');
      }),
    };
    await expect(
      loadWalletAllowlist({ SETTINGS: failing } as unknown as Env, TENANT)
    ).rejects.toThrow('kv down');
  });

  describe('isTokenRevoked asks the right question, and what a malformed answer gives', () => {
    const ODD_JTI = 'a+b&c d/e';

    it('asks /check?jti=<encoded jti> of the shard and of the legacy store', async () => {
      const urls: string[] = [];
      const { namespace } = revocationNamespace({}, (url) => {
        urls.push(url);
        return Response.json({ revoked: false });
      });
      await isTokenRevoked(envWith(namespace), ODD_JTI, TENANT);
      expect(urls).toHaveLength(2);
      for (const url of urls) {
        const parsed = new URL(url);
        expect(parsed.pathname).toBe('/check');
        expect(parsed.searchParams.get('jti')).toBe(ODD_JTI);
      }
    });

    it('a 200 answer of the legacy store without a `revoked` property gives undefined (today), not false', async () => {
      const { namespace } = revocationNamespace(
        { [LEGACY_NAME]: () => Response.json({}) },
        answer(false)
      );
      expect(await isTokenRevoked(envWith(namespace), JTI, TENANT)).toBeUndefined();
    });

    it('an unparsable 200 answer of the legacy store gives false', async () => {
      const { namespace } = revocationNamespace(
        { [LEGACY_NAME]: () => new Response('not json', { status: 200 }) },
        answer(false)
      );
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await isTokenRevoked(envWith(namespace), JTI, TENANT)).toBe(false);
    });
  });
});
