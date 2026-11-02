/**
 * POST /vci/credential — issuance state machine (design D4) against the real offer store SQL.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { buildPolicyConstrainedRegionShardConfig } from '@authrim/ar-lib-core';
import type { Env } from '../../../types';
import { credentialRoute } from '../credential';
import { CredentialOfferStore } from '../../durable-objects/CredentialOfferStore';
import { createSqliteState } from '../../durable-objects/__tests__/sqlite-storage';
import { getCredentialOfferStoreByProofNonce } from '../../../utils/credential-offer-sharding';
import { sha256Base64url } from '../../../utils/crypto';
import { calculateJwkThumbprint } from '../../../utils/jwk-thumbprint';

const mocks = vi.hoisted(() => ({
  validateToken: vi.fn(),
  validateProof: vi.fn(),
  decodeNonce: vi.fn(),
  featureConfig: vi.fn(),
  sdjwtCalls: [] as Array<{ claims: Record<string, unknown>; options: Record<string, unknown> }>,
  /** Runs while the issuer JWT is being signed (to simulate events during signing). */
  onSign: undefined as undefined | (() => void),
  signFails: false,
  credentials: new Map<string, { id: string; status: string; history: string[] }>(),
  sequence: 0,
}));

vi.mock('../../services/token-validation', () => ({
  validateVCIAccessToken: mocks.validateToken,
  validateProofOfPossession: mocks.validateProof,
  decodeVCIProofNonce: mocks.decodeNonce,
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createSDJWTVCWithSigner: vi.fn(
      async (
        claims: Record<string, unknown>,
        issuer: string,
        signer: (payload: Record<string, unknown>) => Promise<string>,
        options: Record<string, unknown>
      ) => {
        mocks.sdjwtCalls.push({ claims, options });
        const issuerJwt = await signer({ iss: issuer, vct: options.vct });
        return { combined: `${issuerJwt}~d1~d2~`, issuerSignedJwt: issuerJwt, disclosures: [] };
      }
    ),
    loadFeatureConfig: mocks.featureConfig,
    ensureDatabaseAdapter: vi.fn(() => ({})),
    resolveTenantMetadataContext: vi.fn(async (_env: unknown, tenantId: string) => ({
      tenantId,
      coreDb: {},
    })),
    D1StatusListRepository: class {},
    StatusListManager: class {
      allocateIndex = vi.fn().mockResolvedValue({
        listId: 'status-list-1',
        listInternalId: 'status-list-internal-1',
        index: 7,
      });
    },
    IssuedCredentialRepository: class {
      async createCredential(input: { status: string }) {
        const id = `credential-${++mocks.sequence}`;
        mocks.credentials.set(id, { id, status: input.status, history: [input.status] });
        return { id };
      }
      async updateStatus(_tenantId: string, id: string, status: string) {
        const row = mocks.credentials.get(id);
        if (!row) return false;
        row.status = status;
        row.history.push(status);
        return true;
      }
      async updateStatusIfCurrent(_tenantId: string, id: string, expected: string, next: string) {
        const row = mocks.credentials.get(id);
        if (!row || row.status !== expected) return false;
        row.status = next;
        row.history.push(next);
        return true;
      }
    },
  };
});

const TENANT = 'tenant-1';
const ADMIN = 'admin-1';
const OFFER_ID = 'g1:apac:3:co_550e8400-e29b-41d4-a716-446655440000';
const HOLDER_KEY = { kty: 'EC', crv: 'P-256', x: 'holder-x', y: 'holder-y' };
const REGION_CONFIG = buildPolicyConstrainedRegionShardConfig({
  residency: {
    version: 1,
    residencyPolicyId: 'test-residency',
    residencyPartition: 'default',
    policyGeneration: 1,
    allowedRegions: ['apac'],
    jurisdiction: null,
  },
  totalShards: 1,
  now: 1,
  updatedBy: 'test',
});

interface Harness {
  store: CredentialOfferStore;
  db: ReturnType<typeof createSqliteState>['db'];
  env: Env;
  eligibility: ReturnType<typeof vi.fn>;
}

async function createHarness(
  options: {
    subjectKind?: 'admin' | 'end_user';
    configurationId?: string;
    eligibility?: unknown;
    withBinding?: boolean;
  } = {}
): Promise<Harness> {
  const sqlite = createSqliteState();
  const store = new CredentialOfferStore(sqlite.state, {} as never);
  await sqlite.ready();
  const now = Date.now();
  store.createOfferRpc({
    id: OFFER_ID,
    tenantId: TENANT,
    userId: ADMIN,
    subjectKind: options.subjectKind ?? 'admin',
    credentialProfileId: 'admin',
    credentialProfileVersion: 1,
    credentialProfileSnapshotHash: 'snapshot',
    credentialConfigurationId: options.configurationId ?? 'AuthrimAdminCredential',
    mappingVersionId: 'admin',
    mappingSnapshotHash: 'mapping',
    claimManifestHash: 'manifest',
    claims: options.subjectKind === 'end_user' ? { given_name: 'Alice' } : {},
    preAuthorizedCodeHash: 'code',
    createdAt: now,
    expiresAt: now + 300_000,
  });
  const reserved = store.reserveOfferRpc({
    id: OFFER_ID,
    tenantId: TENANT,
    preAuthorizedCodeHash: 'code',
    now,
  });
  if (!reserved.reserved) throw new Error('reserve failed');
  store.completeOfferRpc({
    id: OFFER_ID,
    tenantId: TENANT,
    reservationId: reserved.reservationId,
    claimsExpiresAt: now + 120_000,
  });

  const eligibility = vi
    .fn()
    .mockResolvedValue(
      options.eligibility ?? { eligible: true, email: 'ada@example.com', name: 'Ada' }
    );
  const keyManagerStub = {
    signSDJWTIssuerRpc: vi.fn(async () => {
      mocks.onSign?.();
      if (mocks.signFails) throw new Error('sign_failed');
      return { token: 'header.payload.signature' };
    }),
  };
  const env = {
    AUTHRIM_CONFIG: {
      get: vi.fn(async (key: string) =>
        key.startsWith('region_shard_config:') ? REGION_CONFIG : null
      ),
    } as unknown as KVNamespace,
    DB: {} as D1Database,
    CREDENTIAL_OFFER_STORE: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'do-id' }),
      get: vi.fn().mockReturnValue(store),
    } as unknown as DurableObjectNamespace,
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'km-id' }),
      get: vi.fn().mockReturnValue(keyManagerStub),
    } as unknown as DurableObjectNamespace,
    ...(options.withBinding === false
      ? {}
      : { ADMIN_CREDENTIAL_ELIGIBILITY: { checkAdminCredentialEligibility: eligibility } }),
  } as unknown as Env;
  return { store, db: sqlite.db, env, eligibility };
}

/** A proof nonce known to the store, as /vci/nonce would have created it. */
async function createNonce(harness: Harness, label: string): Promise<string> {
  const nonce = `g1:apac:3:cn_550e8400-e29b-41d4-a716-4466554400${label}.abcdefghijklmnopqrstuvwxyzABCDEF`;
  const { nonceId } = getCredentialOfferStoreByProofNonce(harness.env, nonce, TENANT);
  harness.store.createProofNonceRpc({
    id: nonceId,
    tenantId: TENANT,
    nonceHash: await sha256Base64url(nonce),
    createdAt: Date.now(),
    expiresAt: Date.now() + 300_000,
  });
  return nonce;
}

function contextFor(env: Env, body: unknown): Context<{ Bindings: Env }> {
  const url = 'https://authrim.com/vci/credential';
  return {
    env,
    req: {
      raw: new Request(url, { method: 'POST', headers: { Host: 'authrim.com' } }),
      url,
      method: 'POST',
      header: vi.fn().mockReturnValue('Bearer access-token'),
      json: vi.fn().mockResolvedValue(body),
    },
    json: vi.fn(
      (data: unknown, status?: number) =>
        new Response(JSON.stringify(data), {
          status: status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        })
    ),
    header: vi.fn(),
    get: vi.fn().mockReturnValue(undefined),
  } as unknown as Context<{ Bindings: Env }>;
}

async function requestCredential(
  harness: Harness,
  nonce: string,
  configurationId = 'AuthrimAdminCredential'
): Promise<{ status: number; body: Record<string, unknown> }> {
  mocks.decodeNonce.mockReturnValue(nonce);
  const response = await credentialRoute(
    contextFor(harness.env, {
      credential_configuration_id: configurationId,
      proofs: { jwt: [`proof-for-${nonce}`] },
    })
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const progress = (harness: Harness) =>
  harness.store.getAdminOfferProgressRpc({
    id: OFFER_ID,
    tenantId: TENANT,
    userId: ADMIN,
    now: Date.now(),
  });

describe('credential issuance state machine', () => {
  beforeEach(() => {
    mocks.sdjwtCalls.length = 0;
    mocks.credentials.clear();
    mocks.sequence = 0;
    mocks.onSign = undefined;
    mocks.signFails = false;
    mocks.featureConfig.mockReset().mockResolvedValue({ enabled: true });
    mocks.validateToken.mockReset().mockResolvedValue({
      valid: true,
      userId: ADMIN,
      tenantId: TENANT,
      credentialConfigurationId: 'AuthrimAdminCredential',
      jti: 'jti-1',
      offerId: OFFER_ID,
    });
    mocks.validateProof.mockReset().mockResolvedValue({ valid: true, holderPublicKey: HOLDER_KEY });
  });

  it('issues an admin credential with only the fixed claims and activates the pending row', async () => {
    const harness = await createHarness();
    const result = await requestCredential(harness, await createNonce(harness, '01'));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      credentials: [{ credential: 'header.payload.signature~d1~d2~' }],
    });
    expect(harness.eligibility).toHaveBeenCalledWith({ tenantId: TENANT, adminUserId: ADMIN });
    const [call] = mocks.sdjwtCalls;
    expect(Object.keys(call.claims).sort()).toEqual([
      'credentialStatus',
      'email',
      'name',
      'sub',
      'tenant_id',
    ]);
    expect(call.claims).toMatchObject({
      sub: ADMIN,
      tenant_id: TENANT,
      email: 'ada@example.com',
      name: 'Ada',
    });
    expect(call.options.selectiveDisclosureClaims).toEqual(['email', 'name']);
    // End-user custom claims are never resolved for an admin credential.
    expect(mocks.featureConfig).not.toHaveBeenCalled();
    expect([...mocks.credentials.values()][0]?.history).toEqual(['pending', 'active']);
    expect(progress(harness)).toMatchObject({
      state: 'issued',
      holderKeyThumbprint: await calculateJwkThumbprint(HOLDER_KEY),
    });
  });

  it('omits email and name the eligibility result does not carry', async () => {
    const harness = await createHarness({
      eligibility: { eligible: true, email: 'a@example.com', name: null },
    });
    await requestCredential(harness, await createNonce(harness, '01'));
    expect(Object.keys(mocks.sdjwtCalls[0].claims).sort()).toEqual([
      'credentialStatus',
      'email',
      'sub',
      'tenant_id',
    ]);
  });

  it.each([
    ['an ineligible administrator', { eligible: false }, true],
    ['a missing eligibility binding', undefined, false],
  ])(
    'issues nothing for %s and revokes the recorded row',
    async (_label, eligibility, withBinding) => {
      const harness = await createHarness({ eligibility, withBinding });
      const result = await requestCredential(harness, await createNonce(harness, '01'));

      expect(result.status).toBe(400);
      expect(result.body.error).toBe('invalid_credential_request');
      expect(result.body).not.toHaveProperty('credentials');
      expect(mocks.sdjwtCalls).toHaveLength(0);
      expect([...mocks.credentials.values()][0]?.history).toEqual(['pending', 'revoked']);
      expect(progress(harness)?.state).toBe('failed');
    }
  );

  it('returns no credential when it was revoked between signing and activation', async () => {
    const harness = await createHarness();
    mocks.onSign = () => {
      const row = [...mocks.credentials.values()][0];
      if (row) row.status = 'revoked';
    };
    const result = await requestCredential(harness, await createNonce(harness, '01'));

    expect(result.status).toBe(400);
    expect(result.body).not.toHaveProperty('credentials');
    expect([...mocks.credentials.values()][0]?.status).toBe('revoked');
    expect(progress(harness)?.state).toBe('failed');
  });

  it('fails the issuance and revokes the row when signing throws', async () => {
    const harness = await createHarness();
    mocks.signFails = true;
    const result = await requestCredential(harness, await createNonce(harness, '01'));

    expect(result.status).toBe(500);
    expect([...mocks.credentials.values()][0]?.history).toEqual(['pending', 'revoked']);
    expect(progress(harness)?.state).toBe('failed');
    // The offer cannot be retried with a fresh nonce.
    const retry = await requestCredential(harness, await createNonce(harness, '02'));
    expect(retry.status).toBe(400);
  });

  it('rejects a second request with the same access token', async () => {
    const harness = await createHarness();
    const first = await requestCredential(harness, await createNonce(harness, '01'));
    const second = await requestCredential(harness, await createNonce(harness, '02'));

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_credential_request');
    expect(mocks.sdjwtCalls).toHaveLength(1);
    expect(mocks.credentials.size).toBe(1);
  });

  it('lets exactly one of two concurrent requests issue', async () => {
    const harness = await createHarness();
    const [a, b] = [await createNonce(harness, '01'), await createNonce(harness, '02')];
    const results = await Promise.all([
      requestCredential(harness, a),
      requestCredential(harness, b),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    expect(mocks.sdjwtCalls).toHaveLength(1);
    expect(mocks.credentials.size).toBe(1);
  });

  it('does not let an end-user offer yield the admin configuration', async () => {
    const harness = await createHarness({ subjectKind: 'end_user' });
    const result = await requestCredential(harness, await createNonce(harness, '01'));

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_credential_request');
    expect(mocks.sdjwtCalls).toHaveLength(0);
    expect(harness.eligibility).not.toHaveBeenCalled();
    expect(
      harness.db.prepare('SELECT COUNT(*) AS n FROM credential_offer_issuances').get()
    ).toEqual({
      n: 0,
    });
  });

  it('does not let an admin offer yield an end-user configuration', async () => {
    const harness = await createHarness({ configurationId: 'AuthrimIdentityCredential' });
    mocks.validateToken.mockResolvedValue({
      valid: true,
      userId: ADMIN,
      tenantId: TENANT,
      credentialConfigurationId: 'AuthrimIdentityCredential',
      jti: 'jti-1',
      offerId: OFFER_ID,
    });
    const result = await requestCredential(
      harness,
      await createNonce(harness, '01'),
      'AuthrimIdentityCredential'
    );

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_credential_request');
    expect(mocks.sdjwtCalls).toHaveLength(0);
    expect(
      harness.db.prepare('SELECT COUNT(*) AS n FROM credential_offer_issuances').get()
    ).toEqual({
      n: 0,
    });
  });

  it('requires a holder key for the admin credential even when the tenant does not', async () => {
    const harness = await createHarness();
    mocks.validateProof.mockResolvedValue({ valid: true });
    const result = await requestCredential(harness, await createNonce(harness, '01'));

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_proof');
    expect(mocks.sdjwtCalls).toHaveLength(0);
  });

  it('still issues an end-user credential from the offer claims', async () => {
    const harness = await createHarness({
      subjectKind: 'end_user',
      configurationId: 'AuthrimIdentityCredential',
    });
    mocks.featureConfig.mockResolvedValue({ enabled: false });
    mocks.validateToken.mockResolvedValue({
      valid: true,
      userId: ADMIN,
      tenantId: TENANT,
      credentialConfigurationId: 'AuthrimIdentityCredential',
      jti: 'jti-1',
      offerId: OFFER_ID,
    });
    const result = await requestCredential(
      harness,
      await createNonce(harness, '01'),
      'AuthrimIdentityCredential'
    );

    expect(result.status).toBe(200);
    expect(mocks.sdjwtCalls[0].claims).toMatchObject({ given_name: 'Alice' });
    expect([...mocks.credentials.values()][0]?.history).toEqual(['pending', 'active']);
    expect(harness.eligibility).not.toHaveBeenCalled();
  });
});
