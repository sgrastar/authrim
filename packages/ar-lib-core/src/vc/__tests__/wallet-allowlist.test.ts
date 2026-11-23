import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { Env } from '../../types/env';

const auditLog = vi.hoisted(() => ({ createAuditLog: vi.fn() }));
vi.mock('../../utils/audit-log', () => auditLog);

import {
  authenticateWalletClient,
  loadWalletAllowlist,
  parseWalletAllowlist,
  saveWalletAllowlist,
  walletAllowlistDigest,
  walletEntryToClient,
  type WalletAllowlistEntry,
} from '../wallet-allowlist';
import {
  CLIENT_ID,
  ISSUER,
  NOW,
  attestationJwt,
  generateKey,
  makePki,
  popJwt,
  type Pki,
  type TestKey,
} from './wallet-test-pki';

function fakeEnv(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set('settings:tenant:t1:wallet-attestation-allowlist', initial);
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
  };
  // No AUTH_RUNTIME_PORTS: the replay store goes through the Durable Object path, mocked below.
  return { env: { SETTINGS: kv } as unknown as Env, store, kv };
}

const replayStore = vi.hoisted(() => ({ seen: new Set<string>(), fail: false }));
vi.mock('../../utils/jti-replay-guard', () => ({
  recordReplayJti: async (_env: unknown, input: { jti: string }) => {
    if (replayStore.fail) throw new Error('jti_replay_store_unavailable:500');
    if (replayStore.seen.has(input.jti)) return 'replayed';
    replayStore.seen.add(input.jti);
    return 'recorded';
  },
}));

function entryFor(pki: Pki, overrides: Partial<WalletAllowlistEntry> = {}) {
  return {
    clientId: CLIENT_ID,
    label: 'Keyring',
    enabled: true,
    attestationRoots: [pki.anchor],
    keyAttestationRoots: [],
    redirectUris: ['https://wallet.example.com/cb'],
    ...overrides,
  };
}

const list = (...entries: unknown[]) => ({ version: 1, updatedAt: 0, entries });

describe('wallet allowlist', () => {
  let pki: Pki;
  let instance: TestKey;
  beforeAll(async () => {
    pki = await makePki();
    instance = await generateKey();
  });
  beforeEach(() => {
    auditLog.createAuditLog.mockReset().mockResolvedValue(undefined);
    replayStore.seen.clear();
    replayStore.fail = false;
  });

  describe('parseWalletAllowlist', () => {
    it('accepts a valid list and refuses malformed ones', async () => {
      expect((await parseWalletAllowlist(list(entryFor(pki)))).entries).toHaveLength(1);
      const bad: unknown[] = [
        null,
        { version: 2, entries: [] },
        list(entryFor(pki), entryFor(pki)),
        list(entryFor(pki, { clientId: 'bad id' })),
        list(entryFor(pki, { clientId: 'https://wallet.example.com' })),
        list(entryFor(pki, { redirectUris: ['com.example.wallet:/cb'] })),
        list(entryFor(pki, { redirectUris: [] })),
        list(entryFor(pki, { redirectUris: ['http://wallet.example.com/cb'] })),
        list(entryFor(pki, { redirectUris: ['https://wallet.example.com/cb#frag'] })),
        list(entryFor(pki, { attestationRoots: [] })),
        list(entryFor(pki, { attestationRoots: [{ ...pki.anchor, sha256: '0'.repeat(64) }] })),
        list(entryFor(pki, { attestationRoots: [{ certificate: 'AAAA', sha256: 'x' }] })),
      ];
      for (const value of bad) await expect(parseWalletAllowlist(value)).rejects.toThrow();
    });

    it('allows a disabled entry without roots', async () => {
      const parsed = await parseWalletAllowlist(
        list(entryFor(pki, { enabled: false, attestationRoots: [] }))
      );
      expect(parsed.entries[0].enabled).toBe(false);
    });
  });

  describe('load and save', () => {
    it('is empty without a record and fails on a corrupt one', async () => {
      expect((await loadWalletAllowlist(fakeEnv().env, 't1')).entries).toEqual([]);
      await expect(loadWalletAllowlist(fakeEnv('{"version":9}').env, 't1')).rejects.toThrow();
      await expect(loadWalletAllowlist(fakeEnv('not json').env, 't1')).rejects.toThrow();
    });

    const save = (env: Env, extra: Record<string, unknown> = {}) =>
      saveWalletAllowlist(env, {
        tenantId: 't1',
        allowlist: list(entryFor(pki)),
        actorId: 'admin-1',
        expectedRevision: 0,
        gate: 'admin_step_up',
        ...extra,
      } as never);

    it('refuses a call that did not come through the step-up gate', async () => {
      const { env, kv } = fakeEnv();
      await expect(save(env, { gate: 'none' })).rejects.toThrow(
        'wallet_allowlist_step_up_required'
      );
      expect(kv.put).not.toHaveBeenCalled();
      expect(auditLog.createAuditLog).not.toHaveBeenCalled();
    });

    it('audits before storing and after, stores no root contents, and counts revisions', async () => {
      const { env, store } = fakeEnv();
      const saved = await save(env);
      expect(saved.revision).toBe(1);
      const actions = auditLog.createAuditLog.mock.calls.map(
        (call) => (call[1] as { action: string }).action
      );
      expect(actions).toEqual(['wallet_allowlist.update', 'wallet_allowlist.update.applied']);
      const audit = auditLog.createAuditLog.mock.calls[0][1] as {
        severity: string;
        requireDurableFanout: boolean;
        metadata: string;
      };
      expect(audit).toMatchObject({ severity: 'critical', requireDurableFanout: true });
      expect(audit.metadata).not.toContain(pki.anchor.certificate);
      expect(audit.metadata).toContain(pki.anchor.sha256);
      expect(audit.metadata).toContain('https://wallet.example.com/cb');
      expect(store.has('settings:tenant:t1:wallet-attestation-allowlist')).toBe(true);
    });

    it('refuses a change made against an old revision', async () => {
      const { env } = fakeEnv();
      await save(env);
      await expect(save(env, { expectedRevision: 0 })).rejects.toThrow(
        'wallet_allowlist_revision_conflict'
      );
      expect((await save(env, { expectedRevision: 1 })).revision).toBe(2);
    });

    it('does not store the list when the audit cannot be written, and survives a failing applied audit', async () => {
      const { env, kv } = fakeEnv();
      auditLog.createAuditLog.mockRejectedValue(new Error('audit down'));
      await expect(save(env)).rejects.toThrow('audit down');
      expect(kv.put).not.toHaveBeenCalled();
      auditLog.createAuditLog
        .mockReset()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('applied audit down'));
      await expect(save(env)).resolves.toMatchObject({ revision: 1 });
    });

    it('changes the digest when anything an administrator approves changes', async () => {
      const base = (await parseWalletAllowlist(list(entryFor(pki)))).entries;
      const same = await walletAllowlistDigest(base);
      expect(await walletAllowlistDigest(structuredClone(base))).toBe(same);
      const moved = structuredClone(base);
      moved[0].redirectUris = ['https://evil.example.com/cb'];
      expect(await walletAllowlistDigest(moved)).not.toBe(same);
      const off = structuredClone(base);
      off[0].enabled = false;
      expect(await walletAllowlistDigest(off)).not.toBe(same);
    });
  });

  describe('authenticateWalletClient', () => {
    async function headers(pop?: string, attestation?: string) {
      const map = new Map([
        ['OAuth-Client-Attestation', attestation ?? (await attestationJwt(pki, instance))],
        ['OAuth-Client-Attestation-PoP', pop ?? (await popJwt(instance))],
      ]);
      return { get: (name: string) => map.get(name) ?? null };
    }
    const stored = async (...entries: unknown[]) =>
      fakeEnv(JSON.stringify(await parseWalletAllowlist(list(...entries)))).env;

    it('authenticates an allowlisted wallet and returns its virtual client', async () => {
      const result = await authenticateWalletClient({
        env: await stored(entryFor(pki)),
        tenantId: 't1',
        headers: await headers(),
        issuer: ISSUER,
        clientId: CLIENT_ID,
        now: NOW,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.client).toMatchObject({
          client_id: CLIENT_ID,
          token_endpoint_auth_method: 'attest_jwt_client_auth',
          dpop_bound_access_tokens: true,
          require_pkce: true,
          tenant_id: 't1',
        });
        expect(result.client.client_secret_hash).toBeUndefined();
      }
    });

    it('refuses everything with an empty list, a disabled entry or another wallet type', async () => {
      const run = async (env: Env) =>
        authenticateWalletClient({
          env,
          tenantId: 't1',
          headers: await headers(),
          issuer: ISSUER,
          clientId: CLIENT_ID,
          now: NOW,
        });
      expect((await run(fakeEnv().env)).ok).toBe(false);
      expect((await run(await stored(entryFor(pki, { enabled: false })))).ok).toBe(false);
      const other = await makePki();
      // The attestation's chain ends at `pki`, which only the other wallet type trusts.
      const result = await run(
        await stored(
          entryFor(other),
          entryFor(pki, { clientId: 'another-wallet', redirectUris: ['https://a.example.com/cb'] })
        )
      );
      expect(result).toEqual({ ok: false, error: 'attestation_chain_untrusted' });
    });

    it('refuses a replayed proof, a failing replay store and a corrupt list', async () => {
      const env = await stored(entryFor(pki));
      const h = await headers();
      const run = (e: Env, hh = h) =>
        authenticateWalletClient({
          env: e,
          tenantId: 't1',
          headers: hh,
          issuer: ISSUER,
          clientId: CLIENT_ID,
          now: NOW,
        });
      expect((await run(env)).ok).toBe(true);
      expect(await run(env)).toEqual({ ok: false, error: 'pop_replayed' });
      replayStore.fail = true;
      expect(await run(env, await headers())).toEqual({ ok: false, error: 'pop_replayed' });
      replayStore.fail = false;
      expect(await run(fakeEnv('{"version":9}').env, await headers())).toEqual({
        ok: false,
        error: 'wallet_allowlist_unavailable',
      });
    });

    it('refuses missing headers and a client_id that is not the attestation sub', async () => {
      const env = await stored(entryFor(pki));
      expect(
        await authenticateWalletClient({
          env,
          tenantId: 't1',
          headers: { get: () => null },
          issuer: ISSUER,
          clientId: CLIENT_ID,
          now: NOW,
        })
      ).toEqual({ ok: false, error: 'attestation_malformed' });
      expect(
        await authenticateWalletClient({
          env,
          tenantId: 't1',
          headers: await headers(),
          issuer: ISSUER,
          clientId: 'someone-else',
          now: NOW,
        })
      ).toEqual({ ok: false, error: 'wallet_not_allowed' });
    });
  });

  it('builds a virtual client that no secret can authenticate', async () => {
    const client = walletEntryToClient(
      (await parseWalletAllowlist(list(entryFor(pki)))).entries[0],
      't1',
      5
    );
    expect(client.grant_types).toEqual(['authorization_code']);
    expect(client.client_secret).toBeUndefined();
    expect(client.client_secret_hash).toBeUndefined();
  });
});
