import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentElevationResolutionRequest } from '../platform/ports';
import { CloudflareAgentElevationAdapter } from '../platform/cloudflare/elevation';
import {
  adapterFor,
  argsHashFor,
  baseRequest,
  challengeFor,
  keys,
  repositoryMock,
} from './helpers/mut-routes-elevation-fixtures';

afterEach(() => {
  vi.useRealTimers();
});

function withIssuer(issuerOrigin: string): AgentElevationResolutionRequest {
  return { ...baseRequest, issuerOrigin };
}

describe('elevation issuer origin validation', () => {
  it.each([
    'https://tenant-1.authrim.example',
    'http://localhost:8787',
    'http://127.0.0.1:8787',
    'http://[::1]:8787',
  ])('accepts %s', async (origin) => {
    const resolution = await adapterFor(repositoryMock()).resolve(withIssuer(origin));
    expect(resolution).toMatchObject({
      url: `${origin}/admin/agent-access/elevations/ael-1`,
    });
  });

  it.each([
    'http://tenant-1.authrim.example',
    'http://localhost.example',
    'http://127.0.0.2',
    'https://tenant-1.authrim.example/',
    'https://tenant-1.authrim.example/path',
    'https://user:pw@tenant-1.authrim.example',
  ])('rejects %s', async (origin) => {
    await expect(adapterFor(repositoryMock()).resolve(withIssuer(origin))).rejects.toThrow(
      new TypeError('Agent elevation issuer origin is invalid')
    );
  });

  it('percent-encodes the challenge id in the URL', async () => {
    const resolution = await adapterFor(repositoryMock(), {
      generateId: () => 'ael/1 x',
    }).resolve(baseRequest);
    expect(resolution).toMatchObject({
      url: 'https://tenant-1.authrim.example/admin/agent-access/elevations/ael%2F1%20x',
    });
  });
});

describe('new elevation challenges', () => {
  it('persists the exact challenge record and returns the required elicitation', async () => {
    const repository = repositoryMock();
    const resolution = await adapterFor(repository).resolve(baseRequest);
    expect(resolution).toEqual({
      status: 'required',
      challengeId: 'ael-1',
      url: 'https://tenant-1.authrim.example/admin/agent-access/elevations/ael-1',
      message: 'Approve Suspend user for resource user-1?',
      expiresAt: 301_000,
    });
    const created = repository.createElevation.mock.calls[0][0];
    expect(created).toEqual({
      id: 'ael-1',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      userId: 'admin-2',
      actorSub: 'client:client-1',
      clientId: 'client-1',
      toolName: 'admin.write.users.suspend',
      toolSchemaVersion: '1',
      argsEnvelope: expect.any(String) as string,
      argsHash: await argsHashFor(),
      confirmSummaryRedacted: 'Approve Suspend user for resource user-1?',
      payloadKeyVersion: 'key-v1',
      payloadPurgeAt: 1_000 + 24 * 60 * 60 * 1000,
      createdAt: 1_000,
      expiresAt: 301_000,
    });
    expect(repository.findActiveElevationChallenge).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      actorSub: 'client:client-1',
      toolName: 'admin.write.users.suspend',
      argsHash: await argsHashFor(),
    });
  });

  it('describes an unnamed resource generically', async () => {
    const repository = repositoryMock();
    await expect(
      adapterFor(repository).resolve({ ...baseRequest, resource: { tenantId: 'tenant-1' } })
    ).resolves.toMatchObject({ message: 'Approve Suspend user for the selected resource?' });
  });

  it.each([
    [undefined, 300_000],
    [10, 30_000],
    [60_000, 60_000],
    [10 * 60 * 1000, 300_000],
  ])('clamps challengeTtlMs %s to %s', async (challengeTtlMs, ttl) => {
    const repository = repositoryMock();
    await expect(
      adapterFor(repository, { challengeTtlMs }).resolve(baseRequest)
    ).resolves.toMatchObject({ expiresAt: 1_000 + ttl });
  });

  it.each([
    [1_000, 60_000, 60_000],
    [2 * 60 * 60 * 1000, 60_000, 2 * 60 * 60 * 1000],
  ])('keeps payloads at least as long as the challenge (%s)', async (retention, ttl, expected) => {
    const repository = repositoryMock();
    await adapterFor(repository, {
      challengeTtlMs: ttl,
      payloadRetentionMs: retention,
    }).resolve(baseRequest);
    expect(repository.createElevation.mock.calls[0][0].payloadPurgeAt).toBe(1_000 + expected);
  });

  it('uses the wall clock and prefixed random ids by default', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const repository = repositoryMock();
    const resolution = await new CloudflareAgentElevationAdapter(repository, keys, {
      payloadKeyId: 'key-v1',
    }).resolve(baseRequest);
    expect(resolution).toMatchObject({ expiresAt: 350_000 });
    expect(resolution.challengeId).toMatch(/^ael_[0-9a-f-]{36}$/u);
  });

  it('returns a concurrently created challenge when the insert races', async () => {
    const raced = await challengeFor({
      id: 'ael-raced',
      expiresAt: 9_000,
      confirmSummaryRedacted: 'Raced?',
    });
    const repository = repositoryMock({
      createElevation: vi.fn(async () => {
        throw new Error('UNIQUE constraint failed');
      }),
      findActiveElevationChallenge: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(raced),
    });
    await expect(adapterFor(repository).resolve(baseRequest)).resolves.toEqual({
      status: 'required',
      challengeId: 'ael-raced',
      url: 'https://tenant-1.authrim.example/admin/agent-access/elevations/ael-raced',
      message: 'Raced?',
      expiresAt: 9_000,
    });
    expect(repository.findActiveElevationChallenge).toHaveBeenCalledTimes(2);
  });

  it('rethrows the insert error when no concurrent challenge exists', async () => {
    const failure = new Error('database unavailable');
    const repository = repositoryMock({
      createElevation: vi.fn(async () => {
        throw failure;
      }),
    });
    await expect(adapterFor(repository).resolve(baseRequest)).rejects.toBe(failure);
  });
});

describe('existing challenge binding', () => {
  it.each([
    ['tenantId', 'tenant-2'],
    ['grantId', 'grant-2'],
    ['userId', 'admin-9'],
    ['actorSub', 'client:other'],
    ['clientId', 'client-2'],
    ['toolName', 'admin.write.other'],
    ['toolSchemaVersion', '2'],
    ['argsHash', 'other-hash'],
  ] as const)('rejects a challenge whose %s differs', async (field, value) => {
    const challenge = await challengeFor({ status: 'approved', [field]: value });
    const repository = repositoryMock({ getElevationChallenge: vi.fn(async () => challenge) });
    await expect(
      adapterFor(repository).resolve({ ...baseRequest, challengeId: 'ael-1' })
    ).rejects.toThrow(new TypeError('Agent elevation challenge does not match this operation'));
    expect(repository.claimElevationExecution).not.toHaveBeenCalled();
  });

  it('returns the stored pending challenge for a repeated request', async () => {
    const pending = await challengeFor({ confirmSummaryRedacted: 'Stored?', expiresAt: 5_000 });
    const repository = repositoryMock({ findActiveElevationChallenge: vi.fn(async () => pending) });
    await expect(adapterFor(repository).resolve(baseRequest)).resolves.toEqual({
      status: 'required',
      challengeId: 'ael-1',
      url: 'https://tenant-1.authrim.example/admin/agent-access/elevations/ael-1',
      message: 'Stored?',
      expiresAt: 5_000,
    });
    expect(repository.createElevation).not.toHaveBeenCalled();
    expect(repository.getElevationApprovalDecision).not.toHaveBeenCalled();
  });

  it('looks up an explicit challenge by tenant and id', async () => {
    const repository = repositoryMock({
      getElevationChallenge: vi.fn(async () => challengeFor()),
    });
    await adapterFor(repository).resolve({ ...baseRequest, challengeId: 'ael-1' });
    expect(repository.getElevationChallenge).toHaveBeenCalledWith('tenant-1', 'ael-1');
    expect(repository.findActiveElevationChallenge).not.toHaveBeenCalled();
  });
});

describe('challenge expiry', () => {
  async function expiredAt(expiresAt: number, now: number, explicit: boolean) {
    const expired = await challengeFor({ id: 'ael-old', expiresAt });
    const repository = repositoryMock(
      explicit
        ? { getElevationChallenge: vi.fn(async () => expired) }
        : {
            findActiveElevationChallenge: vi
              .fn()
              .mockResolvedValueOnce(expired)
              .mockResolvedValueOnce(null),
          }
    );
    const adapter = adapterFor(repository, { now: () => now });
    return { repository, adapter, expired };
  }

  it('expires a challenge at exactly its expiry time with a system audit record', async () => {
    const { repository, adapter } = await expiredAt(2_000, 2_000, true);
    await expect(adapter.resolve({ ...baseRequest, challengeId: 'ael-old' })).rejects.toThrow(
      new TypeError('Agent elevation challenge expired')
    );
    expect(repository.expireUnclaimedElevation).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      challengeId: 'ael-old',
      expiredAt: 2_000,
      audit: {
        id: 'audit-1',
        tenantId: 'tenant-1',
        action: 'agent.elevation.expired',
        resourceType: 'agent_elevation',
        resourceId: 'ael-old',
        severity: 'info',
        result: 'success',
        actorType: 'system',
        actorSub: 'system:agent-elevation-expiry',
        grantId: 'grant-1',
        elevationId: 'ael-old',
        mcpTool: 'admin.write.users.suspend',
        metadata: { reason: 'challenge_ttl_elapsed', expires_at: 2_000 },
        createdAt: 2_000,
      },
    });
  });

  it('does not expire a challenge one millisecond before its expiry', async () => {
    const { repository, adapter } = await expiredAt(2_001, 2_000, false);
    await expect(adapter.resolve(baseRequest)).resolves.toMatchObject({
      status: 'required',
      challengeId: 'ael-old',
    });
    expect(repository.expireUnclaimedElevation).not.toHaveBeenCalled();
  });

  it('searches again with the same binding after retiring an implicit expired challenge', async () => {
    const { repository, adapter } = await expiredAt(1_500, 2_000, false);
    await expect(adapter.resolve(baseRequest)).resolves.toMatchObject({ challengeId: 'ael-1' });
    const argsHash = await argsHashFor();
    expect(repository.findActiveElevationChallenge.mock.calls).toEqual([
      [
        {
          tenantId: 'tenant-1',
          grantId: 'grant-1',
          actorSub: 'client:client-1',
          toolName: 'admin.write.users.suspend',
          argsHash,
        },
      ],
      [
        {
          tenantId: 'tenant-1',
          grantId: 'grant-1',
          actorSub: 'client:client-1',
          toolName: 'admin.write.users.suspend',
          argsHash,
        },
      ],
    ]);
  });

  it('never uses a still-expired challenge returned by the second lookup', async () => {
    const expired = await challengeFor({ status: 'approved', expiresAt: 1_500 });
    const repository = repositoryMock({ findActiveElevationChallenge: vi.fn(async () => expired) });
    await expect(adapterFor(repository, { now: () => 2_000 }).resolve(baseRequest)).rejects.toThrow(
      new TypeError('Agent elevation challenge expired')
    );
    expect(repository.claimElevationExecution).not.toHaveBeenCalled();
    expect(repository.createElevation).not.toHaveBeenCalled();
  });
});

describe('claiming approved challenges', () => {
  it('claims with an execution token and a 60 s lease and returns the exact authorization', async () => {
    const approved = await challengeFor({ status: 'approved' });
    const repository = repositoryMock({
      getElevationChallenge: vi.fn(async () => approved),
      claimElevationExecution: vi.fn(async () => ({
        id: 'ael-1',
        attempt: 2,
        fence: 5,
        ownerId: 'aex-1',
        leaseExpiresAt: 61_000,
      })),
    });
    await expect(
      adapterFor(repository).resolve({ ...baseRequest, challengeId: 'ael-1' })
    ).resolves.toEqual({
      status: 'authorized',
      challengeId: 'ael-1',
      executionAttempt: 2,
      executionFence: 5,
      executionToken: 'aex-1',
      idempotencyKey: 'agent-elevation:ael-1:2:5',
    });
    expect(repository.claimElevationExecution).toHaveBeenCalledWith(
      'tenant-1',
      'ael-1',
      'aex-1',
      1_000,
      61_000
    );
  });

  it('refuses to claim when a lease is already held', async () => {
    const approved = await challengeFor({ status: 'approved' });
    const repository = repositoryMock({ getElevationChallenge: vi.fn(async () => approved) });
    await expect(
      adapterFor(repository).resolve({ ...baseRequest, challengeId: 'ael-1' })
    ).rejects.toThrow(new TypeError('Agent elevation challenge was already claimed'));
  });

  it('refuses an approved challenge found without presenting its id', async () => {
    const approved = await challengeFor({ status: 'approved' });
    const repository = repositoryMock({
      findActiveElevationChallenge: vi.fn(async () => approved),
    });
    await expect(adapterFor(repository).resolve(baseRequest)).rejects.toThrow(
      new TypeError('Agent elevation challenge is not claimable')
    );
    expect(repository.claimElevationExecution).not.toHaveBeenCalled();
  });

  it.each(['denied', 'consumed', 'executing'] as const)(
    'refuses a %s challenge even with its id',
    async (status) => {
      const challenge = await challengeFor({ status });
      const repository = repositoryMock({ getElevationChallenge: vi.fn(async () => challenge) });
      await expect(
        adapterFor(repository).resolve({ ...baseRequest, challengeId: 'ael-1' })
      ).rejects.toThrow(new TypeError('Agent elevation challenge is not claimable'));
      expect(repository.claimElevationExecution).not.toHaveBeenCalled();
    }
  );
});
