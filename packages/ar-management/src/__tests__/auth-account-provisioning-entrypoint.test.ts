import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AuthAccountProvisioningInput,
  AuthPasskeyRoutePublicationInput,
  ExternalIdpRoutePublicationInput,
  Env,
} from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  resolveOperationAdapter: vi.fn(),
  execute: vi.fn(),
  hashRequest: vi.fn(),
  writeAuthoritative: vi.fn(),
  findForActor: vi.fn(),
  resolveAccountDataContext: vi.fn(),
  tenantQuery: vi.fn(),
  tenantExecute: vi.fn(),
  tenantBatch: vi.fn(),
  publishIdentifier: vi.fn(),
  removeIdentifier: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAuthCorePersistenceAdapterFromEnv: mocks.resolveOperationAdapter,
    resolveAccountDataContext: mocks.resolveAccountDataContext,
    ensureDatabaseAdapter: vi.fn(() => ({
      queryOne: mocks.tenantQuery,
      execute: mocks.tenantExecute,
      batch: mocks.tenantBatch,
    })),
  };
});

vi.mock('../account-creation-operation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../account-creation-operation')>();
  return {
    ...actual,
    hashAccountCreationRequest: mocks.hashRequest,
    AccountCreationOperationRepository: class {
      findForActor = mocks.findForActor;
    },
  };
});

vi.mock('../account-directory-producer', () => ({
  executeDurableInitialAccountDirectoryWrite: mocks.execute,
}));

vi.mock('../account-authoritative-write', () => ({
  writeCanonicalAccountAuthoritative: mocks.writeAuthoritative,
}));

vi.mock('../account-identifier-addition', () => ({
  publishAccountExternalSubjectAddition: mocks.publishIdentifier,
  publishAccountExternalSubjectRemoval: mocks.removeIdentifier,
}));

import { AuthAccountProvisioningEntrypoint } from '../auth-account-provisioning-entrypoint';

function input(
  overrides: Partial<AuthAccountProvisioningInput> = {}
): AuthAccountProvisioningInput {
  return {
    schemaVersion: 1,
    operationId: 'account-create-11111111-1111-4111-8111-111111111111',
    idempotencyKey: `auth-account:${'a'.repeat(64)}`,
    tenantId: 'tenant-a',
    candidateUserId: 'user-a',
    flow: 'email_code',
    email: 'person@example.com',
    runtimeUser: {
      active: true,
      emailVerified: false,
      userType: 'end_user',
      sourceRef: 'auth:email_code',
      piiFields: { email: true, name: true },
      sensitiveValues: { email: 'person@example.com', name: 'Person' },
      customAttributesJson: JSON.stringify({ preferred_username: 'person' }),
    },
    ...overrides,
  };
}

function passkeyRouteInput(
  overrides: Partial<AuthPasskeyRoutePublicationInput> = {}
): AuthPasskeyRoutePublicationInput {
  return {
    schemaVersion: 1,
    operationId: 'passkey-route-passkey-a',
    idempotencyKey: `auth-passkey-route:${'c'.repeat(64)}`,
    tenantId: 'tenant-a',
    accountId: 'account:user-a',
    userId: 'user-a',
    passkeyId: 'passkey-a',
    credentialId: 'credential_A-1',
    rpId: 'login.example.com',
    ...overrides,
  };
}

function anonymousInput(
  overrides: Partial<AuthAccountProvisioningInput> = {}
): AuthAccountProvisioningInput {
  const deviceIdHash = 'd'.repeat(64);
  return input({
    flow: 'anonymous',
    email: null,
    externalSubject: {
      issuer: 'urn:authrim:anonymous-device:v1',
      subject: deviceIdHash,
    },
    anonymousDevice: {
      id: `anonymous-device-${deviceIdHash.slice(0, 32)}`,
      deviceIdHash,
      installationIdHash: null,
      fingerprintHash: null,
      platform: 'web',
      stability: 'installation',
      expiresInDays: 30,
    },
    runtimeUser: {
      active: true,
      emailVerified: false,
      userType: 'anonymous',
      sourceRef: 'auth:anonymous',
      piiFields: {},
      sensitiveValues: {},
    },
    ...overrides,
  });
}

function externalIdpRouteInput(
  overrides: Partial<ExternalIdpRoutePublicationInput> = {}
): ExternalIdpRoutePublicationInput {
  return {
    schemaVersion: 1,
    operationId: 'external-idp-route-11111111111111111111111111111111',
    idempotencyKey: `auth-external-idp-route:${'e'.repeat(64)}`,
    tenantId: 'tenant-a',
    accountId: 'account:user-a',
    userId: 'user-a',
    linkedIdentityId: 'external-link-provider-a-user-a',
    providerId: 'provider-a',
    providerUserId: 'provider-user-a',
    ...overrides,
  };
}

function externalIdpInput(
  overrides: Partial<AuthAccountProvisioningInput> = {}
): AuthAccountProvisioningInput {
  return input({
    flow: 'external_idp',
    externalSubject: { issuer: 'provider-a', subject: 'provider-user-a' },
    externalIdentity: {
      id: 'external-link-provider-a-user-a',
      providerId: 'provider-a',
      providerUserId: 'provider-user-a',
      providerEmail: 'person@example.com',
      emailVerified: true,
      accessTokenEncrypted: 'encrypted-access-token',
      refreshTokenEncrypted: 'encrypted-refresh-token',
      tokenExpiresAt: 1_800_000_000_000,
      rawClaimsJson: JSON.stringify({ sub: 'provider-user-a' }),
      profileDataEncrypted: 'encrypted-jit-plan',
    },
    runtimeUser: {
      ...input().runtimeUser,
      emailVerified: true,
      sourceRef: 'auth:external_idp',
    },
    ...overrides,
  });
}

function worker(
  options: {
    props?: Record<string, unknown>;
    env?: Partial<Env>;
    directoryFactory?: ReturnType<typeof vi.fn>;
  } = {}
): AuthAccountProvisioningEntrypoint {
  return new AuthAccountProvisioningEntrypoint(
    {
      props: options.props ?? {
        caller: 'ar-auth',
        environmentId: 'test',
        audience: 'authrim-auth-account-provisioning-v1',
      },
      exports: {
        AccountDirectoryEntrypoint:
          options.directoryFactory ?? vi.fn(() => ({ publishAccountDirectory: vi.fn() })),
      },
    } as unknown as ConstructorParameters<typeof AuthAccountProvisioningEntrypoint>[0],
    {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      DEFAULT_RESIDENCY_PROFILE_ID: 'residency-policy-a',
      ...options.env,
    } as Env
  );
}

describe('AuthAccountProvisioningEntrypoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveOperationAdapter.mockResolvedValue({});
    mocks.hashRequest.mockResolvedValue('b'.repeat(64));
    mocks.writeAuthoritative.mockResolvedValue({ userId: 'user-a' });
    mocks.findForActor.mockResolvedValue({
      operationId: input().operationId,
      accountId: 'account:user-a',
      userId: 'user-a',
      status: 'directory_pending',
    });
    mocks.resolveAccountDataContext.mockResolvedValue({
      accountId: 'account:user-a',
      legacyUserId: 'user-a',
      coreDb: {},
      piiDb: {},
      membership: {
        routeProjection: {
          schemaVersion: 1,
          accountRouteGeneration: 1,
          residencyPolicyId: 'residency-policy-a',
          targets: [],
        },
      },
    });
    mocks.tenantQuery.mockResolvedValue({
      id: 'passkey-a',
      user_id: 'user-a',
      credential_id: 'credential_A-1',
      rp_id: 'login.example.com',
    });
    mocks.tenantExecute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.tenantBatch.mockResolvedValue([
      { success: true, rowsAffected: 1 },
      { success: true, rowsAffected: 1 },
    ]);
    mocks.publishIdentifier.mockResolvedValue({
      status: 201,
      operationId: 'passkey-route-passkey-a',
      accountId: 'account:user-a',
    });
    mocks.removeIdentifier.mockResolvedValue({
      status: 202,
      operationId: 'anonymous-route-remove-device-a',
      accountId: 'account:user-a',
    });
    mocks.execute.mockImplementation(async (_env, request, dependencies) => {
      await dependencies.writeAuthoritative({
        publication: { accountId: 'account:user-a' },
        tenantCoreUsers: {
          execute: mocks.tenantExecute,
          queryOne: mocks.tenantQuery,
        },
        tenantPii: {
          execute: mocks.tenantExecute,
          queryOne: mocks.tenantQuery,
        },
      });
      return {
        delivery: { status: 201 },
        operation: { operationId: request.candidateOperationId, userId: 'user-a' },
        publication: { accountId: 'account:user-a' },
      };
    });
  });

  it('exposes only a validated paginated PII shard inventory to the bridge', async () => {
    const listAccountRouteSourceShards = vi.fn().mockResolvedValue([
      {
        dataRole: 'tenant_pii',
        shardId: 'pii-apac-001',
        bindingRef: 'TDB_PII_APAC_001',
        residencyPartition: 'apac',
        routeGeneration: 3,
      },
    ]);
    const bridge = worker({
      props: {
        caller: 'ar-bridge',
        environmentId: 'test',
        audience: 'authrim-external-idp-account-provisioning-v1',
      },
      env: { CONTROL: { listAccountRouteSourceShards } as never },
    });

    await expect(
      bridge.listExternalIdpPiiSourceShards({
        schemaVersion: 1,
        afterShardId: 'pii-apac-000',
        limit: 4,
      })
    ).resolves.toEqual([
      {
        shardId: 'pii-apac-001',
        bindingRef: 'TDB_PII_APAC_001',
        residencyPartition: 'apac',
        routeGeneration: 3,
      },
    ]);
    expect(listAccountRouteSourceShards).toHaveBeenCalledWith({
      dataRole: 'tenant_pii',
      afterShardId: 'pii-apac-000',
      limit: 4,
    });
    await expect(
      bridge.listExternalIdpPiiSourceShards({
        schemaVersion: 1,
        afterShardId: null,
        limit: 4,
        dataRole: 'tenant_core/users',
      })
    ).rejects.toThrow('external_idp_pii_source_list_input_invalid');
  });

  it('rejects malformed Control shard inventory before returning it to the bridge', async () => {
    const bridge = worker({
      props: {
        caller: 'ar-bridge',
        environmentId: 'test',
        audience: 'authrim-external-idp-account-provisioning-v1',
      },
      env: {
        CONTROL: {
          listAccountRouteSourceShards: vi.fn().mockResolvedValue([
            {
              dataRole: 'tenant_pii',
              shardId: 'pii-001',
              bindingRef: 'DB',
              residencyPartition: 'default',
              routeGeneration: 1,
              providerResponse: 'must-not-cross-boundary',
            },
          ]),
        } as never,
      },
    });

    await expect(
      bridge.listExternalIdpPiiSourceShards({
        schemaVersion: 1,
        afterShardId: null,
        limit: 4,
      })
    ).rejects.toThrow('external_idp_pii_source_list_response_invalid');
  });

  it('allows only the bridge facade to provision pending external identity authority', async () => {
    const request = externalIdpInput();
    mocks.tenantQuery.mockResolvedValueOnce({
      id: request.externalIdentity?.id,
      user_id: 'user-a',
      provider_id: 'provider-a',
      provider_user_id: 'provider-user-a',
      provisioning_state: 'pending',
    });

    await expect(
      worker({
        props: {
          caller: 'ar-bridge',
          environmentId: 'test',
          audience: 'authrim-external-idp-account-provisioning-v1',
        },
      }).provisionExternalIdpAccount(request)
    ).resolves.toMatchObject({ status: 201, accountId: 'account:user-a', userId: 'user-a' });
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: 'auth:external_idp',
        externalSubject: request.externalSubject,
      }),
      expect.anything()
    );
    expect(mocks.tenantExecute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO linked_identities'),
      expect.arrayContaining([
        request.externalIdentity?.id,
        'tenant-a',
        'user-a',
        'provider-a',
        'provider-user-a',
      ])
    );

    await expect(worker().provisionExternalIdpAccount(request)).rejects.toThrow(
      'external_idp_account_provisioning_rpc_caller_unauthorized'
    );
    await expect(worker().provisionAuthAccount(request)).rejects.toThrow(
      'auth_account_provisioning_input_invalid'
    );
  });

  it('rejects an external identity whose provider subject differs from the Lookup route', async () => {
    const request = externalIdpInput({
      externalSubject: { issuer: 'provider-a', subject: 'other-subject' },
    });
    await expect(
      worker({
        props: {
          caller: 'ar-bridge',
          environmentId: 'test',
          audience: 'authrim-external-idp-account-provisioning-v1',
        },
      }).provisionExternalIdpAccount(request)
    ).rejects.toThrow('auth_account_provisioning_runtime_user_invalid');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects unauthorized and cross-environment callers before storage access', async () => {
    await expect(
      worker({
        props: {
          caller: 'ar-management',
          environmentId: 'test',
          audience: 'authrim-auth-account-provisioning-v1',
        },
      }).provisionAuthAccount(input())
    ).rejects.toThrow('auth_account_provisioning_rpc_caller_unauthorized');
    await expect(
      worker({
        props: {
          caller: 'ar-auth',
          environmentId: 'other',
          audience: 'authrim-auth-account-provisioning-v1',
        },
      }).provisionAuthAccount(input())
    ).rejects.toThrow('auth_account_provisioning_rpc_caller_unauthorized');
    expect(mocks.resolveOperationAdapter).not.toHaveBeenCalled();
  });

  it('rejects route email and authoritative PII mismatches', async () => {
    await expect(
      worker().provisionAuthAccount(
        input({
          runtimeUser: {
            ...input().runtimeUser,
            sensitiveValues: { email: 'other@example.com' },
          },
        })
      )
    ).rejects.toThrow('auth_account_provisioning_runtime_user_invalid');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects unknown PII fields and malformed encoded profile objects', async () => {
    await expect(
      worker().provisionAuthAccount(
        input({
          runtimeUser: {
            ...input().runtimeUser,
            piiFields: { email: true, unknown_field: true } as never,
          },
        })
      )
    ).rejects.toThrow('auth_account_provisioning_runtime_user_invalid');
    await expect(
      worker().provisionAuthAccount(
        input({
          runtimeUser: {
            ...input().runtimeUser,
            customAttributesJson: '[]',
          },
        })
      )
    ).rejects.toThrow('auth_account_provisioning_runtime_user_invalid');
  });

  it('uses fixed internal caller props and hashes only stable logical input', async () => {
    const directoryBinding = { publishAccountDirectory: vi.fn() };
    const directoryFactory = vi.fn(() => directoryBinding);
    const request = input();

    await expect(worker({ directoryFactory }).provisionAuthAccount(request)).resolves.toEqual({
      status: 201,
      operationId: request.operationId,
      accountId: 'account:user-a',
      userId: 'user-a',
    });

    expect(directoryFactory).toHaveBeenCalledWith({
      props: {
        caller: 'ar-management',
        environmentId: 'test',
        audience: 'authrim-account-directory-v1',
      },
    });
    expect(mocks.hashRequest).toHaveBeenCalledWith({
      schemaVersion: 1,
      tenantId: 'tenant-a',
      flow: 'email_code',
      email: 'person@example.com',
      runtimeUser: request.runtimeUser,
    });
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ ACCOUNT_DIRECTORY: directoryBinding }),
      expect.objectContaining({
        actorId: 'auth:email_code',
        idempotencyKey: request.idempotencyKey,
        requestHash: 'b'.repeat(64),
        candidateOperationId: request.operationId,
        candidateUserId: request.candidateUserId,
        residencyPolicyId: 'residency-policy-a',
        residencyPartition: 'default',
      }),
      expect.objectContaining({ writeAuthoritative: expect.any(Function) })
    );
    expect(mocks.writeAuthoritative).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeUser: request.runtimeUser })
    );
  });

  it.each(['_'.repeat(21), `-${'a'.repeat(20)}`])(
    'accepts a generated NanoID candidate beginning with a URL-safe symbol: %s',
    async (candidateUserId) => {
      await expect(
        worker().provisionAuthAccount(input({ candidateUserId }))
      ).resolves.toMatchObject({
        status: 201,
      });
      expect(mocks.execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ candidateUserId }),
        expect.anything()
      );
    }
  );

  it('does not broaden symbol-prefixed candidate IDs beyond the NanoID contract', async () => {
    await expect(
      worker().provisionAuthAccount(input({ candidateUserId: '_not-a-canonical-nanoid' }))
    ).rejects.toThrow('auth_account_provisioning_input_invalid');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('redacts unexpected downstream errors', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('raw provider or PII detail'));
    await expect(worker().provisionAuthAccount(input())).rejects.toThrow(
      'auth_account_provisioning_internal_error'
    );
  });

  it('provisions anonymous device authority without email or raw device identifiers', async () => {
    const request = anonymousInput();
    mocks.tenantQuery.mockResolvedValueOnce({
      id: request.anonymousDevice?.id,
      user_id: 'user-a',
      installation_id_hash: null,
      fingerprint_hash: null,
      device_platform: 'web',
      device_stability: 'installation',
    });

    await expect(worker().provisionAuthAccount(request)).resolves.toMatchObject({
      status: 201,
      accountId: 'account:user-a',
      userId: 'user-a',
    });
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: 'auth:anonymous',
        email: null,
        externalSubject: request.externalSubject,
      }),
      expect.anything()
    );
    expect(mocks.tenantExecute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO anonymous_devices'),
      expect.arrayContaining([
        request.anonymousDevice?.id,
        'tenant-a',
        'user-a',
        request.anonymousDevice?.deviceIdHash,
      ])
    );
  });

  it('rejects anonymous route and authority digest mismatches', async () => {
    await expect(
      worker().provisionAuthAccount(
        anonymousInput({
          externalSubject: {
            issuer: 'urn:authrim:anonymous-device:v1',
            subject: 'e'.repeat(64),
          },
        })
      )
    ).rejects.toThrow('auth_account_provisioning_runtime_user_invalid');
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('publishes only a destination-verified passkey credential route', async () => {
    await expect(worker().publishAuthPasskeyRoute(passkeyRouteInput())).resolves.toEqual({
      status: 201,
      operationId: 'passkey-route-passkey-a',
      accountId: 'account:user-a',
    });
    expect(mocks.tenantQuery).toHaveBeenCalledWith(expect.stringContaining('FROM passkeys'), [
      'passkey-a',
      'tenant-a',
      'user-a',
    ]);
    expect(mocks.publishIdentifier).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-a',
        accountId: 'account:user-a',
        externalSubject: {
          issuer: 'urn:authrim:passkey:login.example.com',
          subject: 'credential_A-1',
        },
      }),
      expect.objectContaining({ tenantCoreUsers: expect.anything() })
    );
  });

  it('publishes an external subject only after primary authority reflection', async () => {
    const request = externalIdpRouteInput();
    mocks.tenantQuery.mockResolvedValueOnce({
      id: request.linkedIdentityId,
      user_id: request.userId,
      provider_id: request.providerId,
      provider_user_id: request.providerUserId,
      provisioning_state: 'active',
    });
    mocks.publishIdentifier.mockResolvedValueOnce({
      status: 202,
      operationId: request.operationId,
      accountId: request.accountId,
    });

    await expect(
      worker({
        props: {
          caller: 'ar-bridge',
          environmentId: 'test',
          audience: 'authrim-external-idp-account-provisioning-v1',
        },
      }).publishExternalIdpRoute(request)
    ).resolves.toEqual({
      status: 202,
      operationId: request.operationId,
      accountId: request.accountId,
    });
    expect(mocks.tenantQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM linked_identities'),
      [request.linkedIdentityId, request.tenantId, request.userId],
      { consistencyClass: 'primary_required' }
    );
    expect(mocks.publishIdentifier).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: request.tenantId,
        accountId: request.accountId,
        externalSubject: {
          issuer: request.providerId,
          subject: request.providerUserId,
        },
      }),
      expect.objectContaining({ tenantCoreUsers: expect.anything() })
    );
  });

  it('rejects cross-account and unreflected external subject publication', async () => {
    const request = externalIdpRouteInput();
    mocks.resolveAccountDataContext.mockResolvedValueOnce({
      accountId: 'account:user-b',
      legacyUserId: 'user-b',
    });
    await expect(
      worker({
        props: {
          caller: 'ar-bridge',
          environmentId: 'test',
          audience: 'authrim-external-idp-account-provisioning-v1',
        },
      }).publishExternalIdpRoute(request)
    ).rejects.toThrow('external_idp_route_account_mismatch');

    mocks.resolveAccountDataContext.mockResolvedValueOnce({
      accountId: request.accountId,
      legacyUserId: request.userId,
      coreDb: {},
      piiDb: {},
      membership: { routeProjection: {} },
    });
    mocks.tenantQuery.mockResolvedValueOnce({
      id: request.linkedIdentityId,
      user_id: request.userId,
      provider_id: request.providerId,
      provider_user_id: 'different-provider-user',
      provisioning_state: 'active',
    });
    await expect(
      worker({
        props: {
          caller: 'ar-bridge',
          environmentId: 'test',
          audience: 'authrim-external-idp-account-provisioning-v1',
        },
      }).publishExternalIdpRoute(request)
    ).rejects.toThrow('external_idp_route_authority_not_found');
    expect(mocks.publishIdentifier).not.toHaveBeenCalled();
  });

  it('atomically records external route cleanup before deleting its authority', async () => {
    const request = externalIdpRouteInput({
      operationId: 'external-idp-route-remove-11111111111111111111111111111111',
      idempotencyKey: `auth-external-idp-route-remove:${'f'.repeat(64)}`,
    });
    mocks.tenantQuery
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: request.linkedIdentityId,
        user_id: request.userId,
        provider_id: request.providerId,
        provider_user_id: request.providerUserId,
        provisioning_state: 'active',
      })
      .mockResolvedValueOnce({
        state: 'pending',
        account_id: request.accountId,
        user_id: request.userId,
      })
      .mockResolvedValueOnce(null);

    await expect(
      worker({
        props: {
          caller: 'ar-bridge',
          environmentId: 'test',
          audience: 'authrim-external-idp-account-provisioning-v1',
        },
      }).removeExternalIdpRoute(request)
    ).resolves.toEqual({
      status: 202,
      operationId: request.operationId,
      accountId: request.accountId,
    });
    expect(mocks.tenantBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        sql: expect.stringContaining('INSERT INTO external_identifier_unlink_operations'),
      }),
      expect.objectContaining({ sql: expect.stringContaining('DELETE FROM linked_identities') }),
    ]);
  });

  it('rejects external route removal when active authority does not match', async () => {
    const request = externalIdpRouteInput({
      operationId: 'external-idp-route-remove-22222222222222222222222222222222',
      idempotencyKey: `auth-external-idp-route-remove:${'1'.repeat(64)}`,
    });
    mocks.tenantQuery.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: request.linkedIdentityId,
      user_id: request.userId,
      provider_id: request.providerId,
      provider_user_id: 'different-subject',
      provisioning_state: 'active',
    });

    await expect(
      worker({
        props: {
          caller: 'ar-bridge',
          environmentId: 'test',
          audience: 'authrim-external-idp-account-provisioning-v1',
        },
      }).removeExternalIdpRoute(request)
    ).rejects.toThrow('external_idp_route_removal_authority_not_found');
    expect(mocks.tenantBatch).not.toHaveBeenCalled();
  });

  it('adopts an exact external route removal after response loss', async () => {
    const request = externalIdpRouteInput({
      operationId: 'external-idp-route-remove-33333333333333333333333333333333',
      idempotencyKey: `auth-external-idp-route-remove:${'2'.repeat(64)}`,
    });
    const digest = async (value: string) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
        (byte) => byte.toString(16).padStart(2, '0')
      ).join('');
    mocks.tenantQuery
      .mockResolvedValueOnce({
        operation_id: request.operationId,
        account_id: request.accountId,
        user_id: request.userId,
        issuer_sha256: await digest(request.providerId),
        subject_sha256: await digest(request.providerUserId),
        route_projection_json: JSON.stringify({
          schemaVersion: 1,
          accountRouteGeneration: 1,
          residencyPolicyId: 'residency-policy-a',
          targets: [],
        }),
        state: 'directory_pending',
      })
      .mockResolvedValueOnce({
        state: 'directory_pending',
        account_id: request.accountId,
        user_id: request.userId,
      })
      .mockResolvedValueOnce(null);

    await expect(
      worker({
        props: {
          caller: 'ar-bridge',
          environmentId: 'test',
          audience: 'authrim-external-idp-account-provisioning-v1',
        },
      }).removeExternalIdpRoute(request)
    ).resolves.toMatchObject({ status: 202, operationId: request.operationId });
    expect(mocks.tenantBatch).not.toHaveBeenCalled();
  });

  it('returns only account-scoped external route removal status', async () => {
    mocks.tenantQuery.mockResolvedValueOnce({
      account_id: 'account:user-a',
      user_id: 'user-a',
      state: 'directory_pending',
    });
    const service = worker({
      props: {
        caller: 'ar-bridge',
        environmentId: 'test',
        audience: 'authrim-external-idp-account-provisioning-v1',
      },
    });

    await expect(
      service.getExternalIdpRouteRemovalStatus({
        schemaVersion: 1,
        tenantId: 'tenant-a',
        accountId: 'account:user-a',
        userId: 'user-a',
        operationId: 'external-idp-route-remove-11111111111111111111111111111111',
      })
    ).resolves.toEqual({
      status: 202,
      operationId: 'external-idp-route-remove-11111111111111111111111111111111',
      accountId: 'account:user-a',
    });

    mocks.resolveAccountDataContext.mockResolvedValueOnce({
      accountId: 'account:user-b',
      legacyUserId: 'user-b',
    });
    await expect(
      service.getExternalIdpRouteRemovalStatus({
        schemaVersion: 1,
        tenantId: 'tenant-a',
        accountId: 'account:user-a',
        userId: 'user-a',
        operationId: 'external-idp-route-remove-11111111111111111111111111111111',
      })
    ).rejects.toThrow('external_idp_route_removal_status_account_mismatch');
  });

  it('rejects cross-account and unreflected passkey route publication', async () => {
    await expect(
      worker().publishAuthPasskeyRoute({
        ...passkeyRouteInput(),
        accountId: 'account:other-user',
      })
    ).rejects.toThrow('auth_passkey_route_input_invalid');
    expect(mocks.resolveAccountDataContext).not.toHaveBeenCalled();

    mocks.resolveAccountDataContext.mockResolvedValueOnce({
      accountId: 'account:user-b',
      legacyUserId: 'user-b',
    });
    await expect(worker().publishAuthPasskeyRoute(passkeyRouteInput())).rejects.toThrow(
      'auth_passkey_route_account_mismatch'
    );
    expect(mocks.publishIdentifier).not.toHaveBeenCalled();

    mocks.resolveAccountDataContext.mockResolvedValueOnce({
      accountId: 'account:user-a',
      legacyUserId: 'user-a',
      coreDb: {},
      membership: { routeProjection: {} },
    });
    mocks.tenantQuery.mockResolvedValueOnce(null);
    await expect(worker().publishAuthPasskeyRoute(passkeyRouteInput())).rejects.toThrow(
      'auth_passkey_route_authority_not_found'
    );
  });

  it('removes only an inactive destination-verified anonymous device route', async () => {
    mocks.tenantQuery.mockResolvedValueOnce({
      id: 'device-a',
      user_id: 'user-a',
      device_id_hash: 'd'.repeat(64),
      is_active: 0,
    });
    await expect(
      worker().removeAuthAnonymousDeviceRoute({
        schemaVersion: 1,
        operationId: 'anonymous-route-remove-device-a',
        idempotencyKey: `auth-anonymous-route-remove:${'e'.repeat(64)}`,
        tenantId: 'tenant-a',
        accountId: 'account:user-a',
        userId: 'user-a',
        deviceId: 'device-a',
        deviceIdHash: 'd'.repeat(64),
      })
    ).resolves.toEqual({
      status: 202,
      operationId: 'anonymous-route-remove-device-a',
      accountId: 'account:user-a',
    });
    expect(mocks.removeIdentifier).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        externalSubject: {
          issuer: 'urn:authrim:anonymous-device:v1',
          subject: 'd'.repeat(64),
        },
      }),
      expect.anything()
    );

    mocks.tenantQuery.mockResolvedValueOnce({
      id: 'device-a',
      user_id: 'user-a',
      device_id_hash: 'd'.repeat(64),
      is_active: 1,
    });
    await expect(
      worker().removeAuthAnonymousDeviceRoute({
        schemaVersion: 1,
        operationId: 'anonymous-route-remove-device-a',
        idempotencyKey: `auth-anonymous-route-remove:${'e'.repeat(64)}`,
        tenantId: 'tenant-a',
        accountId: 'account:user-a',
        userId: 'user-a',
        deviceId: 'device-a',
        deviceIdHash: 'd'.repeat(64),
      })
    ).rejects.toThrow('auth_anonymous_route_removal_authority_active');
  });

  it.each([
    ['directory_pending', 'pending'],
    ['succeeded', 'ready'],
    ['blocked', 'failed'],
    ['canceled', 'failed'],
  ] as const)(
    'maps operation status %s to the public %s state',
    async (operationStatus, status) => {
      mocks.findForActor.mockResolvedValueOnce({
        operationId: input().operationId,
        accountId: 'account:user-a',
        userId: 'user-a',
        status: operationStatus,
      });

      await expect(
        worker().getAuthAccountProvisioningStatus({
          schemaVersion: 1,
          tenantId: 'tenant-a',
          operationId: input().operationId,
          flow: 'email_code',
        })
      ).resolves.toEqual({
        status,
        operationId: input().operationId,
        accountId: 'account:user-a',
        userId: 'user-a',
      });
      expect(mocks.findForActor).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        actorId: 'auth:email_code',
        operationId: input().operationId,
      });
    }
  );

  it('rejects malformed status reads before storage and hides missing operations', async () => {
    await expect(
      worker().getAuthAccountProvisioningStatus({
        schemaVersion: 1,
        tenantId: 'tenant-a',
        operationId: input().operationId,
        flow: 'email_code',
        unexpected: true,
      })
    ).rejects.toThrow('auth_account_provisioning_status_input_invalid');
    expect(mocks.findForActor).not.toHaveBeenCalled();

    mocks.findForActor.mockResolvedValueOnce(null);
    await expect(
      worker().getAuthAccountProvisioningStatus({
        schemaVersion: 1,
        tenantId: 'tenant-a',
        operationId: input().operationId,
        flow: 'email_code',
      })
    ).rejects.toThrow('auth_account_provisioning_status_not_found');
  });
});
