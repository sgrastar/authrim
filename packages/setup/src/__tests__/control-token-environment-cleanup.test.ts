import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CloudflareTokenAuthorityHttpClient,
  CloudflareTokenBootstrapError,
  type CloudflareTokenAuthority,
  type CloudflareTokenPolicy,
  type CloudflareTokenRecord,
} from '../core/cloudflare-control-token-bootstrap.js';
import {
  cleanupSetupManagedControlTokens,
  loadControlTokenCleanupCheckpoint,
} from '../core/control-token-environment-cleanup.js';
import type { ControlProvisioningAuthorityState } from '../core/control-provisioning-authority.js';
import {
  stagePendingControlBootstrap,
  type PendingControlBootstrapArtifact,
} from '../core/pending-control-bootstrap.js';

const ACCOUNT_ID = 'a'.repeat(32);
const CREDENTIAL_ID = 'f'.repeat(32);
const EDIT_GROUP_ID = 'e'.repeat(32);
const D1_TOKEN_ID = '1'.repeat(32);
const WORKERS_TOKEN_ID = '2'.repeat(32);
const BOOTSTRAP_TOKEN_ID = '3'.repeat(32);
const RECOVERY_TOKEN_ID = '4'.repeat(32);
const PRIOR_RECOVERY_TOKEN_ID = '5'.repeat(32);
const BOOTSTRAP_TOKEN = 'bootstrap-token-secret-for-cleanup';
const RECOVERY_TOKEN = 'recovery-token-secret-for-cleanup';
const ENVIRONMENT = 'test';
const execFile = promisify(execFileCallback);

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
  roots = [];
});

function setupAuthority(
  overrides: Partial<ControlProvisioningAuthorityState> = {}
): ControlProvisioningAuthorityState {
  return {
    environmentId: ENVIRONMENT,
    automaticProvisioningEnabled: true,
    tokenOwnership: 'account',
    tokenManagement: 'setup',
    capabilityState: 'ready',
    capabilityCheckedAt: 100,
    bootstrapPhase: 'none',
    bootstrapTokenOwnership: 'none',
    bootstrapTokenId: null,
    bootstrapTokenFingerprint: null,
    childTokens: [
      {
        resourceClass: 'd1',
        tokenId: D1_TOKEN_ID,
        tokenName: 'irrelevant-name-d1',
        secretName: 'CLOUDFLARE_D1_API_TOKEN',
        tokenFingerprint: 'b'.repeat(64),
      },
      {
        resourceClass: 'workers',
        tokenId: WORKERS_TOKEN_ID,
        tokenName: 'irrelevant-name-workers',
        secretName: 'CLOUDFLARE_WORKERS_API_TOKEN',
        tokenFingerprint: 'c'.repeat(64),
      },
    ],
    secretGeneration: { deploymentId: 'deployment:test', versionId: 'version:test' },
    updatedAt: 100,
    ...overrides,
  };
}

function record(
  id: string,
  policies: readonly CloudflareTokenPolicy[] = []
): CloudflareTokenRecord {
  return { id, name: `token-${id.slice(0, 4)}`, status: 'active', policies };
}

function editPolicy(ownership: 'account' | 'user' = 'account'): CloudflareTokenPolicy {
  return {
    effect: 'allow',
    permission_groups: [{ id: EDIT_GROUP_ID }],
    resources:
      ownership === 'account'
        ? { [`com.cloudflare.api.account.${ACCOUNT_ID}`]: '*' }
        : { [`com.cloudflare.api.user.${'9'.repeat(32)}`]: '*' },
  };
}

function fakeAuthority(input: {
  ownership?: 'account' | 'user';
  tokenIds?: readonly string[];
  broadTokenIds?: readonly string[];
  deleteToken?: (tokenId: string) => Promise<void>;
  verifySelf?: () => Promise<{ id: string; status: 'active' | 'disabled' | 'expired' } | null>;
}) {
  const ownership = input.ownership ?? 'account';
  const inventory = new Map<string, CloudflareTokenRecord>();
  inventory.set(CREDENTIAL_ID, record(CREDENTIAL_ID, [editPolicy(ownership)]));
  const broadTokenIds = new Set(input.broadTokenIds ?? []);
  for (const tokenId of input.tokenIds ?? [D1_TOKEN_ID, WORKERS_TOKEN_ID]) {
    inventory.set(
      tokenId,
      record(tokenId, broadTokenIds.has(tokenId) ? [editPolicy(ownership)] : [])
    );
  }
  const deleted: string[] = [];
  const authority: Pick<
    CloudflareTokenAuthority,
    'verifySelf' | 'getToken' | 'listTokens' | 'listPermissionGroups' | 'deleteToken'
  > = {
    verifySelf: vi.fn(
      input.verifySelf ?? (async () => ({ id: CREDENTIAL_ID, status: 'active' as const }))
    ),
    getToken: vi.fn(async (tokenId: string) => inventory.get(tokenId) ?? null),
    listTokens: vi.fn(async () => [...inventory.values()]),
    listPermissionGroups: vi.fn(async () => [
      {
        id: EDIT_GROUP_ID,
        name: ownership === 'account' ? 'Account API Tokens Write' : 'API Tokens Write',
        scopes: [
          ownership === 'account' ? 'com.cloudflare.api.account' : 'com.cloudflare.api.user',
        ],
      },
    ]),
    deleteToken: vi.fn(async (tokenId: string) => {
      if (input.deleteToken) {
        await input.deleteToken(tokenId);
      } else if (!inventory.delete(tokenId)) {
        throw new CloudflareTokenBootstrapError('cloudflare_token_api_http_404');
      }
      deleted.push(tokenId);
    }),
  };
  return { authority, inventory, deleted };
}

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function pendingArtifact(
  overrides: Partial<PendingControlBootstrapArtifact> = {}
): PendingControlBootstrapArtifact {
  const authority = setupAuthority();
  return {
    version: 1,
    environment: ENVIRONMENT,
    accountId: ACCOUNT_ID,
    ownership: 'account',
    bootstrapToken: BOOTSTRAP_TOKEN,
    bootstrapTokenId: BOOTSTRAP_TOKEN_ID,
    bootstrapTokenFingerprint: tokenFingerprint(BOOTSTRAP_TOKEN),
    childTokens: authority.childTokens.map((child) => ({
      resourceClass: child.resourceClass,
      tokenId: child.tokenId,
      tokenName: child.tokenName,
      secretName: child.secretName,
      tokenFingerprint: child.tokenFingerprint!,
    })),
    secretGeneration: authority.secretGeneration!,
    revocationTargetTokenIds: [BOOTSTRAP_TOKEN_ID, PRIOR_RECOVERY_TOKEN_ID],
    recoveryToken: {
      token: RECOVERY_TOKEN,
      tokenId: RECOVERY_TOKEN_ID,
      tokenFingerprint: tokenFingerprint(RECOVERY_TOKEN),
    },
    revocationConfirmed: false,
    ...overrides,
  };
}

async function stagePending(
  baseDir: string,
  overrides: Partial<PendingControlBootstrapArtifact> = {}
): Promise<PendingControlBootstrapArtifact> {
  const artifact = pendingArtifact(overrides);
  await stagePendingControlBootstrap({ baseDir, artifact });
  return artifact;
}

function authorityAfterPendingWrite(
  artifact: PendingControlBootstrapArtifact,
  overrides: Partial<ControlProvisioningAuthorityState> = {}
): ControlProvisioningAuthorityState {
  return setupAuthority({
    tokenOwnership: 'none',
    capabilityState: 'pending',
    capabilityCheckedAt: null,
    bootstrapPhase: 'pending_revocation',
    bootstrapTokenOwnership: artifact.ownership,
    bootstrapTokenId: artifact.bootstrapTokenId,
    bootstrapTokenFingerprint: artifact.bootstrapTokenFingerprint,
    childTokens: artifact.childTokens,
    secretGeneration: artifact.secretGeneration,
    ...overrides,
  });
}

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'authrim-control-token-cleanup-'));
  roots.push(path);
  return path;
}

function dependencies(input: {
  authority: ReturnType<typeof fakeAuthority>['authority'];
  readAuthority?: () => Promise<ControlProvisioningAuthorityState | null>;
  authorityFactory?: (factoryInput: {
    accountId: string;
    ownership: 'account' | 'user';
    apiToken: string;
  }) => void;
}) {
  return {
    readAuthority: vi.fn(input.readAuthority ?? (async () => setupAuthority())),
    resolveAccountId: vi.fn(async () => ACCOUNT_ID),
    resolveApiToken: vi.fn(async () => 'credential-secret-not-persisted'),
    authorityFactory: (factoryInput: {
      accountId: string;
      ownership: 'account' | 'user';
      apiToken: string;
    }) => {
      input.authorityFactory?.(factoryInput);
      return input.authority;
    },
    retryDelaysMs: [0],
    wait: vi.fn(async () => undefined),
  };
}

async function persistIncompleteCheckpoint(
  baseDir: string,
  authorityState: ControlProvisioningAuthorityState = setupAuthority()
): Promise<string> {
  const fake = fakeAuthority({
    tokenIds: authorityState.childTokens.map((child) => child.tokenId),
    deleteToken: async () => {
      throw new CloudflareTokenBootstrapError('cloudflare_token_api_http_503');
    },
  });
  await expect(
    cleanupSetupManagedControlTokens({
      baseDir,
      environment: ENVIRONMENT,
      controlDatabaseName: 'test-authrim-control-db',
      dependencies: dependencies({
        authority: fake.authority,
        readAuthority: async () => authorityState,
      }),
    })
  ).rejects.toThrow('control_token_cleanup_revocation_retry_exhausted');
  return join(baseDir, '.authrim', ENVIRONMENT, 'control-token-cleanup.json');
}

function expectNoProviderAccess(fake: ReturnType<typeof fakeAuthority>): void {
  expect(fake.authority.verifySelf).not.toHaveBeenCalled();
  expect(fake.authority.getToken).not.toHaveBeenCalled();
  expect(fake.authority.deleteToken).not.toHaveBeenCalled();
}

describe('setup-managed Control token environment cleanup', () => {
  it('queries Control authority through the immutable database identifier', async () => {
    const baseDir = await root();
    const fake = fakeAuthority({});
    const deps = dependencies({
      authority: fake.authority,
      readAuthority: async () => null,
    });

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseIdentifier: 'locked-control-id',
        dependencies: deps,
      })
    ).resolves.toMatchObject({ status: 'not_required', reason: 'authority_absent' });
    expect(deps.readAuthority).toHaveBeenCalledWith({
      controlDatabaseName: 'locked-control-id',
      environmentId: ENVIRONMENT,
    });
    expectNoProviderAccess(fake);
  });

  it.each([
    [
      'account' as const,
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/tokens/permission_groups?scope=com.cloudflare.api.account`,
    ],
    [
      'user' as const,
      'https://api.cloudflare.com/client/v4/user/tokens/permission_groups?scope=com.cloudflare.api.user',
    ],
  ])(
    'queries %s-owned token permission groups through the matching authority',
    async (ownership, expectedUrl) => {
      const requested: string[] = [];
      const client = new CloudflareTokenAuthorityHttpClient({
        accountId: ACCOUNT_ID,
        ownership,
        bootstrapToken: 'credential',
        fetcher: (async (request: string | URL | Request) => {
          requested.push(String(request));
          return new Response(
            JSON.stringify({
              success: true,
              result: [{ id: EDIT_GROUP_ID, name: 'API Tokens Write', scopes: [] }],
            }),
            { status: 200 }
          );
        }) as typeof fetch,
      });

      await expect(
        client.listPermissionGroups(
          ownership === 'account' ? 'com.cloudflare.api.account' : 'com.cloudflare.api.user'
        )
      ).resolves.toHaveLength(1);
      expect(requested).toEqual([expectedUrl]);
    }
  );

  it('keeps account-scoped child permission discovery as the token client default', async () => {
    const requested: string[] = [];
    const client = new CloudflareTokenAuthorityHttpClient({
      accountId: ACCOUNT_ID,
      ownership: 'user',
      bootstrapToken: 'credential',
      fetcher: (async (request: string | URL | Request) => {
        requested.push(String(request));
        return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
      }) as typeof fetch,
    });

    await expect(client.listPermissionGroups()).resolves.toEqual([]);
    expect(requested).toEqual([
      'https://api.cloudflare.com/client/v4/user/tokens/permission_groups?scope=com.cloudflare.api.account',
    ]);
  });

  it('checkpoints exact setup-managed IDs before preflight and revokes only those IDs', async () => {
    const baseDir = await root();
    const fake = fakeAuthority({});
    const checkpointFile = join(baseDir, '.authrim', ENVIRONMENT, 'control-token-cleanup.json');
    const authorityFactory = vi.fn(() => expect(existsSync(checkpointFile)).toBe(true));
    const deps = dependencies({
      authority: fake.authority,
      authorityFactory,
    });

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: deps,
      })
    ).resolves.toMatchObject({
      status: 'completed',
      revokedTokenIds: [D1_TOKEN_ID, WORKERS_TOKEN_ID],
    });
    expect(fake.deleted).toEqual([D1_TOKEN_ID, WORKERS_TOKEN_ID]);
    expect(fake.deleted).not.toContain(CREDENTIAL_ID);
    expect(authorityFactory).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      ownership: 'account',
      apiToken: 'credential-secret-not-persisted',
    });
    const checkpoint = await loadControlTokenCleanupCheckpoint({
      baseDir,
      environment: ENVIRONMENT,
    });
    expect(checkpoint?.completedTokenIds).toEqual([D1_TOKEN_ID, WORKERS_TOKEN_ID]);
    expect(checkpoint?.authority.childTokens.map((child) => child.tokenId)).toEqual([
      D1_TOKEN_ID,
      WORKERS_TOKEN_ID,
    ]);
    const raw = await readFile(checkpointFile, 'utf8');
    expect(raw).not.toContain('credential-secret-not-persisted');
    expect(raw).not.toContain('irrelevant-name');
  });

  it('revokes pending child, bootstrap, prior-recovery, and current-recovery IDs after a pre-authority crash', async () => {
    const baseDir = await root();
    await stagePending(baseDir);
    const targetTokenIds = [
      D1_TOKEN_ID,
      WORKERS_TOKEN_ID,
      BOOTSTRAP_TOKEN_ID,
      RECOVERY_TOKEN_ID,
      PRIOR_RECOVERY_TOKEN_ID,
    ];
    const broadTokenIds = [BOOTSTRAP_TOKEN_ID, RECOVERY_TOKEN_ID, PRIOR_RECOVERY_TOKEN_ID];
    const fake = fakeAuthority({ tokenIds: targetTokenIds, broadTokenIds });

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: dependencies({
          authority: fake.authority,
          readAuthority: async () => null,
        }),
      })
    ).resolves.toMatchObject({
      status: 'completed',
      revokedTokenIds: targetTokenIds,
    });
    expect(fake.deleted).toEqual(targetTokenIds);
    const checkpoint = await loadControlTokenCleanupCheckpoint({
      baseDir,
      environment: ENVIRONMENT,
    });
    expect(checkpoint?.targetTokenIds).toEqual(targetTokenIds);
    expect(checkpoint?.broadTokenIds).toEqual(broadTokenIds);
    expect(checkpoint?.completedTokenIds).toEqual(targetTokenIds);
    const rawCheckpoint = await readFile(
      join(baseDir, '.authrim', ENVIRONMENT, 'control-token-cleanup.json'),
      'utf8'
    );
    expect(rawCheckpoint).not.toContain(BOOTSTRAP_TOKEN);
    expect(rawCheckpoint).not.toContain(RECOVERY_TOKEN);
  });

  it('strictly reconciles the pending artifact with a post-authority-write crash state', async () => {
    const baseDir = await root();
    const artifact = await stagePending(baseDir);
    const targetTokenIds = [
      D1_TOKEN_ID,
      WORKERS_TOKEN_ID,
      BOOTSTRAP_TOKEN_ID,
      RECOVERY_TOKEN_ID,
      PRIOR_RECOVERY_TOKEN_ID,
    ];
    const broadTokenIds = [BOOTSTRAP_TOKEN_ID, RECOVERY_TOKEN_ID, PRIOR_RECOVERY_TOKEN_ID];
    const fake = fakeAuthority({ tokenIds: targetTokenIds, broadTokenIds });

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: dependencies({
          authority: fake.authority,
          readAuthority: async () => authorityAfterPendingWrite(artifact),
        }),
      })
    ).resolves.toMatchObject({ status: 'completed', revokedTokenIds: targetTokenIds });
    expect(fake.deleted).toEqual(targetTokenIds);
  });

  it('resumes pending broad-token cleanup without re-deleting checkpointed IDs', async () => {
    const baseDir = await root();
    await stagePending(baseDir);
    const targetTokenIds = [
      D1_TOKEN_ID,
      WORKERS_TOKEN_ID,
      BOOTSTRAP_TOKEN_ID,
      RECOVERY_TOKEN_ID,
      PRIOR_RECOVERY_TOKEN_ID,
    ];
    const broadTokenIds = [BOOTSTRAP_TOKEN_ID, RECOVERY_TOKEN_ID, PRIOR_RECOVERY_TOKEN_ID];
    const first = fakeAuthority({
      tokenIds: targetTokenIds,
      broadTokenIds,
      deleteToken: async (tokenId) => {
        if (tokenId === RECOVERY_TOKEN_ID) {
          throw new CloudflareTokenBootstrapError('cloudflare_token_api_http_503');
        }
        first.inventory.delete(tokenId);
      },
    });
    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: dependencies({
          authority: first.authority,
          readAuthority: async () => null,
        }),
      })
    ).rejects.toThrow('control_token_cleanup_revocation_retry_exhausted');
    expect(first.deleted).toEqual([D1_TOKEN_ID, WORKERS_TOKEN_ID, BOOTSTRAP_TOKEN_ID]);

    const second = fakeAuthority({
      tokenIds: [RECOVERY_TOKEN_ID, PRIOR_RECOVERY_TOKEN_ID],
      broadTokenIds: [RECOVERY_TOKEN_ID, PRIOR_RECOVERY_TOKEN_ID],
    });
    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: null,
        dependencies: dependencies({ authority: second.authority }),
      })
    ).resolves.toMatchObject({
      status: 'completed',
      revokedTokenIds: [RECOVERY_TOKEN_ID, PRIOR_RECOVERY_TOKEN_ID],
    });
    expect(second.deleted).toEqual([RECOVERY_TOKEN_ID, PRIOR_RECOVERY_TOKEN_ID]);
    expect(second.authority.getToken).not.toHaveBeenCalledWith(D1_TOKEN_ID);
    expect(second.authority.getToken).not.toHaveBeenCalledWith(WORKERS_TOKEN_ID);
    expect(second.authority.getToken).not.toHaveBeenCalledWith(BOOTSTRAP_TOKEN_ID);
  });

  it('rejects a pending artifact whose child generation mismatches Control authority', async () => {
    const baseDir = await root();
    const original = pendingArtifact();
    await stagePending(baseDir, {
      childTokens: original.childTokens.map((child, index) =>
        index === 0 ? { ...child, tokenId: '6'.repeat(32) } : child
      ),
    });
    const fake = fakeAuthority({});

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: dependencies({
          authority: fake.authority,
          readAuthority: async () => authorityAfterPendingWrite(original),
        }),
      })
    ).rejects.toThrow('control_token_cleanup_pending_authority_mismatch_manual_recovery_required');
    expectNoProviderAccess(fake);
    await expect(
      loadControlTokenCleanupCheckpoint({ baseDir, environment: ENVIRONMENT })
    ).resolves.toBeNull();
  });

  it('rejects a forged pending artifact before authority or provider access', async () => {
    const baseDir = await root();
    await stagePending(baseDir);
    const path = join(baseDir, '.authrim', ENVIRONMENT, 'pending-control-bootstrap.json');
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    raw.forgedRevocationEvidence = 'accepted-by-old-parser';
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    const fake = fakeAuthority({});
    const readAuthority = vi.fn(async () => setupAuthority());

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: dependencies({ authority: fake.authority, readAuthority }),
      })
    ).rejects.toThrow('pending_control_bootstrap_invalid');
    expect(readAuthority).not.toHaveBeenCalled();
    expectNoProviderAccess(fake);
  });

  it('rejects a forged revocation target that is not a broad token before any deletion', async () => {
    const baseDir = await root();
    await stagePending(baseDir);
    const targetTokenIds = [
      D1_TOKEN_ID,
      WORKERS_TOKEN_ID,
      BOOTSTRAP_TOKEN_ID,
      RECOVERY_TOKEN_ID,
      PRIOR_RECOVERY_TOKEN_ID,
    ];
    const fake = fakeAuthority({
      tokenIds: targetTokenIds,
      // The forged prior-recovery ID resolves to an unrelated narrow token.
      broadTokenIds: [BOOTSTRAP_TOKEN_ID, RECOVERY_TOKEN_ID],
    });

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: dependencies({
          authority: fake.authority,
          readAuthority: async () => null,
        }),
      })
    ).rejects.toThrow('control_token_cleanup_broad_target_policy_mismatch');
    expect(fake.authority.deleteToken).not.toHaveBeenCalled();
    expect(
      (await loadControlTokenCleanupCheckpoint({ baseDir, environment: ENVIRONMENT }))
        ?.completedTokenIds
    ).toEqual([]);
  });

  it('never revokes operator-managed token evidence', async () => {
    const baseDir = await root();
    const fake = fakeAuthority({});
    const deps = dependencies({
      authority: fake.authority,
      readAuthority: async () => setupAuthority({ tokenManagement: 'operator' }),
    });

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: deps,
      })
    ).resolves.toEqual({
      status: 'not_required',
      reason: 'not_setup_managed',
      revokedTokenIds: [],
      alreadyAbsentTokenIds: [],
    });
    expect(fake.authority.deleteToken).not.toHaveBeenCalled();
    expect(fake.authority.listTokens).not.toHaveBeenCalled();
    await expect(
      loadControlTokenCleanupCheckpoint({ baseDir, environment: ENVIRONMENT })
    ).resolves.toBeNull();
  });

  it('uses the user token authority for setup-managed user-owned children', async () => {
    const baseDir = await root();
    const fake = fakeAuthority({ ownership: 'user' });
    const authorityFactory = vi.fn();

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: dependencies({
          authority: fake.authority,
          readAuthority: async () => setupAuthority({ tokenOwnership: 'user' }),
          authorityFactory,
        }),
      })
    ).resolves.toMatchObject({ status: 'completed' });
    expect(authorityFactory).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      ownership: 'user',
      apiToken: 'credential-secret-not-persisted',
    });
    expect(fake.deleted).toEqual([D1_TOKEN_ID, WORKERS_TOKEN_ID]);
  });

  it('resumes a partial checkpoint without duplicate deletion after Control D1 disappears', async () => {
    const baseDir = await root();
    const first = fakeAuthority({
      deleteToken: async (tokenId) => {
        if (tokenId === D1_TOKEN_ID) {
          first.inventory.delete(tokenId);
          return;
        }
        throw new CloudflareTokenBootstrapError('cloudflare_token_api_http_503');
      },
    });
    const firstDeps = dependencies({ authority: first.authority });
    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: firstDeps,
      })
    ).rejects.toThrow('control_token_cleanup_revocation_retry_exhausted');
    expect(first.deleted).toEqual([D1_TOKEN_ID]);
    expect(
      (await loadControlTokenCleanupCheckpoint({ baseDir, environment: ENVIRONMENT }))
        ?.completedTokenIds
    ).toEqual([D1_TOKEN_ID]);

    const second = fakeAuthority({ tokenIds: [WORKERS_TOKEN_ID] });
    const missingControlRead = vi.fn(async () => {
      throw new Error('Control D1 already missing');
    });
    const secondDeps = dependencies({
      authority: second.authority,
      readAuthority: missingControlRead,
    });
    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: null,
        dependencies: secondDeps,
      })
    ).resolves.toMatchObject({ status: 'completed', revokedTokenIds: [WORKERS_TOKEN_ID] });
    expect(missingControlRead).not.toHaveBeenCalled();
    expect(second.deleted).toEqual([WORKERS_TOKEN_ID]);
    expect(second.authority.getToken).not.toHaveBeenCalledWith(D1_TOKEN_ID);
  });

  it('fails closed if a still-present Control D1 reports a different token generation', async () => {
    const baseDir = await root();
    const first = fakeAuthority({
      deleteToken: async () => {
        throw new CloudflareTokenBootstrapError('cloudflare_token_api_http_503');
      },
    });
    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: dependencies({ authority: first.authority }),
      })
    ).rejects.toThrow('control_token_cleanup_revocation_retry_exhausted');

    const second = fakeAuthority({});
    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: dependencies({
          authority: second.authority,
          readAuthority: async () =>
            setupAuthority({
              secretGeneration: {
                deploymentId: 'deployment:test',
                versionId: 'version:replacement',
              },
            }),
        }),
      })
    ).rejects.toThrow('control_token_cleanup_authority_changed_manual_recovery_required');
    expect(second.authority.verifySelf).not.toHaveBeenCalled();
    expect(second.authority.deleteToken).not.toHaveBeenCalled();
  });

  it('rejects duplicate authority IDs before any token API access', async () => {
    const baseDir = await root();
    const fake = fakeAuthority({});
    const duplicated = setupAuthority({
      childTokens: [
        setupAuthority().childTokens[0]!,
        { ...setupAuthority().childTokens[1]!, tokenId: D1_TOKEN_ID },
      ],
    });
    const deps = dependencies({ authority: fake.authority, readAuthority: async () => duplicated });

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: deps,
      })
    ).rejects.toThrow('control_token_cleanup_checkpoint_invalid');
    expect(fake.authority.verifySelf).not.toHaveBeenCalled();
    expect(fake.authority.deleteToken).not.toHaveBeenCalled();
  });

  it('does nothing when the Control authority row is absent', async () => {
    const baseDir = await root();
    const fake = fakeAuthority({});
    const deps = dependencies({ authority: fake.authority, readAuthority: async () => null });

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: deps,
      })
    ).resolves.toMatchObject({ status: 'not_required', reason: 'authority_absent' });
    expect(fake.authority.verifySelf).not.toHaveBeenCalled();
    expect(fake.authority.deleteToken).not.toHaveBeenCalled();
  });

  it('fails closed without checkpoint evidence when Control D1 is already missing', async () => {
    const baseDir = await root();
    const fake = fakeAuthority({});
    const deps = dependencies({ authority: fake.authority });

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: null,
        dependencies: deps,
      })
    ).rejects.toThrow(
      'control_token_cleanup_checkpoint_required_for_missing_control_database_manual_recovery_required'
    );
    expect(fake.authority.listTokens).not.toHaveBeenCalled();
    expect(fake.authority.deleteToken).not.toHaveBeenCalled();
  });

  it('does not treat unauthorized token-edit preflight as success', async () => {
    const baseDir = await root();
    const fake = fakeAuthority({
      verifySelf: async () => {
        throw new CloudflareTokenBootstrapError('cloudflare_token_api_http_403');
      },
    });
    const deps = dependencies({ authority: fake.authority });

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: deps,
      })
    ).rejects.toThrow('control_token_cleanup_token_edit_credential_unauthorized');
    expect(fake.authority.deleteToken).not.toHaveBeenCalled();
    expect(
      await loadControlTokenCleanupCheckpoint({ baseDir, environment: ENVIRONMENT })
    ).not.toBeNull();
  });

  it.each([401, 403])(
    'does not treat an HTTP %s exact-ID revocation response as success',
    async (status) => {
      const baseDir = await root();
      const fake = fakeAuthority({
        deleteToken: async () => {
          throw new CloudflareTokenBootstrapError(`cloudflare_token_api_http_${status}`);
        },
      });

      await expect(
        cleanupSetupManagedControlTokens({
          baseDir,
          environment: ENVIRONMENT,
          controlDatabaseName: 'test-authrim-control-db',
          dependencies: dependencies({ authority: fake.authority }),
        })
      ).rejects.toThrow('control_token_cleanup_token_edit_credential_unauthorized');
      expect(fake.authority.deleteToken).toHaveBeenCalledTimes(1);
      expect(
        (await loadControlTokenCleanupCheckpoint({ baseDir, environment: ENVIRONMENT }))
          ?.completedTokenIds
      ).toEqual([]);
    }
  );

  it('does not infer token-edit authority from a valid credential without an edit policy', async () => {
    const baseDir = await root();
    const fake = fakeAuthority({});
    fake.inventory.set(CREDENTIAL_ID, record(CREDENTIAL_ID));

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: dependencies({ authority: fake.authority }),
      })
    ).rejects.toThrow('control_token_cleanup_token_edit_permission_required');
    expect(fake.authority.deleteToken).not.toHaveBeenCalled();
  });

  it('treats an exact-ID delete 404 as an idempotent already-absent result', async () => {
    const baseDir = await root();
    const fake = fakeAuthority({
      deleteToken: async (tokenId) => {
        fake.inventory.delete(tokenId);
        throw new CloudflareTokenBootstrapError('cloudflare_token_api_http_404');
      },
    });
    const deps = dependencies({ authority: fake.authority });

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: deps,
      })
    ).resolves.toMatchObject({
      status: 'completed',
      alreadyAbsentTokenIds: [D1_TOKEN_ID, WORKERS_TOKEN_ID],
    });
  });

  it('rejects checkpoint tampering before provider access', async () => {
    const baseDir = await root();
    const first = fakeAuthority({
      deleteToken: async () => {
        throw new CloudflareTokenBootstrapError('cloudflare_token_api_http_503');
      },
    });
    const deps = dependencies({ authority: first.authority });
    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: deps,
      })
    ).rejects.toThrow('control_token_cleanup_revocation_retry_exhausted');

    const path = join(baseDir, '.authrim', ENVIRONMENT, 'control-token-cleanup.json');
    const raw = JSON.parse(await readFile(path, 'utf8')) as { completedTokenIds: string[] };
    raw.completedTokenIds = [D1_TOKEN_ID];
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });

    const second = fakeAuthority({});
    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: null,
        dependencies: dependencies({ authority: second.authority }),
      })
    ).rejects.toThrow('control_token_cleanup_checkpoint_tampered');
    expect(second.authority.verifySelf).not.toHaveBeenCalled();
    expect(second.authority.deleteToken).not.toHaveBeenCalled();
  });

  it('rejects unrecognized checkpoint fields instead of ignoring them', async () => {
    const baseDir = await root();
    const first = fakeAuthority({
      deleteToken: async () => {
        throw new CloudflareTokenBootstrapError('cloudflare_token_api_http_503');
      },
    });
    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: 'test-authrim-control-db',
        dependencies: dependencies({ authority: first.authority }),
      })
    ).rejects.toThrow('control_token_cleanup_revocation_retry_exhausted');

    const path = join(baseDir, '.authrim', ENVIRONMENT, 'control-token-cleanup.json');
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    raw.unrecognized = 'ignored-by-old-parser';
    await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });

    await expect(
      loadControlTokenCleanupCheckpoint({ baseDir, environment: ENVIRONMENT })
    ).rejects.toThrow('control_token_cleanup_checkpoint_invalid');
  });

  it('rejects a symlinked cleanup checkpoint before provider access', async () => {
    if (process.platform === 'win32') return;
    const baseDir = await root();
    const path = await persistIncompleteCheckpoint(baseDir);
    const outside = join(baseDir, 'outside-control-token-cleanup.json');
    await writeFile(outside, await readFile(path), { mode: 0o600 });
    await rm(path);
    await symlink(outside, path);
    const fake = fakeAuthority({});

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: null,
        dependencies: dependencies({ authority: fake.authority }),
      })
    ).rejects.toThrow('control_token_cleanup_checkpoint_invalid');
    expectNoProviderAccess(fake);
  });

  it('rejects a symlinked environment config before provider access', async () => {
    if (process.platform === 'win32') return;
    const baseDir = await root();
    const environmentRoot = join(baseDir, '.authrim', ENVIRONMENT);
    await mkdir(environmentRoot, { recursive: true, mode: 0o700 });
    const outside = join(baseDir, 'outside-config.json');
    await writeFile(outside, `${JSON.stringify({ cloudflare: { accountId: ACCOUNT_ID } })}\n`, {
      mode: 0o600,
    });
    await symlink(outside, join(environmentRoot, 'config.json'));
    const fake = fakeAuthority({});

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: null,
        dependencies: dependencies({ authority: fake.authority }),
      })
    ).rejects.toThrow('control_token_cleanup_config_invalid');
    expectNoProviderAccess(fake);
  });

  it('rejects a FIFO cleanup checkpoint without hanging or reaching the provider', async () => {
    if (process.platform === 'win32') return;
    const baseDir = await root();
    const path = await persistIncompleteCheckpoint(baseDir);
    await rm(path);
    await execFile('mkfifo', [path]);
    const fake = fakeAuthority({});

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: null,
        dependencies: dependencies({ authority: fake.authority }),
      })
    ).rejects.toThrow('control_token_cleanup_checkpoint_invalid');
    expectNoProviderAccess(fake);
  });

  it('rejects an oversized cleanup checkpoint before parsing or provider access', async () => {
    const baseDir = await root();
    const path = await persistIncompleteCheckpoint(baseDir);
    await writeFile(path, 'x'.repeat(64 * 1024 + 1), { mode: 0o600 });
    const fake = fakeAuthority({});

    await expect(
      cleanupSetupManagedControlTokens({
        baseDir,
        environment: ENVIRONMENT,
        controlDatabaseName: null,
        dependencies: dependencies({ authority: fake.authority }),
      })
    ).rejects.toThrow('control_token_cleanup_checkpoint_invalid');
    expectNoProviderAccess(fake);
  });

  it('never parses a cleanup checkpoint replacement made after open', async () => {
    if (process.platform === 'win32') return;
    const baseDir = await root();
    const originalPath = await persistIncompleteCheckpoint(baseDir);
    const forgedBaseDir = await root();
    const baseAuthority = setupAuthority();
    const forgedAuthority = setupAuthority({
      childTokens: [
        { ...baseAuthority.childTokens[0]!, tokenId: '3'.repeat(32) },
        { ...baseAuthority.childTokens[1]!, tokenId: '4'.repeat(32) },
      ],
    });
    const forgedPath = await persistIncompleteCheckpoint(forgedBaseDir, forgedAuthority);
    const forgedContent = await readFile(forgedPath);
    const openedOriginalPath = join(baseDir, 'opened-control-token-cleanup.json');

    const probe = await open(originalPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      readFile: FileHandle['readFile'];
    };
    await probe.close();
    const originalReadFile = fileHandlePrototype.readFile;
    let swappedAfterOpen = false;
    const readSpy = vi
      .spyOn(fileHandlePrototype, 'readFile')
      .mockImplementationOnce(async function (this: FileHandle) {
        swappedAfterOpen = true;
        await rename(originalPath, openedOriginalPath);
        await writeFile(originalPath, forgedContent, { mode: 0o600 });
        return originalReadFile.call(this);
      });
    const fake = fakeAuthority({});
    let result: Awaited<ReturnType<typeof cleanupSetupManagedControlTokens>> | undefined;
    let failure: unknown;
    try {
      try {
        result = await cleanupSetupManagedControlTokens({
          baseDir,
          environment: ENVIRONMENT,
          controlDatabaseName: null,
          dependencies: dependencies({ authority: fake.authority }),
        });
      } catch (error) {
        failure = error;
      }
    } finally {
      readSpy.mockRestore();
    }
    expect(swappedAfterOpen).toBe(true);
    if (failure !== undefined) {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('control_token_cleanup_checkpoint_invalid');
      expectNoProviderAccess(fake);
    } else {
      expect(result).toMatchObject({
        status: 'completed',
        revokedTokenIds: [D1_TOKEN_ID, WORKERS_TOKEN_ID],
      });
      expect(fake.deleted).toEqual([D1_TOKEN_ID, WORKERS_TOKEN_ID]);
      expect(fake.deleted).not.toContain('3'.repeat(32));
      expect(fake.deleted).not.toContain('4'.repeat(32));
    }
  });
});
