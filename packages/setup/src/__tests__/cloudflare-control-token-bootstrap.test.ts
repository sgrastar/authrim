import { describe, expect, it } from 'vitest';
import {
  bootstrapControlWorkerTokens,
  buildCloudflareChildTokenName,
  buildCloudflareBootstrapTokenEndDate,
  buildCloudflareBootstrapTemplateUrl,
  cleanupCloudflareBootstrapToken,
  CloudflareTokenBootstrapError,
  detectCloudflareTokenOwnership,
  inspectCloudflareBootstrapRecoveryToken,
  inspectCloudflarePendingBootstrapRecoveryState,
  reconcileCloudflareBootstrapRevocationWithRecoveryToken,
  selectPreferredCloudflareTokenOwnership,
  resumeCloudflareBootstrapTokenRevocation,
  validateDirectControlTokens,
  validateDirectControlTokensWithEvidence,
  WranglerControlSecretSink,
  CloudflareTokenAuthorityHttpClient,
  type CloudflareTokenAuthority,
  type CloudflareTokenPermissionGroup,
  type CloudflareTokenPolicy,
  type CloudflareTokenRecord,
  type ControlSecretSink,
} from '../core/cloudflare-control-token-bootstrap.js';

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const BOOTSTRAP_ID = '11111111111111111111111111111111';

const groups: CloudflareTokenPermissionGroup[] = [
  { id: 'pg-bootstrap', name: 'Account API Tokens Write', scopes: ['com.cloudflare.api.account'] },
  { id: 'pg-d1', name: 'D1 Write', scopes: ['com.cloudflare.api.account'] },
  {
    id: 'pg-workers',
    name: 'Workers Scripts Write',
    scopes: ['com.cloudflare.api.account'],
  },
  { id: 'pg-kv', name: 'Workers KV Storage Write', scopes: ['com.cloudflare.api.account'] },
  { id: 'pg-r2', name: 'Workers R2 Storage Write', scopes: ['com.cloudflare.api.account'] },
];

function policy(permissionGroup: { id: string; name?: string }): CloudflareTokenPolicy {
  return {
    effect: 'allow',
    permission_groups: [permissionGroup],
    resources: { [`com.cloudflare.api.account.${ACCOUNT_ID}`]: '*' },
  };
}

class FakeAuthority implements CloudflareTokenAuthority {
  readonly bootstrapValue = 'bootstrap-secret-value';
  readonly records = new Map<string, CloudflareTokenRecord>();
  readonly deleted: string[] = [];
  createCalls = 0;
  loseFirstCreateResponse = false;
  loseBootstrapDeleteResponse = false;
  leaveDeletedTokenActive = false;
  loseNextDeleteResponse = false;
  makeChildrenIdentical = false;
  loseMissingBootstrapVerifyResponse = false;
  allowChildCrossResource = false;
  deniedCapabilityProbeRounds = 0;
  capabilityProbeFailuresRemaining = 0;
  capabilityProbeCalls = 0;
  lostCreateVisibilityDelayLists = 0;
  pendingLostCreate: CloudflareTokenRecord | null = null;
  getTokenError: Error | null = null;
  verifySelfError: Error | null = null;
  verifyIssuedTokenError: Error | null = null;
  readonly selfTokenId: string;

  constructor(
    bootstrapPolicy = policy({ id: 'pg-bootstrap', name: 'Account API Tokens Write' }),
    selfTokenId = BOOTSTRAP_ID
  ) {
    this.selfTokenId = selfTokenId;
    this.records.set(selfTokenId, {
      id: selfTokenId,
      name: 'authrim-test-bootstrap',
      status: 'active',
      policies: [bootstrapPolicy],
      expires_on: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      value: this.bootstrapValue,
    });
  }

  async verifySelf() {
    if (this.verifySelfError) throw this.verifySelfError;
    const token = this.records.get(this.selfTokenId);
    if (!token && this.loseMissingBootstrapVerifyResponse) {
      throw new Error('verify response lost');
    }
    return token ? { id: token.id, status: token.status } : null;
  }

  async getToken(tokenId: string) {
    if (this.getTokenError) throw this.getTokenError;
    return this.records.get(tokenId) ?? null;
  }

  async listTokens() {
    if (this.pendingLostCreate) {
      if (this.lostCreateVisibilityDelayLists > 0) {
        this.lostCreateVisibilityDelayLists -= 1;
      } else {
        this.records.set(this.pendingLostCreate.id, this.pendingLostCreate);
        this.pendingLostCreate = null;
      }
    }
    return [...this.records.values()];
  }

  async listPermissionGroups() {
    return groups;
  }

  async createToken(input: { name: string; policies: readonly CloudflareTokenPolicy[] }) {
    this.createCalls += 1;
    const suffix = this.makeChildrenIdentical ? 2 : this.createCalls + 1;
    const id = `${suffix}`.repeat(32);
    const token: CloudflareTokenRecord = {
      id,
      name: input.name,
      status: 'active',
      policies: input.policies,
      value: `child-secret-${suffix}`,
    };
    this.records.set(id, token);
    if (this.loseFirstCreateResponse && this.createCalls === 1) {
      if (this.lostCreateVisibilityDelayLists > 0) {
        this.records.delete(id);
        this.pendingLostCreate = token;
      }
      throw new Error('response lost');
    }
    return token;
  }

  async deleteToken(tokenId: string) {
    this.deleted.push(tokenId);
    if (!this.leaveDeletedTokenActive) this.records.delete(tokenId);
    if (this.loseNextDeleteResponse) {
      this.loseNextDeleteResponse = false;
      throw new Error('response lost');
    }
    if (tokenId === BOOTSTRAP_ID && this.loseBootstrapDeleteResponse) {
      throw new Error('response lost');
    }
  }

  async verifyIssuedToken(token: string) {
    if (this.verifyIssuedTokenError) throw this.verifyIssuedTokenError;
    const record = [...this.records.values()].find((candidate) => candidate.value === token);
    return record ? { id: record.id, status: record.status } : null;
  }

  async probeIssuedToken(token: string, resourceClass: 'd1' | 'workers' | 'kv' | 'r2') {
    this.capabilityProbeCalls += 1;
    if (this.capabilityProbeFailuresRemaining > 0) {
      this.capabilityProbeFailuresRemaining -= 1;
      throw new CloudflareTokenBootstrapError('cloudflare_token_capability_probe_unavailable');
    }
    if (this.capabilityProbeCalls <= this.deniedCapabilityProbeRounds * 4) {
      return 'denied' as const;
    }
    const record = [...this.records.values()].find((candidate) => candidate.value === token);
    if (!record) return 'denied' as const;
    const permissionGroupId = record.policies[0]?.permission_groups[0]?.id;
    const expected = {
      d1: 'pg-d1',
      workers: 'pg-workers',
      kv: 'pg-kv',
      r2: 'pg-r2',
    }[resourceClass];
    return permissionGroupId === expected || this.allowChildCrossResource
      ? ('allowed' as const)
      : ('denied' as const);
  }
}

class FakeSecretSink implements ControlSecretSink {
  readonly values = new Map<string, string>();
  readonly deleted: string[] = [];
  loseFirstPutResponse = false;
  loseAllPutResponses = false;
  failPutBeforeWrite = false;
  inventoryFailuresRemaining = 0;
  putCalls = 0;
  hasCalls = 0;
  activeGeneration = { deploymentId: 'deployment-0', versionId: 'version-0' };

  async putGeneration(
    secrets: Parameters<ControlSecretSink['putGeneration']>[0],
    _generationTag: string
  ) {
    this.putCalls += 1;
    if (this.failPutBeforeWrite) throw new Error('put failed before write');
    for (const [secretName, value] of Object.entries(secrets)) {
      if (value !== undefined) this.values.set(secretName, value);
    }
    this.activeGeneration = {
      deploymentId: `deployment-${this.putCalls}`,
      versionId: `version-${this.putCalls}`,
    };
    if (this.loseAllPutResponses) {
      throw new CloudflareTokenBootstrapError(
        'cloudflare_control_secret_generation_creation_unconfirmed',
        true,
        undefined,
        true
      );
    }
    // The production sink reconciles a lost upload response by its immutable unique version tag.
    if (this.loseFirstPutResponse && this.putCalls === 1) return this.activeGeneration;
    return this.activeGeneration;
  }

  async readActiveGeneration() {
    return this.activeGeneration;
  }

  async has(secretName: string) {
    this.hasCalls += 1;
    if (this.inventoryFailuresRemaining > 0) {
      this.inventoryFailuresRemaining -= 1;
      throw new Error('inventory unavailable');
    }
    return this.values.has(secretName);
  }

  async delete(secretName: string) {
    this.deleted.push(secretName);
    this.values.delete(secretName);
  }
}

function addExistingChildToken(
  authority: FakeAuthority,
  resourceClass: 'd1' | 'workers',
  id: string,
  value: string
): void {
  const permissionGroup = resourceClass === 'd1' ? groups[1]! : groups[2]!;
  authority.records.set(id, {
    id,
    name: buildCloudflareChildTokenName({
      accountId: ACCOUNT_ID,
      environment: 'test',
      resourceClass,
    }),
    status: 'active',
    policies: [policy(permissionGroup)],
    value,
  });
}

describe('Cloudflare Control token bootstrap', () => {
  it('builds templates with only token-management edit permission', () => {
    const account = new URL(
      buildCloudflareBootstrapTemplateUrl({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
      })
    );
    expect(JSON.parse(account.searchParams.get('permissionGroupKeys')!)).toEqual([
      { key: 'account_api_tokens', type: 'edit' },
    ]);

    const user = new URL(
      buildCloudflareBootstrapTemplateUrl({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'user',
      })
    );
    expect(JSON.parse(user.searchParams.get('permissionGroupKeys')!)).toEqual([
      { key: 'api_tokens', type: 'edit' },
    ]);
  });

  it('recommends a UTC End Date that leaves at least 24 hours at day rollover', () => {
    expect(buildCloudflareBootstrapTokenEndDate(new Date('2026-09-01T23:59:59Z'))).toBe(
      '2026-09-03'
    );
    expect(() => buildCloudflareBootstrapTokenEndDate(new Date('invalid'))).toThrow(
      'cloudflare_bootstrap_token_end_date_invalid'
    );
  });

  it('prefers account ownership for an accepted Super Administrator membership', async () => {
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              account: { id: ACCOUNT_ID },
              status: 'accepted',
              roles: [{ name: 'Super Administrator - All Privileges' }],
            },
          ],
        })
      );
    await expect(
      selectPreferredCloudflareTokenOwnership({
        accountId: ACCOUNT_ID,
        wranglerOAuthToken: 'oauth-value',
        fetcher: fetcher as typeof fetch,
      })
    ).resolves.toBe('account');
  });

  it('falls back to user ownership when account ownership cannot be confirmed', async () => {
    await expect(
      selectPreferredCloudflareTokenOwnership({
        accountId: ACCOUNT_ID,
        wranglerOAuthToken: 'oauth-value',
        fetcher: (async () => new Response('{}', { status: 403 })) as typeof fetch,
      })
    ).resolves.toBe('user');
  });

  it('bounds a membership lookup even when the injected fetcher never settles', async () => {
    let aborted = false;
    const fetcher = ((_url: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise<Response>(() => undefined);
    }) as typeof fetch;

    await expect(
      selectPreferredCloudflareTokenOwnership({
        accountId: ACCOUNT_ID,
        wranglerOAuthToken: 'oauth-value',
        fetcher,
        tokenApiAttemptTimeoutMs: 20,
        tokenApiOperationTimeoutMs: 50,
      })
    ).resolves.toBe('user');
    expect(aborted).toBe(true);
  });

  it('detects bootstrap ownership without relying on browser state', async () => {
    const fetcher = (async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/user/tokens/verify')) {
        return new Response(JSON.stringify({ success: true, result: { status: 'active' } }), {
          status: 200,
        });
      }
      return new Response('{}', { status: 403 });
    }) as typeof fetch;

    await expect(
      detectCloudflareTokenOwnership({
        accountId: ACCOUNT_ID,
        token: 'bootstrap-secret-value',
        fetcher,
      })
    ).resolves.toBe('user');
  });

  it('fails closed when bootstrap ownership verification is unavailable', async () => {
    await expect(
      detectCloudflareTokenOwnership({
        accountId: ACCOUNT_ID,
        token: 'bootstrap-secret-value',
        fetcher: (async () => new Response('{}', { status: 503 })) as typeof fetch,
        retryDelaysMs: [],
      })
    ).rejects.toMatchObject({ code: 'cloudflare_token_ownership_verification_failed' });
  });

  it('accepts only distinct direct tokens with separated account capabilities', async () => {
    const fetcher = (async (url: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
      const token = new Headers(init?.headers).get('Authorization');
      const path = String(url);
      if (path.endsWith('/user/tokens/verify')) {
        const id = token === 'Bearer direct-d1' ? '2'.repeat(32) : '3'.repeat(32);
        return new Response(JSON.stringify({ success: true, result: { id, status: 'active' } }), {
          status: 200,
        });
      }
      if (path.endsWith('/tokens/verify')) return new Response('{}', { status: 403 });
      const allowed =
        (token === 'Bearer direct-d1' && path.includes('/d1/database')) ||
        (token === 'Bearer direct-workers' && path.includes('/workers/scripts'));
      return new Response('{}', { status: allowed ? 200 : 403 });
    }) as typeof fetch;
    await expect(
      validateDirectControlTokens({
        accountId: ACCOUNT_ID,
        d1Token: 'direct-d1',
        workersToken: 'direct-workers',
        fetcher,
      })
    ).resolves.toBe('user');
    const evidence = await validateDirectControlTokensWithEvidence({
      accountId: ACCOUNT_ID,
      d1Token: 'direct-d1',
      workersToken: 'direct-workers',
      fetcher,
    });
    expect(evidence).toMatchObject({
      ownership: 'user',
      childTokens: [
        {
          resourceClass: 'd1',
          tokenId: '2'.repeat(32),
          secretName: 'CLOUDFLARE_D1_API_TOKEN',
        },
        {
          resourceClass: 'workers',
          tokenId: '3'.repeat(32),
          secretName: 'CLOUDFLARE_WORKERS_API_TOKEN',
        },
      ],
    });
    expect(evidence.childTokens.map((child) => child.tokenFingerprint)).toEqual([
      'add76d08e6b0a64b31d1805e60dcb5ca97cb048251c00836b2c5a2cad8ebcc94',
      'abd3f7a9b112ce8f7eab78fa291bb6e60e8eaac8c996e0a88588656cf4a6f000',
    ]);
    expect(new Set(evidence.childTokens.map((child) => child.tokenFingerprint)).size).toBe(2);
    expect(JSON.stringify(evidence)).not.toContain('direct-d1');
    expect(JSON.stringify(evidence)).not.toContain('direct-workers');
    await expect(
      validateDirectControlTokens({
        accountId: ACCOUNT_ID,
        d1Token: 'direct-d1',
        workersToken: 'direct-d1',
        fetcher,
      })
    ).rejects.toMatchObject({ code: 'cloudflare_direct_tokens_not_distinct' });
  });

  it('rejects a direct D1 token that also reaches Workers Scripts', async () => {
    const fetcher = (async (url: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
      const token = new Headers(init?.headers).get('Authorization');
      const path = String(url);
      if (path.endsWith('/user/tokens/verify')) {
        const id = token === 'Bearer overprivileged' ? '4'.repeat(32) : '3'.repeat(32);
        return new Response(JSON.stringify({ success: true, result: { id, status: 'active' } }), {
          status: 200,
        });
      }
      if (path.endsWith('/tokens/verify')) return new Response('{}', { status: 403 });
      const allowed =
        token === 'Bearer overprivileged' ||
        (token === 'Bearer direct-workers' && path.includes('/workers/scripts'));
      return new Response('{}', { status: allowed ? 200 : 403 });
    }) as typeof fetch;
    await expect(
      validateDirectControlTokens({
        accountId: ACCOUNT_ID,
        d1Token: 'overprivileged',
        workersToken: 'direct-workers',
        fetcher,
      })
    ).rejects.toMatchObject({ code: 'cloudflare_direct_d1_token_scope_invalid' });
  });

  it('rejects direct-token authority evidence when verify omits or reuses an exact token ID', async () => {
    const buildFetcher = (tokenId: string | undefined) =>
      (async (url: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
        const token = new Headers(init?.headers).get('Authorization');
        const path = String(url);
        if (path.endsWith('/user/tokens/verify')) {
          return new Response(
            JSON.stringify({
              success: true,
              result: { ...(tokenId ? { id: tokenId } : {}), status: 'active' },
            }),
            { status: 200 }
          );
        }
        if (path.endsWith('/tokens/verify')) return new Response('{}', { status: 403 });
        const allowed =
          (token === 'Bearer direct-d1' && path.includes('/d1/database')) ||
          (token === 'Bearer direct-workers' && path.includes('/workers/scripts'));
        return new Response('{}', { status: allowed ? 200 : 403 });
      }) as typeof fetch;

    await expect(
      validateDirectControlTokensWithEvidence({
        accountId: ACCOUNT_ID,
        d1Token: 'direct-d1',
        workersToken: 'direct-workers',
        fetcher: buildFetcher(undefined),
      })
    ).rejects.toMatchObject({ code: 'cloudflare_direct_token_identity_invalid' });
    await expect(
      validateDirectControlTokensWithEvidence({
        accountId: ACCOUNT_ID,
        d1Token: 'direct-d1',
        workersToken: 'direct-workers',
        fetcher: buildFetcher('5'.repeat(32)),
      })
    ).rejects.toMatchObject({ code: 'cloudflare_direct_token_ownership_invalid' });
  });

  it('retries transient ownership verification without weakening the exact identity check', async () => {
    let accountCalls = 0;
    let userCalls = 0;
    const fetcher = (async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith(`/accounts/${ACCOUNT_ID}/tokens/verify`)) {
        accountCalls += 1;
        return new Response('{}', { status: accountCalls === 1 ? 503 : 403 });
      }
      userCalls += 1;
      return userCalls === 1
        ? new Response('{}', { status: 503 })
        : new Response(
            JSON.stringify({
              success: true,
              result: { id: '6'.repeat(32), status: 'active' },
            }),
            { status: 200 }
          );
    }) as typeof fetch;

    await expect(
      detectCloudflareTokenOwnership({
        accountId: ACCOUNT_ID,
        token: 'transient-token',
        fetcher,
        retryDelaysMs: [0],
      })
    ).resolves.toBe('user');
    expect(accountCalls).toBe(2);
    expect(userCalls).toBe(2);
  });

  it('does not treat a capability probe outage as a denied cross-resource request', async () => {
    let calls = 0;
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'user',
      bootstrapToken: 'bootstrap-token-value',
      fetcher: (async () => {
        calls += 1;
        return new Response('{}', { status: 503 });
      }) as typeof fetch,
    });

    await expect(client.probeIssuedToken('child-token-value', 'kv')).rejects.toMatchObject({
      code: 'cloudflare_token_capability_probe_unavailable',
    });
    expect(calls).toBe(4);
  });

  it('retries a transient child capability probe without recreating tokens', async () => {
    const authority = new FakeAuthority();
    authority.capabilityProbeFailuresRemaining = 1;

    const result = await bootstrapControlWorkerTokens({
      accountId: ACCOUNT_ID,
      environment: 'test',
      ownership: 'account',
      authority,
      secretSink: new FakeSecretSink(),
      capabilityStabilizationDelaysMs: [0],
    });

    expect(result.bootstrapRevoked).toBe(true);
    expect(result.childTokens).toHaveLength(2);
    expect(authority.createCalls).toBe(2);
    expect(new Set(result.childTokens.map((token) => token.tokenId)).size).toBe(2);
  });

  it('uses the current account endpoints for all resource-class capability probes', async () => {
    const paths: string[] = [];
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'user',
      bootstrapToken: 'bootstrap-token-value',
      fetcher: (async (url: string | URL | Request) => {
        paths.push(new URL(String(url)).pathname);
        return new Response('{}', { status: 403 });
      }) as typeof fetch,
    });

    await expect(client.probeIssuedToken('child-token-value', 'd1')).resolves.toBe('denied');
    await expect(client.probeIssuedToken('child-token-value', 'workers')).resolves.toBe('denied');
    await expect(client.probeIssuedToken('child-token-value', 'kv')).resolves.toBe('denied');
    await expect(client.probeIssuedToken('child-token-value', 'r2')).resolves.toBe('denied');
    expect(paths).toEqual([
      `/client/v4/accounts/${ACCOUNT_ID}/d1/database`,
      `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts`,
      `/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces`,
      `/client/v4/accounts/${ACCOUNT_ID}/r2/buckets`,
    ]);
  });

  it('creates distinct account-scoped child tokens, registers secrets, then revokes bootstrap', async () => {
    const authority = new FakeAuthority();
    const sink = new FakeSecretSink();
    const result = await bootstrapControlWorkerTokens({
      accountId: ACCOUNT_ID,
      environment: 'test',
      ownership: 'account',
      authority,
      secretSink: sink,
    });

    expect(result.bootstrapRevoked).toBe(true);
    expect(result.childTokens.map((token) => token.resourceClass)).toEqual(['d1', 'workers']);
    expect(new Set(result.childTokens.map((token) => token.tokenId)).size).toBe(2);
    expect(authority.deleted.at(-1)).toBe(BOOTSTRAP_ID);
    expect(sink.values.get('CLOUDFLARE_D1_API_TOKEN')).toBe('child-secret-2');
    expect(sink.values.get('CLOUDFLARE_WORKERS_API_TOKEN')).toBe('child-secret-3');
    for (const child of result.childTokens) {
      expect(authority.records.get(child.tokenId)?.policies).toEqual([
        expect.objectContaining({
          effect: 'allow',
          resources: { [`com.cloudflare.api.account.${ACCOUNT_ID}`]: '*' },
        }),
      ]);
    }
    expect(JSON.stringify(result)).not.toContain('child-secret');
    expect(JSON.stringify(result)).not.toContain(authority.bootstrapValue);
  });

  it.each([
    { label: 'no expiration', expiresOn: undefined },
    { label: 'provider-specific metadata', expiresOn: 'invalid' },
    { label: 'short expiration', expiresOn: '2026-09-01T12:10:00Z' },
    { label: 'long expiration', expiresOn: '2027-09-01T12:00:00Z' },
  ])('does not enforce bootstrap token lifetime: $label', async ({ expiresOn }) => {
    const authority = new FakeAuthority();
    const bootstrap = authority.records.get(BOOTSTRAP_ID)!;
    if (expiresOn === undefined) delete bootstrap.expires_on;
    else bootstrap.expires_on = expiresOn;

    const result = await bootstrapControlWorkerTokens({
      accountId: ACCOUNT_ID,
      environment: 'test',
      ownership: 'account',
      authority,
      secretSink: new FakeSecretSink(),
    });

    expect(result.bootstrapRevoked).toBe(true);
    expect(authority.createCalls).toBe(2);
    expect(authority.deleted.at(-1)).toBe(BOOTSTRAP_ID);
  });

  it('creates and capability-probes all requested resource-class tokens', async () => {
    const authority = new FakeAuthority();
    const result = await bootstrapControlWorkerTokens({
      accountId: ACCOUNT_ID,
      environment: 'test',
      ownership: 'account',
      authority,
      secretSink: new FakeSecretSink(),
      resourceClasses: ['d1', 'workers', 'kv', 'r2'],
    });

    expect(result.childTokens.map((token) => token.resourceClass)).toEqual([
      'd1',
      'workers',
      'kv',
      'r2',
    ]);
  });

  it('waits for an active child token capability to stabilize before rejecting it', async () => {
    const authority = new FakeAuthority();
    authority.deniedCapabilityProbeRounds = 2;

    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
        capabilityStabilizationDelaysMs: [0, 0],
      })
    ).resolves.toMatchObject({ bootstrapRevoked: true });
    expect(authority.capabilityProbeCalls).toBeGreaterThanOrEqual(12);
  });

  it('rejects a child token that the provider allows across resource classes', async () => {
    const authority = new FakeAuthority();
    authority.allowChildCrossResource = true;

    const failure = bootstrapControlWorkerTokens({
      accountId: ACCOUNT_ID,
      environment: 'test',
      ownership: 'account',
      authority,
      secretSink: new FakeSecretSink(),
      capabilityStabilizationDelaysMs: [],
    });
    await expect(failure).rejects.toMatchObject({
      code: 'cloudflare_child_token_capability_invalid',
      capabilityDiagnostic: {
        issuedFor: 'd1',
        probes: {
          d1: 'allowed',
          workers: 'allowed',
          kv: 'allowed',
          r2: 'allowed',
        },
      },
    });
    expect(authority.records.size).toBe(0);
  });

  it('revokes stale deterministic-name bootstrap tokens before creating child tokens', async () => {
    const authority = new FakeAuthority();
    const staleId = '9'.repeat(32);
    const unrelatedId = '8'.repeat(32);
    authority.records.set(staleId, {
      id: staleId,
      name: `authrim-test-${ACCOUNT_ID.slice(0, 8)}-bootstrap`,
      status: 'active',
      policies: [policy({ id: 'pg-bootstrap', name: 'Account API Tokens Write' })],
    });
    authority.records.set(unrelatedId, {
      id: unrelatedId,
      name: 'operator-owned-unrelated-token',
      status: 'active',
      policies: [policy({ id: 'pg-bootstrap', name: 'Account API Tokens Write' })],
    });

    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
      })
    ).resolves.toMatchObject({ bootstrapRevoked: true });

    expect(authority.deleted).toContain(staleId);
    expect(authority.records.has(unrelatedId)).toBe(true);
  });

  it('fails closed when stale deterministic bootstrap cleanup cannot be confirmed', async () => {
    const authority = new FakeAuthority();
    const staleId = '9'.repeat(32);
    authority.records.set(staleId, {
      id: staleId,
      name: `authrim-test-${ACCOUNT_ID.slice(0, 8)}-bootstrap`,
      status: 'active',
      policies: [policy({ id: 'pg-bootstrap', name: 'Account API Tokens Write' })],
    });
    authority.leaveDeletedTokenActive = true;

    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_token_cleanup_unconfirmed',
      cleanupRequired: true,
    });
    expect(authority.createCalls).toBe(0);
  });

  it('adopts stale bootstrap deletion response loss only after inventory reflection', async () => {
    const authority = new FakeAuthority();
    const staleId = '9'.repeat(32);
    authority.records.set(staleId, {
      id: staleId,
      name: `authrim-test-${ACCOUNT_ID.slice(0, 8)}-bootstrap`,
      status: 'active',
      policies: [policy({ id: 'pg-bootstrap', name: 'Account API Tokens Write' })],
    });
    authority.loseNextDeleteResponse = true;

    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
      })
    ).resolves.toMatchObject({ bootstrapRevoked: true });
    expect(authority.records.has(staleId)).toBe(false);
  });

  it('reconciles a lost child-create response and retires the previous named token after cutover', async () => {
    const authority = new FakeAuthority();
    const oldTokenId = '7'.repeat(32);
    addExistingChildToken(authority, 'd1', oldTokenId, 'old-d1-token');
    authority.loseFirstCreateResponse = true;
    const result = await bootstrapControlWorkerTokens({
      accountId: ACCOUNT_ID,
      environment: 'test',
      ownership: 'account',
      authority,
      secretSink: new FakeSecretSink(),
      childTokenCreateReconciliationDelaysMs: [0],
    });
    expect(result.bootstrapRevoked).toBe(true);
    expect(authority.createCalls).toBe(3);
    expect(authority.deleted).toContain('2'.repeat(32));
    expect(authority.deleted).toContain(oldTokenId);
    expect(authority.records.has(oldTokenId)).toBe(false);
  });

  it('waits for delayed exact-name inventory before replaying a lost child-token create', async () => {
    const authority = new FakeAuthority();
    authority.loseFirstCreateResponse = true;
    authority.lostCreateVisibilityDelayLists = 2;

    const result = await bootstrapControlWorkerTokens({
      accountId: ACCOUNT_ID,
      environment: 'test',
      ownership: 'account',
      authority,
      secretSink: new FakeSecretSink(),
      childTokenCreateReconciliationDelaysMs: [0, 0, 0],
    });

    expect(result.bootstrapRevoked).toBe(true);
    expect(authority.createCalls).toBe(3);
    expect(authority.pendingLostCreate).toBeNull();
    expect(authority.deleted).toContain('2'.repeat(32));
    const d1Name = buildCloudflareChildTokenName({
      accountId: ACCOUNT_ID,
      environment: 'test',
      resourceClass: 'd1',
    });
    const d1Tokens = [...authority.records.values()].filter((token) => token.name === d1Name);
    expect(d1Tokens).toHaveLength(1);
    expect(d1Tokens[0]?.id).toBe(result.childTokens[0]?.tokenId);
  });

  it('does not issue a second create before delayed inventory is visible and converges on retry', async () => {
    const authority = new FakeAuthority();
    authority.loseFirstCreateResponse = true;
    authority.lostCreateVisibilityDelayLists = 10;

    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
        childTokenCreateReconciliationDelaysMs: [0],
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_child_token_create_outcome_unconfirmed',
      cleanupRequired: false,
      bootstrapRetainedForRetry: true,
    });
    expect(authority.createCalls).toBe(1);
    expect(authority.records.has(BOOTSTRAP_ID)).toBe(true);

    authority.lostCreateVisibilityDelayLists = 0;
    const result = await bootstrapControlWorkerTokens({
      accountId: ACCOUNT_ID,
      environment: 'test',
      ownership: 'account',
      authority,
      secretSink: new FakeSecretSink(),
      childTokenCreateReconciliationDelaysMs: [0],
    });

    expect(result.bootstrapRevoked).toBe(true);
    expect(authority.pendingLostCreate).toBeNull();
    expect(authority.deleted).toContain('2'.repeat(32));
    for (const child of result.childTokens) {
      expect(
        [...authority.records.values()].filter((token) => token.name === child.tokenName)
      ).toHaveLength(1);
    }
  });

  it('retains bootstrap when token details remain transiently unavailable', async () => {
    const authority = new FakeAuthority();
    authority.getTokenError = new CloudflareTokenBootstrapError('cloudflare_token_api_http_503');

    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_token_api_http_503',
      cleanupRequired: false,
      bootstrapRetainedForRetry: true,
    });

    expect(authority.records.has(BOOTSTRAP_ID)).toBe(true);
    expect(authority.deleted).not.toContain(BOOTSTRAP_ID);
    expect(authority.createCalls).toBe(0);
  });

  it('retains bootstrap and removes an unregistered child after indeterminate verification', async () => {
    const authority = new FakeAuthority();
    authority.verifyIssuedTokenError = new CloudflareTokenBootstrapError(
      'cloudflare_token_api_response_lost'
    );

    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_token_api_response_lost',
      cleanupRequired: false,
      bootstrapRetainedForRetry: true,
    });

    expect(authority.records.has(BOOTSTRAP_ID)).toBe(true);
    expect(authority.records.has('2'.repeat(32))).toBe(false);
    expect(authority.deleted).toContain('2'.repeat(32));
    expect(authority.deleted).not.toContain(BOOTSTRAP_ID);
  });

  it('retains bootstrap when self verification exhausts transient retries', async () => {
    const authority = new FakeAuthority();
    authority.verifySelfError = new CloudflareTokenBootstrapError('cloudflare_token_api_http_503');

    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_token_api_http_503',
      cleanupRequired: false,
      bootstrapRetainedForRetry: true,
    });

    expect(authority.records.has(BOOTSTRAP_ID)).toBe(true);
    expect(authority.deleted).toEqual([]);
  });

  it('replays an ambiguous secret put and retires the previous credential after confirmation', async () => {
    const authority = new FakeAuthority();
    const oldTokenId = '7'.repeat(32);
    addExistingChildToken(authority, 'd1', oldTokenId, 'old-d1-token');
    const sink = new FakeSecretSink();
    sink.values.set('CLOUDFLARE_D1_API_TOKEN', 'stale-secret-value');
    sink.loseFirstPutResponse = true;
    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: sink,
        secretInventoryRetryDelaysMs: [],
      })
    ).resolves.toMatchObject({ bootstrapRevoked: true });
    expect(sink.deleted).not.toContain('CLOUDFLARE_D1_API_TOKEN');
    expect(sink.values.get('CLOUDFLARE_D1_API_TOKEN')).toBe('child-secret-2');
    expect(authority.records.has(oldTokenId)).toBe(false);
    expect(authority.deleted).toContain(oldTokenId);
    expect(sink.putCalls).toBe(1);
  });

  it('fails closed and retains the old credential when every replacement write fails', async () => {
    const authority = new FakeAuthority();
    const oldTokenId = '7'.repeat(32);
    addExistingChildToken(authority, 'd1', oldTokenId, 'old-d1-token');
    const sink = new FakeSecretSink();
    sink.values.set('CLOUDFLARE_D1_API_TOKEN', 'stale-secret-value');
    sink.failPutBeforeWrite = true;

    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: sink,
        secretInventoryRetryDelaysMs: [],
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_token_bootstrap_failed',
      cleanupRequired: true,
    });

    expect(sink.deleted).not.toContain('CLOUDFLARE_D1_API_TOKEN');
    expect(sink.values.get('CLOUDFLARE_D1_API_TOKEN')).toBe('stale-secret-value');
    expect(authority.records.has(oldTokenId)).toBe(true);
    expect(authority.deleted).not.toContain(oldTokenId);
    expect(sink.putCalls).toBe(1);
  });

  it('retains both token generations when every put response is ambiguous', async () => {
    const authority = new FakeAuthority();
    const oldTokenId = '7'.repeat(32);
    addExistingChildToken(authority, 'd1', oldTokenId, 'old-d1-token');
    const sink = new FakeSecretSink();
    sink.values.set('CLOUDFLARE_D1_API_TOKEN', 'stale-secret-value');
    sink.loseAllPutResponses = true;

    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: sink,
        secretInventoryRetryDelaysMs: [],
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_control_secret_generation_creation_unconfirmed',
      cleanupRequired: false,
      bootstrapRetainedForRetry: true,
    });

    expect(sink.values.get('CLOUDFLARE_D1_API_TOKEN')).toBe('child-secret-2');
    expect(authority.records.has(oldTokenId)).toBe(true);
    expect(authority.records.has('2'.repeat(32))).toBe(true);
    expect(authority.deleted).not.toContain(oldTokenId);
    expect(authority.deleted).not.toContain('2'.repeat(32));
    expect(sink.deleted).toEqual([]);
  });

  it('retries read-only secret inventory before replaying a confirmed put', async () => {
    const sink = new FakeSecretSink();
    sink.inventoryFailuresRemaining = 2;

    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority: new FakeAuthority(),
        secretSink: sink,
        secretInventoryRetryDelaysMs: [0, 0],
      })
    ).resolves.toMatchObject({ bootstrapRevoked: true });

    expect(sink.putCalls).toBe(1);
    expect(sink.hasCalls).toBe(4);
  });

  it('revokes previous child tokens only after functional cutover verification', async () => {
    const authority = new FakeAuthority();
    const oldD1TokenId = '7'.repeat(32);
    const oldWorkersTokenId = '8'.repeat(32);
    addExistingChildToken(authority, 'd1', oldD1TokenId, 'old-d1-token');
    addExistingChildToken(authority, 'workers', oldWorkersTokenId, 'old-workers-token');
    const verified: unknown[] = [];

    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
        verifyControlSecretCutover: async (result) => {
          verified.push(result);
          return true;
        },
      })
    ).resolves.toMatchObject({ bootstrapRevoked: true });

    expect(verified).toHaveLength(1);
    expect(authority.deleted).toContain(oldD1TokenId);
    expect(authority.deleted).toContain(oldWorkersTokenId);
    expect(authority.records.has(oldD1TokenId)).toBe(false);
    expect(authority.records.has(oldWorkersTokenId)).toBe(false);
  });

  it('retains previous child tokens when functional cutover verification fails', async () => {
    const authority = new FakeAuthority();
    const oldD1TokenId = '7'.repeat(32);
    const oldWorkersTokenId = '8'.repeat(32);
    addExistingChildToken(authority, 'd1', oldD1TokenId, 'old-d1-token');
    addExistingChildToken(authority, 'workers', oldWorkersTokenId, 'old-workers-token');

    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
        verifyControlSecretCutover: async () => false,
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_control_secret_cutover_verification_failed',
      cleanupRequired: true,
    });

    expect(authority.records.has(oldD1TokenId)).toBe(true);
    expect(authority.records.has(oldWorkersTokenId)).toBe(true);
    expect(authority.deleted).not.toContain(oldD1TokenId);
    expect(authority.deleted).not.toContain(oldWorkersTokenId);
  });

  it('fails closed when the bootstrap DELETE response is lost even if the mutation occurred', async () => {
    const authority = new FakeAuthority();
    authority.loseBootstrapDeleteResponse = true;
    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_bootstrap_revocation_unconfirmed',
      cleanupRequired: true,
    });
  });

  it('accepts a successful bootstrap DELETE without a separate verify request', async () => {
    const authority = new FakeAuthority();
    authority.loseMissingBootstrapVerifyResponse = true;
    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
      })
    ).resolves.toMatchObject({ bootstrapRevoked: true });
  });

  it('revokes an entered bootstrap token after an earlier setup step fails', async () => {
    const staleId = '9'.repeat(32);
    const records = new Map<string, CloudflareTokenRecord>([
      [
        BOOTSTRAP_ID,
        {
          id: BOOTSTRAP_ID,
          name: `authrim-test-${ACCOUNT_ID.slice(0, 8)}-bootstrap`,
          status: 'active',
          policies: [],
        },
      ],
      [
        staleId,
        {
          id: staleId,
          name: `authrim-test-${ACCOUNT_ID.slice(0, 8)}-bootstrap`,
          status: 'active',
          policies: [],
        },
      ],
    ]);
    const requests: Array<{ method: string; url: string }> = [];
    const fetcher = (async (url: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
      const method = init?.method ?? 'GET';
      const parsed = new URL(String(url));
      requests.push({ method, url: parsed.toString() });
      if (method === 'DELETE') {
        const id = parsed.pathname.split('/').at(-1)!;
        records.delete(id);
        return new Response(JSON.stringify({ success: true, result: { id } }));
      }
      if (parsed.pathname.endsWith('/verify')) {
        if (!records.has(BOOTSTRAP_ID)) return new Response('{}', { status: 401 });
        return new Response(
          JSON.stringify({
            success: true,
            result: { id: BOOTSTRAP_ID, status: 'active' },
          })
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: [...records.values()],
          result_info: { count: records.size, page: 1, per_page: 50, total_count: records.size },
        })
      );
    }) as typeof fetch;

    await expect(
      cleanupCloudflareBootstrapToken({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        bootstrapToken: 'bootstrap-token-value',
        fetcher,
      })
    ).resolves.toEqual({ revoked: true });
    expect(records.size).toBe(0);
    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain('bootstrap-token-value');
  });

  it('requires manual cleanup when early-failure bootstrap revocation remains active', async () => {
    const fetcher = (async (url: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
      if (init?.method === 'DELETE') throw new Error('response lost before delete');
      if (!String(url).endsWith('/verify')) {
        return new Response(
          JSON.stringify({
            success: true,
            result: [
              {
                id: BOOTSTRAP_ID,
                name: `authrim-test-${ACCOUNT_ID.slice(0, 8)}-bootstrap`,
                status: 'active',
                policies: [],
              },
            ],
            result_info: { count: 1, page: 1, per_page: 50, total_count: 1 },
          })
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: { id: BOOTSTRAP_ID, status: 'active' },
        })
      );
    }) as typeof fetch;

    await expect(
      cleanupCloudflareBootstrapToken({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        bootstrapToken: 'bootstrap-token-value',
        fetcher,
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_bootstrap_revocation_unconfirmed',
      cleanupRequired: true,
    });
  });

  it('paginates the full token inventory before deterministic-name cleanup', async () => {
    const requestedPages: number[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      const page = Number(parsed.searchParams.get('page'));
      requestedPages.push(page);
      const count = page === 1 ? 50 : 1;
      return new Response(
        JSON.stringify({
          success: true,
          result: Array.from({ length: count }, (_, index) => ({
            id: ((page - 1) * 50 + index).toString(16).padStart(32, '0'),
            name: page === 2 ? 'target-token' : `token-${index}`,
            status: 'active',
            policies: [],
          })),
          result_info: { count, page, per_page: 50, total_count: 51 },
        })
      );
    }) as typeof fetch;
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'account',
      bootstrapToken: 'bootstrap-token-value',
      fetcher,
    });

    await expect(client.listTokens()).resolves.toHaveLength(51);
    expect(requestedPages).toEqual([1, 2]);
  });

  it('rejects a repeated token inventory page instead of mistaking duplicates for completion', async () => {
    const requestedPages: number[] = [];
    const repeated = Array.from({ length: 50 }, (_, index) => ({
      id: index.toString(16).padStart(32, '0'),
      name: `token-${index}`,
      status: 'active',
      policies: [],
    }));
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'account',
      bootstrapToken: 'bootstrap-token-value',
      fetcher: (async (url: string | URL | Request) => {
        const page = Number(new URL(String(url)).searchParams.get('page'));
        requestedPages.push(page);
        return new Response(
          JSON.stringify({
            success: true,
            result: repeated,
            result_info: { count: 50, page, per_page: 50, total_count: 100 },
          })
        );
      }) as typeof fetch,
    });

    await expect(client.listTokens()).rejects.toMatchObject({
      code: 'cloudflare_token_inventory_invalid',
      cleanupRequired: true,
    });
    expect(requestedPages).toEqual([1, 2]);
  });

  it.each([
    {
      label: 'response page',
      result: [{ id: 'a'.repeat(32), name: 'token-a', status: 'active', policies: [] }],
      resultInfo: { count: 1, page: 2, per_page: 50, total_count: 1 },
    },
    {
      label: 'page size',
      result: [{ id: 'a'.repeat(32), name: 'token-a', status: 'active', policies: [] }],
      resultInfo: { count: 1, page: 1, per_page: 49, total_count: 1 },
    },
    {
      label: 'reported count',
      result: [{ id: 'a'.repeat(32), name: 'token-a', status: 'active', policies: [] }],
      resultInfo: { count: 2, page: 1, per_page: 50, total_count: 1 },
    },
    {
      label: 'premature empty page',
      result: [],
      resultInfo: { count: 0, page: 1, per_page: 50, total_count: 1 },
    },
  ])('rejects inconsistent token inventory $label metadata', async ({ result, resultInfo }) => {
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'account',
      bootstrapToken: 'bootstrap-token-value',
      fetcher: (async () =>
        new Response(
          JSON.stringify({ success: true, result, result_info: resultInfo })
        )) as typeof fetch,
    });

    await expect(client.listTokens()).rejects.toMatchObject({
      code: 'cloudflare_token_inventory_invalid',
      cleanupRequired: true,
    });
  });

  it('rejects duplicate token IDs within one inventory page', async () => {
    const duplicated = {
      id: 'a'.repeat(32),
      name: 'token-a',
      status: 'active',
      policies: [],
    };
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'account',
      bootstrapToken: 'bootstrap-token-value',
      fetcher: (async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: [duplicated, duplicated],
            result_info: { count: 2, page: 1, per_page: 50, total_count: 2 },
          })
        )) as typeof fetch,
    });

    await expect(client.listTokens()).rejects.toMatchObject({
      code: 'cloudflare_token_inventory_invalid',
      cleanupRequired: true,
    });
  });

  it('rejects a total count that changes between token inventory pages', async () => {
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'account',
      bootstrapToken: 'bootstrap-token-value',
      fetcher: (async (url: string | URL | Request) => {
        const page = Number(new URL(String(url)).searchParams.get('page'));
        const count = page === 1 ? 50 : 2;
        const offset = page === 1 ? 0 : 50;
        return new Response(
          JSON.stringify({
            success: true,
            result: Array.from({ length: count }, (_, index) => ({
              id: (offset + index).toString(16).padStart(32, '0'),
              name: `token-${offset + index}`,
              status: 'active',
              policies: [],
            })),
            result_info: {
              count,
              page,
              per_page: 50,
              total_count: page === 1 ? 51 : 52,
            },
          })
        );
      }) as typeof fetch,
    });

    await expect(client.listTokens()).rejects.toMatchObject({
      code: 'cloudflare_token_inventory_invalid',
      cleanupRequired: true,
    });
  });

  it('rejects token inventories above the bounded pagination limit', async () => {
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'account',
      bootstrapToken: 'bootstrap-token-value',
      fetcher: (async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: [],
            result_info: { count: 0, page: 1, per_page: 50, total_count: 5_001 },
          })
        )) as typeof fetch,
    });

    await expect(client.listTokens()).rejects.toMatchObject({
      code: 'cloudflare_token_inventory_too_large',
      cleanupRequired: true,
    });
  });

  it('retries transient token API read failures before failing bootstrap', async () => {
    let permissionGroupCalls = 0;
    const fetcher = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith('/permission_groups')) {
        permissionGroupCalls += 1;
        if (permissionGroupCalls === 1) return new Response('{}', { status: 500 });
        return new Response(JSON.stringify({ success: true, result: groups }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'account',
      bootstrapToken: 'bootstrap-token-value',
      fetcher,
      tokenApiRetryDelaysMs: [0],
    });

    await expect(client.listPermissionGroups()).resolves.toEqual(groups);
    expect(permissionGroupCalls).toBe(2);
  });

  it('retries bootstrap self verification after transport and 5xx failures', async () => {
    let calls = 0;
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'account',
      bootstrapToken: 'bootstrap-token-value',
      fetcher: (async () => {
        calls += 1;
        if (calls === 1) throw new Error('connection reset');
        if (calls === 2) return new Response('{}', { status: 503 });
        return new Response(
          JSON.stringify({
            success: true,
            result: { id: BOOTSTRAP_ID, status: 'active' },
          })
        );
      }) as typeof fetch,
      tokenApiRetryDelaysMs: [0, 0],
    });

    await expect(client.verifySelf()).resolves.toEqual({ id: BOOTSTRAP_ID, status: 'active' });
    expect(calls).toBe(3);
  });

  it('retries token details and propagates an exhausted 5xx instead of returning absent', async () => {
    let calls = 0;
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'account',
      bootstrapToken: 'bootstrap-token-value',
      fetcher: (async () => {
        calls += 1;
        return new Response('{}', { status: 503 });
      }) as typeof fetch,
      tokenApiRetryDelaysMs: [0, 0],
    });

    await expect(client.getToken(BOOTSTRAP_ID)).rejects.toMatchObject({
      code: 'cloudflare_token_api_http_503',
    });
    expect(calls).toBe(3);
  });

  it('retries issued-token verification with the child credential after transport and 5xx failures', async () => {
    let calls = 0;
    const authorizations: Array<string | null> = [];
    const childId = '2'.repeat(32);
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'account',
      bootstrapToken: 'bootstrap-token-value',
      fetcher: (async (_url: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
        calls += 1;
        authorizations.push(new Headers(init?.headers).get('Authorization'));
        if (calls === 1) throw new Error('connection reset');
        if (calls === 2) return new Response('{}', { status: 502 });
        return new Response(
          JSON.stringify({ success: true, result: { id: childId, status: 'active' } })
        );
      }) as typeof fetch,
      tokenApiRetryDelaysMs: [0, 0],
    });

    await expect(client.verifyIssuedToken('child-token-value')).resolves.toEqual({
      id: childId,
      status: 'active',
    });
    expect(calls).toBe(3);
    expect(authorizations).toEqual([
      'Bearer child-token-value',
      'Bearer child-token-value',
      'Bearer child-token-value',
    ]);
  });

  it('propagates bootstrap verification transport loss instead of treating it as revoked', async () => {
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'account',
      bootstrapToken: 'bootstrap-token-value',
      fetcher: (async () => {
        throw new Error('network down');
      }) as typeof fetch,
      tokenApiRetryDelaysMs: [],
    });

    await expect(client.verifySelf()).rejects.toMatchObject({
      code: 'cloudflare_token_api_response_lost',
    });
  });

  it('bounds token API reads by the overall deadline when the injected fetcher ignores abort', async () => {
    let aborted = false;
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'account',
      bootstrapToken: 'bootstrap-token-value',
      fetcher: ((_url: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise<Response>(() => undefined);
      }) as typeof fetch,
      tokenApiRetryDelaysMs: [],
      tokenApiAttemptTimeoutMs: 100,
      tokenApiOperationTimeoutMs: 20,
    });

    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority: client,
        secretSink: new FakeSecretSink(),
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_token_api_response_lost',
      cleanupRequired: false,
      bootstrapRetainedForRetry: true,
    });
    expect(aborted).toBe(true);
  });

  it.each([401, 403])(
    'does not interpret bootstrap verification HTTP %s as proof of revocation',
    async (status) => {
      const client = new CloudflareTokenAuthorityHttpClient({
        accountId: ACCOUNT_ID,
        ownership: 'account',
        bootstrapToken: 'bootstrap-token-value',
        fetcher: (async () => new Response('{}', { status })) as typeof fetch,
        tokenApiRetryDelaysMs: [],
      });

      await expect(client.verifySelf()).rejects.toMatchObject({
        code: `cloudflare_token_api_http_${status}`,
      });
      await expect(
        resumeCloudflareBootstrapTokenRevocation({
          accountId: ACCOUNT_ID,
          ownership: 'account',
          expectedBootstrapTokenId: BOOTSTRAP_ID,
          authority: client,
        })
      ).rejects.toMatchObject({ code: `cloudflare_token_api_http_${status}` });
    }
  );

  it('projects secret-free authority state before revocation', async () => {
    const authority = new FakeAuthority();
    const callbackResults: unknown[] = [];
    await bootstrapControlWorkerTokens({
      accountId: ACCOUNT_ID,
      environment: 'test',
      ownership: 'account',
      authority,
      secretSink: new FakeSecretSink(),
      beforeBootstrapRevocation: async (result) => {
        callbackResults.push(result);
        expect(authority.records.has(BOOTSTRAP_ID)).toBe(true);
      },
    });
    expect(callbackResults).toEqual([
      expect.objectContaining({ bootstrapRevoked: false, ownership: 'account' }),
    ]);
    expect(JSON.stringify(callbackResults)).not.toContain('child-secret');
    expect(authority.deleted.at(-1)).toBe(BOOTSTRAP_ID);
  });

  it('retains cutover credentials when authority projection fails before revocation', async () => {
    const authority = new FakeAuthority();
    const sink = new FakeSecretSink();
    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: sink,
        beforeBootstrapRevocation: async () => {
          throw new Error('control authority response lost');
        },
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_bootstrap_revocation_checkpoint_failed',
      cleanupRequired: false,
      bootstrapRetainedForRetry: true,
    });
    expect(authority.records.size).toBe(3);
    expect(authority.deleted).not.toContain(BOOTSTRAP_ID);
    expect(sink.values.size).toBe(2);
    expect(sink.deleted).toEqual([]);
  });

  it('reports a durable-checkpoint failure after confirmed revocation without restoring broad access', async () => {
    const authority = new FakeAuthority();
    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
        afterBootstrapRevocation: async () => {
          throw new Error('control authority response lost');
        },
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_bootstrap_cutover_checkpoint_failed',
      bootstrapRetainedForRetry: false,
    });
    expect(authority.records.has(BOOTSTRAP_ID)).toBe(false);
    expect(authority.deleted).toContain(BOOTSTRAP_ID);
  });

  it('resumes the exact checkpointed bootstrap revocation but does not infer prior revocation', async () => {
    const active = new FakeAuthority();
    await expect(
      resumeCloudflareBootstrapTokenRevocation({
        accountId: ACCOUNT_ID,
        ownership: 'account',
        expectedBootstrapTokenId: BOOTSTRAP_ID,
        authority: active,
      })
    ).resolves.toEqual({ revoked: true });
    expect(active.records.has(BOOTSTRAP_ID)).toBe(false);

    await expect(
      resumeCloudflareBootstrapTokenRevocation({
        accountId: ACCOUNT_ID,
        ownership: 'account',
        expectedBootstrapTokenId: BOOTSTRAP_ID,
        authority: active,
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_bootstrap_revocation_unconfirmed',
      bootstrapRetainedForRetry: true,
    });
  });

  it('uses an independently authenticated strict recovery token to prove and remove old IDs', async () => {
    const recoveryId = '4'.repeat(32);
    const authority = new FakeAuthority(
      policy({ id: 'pg-bootstrap', name: 'Account API Tokens Write' }),
      recoveryId
    );
    authority.records.set(BOOTSTRAP_ID, {
      id: BOOTSTRAP_ID,
      name: 'authrim-test-bootstrap',
      status: 'active',
      policies: [policy({ id: 'pg-bootstrap', name: 'Account API Tokens Write' })],
    });

    await expect(
      inspectCloudflareBootstrapRecoveryToken({
        accountId: ACCOUNT_ID,
        ownership: 'account',
        authority,
      })
    ).resolves.toEqual({ tokenId: recoveryId });
    await expect(
      reconcileCloudflareBootstrapRevocationWithRecoveryToken({
        accountId: ACCOUNT_ID,
        ownership: 'account',
        expectedRecoveryTokenId: recoveryId,
        revocationTargetTokenIds: [BOOTSTRAP_ID],
        authority,
      })
    ).resolves.toEqual({ revoked: true });
    expect(authority.records.has(BOOTSTRAP_ID)).toBe(false);
    expect(authority.records.has(recoveryId)).toBe(false);
    expect(authority.deleted).toEqual([BOOTSTRAP_ID, recoveryId]);
  });

  it('read-only reconciles exact Control bootstrap, child, and recovery identities', async () => {
    const recoveryId = '4'.repeat(32);
    const authority = new FakeAuthority(
      policy({ id: 'pg-bootstrap', name: 'Account API Tokens Write' }),
      recoveryId
    );
    authority.records.set(BOOTSTRAP_ID, {
      id: BOOTSTRAP_ID,
      name: 'authrim-test-bootstrap',
      status: 'active',
      policies: [policy({ id: 'pg-bootstrap', name: 'Account API Tokens Write' })],
    });
    addExistingChildToken(authority, 'd1', '2'.repeat(32), 'child-secret-d1');
    addExistingChildToken(authority, 'workers', '3'.repeat(32), 'child-secret-workers');
    const childTokens = [
      {
        resourceClass: 'd1' as const,
        tokenId: '2'.repeat(32),
        tokenName: buildCloudflareChildTokenName({
          accountId: ACCOUNT_ID,
          environment: 'test',
          resourceClass: 'd1',
        }),
        secretName: 'CLOUDFLARE_D1_API_TOKEN' as const,
        tokenFingerprint: 'a'.repeat(64),
      },
      {
        resourceClass: 'workers' as const,
        tokenId: '3'.repeat(32),
        tokenName: buildCloudflareChildTokenName({
          accountId: ACCOUNT_ID,
          environment: 'test',
          resourceClass: 'workers',
        }),
        secretName: 'CLOUDFLARE_WORKERS_API_TOKEN' as const,
        tokenFingerprint: 'b'.repeat(64),
      },
    ];

    await expect(
      inspectCloudflarePendingBootstrapRecoveryState({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        expectedBootstrapTokenId: BOOTSTRAP_ID,
        expectedBootstrapTokenFingerprint: 'c'.repeat(64),
        childTokens,
        authority,
      })
    ).resolves.toEqual({ recoveryTokenId: recoveryId });
    expect(authority.deleted).toEqual([]);

    authority.records.get('2'.repeat(32))!.name = 'same-name-replacement';
    await expect(
      inspectCloudflarePendingBootstrapRecoveryState({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        expectedBootstrapTokenId: BOOTSTRAP_ID,
        expectedBootstrapTokenFingerprint: 'c'.repeat(64),
        childTokens,
        authority,
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_bootstrap_recovery_child_token_mismatch',
    });
    expect(authority.deleted).toEqual([]);
  });

  it('rejects a recovery token that is the checkpointed bootstrap authority', async () => {
    const authority = new FakeAuthority();
    await expect(
      inspectCloudflarePendingBootstrapRecoveryState({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        expectedBootstrapTokenId: BOOTSTRAP_ID,
        expectedBootstrapTokenFingerprint: 'c'.repeat(64),
        childTokens: [
          {
            resourceClass: 'd1',
            tokenId: '2'.repeat(32),
            tokenName: buildCloudflareChildTokenName({
              accountId: ACCOUNT_ID,
              environment: 'test',
              resourceClass: 'd1',
            }),
            secretName: 'CLOUDFLARE_D1_API_TOKEN',
            tokenFingerprint: 'a'.repeat(64),
          },
          {
            resourceClass: 'workers',
            tokenId: '3'.repeat(32),
            tokenName: buildCloudflareChildTokenName({
              accountId: ACCOUNT_ID,
              environment: 'test',
              resourceClass: 'workers',
            }),
            secretName: 'CLOUDFLARE_WORKERS_API_TOKEN',
            tokenFingerprint: 'b'.repeat(64),
          },
        ],
        authority,
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_bootstrap_recovery_token_not_independent',
    });
    expect(authority.deleted).toEqual([]);
  });

  it('resumes after a lost bootstrap DELETE response without deleting any target twice', async () => {
    const recoveryId = '4'.repeat(32);
    const authority = new FakeAuthority(
      policy({ id: 'pg-bootstrap', name: 'Account API Tokens Write' }),
      recoveryId
    );
    authority.records.set(BOOTSTRAP_ID, {
      id: BOOTSTRAP_ID,
      name: 'authrim-test-bootstrap',
      status: 'active',
      policies: [policy({ id: 'pg-bootstrap', name: 'Account API Tokens Write' })],
    });
    authority.loseNextDeleteResponse = true;

    await expect(
      reconcileCloudflareBootstrapRevocationWithRecoveryToken({
        accountId: ACCOUNT_ID,
        ownership: 'account',
        expectedRecoveryTokenId: recoveryId,
        revocationTargetTokenIds: [BOOTSTRAP_ID],
        authority,
      })
    ).rejects.toThrow('response lost');
    await expect(
      reconcileCloudflareBootstrapRevocationWithRecoveryToken({
        accountId: ACCOUNT_ID,
        ownership: 'account',
        expectedRecoveryTokenId: recoveryId,
        revocationTargetTokenIds: [BOOTSTRAP_ID],
        authority,
      })
    ).resolves.toEqual({ revoked: true });
    expect(authority.deleted.filter((tokenId) => tokenId === BOOTSTRAP_ID)).toHaveLength(1);
    expect(authority.deleted.filter((tokenId) => tokenId === recoveryId)).toHaveLength(1);
  });

  it('rejects a recovery token whose token-management permission covers every account', async () => {
    const recoveryId = '4'.repeat(32);
    const authority = new FakeAuthority(
      {
        effect: 'allow',
        permission_groups: [{ id: 'pg-bootstrap', name: 'Account API Tokens Write' }],
        resources: { 'com.cloudflare.api.account.*': '*' },
      },
      recoveryId
    );

    await expect(
      inspectCloudflareBootstrapRecoveryToken({
        accountId: ACCOUNT_ID,
        ownership: 'account',
        authority,
      })
    ).rejects.toMatchObject({ code: 'cloudflare_bootstrap_token_scope_invalid' });
    expect(authority.deleted).toEqual([]);
  });

  it('fails closed when independent recovery token self-revocation loses its response', async () => {
    const recoveryId = '4'.repeat(32);
    const authority = new FakeAuthority(
      policy({ id: 'pg-bootstrap', name: 'Account API Tokens Write' }),
      recoveryId
    );
    authority.loseNextDeleteResponse = true;

    await expect(
      reconcileCloudflareBootstrapRevocationWithRecoveryToken({
        accountId: ACCOUNT_ID,
        ownership: 'account',
        expectedRecoveryTokenId: recoveryId,
        revocationTargetTokenIds: ['5'.repeat(32)],
        authority,
      })
    ).rejects.toMatchObject({ cleanupRequired: true });
  });

  it('does not revoke an active credential whose identity differs from the checkpoint', async () => {
    const authority = new FakeAuthority();
    await expect(
      resumeCloudflareBootstrapTokenRevocation({
        accountId: ACCOUNT_ID,
        ownership: 'account',
        expectedBootstrapTokenId: 'f'.repeat(32),
        authority,
      })
    ).rejects.toMatchObject({ code: 'cloudflare_bootstrap_token_identity_mismatch' });
    expect(authority.deleted).not.toContain(BOOTSTRAP_ID);
    expect(authority.records.has(BOOTSTRAP_ID)).toBe(true);
  });

  it('revokes bootstrap when its policy has extra privilege', async () => {
    const authority = new FakeAuthority({
      effect: 'allow',
      permission_groups: [
        { id: 'pg-bootstrap', name: 'Account API Tokens Write' },
        { id: 'pg-d1', name: 'D1 Write' },
      ],
      resources: { [`com.cloudflare.api.account.${ACCOUNT_ID}`]: '*' },
    });
    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
      })
    ).rejects.toMatchObject({ code: 'cloudflare_bootstrap_token_scope_invalid' });
    expect(authority.deleted).toContain(BOOTSTRAP_ID);
  });

  it('does not delete a token that may back an earlier cutover when identity is reused', async () => {
    const authority = new FakeAuthority();
    authority.makeChildrenIdentical = true;
    const sink = new FakeSecretSink();
    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: sink,
      })
    ).rejects.toMatchObject({
      code: 'cloudflare_child_tokens_not_distinct',
      cleanupRequired: false,
    });
    expect(authority.deleted).toContain(BOOTSTRAP_ID);
    expect(authority.records.size).toBe(0);
    expect(sink.values.get('CLOUDFLARE_D1_API_TOKEN')).toBeUndefined();
    expect(sink.deleted).toEqual([]);
  });

  it('reports explicit cleanup when revocation remains active', async () => {
    const authority = new FakeAuthority();
    authority.leaveDeletedTokenActive = true;
    authority.loseBootstrapDeleteResponse = true;
    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority,
        secretSink: new FakeSecretSink(),
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<CloudflareTokenBootstrapError>>({
        code: 'cloudflare_bootstrap_revocation_unconfirmed',
        cleanupRequired: true,
      })
    );
  });

  it('uploads generated secrets as one tagged immutable version through stdin and deploys it', async () => {
    const calls: Array<{
      args: readonly string[];
      input?: string;
      logLevel?: string;
    }> = [];
    let versionListCalls = 0;
    let deployed = false;
    const sink = new WranglerControlSecretSink({
      workerName: 'test-ar-control',
      cwd: '/workspace',
      runner: async (_command, args, options) => {
        calls.push({ args, input: options.input, logLevel: options.env.WRANGLER_LOG });
        if (args.includes('deployments') && args.includes('status')) {
          return {
            stdout: JSON.stringify({
              id: deployed ? 'deployment-1' : 'deployment-previous',
              versions: [
                { version_id: deployed ? 'version-1' : 'version-previous', percentage: 100 },
              ],
            }),
          };
        }
        if (args.includes('versions') && args.includes('list')) {
          versionListCalls += 1;
          return {
            stdout:
              versionListCalls === 1
                ? '[]'
                : JSON.stringify([
                    {
                      id: 'version-1',
                      annotations: { 'workers/tag': 'authrim-test-generation' },
                    },
                  ]),
          };
        }
        if (args.includes('bulk') && args.includes('secret')) {
          return { stdout: 'Success! Created version version-1 with 2 secrets.' };
        }
        if (args.includes('versions') && args.includes('deploy')) {
          deployed = true;
          return { stdout: 'Deployed version-1' };
        }
        if (args.includes('secret') && args.includes('list')) {
          return { stdout: '[{"name":"CLOUDFLARE_D1_API_TOKEN","type":"secret_text"}]' };
        }
        return { stdout: '' };
      },
    });
    await expect(
      sink.putGeneration(
        {
          CLOUDFLARE_D1_API_TOKEN: 'generated-d1-secret-value',
          CLOUDFLARE_WORKERS_API_TOKEN: 'generated-workers-secret-value',
        },
        'authrim-test-generation'
      )
    ).resolves.toEqual({ deploymentId: 'deployment-1', versionId: 'version-1' });
    const bulkCall = calls.find((call) => call.args.includes('bulk'))!;
    expect(JSON.parse(bulkCall.input!)).toEqual({
      CLOUDFLARE_D1_API_TOKEN: 'generated-d1-secret-value',
      CLOUDFLARE_WORKERS_API_TOKEN: 'generated-workers-secret-value',
    });
    expect(calls.map((call) => call.args.join(' ')).join('\n')).not.toContain(
      'generated-d1-secret-value'
    );
    expect(bulkCall.args).toContain('authrim-test-generation');
    expect(calls.some((call) => call.args.includes('deploy'))).toBe(true);
  });

  it('reconciles lost bulk-upload and deploy responses by immutable tag and active version', async () => {
    let versionListCalls = 0;
    let deployCalls = 0;
    const sink = new WranglerControlSecretSink({
      workerName: 'test-ar-control',
      cwd: '/workspace',
      runner: async (_command, args) => {
        if (args.includes('versions') && args.includes('list')) {
          versionListCalls += 1;
          return {
            stdout:
              versionListCalls === 1
                ? '[]'
                : JSON.stringify([
                    {
                      id: 'version-reconciled',
                      annotations: { 'workers/tag': 'authrim-test-reconcile' },
                    },
                  ]),
          };
        }
        if (args.includes('secret') && args.includes('bulk')) {
          throw new Error('upload response lost');
        }
        if (args.includes('versions') && args.includes('deploy')) {
          deployCalls += 1;
          throw new Error('deployment response lost');
        }
        if (args.includes('deployments') && args.includes('status')) {
          return {
            stdout: JSON.stringify({
              id: deployCalls === 0 ? 'deployment-previous' : 'deployment-reconciled',
              versions: [
                {
                  version_id: deployCalls === 0 ? 'version-previous' : 'version-reconciled',
                  percentage: 100,
                },
              ],
            }),
          };
        }
        return { stdout: '[]' };
      },
    });

    await expect(
      sink.putGeneration(
        {
          CLOUDFLARE_D1_API_TOKEN: 'generated-d1-secret-value',
          CLOUDFLARE_WORKERS_API_TOKEN: 'generated-workers-secret-value',
        },
        'authrim-test-reconcile'
      )
    ).resolves.toEqual({
      deploymentId: 'deployment-reconciled',
      versionId: 'version-reconciled',
    });
    expect(deployCalls).toBe(1);
  });

  it('treats code 10000 as commit-ambiguous and never replays while active status is stale', async () => {
    let versionListCalls = 0;
    let deployCalls = 0;
    let statusCalls = 0;
    const deployedVersions: string[] = [];
    const sink = new WranglerControlSecretSink({
      workerName: 'test-ar-control',
      cwd: '/workspace',
      runner: async (_command, args) => {
        if (args.includes('versions') && args.includes('list')) {
          versionListCalls += 1;
          return {
            stdout:
              versionListCalls === 1
                ? '[]'
                : JSON.stringify([
                    {
                      id: 'version-retry',
                      annotations: { 'workers/tag': 'authrim-test-retry' },
                    },
                  ]),
          };
        }
        if (args.includes('secret') && args.includes('bulk')) {
          return { stdout: 'Success! Created version version-retry with 2 secrets.' };
        }
        if (args.includes('deployments') && args.includes('status')) {
          statusCalls += 1;
          const visible = deployCalls > 0 && statusCalls >= 3;
          return {
            stdout: JSON.stringify({
              id: visible ? 'deployment-retry' : 'deployment-previous',
              versions: [
                {
                  version_id: visible ? 'version-retry' : 'version-previous',
                  percentage: 100,
                },
              ],
            }),
          };
        }
        if (args.includes('versions') && args.includes('deploy')) {
          deployCalls += 1;
          deployedVersions.push(args[4]!);
          // The provider committed the mutation, but Wrangler lost the successful outcome and
          // active deployment visibility remains stale for the first readback.
          throw new Error('Authentication error [code: 10000]');
        }
        return { stdout: '' };
      },
    });

    await expect(
      sink.putGeneration(
        {
          CLOUDFLARE_D1_API_TOKEN: 'generated-d1-secret-value',
          CLOUDFLARE_WORKERS_API_TOKEN: 'generated-workers-secret-value',
        },
        'authrim-test-retry'
      )
    ).resolves.toEqual({ deploymentId: 'deployment-retry', versionId: 'version-retry' });
    expect(deployCalls).toBe(1);
    expect(deployedVersions).toEqual(['version-retry@100%']);
    expect(statusCalls).toBeGreaterThanOrEqual(3);
  });

  it('returns a recoverable state without replay when an ambiguous deploy never becomes visible', async () => {
    let versionListCalls = 0;
    let deployCalls = 0;
    const sink = new WranglerControlSecretSink({
      workerName: 'test-ar-control',
      cwd: '/workspace',
      operationTimeoutMs: 100,
      runner: async (_command, args) => {
        if (args.includes('versions') && args.includes('list')) {
          versionListCalls += 1;
          return {
            stdout:
              versionListCalls === 1
                ? '[]'
                : JSON.stringify([
                    {
                      id: 'version-unconfirmed',
                      annotations: { 'workers/tag': 'authrim-test-unconfirmed' },
                    },
                  ]),
          };
        }
        if (args.includes('secret') && args.includes('bulk')) {
          return { stdout: 'Success! Created version version-unconfirmed with 2 secrets.' };
        }
        if (args.includes('deployments') && args.includes('status')) {
          return {
            stdout: JSON.stringify({
              id: 'deployment-previous',
              versions: [{ version_id: 'version-previous', percentage: 100 }],
            }),
          };
        }
        if (args.includes('versions') && args.includes('deploy')) {
          deployCalls += 1;
          throw new Error('Authentication error [code: 10000]');
        }
        return { stdout: '' };
      },
    });

    await expect(
      sink.putGeneration(
        {
          CLOUDFLARE_D1_API_TOKEN: 'generated-d1-secret-value',
          CLOUDFLARE_WORKERS_API_TOKEN: 'generated-workers-secret-value',
        },
        'authrim-test-unconfirmed'
      )
    ).rejects.toMatchObject({
      code: 'cloudflare_control_secret_generation_deployment_unconfirmed',
      cleanupRequired: true,
      bootstrapRetainedForRetry: true,
    });
    expect(deployCalls).toBe(1);
  });

  it('returns an already-active immutable version from pre-readback without redeploying it', async () => {
    let versionListCalls = 0;
    let deployCalls = 0;
    const sink = new WranglerControlSecretSink({
      workerName: 'test-ar-control',
      cwd: '/workspace',
      runner: async (_command, args) => {
        if (args.includes('versions') && args.includes('list')) {
          versionListCalls += 1;
          return {
            stdout:
              versionListCalls === 1
                ? '[]'
                : JSON.stringify([
                    {
                      id: 'version-pre-active',
                      annotations: { 'workers/tag': 'authrim-test-pre-active' },
                    },
                  ]),
          };
        }
        if (args.includes('secret') && args.includes('bulk')) {
          return { stdout: 'Success! Created version version-pre-active with 2 secrets.' };
        }
        if (args.includes('deployments') && args.includes('status')) {
          return {
            stdout: JSON.stringify({
              id: 'deployment-pre-active',
              versions: [{ version_id: 'version-pre-active', percentage: 100 }],
            }),
          };
        }
        if (args.includes('versions') && args.includes('deploy')) deployCalls += 1;
        return { stdout: '' };
      },
    });

    await expect(
      sink.putGeneration(
        {
          CLOUDFLARE_D1_API_TOKEN: 'generated-d1-secret-value',
          CLOUDFLARE_WORKERS_API_TOKEN: 'generated-workers-secret-value',
        },
        'authrim-test-pre-active'
      )
    ).resolves.toEqual({
      deploymentId: 'deployment-pre-active',
      versionId: 'version-pre-active',
    });
    expect(deployCalls).toBe(0);
  });

  it.each([
    { commandTimeoutMs: 20, operationTimeoutMs: 50 },
    { commandTimeoutMs: 100, operationTimeoutMs: 20 },
  ])(
    'bounds a never-settling injected Wrangler runner at the command/operation deadline %#',
    async ({ commandTimeoutMs, operationTimeoutMs }) => {
      let aborted = false;
      let receivedTimeoutMs: number | undefined;
      const sink = new WranglerControlSecretSink({
        workerName: 'test-ar-control',
        cwd: '/workspace',
        commandTimeoutMs,
        operationTimeoutMs,
        runner: async (_command, _args, options) => {
          receivedTimeoutMs = options.timeoutMs;
          options.signal.addEventListener('abort', () => {
            aborted = true;
          });
          return new Promise(() => undefined);
        },
      });

      await expect(sink.readActiveGeneration()).rejects.toMatchObject({
        code: 'cloudflare_control_secret_command_timeout',
        cleanupRequired: true,
        bootstrapRetainedForRetry: true,
      });
      expect(aborted).toBe(true);
      expect(receivedTimeoutMs).toBeGreaterThan(0);
      expect(receivedTimeoutMs).toBeLessThanOrEqual(Math.min(commandTimeoutMs, operationTimeoutMs));
    }
  );

  it('fails before mutation when the supposedly unique generation tag already exists', async () => {
    const calls: string[][] = [];
    const sink = new WranglerControlSecretSink({
      workerName: 'test-ar-control',
      cwd: '/workspace',
      runner: async (_command, args) => {
        calls.push([...args]);
        return {
          stdout: JSON.stringify([
            {
              id: 'version-existing',
              annotations: { 'workers/tag': 'authrim-test-collision' },
            },
          ]),
        };
      },
    });

    await expect(
      sink.putGeneration(
        {
          CLOUDFLARE_D1_API_TOKEN: 'generated-d1-secret-value',
          CLOUDFLARE_WORKERS_API_TOKEN: 'generated-workers-secret-value',
        },
        'authrim-test-collision'
      )
    ).rejects.toMatchObject({ code: 'cloudflare_control_secret_generation_tag_collision' });
    expect(calls.some((args) => args.includes('bulk'))).toBe(false);
  });

  it('rejects a split or malformed active deployment as an exact generation receipt', async () => {
    const sink = new WranglerControlSecretSink({
      workerName: 'test-ar-control',
      cwd: '/workspace',
      runner: async () => ({
        stdout: JSON.stringify({
          id: 'deployment-split',
          versions: [
            { version_id: 'version-a', percentage: 50 },
            { version_id: 'version-b', percentage: 50 },
          ],
        }),
      }),
    });

    await expect(sink.readActiveGeneration()).rejects.toMatchObject({
      code: 'cloudflare_control_secret_generation_receipt_invalid',
    });
  });

  it('restores one exact immutable secret generation before a managed code redeploy', async () => {
    const calls: string[][] = [];
    let activeVersion = 'version-code';
    const sink = new WranglerControlSecretSink({
      workerName: 'test-ar-control',
      cwd: '/workspace',
      runner: async (_command, args) => {
        calls.push([...args]);
        if (args.includes('view')) {
          return { stdout: JSON.stringify({ id: 'version-secret' }) };
        }
        if (args.includes('deploy') && args.includes('version-secret@100%')) {
          activeVersion = 'version-secret';
          return { stdout: 'Deployed version-secret' };
        }
        if (args.includes('deployments') && args.includes('status')) {
          return {
            stdout: JSON.stringify({
              id: activeVersion === 'version-secret' ? 'deployment-restored' : 'deployment-code',
              versions: [{ version_id: activeVersion, percentage: 100 }],
            }),
          };
        }
        return { stdout: '' };
      },
    });

    await expect(
      sink.activateGeneration({ deploymentId: 'deployment-secret', versionId: 'version-secret' })
    ).resolves.toEqual({ deploymentId: 'deployment-restored', versionId: 'version-secret' });
    expect(calls.some((args) => args.includes('view') && args.includes('version-secret'))).toBe(
      true
    );
    expect(calls.some((args) => args.includes('version-secret@100%'))).toBe(true);
  });

  it('uses a visible Wrangler log level for JSON secret-list output', async () => {
    const sink = new WranglerControlSecretSink({
      workerName: 'test-ar-control',
      cwd: '/workspace',
      runner: async (_command, args, options) => ({
        stdout:
          args.includes('list') && options.env.WRANGLER_LOG === 'log'
            ? '[{"name":"CLOUDFLARE_WORKERS_API_TOKEN","type":"secret_text"}]'
            : '',
      }),
    });

    await expect(sink.has('CLOUDFLARE_WORKERS_API_TOKEN')).resolves.toBe(true);
  });

  it('deletes generated secrets through stdin without exposing values', async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const sink = new WranglerControlSecretSink({
      workerName: 'test-ar-control',
      cwd: '/workspace',
      runner: async (_command, args, options) => {
        calls.push({ args, input: options.input });
        return { stdout: '[]' };
      },
    });
    await sink.delete('CLOUDFLARE_D1_API_TOKEN');
    expect(calls[0]).toMatchObject({
      input: JSON.stringify({ CLOUDFLARE_D1_API_TOKEN: null }),
    });
    expect(calls[0]?.args).not.toContain('generated-secret-value');
  });
});
