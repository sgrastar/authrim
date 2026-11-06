import { beforeEach, describe, expect, it } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';
import { ChallengeStore } from '../../durable-objects/ChallengeStore';
import { LitePolicyStore } from '../../durable-objects/LitePolicyStore';
import { verifyHumanVerificationWithRunner } from '../human-verification-runner';
import { createPowChallenge, parsePowKeyring, type PowChallenge } from '../human-verification-pow';
import { litePowSettingsFrom } from '../lite-human-verification';
import { resetLitePolicyRuntimeCache } from '../lite-policy';

class Storage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.data.entries()].filter(([key]) => key.startsWith(options?.prefix ?? ''))
    ) as Map<string, T>;
  }
  async setAlarm(): Promise<void> {}
  async getAlarm(): Promise<null> {
    return null;
  }
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

const KEYRING = JSON.stringify({
  current: 1,
  keys: { '1': base64Url(new Uint8Array(32).fill(7)) },
});
const encoder = new TextEncoder();

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function solve(challenge: PowChallenge): Promise<string> {
  for (let number = 0; number <= challenge.maxnumber; number += 1) {
    if ((await sha256Hex(`${challenge.salt}${number}`)) === challenge.challenge) {
      const { algorithm, salt, signature } = challenge;
      return btoa(
        JSON.stringify({ algorithm, challenge: challenge.challenge, number, salt, signature })
      );
    }
  }
  throw new Error('no solution');
}

let policy: LitePolicyStore;
let env: Record<string, unknown>;
let kv: Map<string, string>;

async function setPolicy(
  liteMode: 'off' | 'always',
  required = { login: true, signup: false, reauth: false }
) {
  // As the switch route does: the marker before `always` (the same object stands for both
  // instances here). The runtimes cache what they read; a test reads the change at once.
  if (liteMode === 'always') await policy.markEverLiteRpc('tenant-a');
  resetLitePolicyRuntimeCache();
  const lease = await policy.acquireLeaseRpc('tenant-a');
  if (!lease.acquired) throw new Error('lease');
  const result = await policy.commitRpc({
    tenantId: 'tenant-a',
    token: lease.token,
    expectedGeneration: lease.generation,
    liteMode,
    humanVerificationRequired: required,
  });
  if (!result.committed) throw new Error('commit');
  return result.snapshot;
}

beforeEach(() => {
  resetLitePolicyRuntimeCache();
  policy = new LitePolicyStore({ storage: new Storage() } as never, {} as never);
  const challengeStores = new Map<string, ChallengeStore>();
  kv = new Map([
    [
      'settings:tenant:tenant-a:authentication-methods',
      JSON.stringify({ 'authentication-methods.human_verification.pow_max_number': 1000 }),
    ],
  ]);
  env = {
    LITE_POLICY_STORE: { idFromName: (name: string) => name, get: () => policy },
    CHALLENGE_STORE: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        if (!challengeStores.has(id)) {
          const ctx = { storage: new Storage() } as unknown as DurableObjectState;
          challengeStores.set(id, new ChallengeStore(ctx, {} as never));
        }
        return challengeStores.get(id);
      },
    },
    SETTINGS: { get: async (key: string) => kv.get(key) ?? null },
    HUMAN_VERIFICATION_POW_HMAC_KEYRING: KEYRING,
  };
});

async function proof(action: 'login' | 'signup' | 'reauth', revision: string) {
  const challenge = await createPowChallenge(
    parsePowKeyring(KEYRING),
    { tenantId: 'tenant-a', action, policyRevision: revision },
    { maxNumber: 1000, ttlSeconds: 600 }
  );
  return solve(challenge);
}

const verify = (
  responseToken: unknown,
  action: 'login' | 'signup' | 'reauth' = 'login',
  alsoRequiredFor?: Array<'signup'>
) =>
  verifyHumanVerificationWithRunner(env as never, {
    tenantId: 'tenant-a',
    action,
    alsoRequiredFor,
    responseToken,
  });

describe('human verification of a tenant in lite mode', () => {
  it('accepts a proof of work once', async () => {
    const snapshot = await setPolicy('always');
    const token = await proof('login', snapshot.policyRevision);
    await expect(verify(token)).resolves.toEqual({ required: true, verified: true });
    await expect(verify(token)).resolves.toEqual({ required: true, verified: false });
  });

  it('refuses a proof made before the policy changed', async () => {
    const before = await setPolicy('always');
    const token = await proof('login', before.policyRevision);
    await setPolicy('always', { login: true, signup: true, reauth: false });
    await expect(verify(token)).resolves.toEqual({ required: true, verified: false });
  });

  it('takes the required actions from the policy store, alsoRequiredFor included', async () => {
    const snapshot = await setPolicy('always', { login: false, signup: true, reauth: false });
    await expect(verify('')).resolves.toEqual({ required: false, verified: true });
    await expect(verify('', 'login', ['signup'])).resolves.toEqual({
      required: true,
      verified: false,
    });
    const token = await proof('login', snapshot.policyRevision);
    await expect(verify(token, 'login', ['signup'])).resolves.toEqual({
      required: true,
      verified: true,
    });
  });

  it('applies requirements made stricter at once, with the runtime cache warm', async () => {
    await setPolicy('always', { login: false, signup: false, reauth: false });
    await expect(verify('')).resolves.toEqual({ required: false, verified: true });
    // Stricter, mode unchanged, and the runtime cache not reset: the runner reads the policy.
    const lease = await policy.acquireLeaseRpc('tenant-a');
    if (!lease.acquired) throw new Error('lease');
    await policy.commitRpc({
      tenantId: 'tenant-a',
      token: lease.token,
      expectedGeneration: lease.generation,
      liteMode: 'always',
      humanVerificationRequired: { login: true, signup: false, reauth: false },
    });
    await expect(verify('')).resolves.toEqual({ required: true, verified: false });
  });

  it('refuses a proof for another action', async () => {
    const snapshot = await setPolicy('always', { login: true, signup: true, reauth: true });
    const token = await proof('signup', snapshot.policyRevision);
    await expect(verify(token, 'login')).resolves.toEqual({ required: true, verified: false });
  });

  it('refuses every proof when the keyring is missing', async () => {
    const snapshot = await setPolicy('always');
    const token = await proof('login', snapshot.policyRevision);
    delete env.HUMAN_VERIFICATION_POW_HMAC_KEYRING;
    await expect(verify(token)).resolves.toEqual({ required: true, verified: false });
  });

  it('fails closed when the policy cannot be read and the tenant was ever switched on', async () => {
    env.LITE_POLICY_STORE = {
      idFromName: (name: string) => name,
      get: (id: string) =>
        id.startsWith('lite-policy-marker:')
          ? { isEverLiteRpc: async () => true }
          : {
              getSnapshotRpc: async () => {
                throw new Error('down');
              },
            },
    };
    await expect(verify('anything')).resolves.toEqual({ required: true, verified: false });
  });
});

describe('litePowSettingsFrom', () => {
  it('reads KV, then the environment, then the default, within bounds', () => {
    expect(litePowSettingsFrom(null, {})).toEqual({
      maxNumber: 25_000,
      ttlSeconds: 600,
      issuePerIpPerMinute: 30,
      issuePerTenantPerMinute: 3_000,
    });
    expect(
      litePowSettingsFrom(
        { 'authentication-methods.human_verification.pow_max_number': 50_000 },
        { LITE_POW_MAX_NUMBER: '40000', LITE_POW_CHALLENGE_TTL: '900' }
      )
    ).toMatchObject({ maxNumber: 50_000, ttlSeconds: 900 });
    expect(
      litePowSettingsFrom(
        { 'authentication-methods.human_verification.pow_max_number': 5 },
        { LITE_POW_MAX_NUMBER: '99999999999' }
      ).maxNumber
    ).toBe(25_000);
  });
});
