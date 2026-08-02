import { describe, expect, it } from 'vitest';
import {
  bootstrapControlWorkerTokens,
  buildCloudflareBootstrapTemplateUrl,
  cleanupCloudflareBootstrapToken,
  CloudflareTokenBootstrapError,
  detectCloudflareTokenOwnership,
  selectPreferredCloudflareTokenOwnership,
  validateDirectControlTokens,
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
  capabilityProbeCalls = 0;

  constructor(bootstrapPolicy = policy({ id: 'pg-bootstrap', name: 'Account API Tokens Write' })) {
    this.records.set(BOOTSTRAP_ID, {
      id: BOOTSTRAP_ID,
      name: 'authrim-test-bootstrap',
      status: 'active',
      policies: [bootstrapPolicy],
      value: this.bootstrapValue,
    });
  }

  async verifySelf() {
    const token = this.records.get(BOOTSTRAP_ID);
    if (!token && this.loseMissingBootstrapVerifyResponse) {
      throw new Error('verify response lost');
    }
    return token ? { id: token.id, status: token.status } : null;
  }

  async getToken(tokenId: string) {
    return this.records.get(tokenId) ?? null;
  }

  async listTokens() {
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
    const record = [...this.records.values()].find((candidate) => candidate.value === token);
    return record ? { id: record.id, status: record.status } : null;
  }

  async probeIssuedToken(token: string, resourceClass: 'd1' | 'workers' | 'kv' | 'r2') {
    this.capabilityProbeCalls += 1;
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
  putCalls = 0;

  async put(secretName: Parameters<ControlSecretSink['put']>[0], value: string) {
    this.putCalls += 1;
    this.values.set(secretName, value);
    if (this.loseFirstPutResponse && this.putCalls === 1) throw new Error('response lost');
  }

  async has(secretName: string) {
    return this.values.has(secretName);
  }

  async delete(secretName: string) {
    this.deleted.push(secretName);
    this.values.delete(secretName);
  }
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
      })
    ).rejects.toMatchObject({ code: 'cloudflare_token_ownership_verification_failed' });
  });

  it('accepts only distinct direct tokens with separated account capabilities', async () => {
    const fetcher = (async (url: string | URL | Request, init?: Parameters<typeof fetch>[1]) => {
      const token = new Headers(init?.headers).get('Authorization');
      const path = String(url);
      if (path.endsWith('/user/tokens/verify')) {
        return new Response(JSON.stringify({ success: true, result: { status: 'active' } }), {
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
        return new Response(JSON.stringify({ success: true, result: { status: 'active' } }), {
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

  it('does not treat a capability probe outage as a denied cross-resource request', async () => {
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'user',
      bootstrapToken: 'bootstrap-token-value',
      fetcher: (async () => new Response('{}', { status: 503 })) as typeof fetch,
    });

    await expect(client.probeIssuedToken('child-token-value', 'kv')).rejects.toMatchObject({
      code: 'cloudflare_token_capability_probe_unavailable',
    });
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

  it('reconciles a lost child-create response by deleting the unknown named token', async () => {
    const authority = new FakeAuthority();
    authority.loseFirstCreateResponse = true;
    const result = await bootstrapControlWorkerTokens({
      accountId: ACCOUNT_ID,
      environment: 'test',
      ownership: 'account',
      authority,
      secretSink: new FakeSecretSink(),
    });
    expect(result.bootstrapRevoked).toBe(true);
    expect(authority.createCalls).toBe(3);
    expect(authority.deleted).toContain('2'.repeat(32));
  });

  it('accepts a lost secret response only after confirming the secret exists', async () => {
    const sink = new FakeSecretSink();
    sink.loseFirstPutResponse = true;
    await expect(
      bootstrapControlWorkerTokens({
        accountId: ACCOUNT_ID,
        environment: 'test',
        ownership: 'account',
        authority: new FakeAuthority(),
        secretSink: sink,
      })
    ).resolves.toMatchObject({ bootstrapRevoked: true });
    expect(sink.putCalls).toBe(2);
  });

  it('accepts a lost bootstrap-delete response only after verification fails closed', async () => {
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
    ).resolves.toMatchObject({ bootstrapRevoked: true });
  });

  it('does not accept bootstrap revocation when the verification response is lost', async () => {
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
    ).rejects.toMatchObject({ cleanupRequired: true });
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
          result_info: { page: 1, per_page: 50, total_count: records.size },
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
            result_info: { page: 1, per_page: 50, total_count: 1 },
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
            id: `${page}${index}`.padEnd(32, '0').slice(0, 32),
            name: page === 2 ? 'target-token' : `token-${index}`,
            status: 'active',
            policies: [],
          })),
          result_info: { page, per_page: 50, total_count: 51 },
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

  it('propagates bootstrap verification transport loss instead of treating it as revoked', async () => {
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'account',
      bootstrapToken: 'bootstrap-token-value',
      fetcher: (async () => {
        throw new Error('network down');
      }) as typeof fetch,
    });

    await expect(client.verifySelf()).rejects.toMatchObject({
      code: 'cloudflare_token_api_response_lost',
    });
  });

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

  it('cleans child tokens and secrets when authority projection fails before revocation', async () => {
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
    ).rejects.toMatchObject({ code: 'cloudflare_token_bootstrap_failed' });
    expect(authority.records.size).toBe(0);
    expect(authority.deleted).toContain(BOOTSTRAP_ID);
    expect(sink.values.size).toBe(0);
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

  it('cleans child tokens and Control secrets when child identity is reused', async () => {
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
    ).rejects.toMatchObject({ code: 'cloudflare_child_tokens_not_distinct' });
    expect(authority.deleted).toContain(BOOTSTRAP_ID);
    expect(authority.records.size).toBe(0);
    expect(sink.values.size).toBe(0);
  });

  it('reports explicit cleanup when revocation remains active', async () => {
    const authority = new FakeAuthority();
    authority.leaveDeletedTokenActive = true;
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

  it('passes generated secrets through stdin rather than command arguments', async () => {
    const calls: Array<{
      args: readonly string[];
      input?: string;
      logLevel?: string;
    }> = [];
    const sink = new WranglerControlSecretSink({
      workerName: 'test-ar-control',
      cwd: '/workspace',
      runner: async (_command, args, options) => {
        calls.push({ args, input: options.input, logLevel: options.env.WRANGLER_LOG });
        if (args.includes('list')) {
          return { stdout: '[{"name":"CLOUDFLARE_D1_API_TOKEN","type":"secret_text"}]' };
        }
        return { stdout: '' };
      },
    });
    await sink.put('CLOUDFLARE_D1_API_TOKEN', 'generated-secret-value');
    await expect(sink.has('CLOUDFLARE_D1_API_TOKEN')).resolves.toBe(true);
    expect(calls[0]?.input).toBe('generated-secret-value');
    expect(calls[0]?.args.join(' ')).not.toContain('generated-secret-value');
    expect(calls[0]?.logLevel).toBe('warn');
    expect(calls[1]?.logLevel).toBe('log');
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
