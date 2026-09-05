import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  source: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  target: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  admin: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  authority: vi.fn(),
  tenantGuard: vi.fn(),
  singleTenant: vi.fn(),
  singleTenantError: vi.fn(),
  audit: vi.fn(),
  beginProvisioning: vi.fn(),
  provision: vi.fn(),
  activate: vi.fn(),
  rotateSigningKey: vi.fn(),
  seedBuiltinProfileClaimSchemas: vi.fn(),
  rollback: vi.fn(),
  logger: { error: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn((_c, tenantId: string) => ({
      coreAdapter: tenantId === 'source' ? mocks.source : mocks.target,
    })),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async (_env, partition: string) =>
      partition.includes('source') ? mocks.source : mocks.target
    ),
    createAuditLog: mocks.audit,
    createAuditLogFromContext: mocks.audit,
    requireAdminDatabaseAdapter: vi.fn(() => mocks.admin),
    seedBuiltinProfileClaimSchemas: mocks.seedBuiltinProfileClaimSchemas,
    createErrorResponse: vi.fn((c, code, options) => {
      const status =
        code === actual.AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND
          ? 404
          : code === actual.AR_ERROR_CODES.INTERNAL_ERROR
            ? 500
            : 400;
      return c.json({ error: code, ...options }, status);
    }),
    getLogger: vi.fn(() => ({ module: vi.fn(() => mocks.logger) })),
  };
});

vi.mock('../tenant-alias-directory', () => ({
  resolveTenantDiscoveryAliasDirectoryInput: vi.fn(async (_env, input) => ({
    ...input,
    routeProjection: {},
  })),
  prepareTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  activateTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
  ensureActiveTenantDiscoveryAliasDirectory: vi.fn(async () => undefined),
}));

vi.mock('../admin-tenant-access', () => ({
  requirePlatformTenantManagementAuthority: mocks.authority,
}));

vi.mock('../single-tenant-guard', () => ({
  ensureSupportedTenantId: mocks.tenantGuard,
  isSingleTenantMode: mocks.singleTenant,
  createSingleTenantMutationError: mocks.singleTenantError,
}));

vi.mock('../admin-tenants', () => ({
  beginTenantProvisioning: mocks.beginProvisioning,
  formatTenantProvisioningOperation: vi.fn((operation) => operation),
  provisionTenant: mocks.provision,
  activateProvisionedTenant: mocks.activate,
  rotateProvisionedTenantSigningKey: mocks.rotateSigningKey,
  rollbackProvisionedTenant: mocks.rollback,
}));

import {
  adminTenantCloneHandler as publicAdminTenantCloneHandler,
  classifySettingsKey,
  CLIENT_CREDENTIAL_COLUMNS,
  CLIENT_NON_CREDENTIAL_COLUMNS,
  cleanupTenantCloneKvArtifacts,
  OAUTH_CLIENT_CLONE_COLUMNS,
  OAUTH_CLIENT_NON_CLONE_COLUMNS,
  prepareTenantCloneForProvisioning,
  executePreparedTenantClone,
  sanitizeClientJwks,
  sanitizeCopiedSettingsValue,
} from '../admin-tenant-clone';

function kvNamespace(initial: Record<string, string> = {}, pageSize = Number.POSITIVE_INFINITY) {
  const values = new Map(Object.entries(initial));
  const kv = {
    values,
    get: vi.fn(async (key: string | string[]) =>
      Array.isArray(key)
        ? new Map(key.map((entry) => [entry, values.get(entry) ?? null]))
        : (values.get(key) ?? null)
    ),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    list: vi.fn(async ({ prefix = '', cursor }: { prefix?: string; cursor?: string }) => {
      const matching = [...values.keys()].filter((key) => key.startsWith(prefix));
      const start = cursor ? Number(cursor) : 0;
      const keys = matching.slice(start, start + pageSize).map((name) => ({ name }));
      const next = start + keys.length;
      return next >= matching.length
        ? { list_complete: true as const, keys, cacheStatus: null }
        : { list_complete: false as const, keys, cursor: String(next), cacheStatus: null };
    }),
  };
  return kv;
}

function context(body: unknown, env: Record<string, unknown>) {
  return {
    req: {
      param: vi.fn(() => 'source'),
      json: vi.fn().mockResolvedValue(body),
    },
    env,
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

async function adminTenantCloneHandler(c: Parameters<typeof publicAdminTenantCloneHandler>[0]) {
  let requestBody: Record<string, unknown>;
  try {
    requestBody = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return publicAdminTenantCloneHandler(c);
  }
  const env = c.env as unknown as Record<string, unknown>;
  env.KEY_MANAGER ??= {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({ rotateKeysRpc: vi.fn(async () => undefined) })),
  };
  return executePreparedTenantClone(c, {
    sourceTenantId: 'source',
    requestBody: requestBody as never,
    sourceAdapter: mocks.source as never,
    targetAdapter: mocks.target as never,
    adminAdapter: mocks.admin as never,
    actorId: 'admin-actor',
  });
}

describe('admin tenant clone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const mock of [
      mocks.source.query,
      mocks.source.queryOne,
      mocks.source.execute,
      mocks.target.query,
      mocks.target.queryOne,
      mocks.target.execute,
      mocks.admin.query,
      mocks.admin.queryOne,
      mocks.admin.execute,
      mocks.audit,
    ]) {
      mock.mockReset();
    }
    mocks.authority.mockResolvedValue(null);
    mocks.tenantGuard.mockResolvedValue(null);
    mocks.singleTenant.mockReturnValue(false);
    mocks.singleTenantError.mockImplementation((c) => c.json({ error: 'single_tenant' }, 400));
    mocks.source.queryOne.mockResolvedValue({
      id: 'source',
      name: 'Source tenant',
      lifecycle_state: 'active',
      updated_at: 1,
    });
    mocks.source.query.mockResolvedValue([]);
    mocks.target.query.mockResolvedValue([]);
    mocks.target.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.admin.query.mockResolvedValue([]);
    mocks.admin.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
    mocks.audit.mockResolvedValue(undefined);
    mocks.beginProvisioning.mockResolvedValue({
      tenant: {
        id: 'destination',
        tenant_code: 'destination',
        name: 'Destination',
        description: null,
        lifecycle_state: 'provisioning',
        is_default: false,
        created_at: 1,
        updated_at: 1,
      },
      operation: {
        operationId: 'tenant_clone_destination',
        tenantId: 'destination',
        operationKind: 'clone',
        status: 'queued',
        currentStep: 'request_accepted',
        steps: [],
      },
    });
    mocks.provision.mockResolvedValue({
      ok: true,
      tenant: {
        id: 'destination',
        tenant_code: 'destination',
        name: 'Destination',
        description: null,
        lifecycle_state: 'active',
        is_default: false,
        created_at: 1,
        updated_at: 1,
      },
    });
    mocks.activate.mockResolvedValue({
      id: 'destination',
      tenant_code: 'destination',
      name: 'Destination',
      description: null,
      lifecycle_state: 'active',
      is_default: false,
      created_at: 1,
      updated_at: 2,
    });
    mocks.rotateSigningKey.mockResolvedValue(undefined);
    mocks.rollback.mockResolvedValue({ ok: true, failures: [] });
  });

  it('keeps strict rate limiting and required idempotency on the clone route', () => {
    const router = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const route = router.match(
      /app\.post\(\s*'\/api\/admin\/tenants\/:id\/clone',[\s\S]*?adminTenantCloneHandler\s*\)/
    )?.[0];
    expect(route).toBeDefined();
    expect(route).toContain("getRateLimitProfileAsync(c.env, 'strict')");
    expect(route).toContain('rateLimitMiddleware(profile)');
    expect(route).not.toContain('endpoints:');
    expect(route).toContain('failClosedOnStorageError: true');
    expect(route).toContain('reserveBeforeExecution: true');
    expect(route).toContain('redactFields: []');
  });

  it('keeps the cloned OAuth client fields aligned with the current schema', () => {
    const migrationsUrl = new URL('../../../../migrations/', import.meta.url);
    const migration = readFileSync(new URL('001_0_4_0_core_baseline.sql', migrationsUrl), 'utf8');
    const definition = migration.match(
      /CREATE TABLE oauth_clients \(([\s\S]*?)\);\nCREATE TABLE web_origin_registry/u
    )?.[1];
    expect(definition).toBeDefined();

    const schemaColumns = definition!
      .replace(/--.*$/gm, '')
      .split(',')
      .map((part) =>
        part
          .trim()
          .match(/^([a-z_][a-z0-9_]*)\s/i)?.[1]
          ?.toLowerCase()
      )
      .filter((column): column is string => Boolean(column))
      .filter(
        (column) =>
          !['tenant_id', 'created_at', 'updated_at', 'primary', 'foreign', 'unique'].includes(
            column
          )
      );
    expect(new Set([...OAUTH_CLIENT_CLONE_COLUMNS, ...OAUTH_CLIENT_NON_CLONE_COLUMNS])).toEqual(
      new Set(schemaColumns)
    );
    expect(
      OAUTH_CLIENT_CLONE_COLUMNS.filter((column) => OAUTH_CLIENT_NON_CLONE_COLUMNS.has(column))
    ).toEqual([]);
  });

  it('classifies every OAuth client column explicitly as credential or non-credential', () => {
    expect(
      [...CLIENT_CREDENTIAL_COLUMNS].filter((column) => CLIENT_NON_CREDENTIAL_COLUMNS.has(column))
    ).toEqual([]);
    expect(new Set([...CLIENT_CREDENTIAL_COLUMNS, ...CLIENT_NON_CREDENTIAL_COLUMNS])).toEqual(
      new Set(OAUTH_CLIENT_CLONE_COLUMNS)
    );
  });

  it('uses a fail-closed classification for settings categories', () => {
    const prefix = 'settings:tenant:source:';
    expect(classifySettingsKey(`${prefix}login-ui`, prefix)).toBe('safe');
    expect(classifySettingsKey(`${prefix}email-settings`, prefix)).toBe('safe');
    expect(classifySettingsKey(`${prefix}directory-connector-secret:campus`, prefix)).toBe(
      'secret'
    );
    expect(classifySettingsKey(`${prefix}saml`, prefix)).toBe('safe');
    expect(classifySettingsKey(`${prefix}future-private-config`, prefix)).toBe('unclassified');
    expect(classifySettingsKey(`${prefix}toString`, prefix)).toBe('unclassified');
  });

  it('removes destination-bound identities, keys, and uncopied resource references', () => {
    const context = {
      targetTenantId: 'destination',
      targetTenantName: 'Destination',
      includeClients: false,
    };

    expect(
      JSON.parse(
        sanitizeCopiedSettingsValue(
          'tenant',
          JSON.stringify({
            'tenant.default_id': 'source',
            'tenant.name': 'Source',
            'tenant.allowed_origins': 'https://source.example',
            'tenant.allowed_domains': 'source.example',
            'tenant.audit_profile_id': 'source-audit',
            'tenant.residency_profile_id': 'source-residency',
            'tenant.logo_uri': 'https://cdn.example/logo.svg',
          }),
          false,
          context
        )!
      )
    ).toEqual({
      'tenant.default_id': 'destination',
      'tenant.name': 'Destination',
      'tenant.logo_uri': 'https://cdn.example/logo.svg',
    });

    expect(
      JSON.parse(
        sanitizeCopiedSettingsValue(
          'tokens',
          JSON.stringify({
            'tokens.access_token_ttl': 300,
            'tokens.access_token_signing_key_id': 'source-access-key',
            'tokens.id_token_signing_key_id': 'source-id-key',
            'tokens.userinfo_signing_key_id': 'source-userinfo-key',
          }),
          false,
          context
        )!
      )
    ).toEqual({
      'tokens.access_token_ttl': 300,
      'tokens.access_token_signing_key_id': '',
      'tokens.id_token_signing_key_id': '',
      'tokens.userinfo_signing_key_id': '',
    });

    expect(
      JSON.parse(
        sanitizeCopiedSettingsValue(
          'security',
          JSON.stringify({
            'security.fapi_enabled': true,
            'security.trusted_redirect_origins': '["https://source.example"]',
          }),
          false,
          context
        )!
      )
    ).toEqual({
      'security.fapi_enabled': true,
      'security.trusted_redirect_origins': '[]',
    });

    expect(
      JSON.parse(
        sanitizeCopiedSettingsValue(
          'login-entry',
          JSON.stringify({
            'login-entry.post_login_behavior': 'app_login',
            'login-entry.app_login_client_id': 'source-client',
            'login-entry.app_login_redirect_uri': 'https://source.example/callback',
          }),
          false,
          context
        )!
      )
    ).toMatchObject({
      'login-entry.post_login_behavior': 'account',
      'login-entry.app_login_client_id': '',
      'login-entry.app_login_redirect_uri': '',
    });

    expect(
      JSON.parse(
        sanitizeCopiedSettingsValue(
          'saml',
          JSON.stringify({
            entityIdStyle: 'metadata_url',
            signingKeyPolicies: {
              idp: { active: { keyRef: 'source-key', certificate: 'source-certificate' } },
            },
            certificateSubjectAlternativeNames: {
              includeGeneratedDnsNames: false,
              dnsNames: ['source.example'],
            },
            updatedAt: 1,
          }),
          false,
          context
        )!
      )
    ).toEqual({
      entityIdStyle: 'metadata_url',
      signingKeyPolicies: {},
      certificateSubjectAlternativeNames: {
        includeGeneratedDnsNames: true,
        dnsNames: [],
      },
    });
  });

  it('disables authentication methods whose secrets or subjects are not copied', () => {
    const copied = JSON.parse(
      sanitizeCopiedSettingsValue(
        'authentication-methods',
        JSON.stringify({
          'authentication-methods.directory_password.enabled': true,
          'authentication-methods.directory_password.auto_provision': true,
          'authentication-methods.human_verification.login_enabled': true,
          'authentication-methods.totp.requirement_policy': JSON.stringify({
            mode: 'required_for_selected',
            user_ids: ['source-user'],
            group_ids: ['source-group'],
          }),
        }),
        false,
        {
          targetTenantId: 'destination',
          targetTenantName: 'Destination',
          includeClients: false,
        }
      )!
    ) as Record<string, unknown>;

    expect(copied['authentication-methods.directory_password.enabled']).toBe(false);
    expect(copied['authentication-methods.directory_password.auto_provision']).toBe(false);
    expect(copied['authentication-methods.human_verification.login_enabled']).toBe(false);
    expect(JSON.parse(String(copied['authentication-methods.totp.requirement_policy']))).toEqual({
      mode: 'required_for_selected',
      user_ids: [],
      group_ids: [],
    });
  });

  it('removes private and symmetric key material from copied client JWKS', () => {
    expect(
      JSON.parse(
        sanitizeClientJwks(
          JSON.stringify({
            keys: [
              { kty: 'RSA', kid: 'rsa', n: 'n', e: 'AQAB', d: 'private', p: 'private-p' },
              { kty: 'oct', kid: 'symmetric', k: 'secret' },
            ],
          })
        )!
      )
    ).toEqual({ keys: [{ kty: 'RSA', kid: 'rsa', n: 'n', e: 'AQAB' }] });
    expect(sanitizeClientJwks('{bad')).toBeNull();
  });

  it('copies non-secret settings and creates a distinct tenant signing key', async () => {
    const settings = kvNamespace({
      'settings:tenant:source:login-ui': '{"brand":"Source"}',
      'settings:tenant:source:certification-profile': '{"fapi":true}',
      'settings:tenant:source:directory-connector-secret:campus': '{"password":"enc"}',
    });
    const config = kvNamespace({
      'settings:tenant:source:tenant': '{"tenant.allowed_origins":"https://source.test"}',
      'test:contract:tenant:source': JSON.stringify({
        tenantId: 'source',
        version: 9,
        metadata: { createdBy: 'admin' },
      }),
    });

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination' },
        { SETTINGS: settings, AUTHRIM_CONFIG: config, ENVIRONMENT: 'test' }
      )
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(settings.values.get('settings:tenant:destination:login-ui')).toBe('{"brand":"Source"}');
    expect(settings.values.get('settings:tenant:destination:certification-profile')).toBe(
      '{"fapi":true}'
    );
    expect(
      settings.values.has('settings:tenant:destination:directory-connector-secret:campus')
    ).toBe(false);
    expect(JSON.parse(config.values.get('test:contract:tenant:destination')!)).toMatchObject({
      tenantId: 'destination',
      version: 1,
      metadata: { createdBy: 'tenant-clone', status: 'active' },
    });
    expect(body.signing_keys).toEqual({ copied: false, generated: true });
    expect(body.cloned_items).toMatchObject({ settings: 4, secret_settings_skipped: 1 });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'tenant.clone.prepared',
        tenantId: 'destination',
        resource: 'tenant',
        resourceId: 'destination',
      })
    );
  });

  it('starts the Control-plane saga instead of reserving a preallocated clone slot', async () => {
    const response = await publicAdminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { settings: false, roles: false } },
        {
          SETTINGS: kvNamespace(),
          AUTHRIM_CONFIG: kvNamespace(),
          ENVIRONMENT: 'test',
        }
      )
    );

    expect(response.status).toBe(202);
    expect(mocks.beginProvisioning).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'destination',
        operationKind: 'clone',
        sourceTenantId: 'source',
        preparationPayload: {
          copy: expect.objectContaining({ settings: false, roles: false }),
          source_snapshot: {
            tenant_updated_at: 1,
            database_version: expect.stringMatching(/^[a-f0-9]{64}$/),
            kv_version: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      })
    );
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      lifecycle_state: 'provisioning',
      provisioning: { mode: 'control-plane', operationId: 'tenant_clone_destination' },
    });
  });

  it('prepares a clone on the routed destination before Lookup activation', async () => {
    const rotateKeysRpc = vi.fn();
    const emptyStateHash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({})))
      ),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
    const result = await prepareTenantCloneForProvisioning(
      {
        DB_ADMIN: 'admin',
        TDB_DEFAULT_A: {},
        SETTINGS: kvNamespace(),
        AUTHRIM_CONFIG: kvNamespace(),
        KEY_MANAGER: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({ rotateKeysRpc })),
        },
      } as never,
      {
        operationId: 'tenant_clone_destination',
        environmentId: 'test',
        tenantId: 'destination',
        tenantCode: 'destination',
        tenantName: 'Destination',
        tenantDescription: null,
        isolationPolicy: 'tenant_exclusive',
        operationKind: 'clone',
        sourceTenantId: 'source',
        preparationPayload: {
          copy: {
            settings: false,
            secret_settings: false,
            clients: false,
            client_credentials: false,
            roles: false,
            admin_access: false,
            webhooks: false,
            webhook_secrets: false,
          },
          source_snapshot: {
            tenant_updated_at: 1,
            database_version: emptyStateHash,
            kv_version: emptyStateHash,
          },
        },
        preparationResult: null,
        residencyPolicyId: 'builtin:residency:default',
        residencyPartition: 'default',
        requestHash: 'a'.repeat(64),
        idempotencyKey: 'clone-destination',
        status: 'running',
        currentStep: 'tenant_prepare',
        capacityOperationIds: {},
        defaultRouteAllocation: null,
        attemptCount: 1,
        retryBudgetStartedAt: 1,
        nextAttemptAt: null,
        lastErrorCode: null,
        fencingToken: 1,
        createdBy: 'admin-a',
        createdAt: 1,
        startedAt: 1,
        completedAt: null,
        updatedAt: 1,
        steps: [],
      },
      {
        allocationId: 'allocation-a',
        tenantId: 'destination',
        state: 'reserved',
        target: {
          shardId: 'default-a',
          dataRole: 'tenant_core/default',
          residencyPolicyId: 'builtin:residency:default',
          residencyPartition: 'default',
          routeGeneration: 1,
          bindingRef: 'TDB_DEFAULT_A',
          databaseId: 'database-a',
          databaseName: 'database-a',
          allocationScope: 'tenant_exclusive',
          ownerTenantId: 'destination',
          assignmentGeneration: 1,
        },
      }
    );

    expect(result).toMatchObject({
      source_tenant_id: 'source',
      cloned_items: { settings: 0, clients: 0, roles: 0 },
    });
    expect(mocks.seedBuiltinProfileClaimSchemas).toHaveBeenCalledWith({
      db: mocks.target,
      tenantId: 'destination',
    });
    expect(rotateKeysRpc).toHaveBeenCalledOnce();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it('removes every clone-owned KV shape during terminal provisioning cleanup', async () => {
    const settings = kvNamespace({
      'plugins:registry': JSON.stringify({ resend: {} }),
      'settings:tenant:destination:login-ui': '{}',
      'settings:client:destination:client-a': '{}',
      'plugins:config:resend:tenant:destination': '{"apiKey":"encrypted"}',
      'plugins:enabled:resend:tenant:destination': 'true',
    });
    const config = kvNamespace({
      'settings:tenant:destination:tenant': '{}',
      'test:contract:tenant:destination': '{}',
      'test:contract:client:destination:client-a': '{}',
    });

    await cleanupTenantCloneKvArtifacts(
      { SETTINGS: settings, AUTHRIM_CONFIG: config, ENVIRONMENT: 'test' } as never,
      'destination'
    );

    expect([...settings.values.keys()]).toEqual(['plugins:registry']);
    expect([...config.values.keys()]).toEqual([]);
  });

  it('preserves destination origins instead of granting source origins', async () => {
    const config = kvNamespace({
      'settings:tenant:source:tenant': JSON.stringify({
        'tenant.allowed_origins': 'https://source.example',
        'tenant.allowed_domains': 'source.example',
        'tenant.audit_profile_id': 'source-audit',
        'tenant.residency_profile_id': 'source-residency',
      }),
      'settings:tenant:destination:tenant': JSON.stringify({
        'tenant.allowed_origins': 'https://destination.example',
        'tenant.allowed_domains': 'destination.example',
        'tenant.allowed_identifiers': 'destination',
        'tenant.audit_profile_id': 'destination-audit',
        'tenant.residency_profile_id': 'destination-residency',
      }),
    });

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination' },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: config, ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(201);
    expect(JSON.parse(config.values.get('settings:tenant:destination:tenant')!)).toMatchObject({
      'tenant.allowed_origins': 'https://destination.example',
      'tenant.allowed_domains': 'destination.example',
      'tenant.allowed_identifiers': 'destination',
      'tenant.audit_profile_id': 'destination-audit',
      'tenant.residency_profile_id': 'destination-residency',
    });
    expect(config.values.get('settings:tenant:destination:tenant')).not.toContain('source.example');
  });

  it('removes source-bound tenant identity when destination defaults are unavailable', async () => {
    const config = kvNamespace({
      'settings:tenant:source:tenant': JSON.stringify({
        'tenant.allowed_origins': 'https://source.example',
        'tenant.allowed_domains': 'source.example',
        'tenant.allowed_identifiers': 'https://source.example',
        'tenant.base_domain': 'source.example',
        'tenant.audit_profile_id': 'source-audit',
        'tenant.residency_profile_id': 'source-residency',
        'tenant.default_id': 'source',
        'tenant.name': 'Source tenant',
        'tenant.logo_uri': 'https://cdn.example/logo.svg',
      }),
    });

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination' },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: config, ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(201);
    expect(JSON.parse(config.values.get('settings:tenant:destination:tenant')!)).toEqual({
      'tenant.default_id': 'destination',
      'tenant.name': 'Destination',
      'tenant.logo_uri': 'https://cdn.example/logo.svg',
    });
  });

  it('disables copied directory connectors and skips unknown settings without secrets', async () => {
    const settings = kvNamespace({
      'settings:tenant:source:directory-connectors': JSON.stringify({
        enabled: true,
        connectors: [{ id: 'campus', enabled: true }],
      }),
      'settings:tenant:source:future-private-config': '{"token":"secret"}',
    });
    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination' },
        { SETTINGS: settings, AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );
    const body = (await response.json()) as {
      cloned_items: { unclassified_settings_skipped: number };
    };

    expect(response.status).toBe(201);
    expect(
      JSON.parse(settings.values.get('settings:tenant:destination:directory-connectors')!)
    ).toMatchObject({ enabled: false });
    expect(settings.values.has('settings:tenant:destination:future-private-config')).toBe(false);
    expect(body.cloned_items.unclassified_settings_skipped).toBe(1);
  });

  it('records preparation without activating outside the Control Plane saga', async () => {
    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination' },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(201);
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'tenant.clone.prepared', tenantId: 'destination' })
    );
  });

  it('does not activate when the clone-preparation audit cannot be persisted', async () => {
    mocks.audit.mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination' },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(500);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.rollback).not.toHaveBeenCalled();
    expect(
      mocks.target.execute.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM '))
    ).toBe(true);
  });

  it('leaves final activation and its success audit to the Control Plane saga', async () => {
    mocks.audit
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('audit unavailable'));

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination' },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(201);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.rollback).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it('omits client and webhook credentials unless explicitly selected', async () => {
    mocks.source.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM oauth_clients')) {
        return [
          {
            client_id: 'client-one',
            client_name: 'Client One',
            client_secret_hash: 'secret-hash',
            registration_access_token_hash: 'registration-hash',
            logout_webhook_secret_encrypted: 'logout-secret',
          },
        ];
      }
      if (sql.includes('FROM webhook_configs')) {
        return [
          {
            client_id: null,
            name: 'Events',
            url: 'https://example.com/hook',
            events: '["user.created"]',
            secret_encrypted: 'webhook-secret',
            headers: '{"Authorization":"Bearer secret"}',
            retry_policy: '{}',
            timeout_ms: 5000,
            active: 1,
          },
        ];
      }
      return [];
    });

    const response = await adminTenantCloneHandler(
      context(
        {
          id: 'destination',
          name: 'Destination',
          copy: { clients: true, webhooks: true },
        },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );
    expect(response.status).toBe(201);

    const clientInsert = mocks.target.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO oauth_clients')
    );
    const webhookInsert = mocks.target.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO webhook_configs')
    );
    expect(clientInsert?.[1]).not.toContain('secret-hash');
    expect(clientInsert?.[1]).not.toContain('registration-hash');
    expect(clientInsert?.[1]).not.toContain('logout-secret');
    expect(webhookInsert?.[1]).not.toContain('webhook-secret');
    expect(webhookInsert?.[1]).not.toContain('{"Authorization":"Bearer secret"}');
    expect(webhookInsert?.[1]).toContain(0);
    const clientRead = mocks.source.query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM oauth_clients')
    );
    const webhookRead = mocks.source.query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM webhook_configs')
    );
    expect(clientRead?.[0]).toContain('NULL AS client_secret_hash');
    expect(clientRead?.[0]).toContain('NULL AS registration_access_token_hash');
    expect(clientRead?.[0]).toContain('NULL AS logout_webhook_secret_encrypted');
    expect(clientRead?.[0]).toContain('agent_access_registration_mode IS NULL');
    expect(webhookRead?.[0]).toContain('NULL AS secret_encrypted, NULL AS headers');
  });

  it('reads and copies client and webhook credentials only when explicitly selected', async () => {
    mocks.source.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM oauth_clients')) {
        return [
          {
            client_id: 'client-one',
            client_secret_hash: 'secret-hash',
            registration_access_token_hash: 'registration-hash',
            logout_webhook_secret_encrypted: 'logout-secret',
          },
        ];
      }
      if (sql.includes('FROM webhook_configs')) {
        return [
          {
            client_id: null,
            scope: 'tenant',
            name: 'Events',
            url: 'https://example.com/hook',
            events: '[]',
            secret_encrypted: 'webhook-secret',
            headers: '{"Authorization":"Bearer secret"}',
            retry_policy: '{}',
            timeout_ms: 5000,
            active: 1,
          },
        ];
      }
      return [];
    });

    const response = await adminTenantCloneHandler(
      context(
        {
          id: 'destination',
          name: 'Destination',
          copy: {
            clients: true,
            client_credentials: true,
            webhooks: true,
            webhook_secrets: true,
          },
        },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(201);
    const clientRead = mocks.source.query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM oauth_clients')
    );
    const webhookRead = mocks.source.query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM webhook_configs')
    );
    expect(clientRead?.[0]).not.toContain('NULL AS client_secret_hash');
    expect(webhookRead?.[0]).toContain('secret_encrypted, headers');
    expect(
      mocks.target.execute.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO oauth_clients')
      )?.[1]
    ).toEqual(expect.arrayContaining(['secret-hash', 'registration-hash', 'logout-secret']));
    expect(
      mocks.target.execute.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO webhook_configs')
      )?.[1]
    ).toEqual(expect.arrayContaining(['webhook-secret', '{"Authorization":"Bearer secret"}', 1]));
  });

  it('copies complete client configuration and normalizes Client Contract lineage', async () => {
    mocks.source.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM oauth_clients')) {
        return [{ client_id: 'client-one', client_name: 'Client One' }];
      }
      if (sql.includes('FROM web_origin_registry')) {
        return [
          {
            client_id: 'client-one',
            origin: 'https://app.example.com',
            cors_allowed: 1,
            csp_frame_ancestors: null,
            handoff_allowed: 1,
            iframe_allowed: 0,
            environment: 'production',
            is_active: 1,
          },
        ];
      }
      if (sql.includes('FROM client_trust_policies')) {
        return [
          {
            name: 'first-party-client',
            display_name: 'First party client',
            description: null,
            target_id: 'client-one',
            first_party: 1,
            trusted: 1,
            skip_authorization_consent: 1,
            is_active: 1,
          },
        ];
      }
      return [];
    });
    const settings = kvNamespace({
      'settings:client:source:client-one:login-ui': '{"theme":"client"}',
    });
    const config = kvNamespace({
      'test:contract:client:source:client-one': JSON.stringify({
        clientId: 'client-one',
        version: 7,
        tenantContractVersion: 9,
        encryption: {
          jwks: {
            keys: [
              { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'private' },
              { kty: 'oct', k: 'symmetric-secret' },
            ],
          },
        },
        metadata: { createdBy: 'source-admin', status: 'draft' },
      }),
    });

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { clients: true } },
        { SETTINGS: settings, AUTHRIM_CONFIG: config, ENVIRONMENT: 'test' }
      )
    );
    const body = (await response.json()) as {
      cloned_items: Record<string, number>;
    };

    expect(response.status).toBe(201);
    expect(settings.values.get('settings:client:destination:client-one:login-ui')).toBe(
      '{"theme":"client"}'
    );
    const clonedContract = JSON.parse(
      config.values.get('test:contract:client:destination:client-one')!
    );
    expect(clonedContract).toMatchObject({
      clientId: 'client-one',
      version: 1,
      tenantContractVersion: 1,
      metadata: { createdBy: 'tenant-clone', status: 'active' },
    });
    expect(clonedContract.encryption.jwks.keys).toEqual([
      { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    ]);
    expect(body.cloned_items).toMatchObject({
      clients: 1,
      client_settings: 1,
      client_contracts: 1,
      client_web_origins: 1,
      client_trust_policies: 1,
    });
    expect(
      mocks.target.execute.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO web_origin_registry')
      )
    ).toBe(true);
    expect(
      mocks.target.execute.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO client_trust_policies')
      )
    ).toBe(true);
  });

  it('copies client-scoped webhooks only when the referenced client is copied', async () => {
    mocks.source.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM webhook_configs')) {
        return [
          {
            client_id: null,
            scope: 'tenant',
            name: 'Tenant events',
            url: 'https://example.com/tenant',
            events: '[]',
            secret_encrypted: null,
            headers: '{}',
            retry_policy: '{}',
            timeout_ms: 5000,
            active: 1,
          },
          {
            client_id: 'not-copied',
            scope: 'client',
            name: 'Client events',
            url: 'https://example.com/client',
            events: '[]',
            secret_encrypted: null,
            headers: '{}',
            retry_policy: '{}',
            timeout_ms: 5000,
            active: 1,
          },
        ];
      }
      return [];
    });

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { webhooks: true } },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );
    const body = (await response.json()) as {
      cloned_items: { webhooks: number; client_webhooks_skipped: number };
      warnings: string[];
    };

    expect(response.status).toBe(201);
    expect(body.cloned_items).toMatchObject({ webhooks: 1, client_webhooks_skipped: 1 });
    expect(body.warnings.some((warning) => warning.includes('client-scoped webhooks'))).toBe(true);
    expect(
      mocks.target.execute.mock.calls.filter(([sql]) =>
        String(sql).includes('INSERT INTO webhook_configs')
      )
    ).toHaveLength(1);
  });

  it('copies active Admin user permissions and remaps custom Admin roles', async () => {
    mocks.admin.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM admin_roles')) {
        return [
          {
            id: 'source-custom-role',
            name: 'support_custom',
            display_name: 'Support Custom',
            description: null,
            permissions_json: '["admin:users:read"]',
            hierarchy_level: 40,
            role_type: 'custom',
          },
        ];
      }
      if (sql.includes('FROM admin_role_assignments')) {
        return [
          {
            admin_user_id: 'admin-one',
            admin_role_id: 'source-custom-role',
            scope_type: 'tenant',
            scope_id: 'source',
            expires_at: null,
            assigned_by: 'admin-root',
            is_system: 0,
          },
          {
            admin_user_id: 'admin-two',
            admin_role_id: 'role_security_admin',
            scope_type: 'tenant',
            scope_id: 'source',
            expires_at: null,
            assigned_by: 'admin-root',
            is_system: 1,
          },
          {
            admin_user_id: 'admin-three',
            admin_role_id: 'role_security_admin',
            scope_type: 'org',
            scope_id: 'source-org',
            expires_at: null,
            assigned_by: 'admin-root',
            is_system: 1,
          },
          {
            admin_user_id: 'admin-four',
            admin_role_id: 'role_security_admin',
            scope_type: 'tenant',
            scope_id: 'other-tenant',
            expires_at: null,
            assigned_by: 'admin-root',
            is_system: 1,
          },
        ];
      }
      return [];
    });

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { admin_access: true } },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );
    const body = (await response.json()) as {
      cloned_items: {
        admin_roles: number;
        admin_role_assignments: number;
        admin_role_assignments_skipped: number;
      };
    };
    expect(response.status).toBe(201);
    expect(body.cloned_items).toMatchObject({
      admin_roles: 1,
      admin_role_assignments: 2,
      admin_role_assignments_skipped: 2,
    });

    const assignmentCalls = mocks.admin.execute.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO admin_role_assignments')
    );
    expect(assignmentCalls).toHaveLength(2);
    expect(assignmentCalls[0]?.[1]).not.toContain('source-custom-role');
    expect(assignmentCalls[0]?.[1]).toContain('destination');
    expect(assignmentCalls[1]?.[1]).toContain('role_security_admin');
    const assignmentRead = mocks.admin.query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM admin_role_assignments')
    );
    expect(Number((assignmentRead?.[1] as unknown[])[1])).toBeGreaterThan(1e12);
  });

  it('restores custom Admin role inheritance and preserves system parents', async () => {
    mocks.admin.query.mockImplementation(async (sql: string) => {
      if (sql.includes('WHERE tenant_id = ? AND is_system = 0')) {
        return [
          {
            id: 'parent-custom',
            name: 'parent',
            permissions_json: '[]',
            inherits_from: 'role_security_admin',
          },
          {
            id: 'child-custom',
            name: 'child',
            permissions_json: '[]',
            inherits_from: 'parent-custom',
          },
        ];
      }
      if (sql.includes('WHERE is_system = 1')) return [{ id: 'role_security_admin' }];
      return [];
    });

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { admin_access: true } },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(201);
    const updates = mocks.admin.execute.mock.calls.filter(([sql]) =>
      String(sql).includes('UPDATE admin_roles SET inherits_from')
    );
    expect(updates).toHaveLength(2);
    expect(
      updates.some(([, params]) => (params as unknown[]).includes('role_security_admin'))
    ).toBe(true);
    expect(updates.flatMap(([, params]) => params as unknown[])).not.toContain('parent-custom');
  });

  it('remaps role parents and omits malformed or external-scope assignment rules', async () => {
    mocks.source.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM roles WHERE tenant_id = ? AND is_system = 0')) {
        return [
          { id: 'parent', name: 'parent', permissions_json: '[]', parent_role_id: null },
          { id: 'child', name: 'child', permissions_json: '[]', parent_role_id: 'parent' },
        ];
      }
      if (sql.includes('FROM roles WHERE tenant_id = ? AND is_system = 1')) return [];
      if (sql.includes('FROM role_assignment_rules')) {
        return [
          {
            name: 'valid',
            role_id: 'child',
            scope_type: 'global',
            scope_target: '',
            conditions_json: '{"role_id":"parent"}',
            actions_json: '[{"type":"assign_role","role_id":"child"}]',
          },
          {
            name: 'malformed',
            role_id: 'child',
            scope_type: 'global',
            scope_target: '',
            conditions_json: '{bad',
            actions_json: '[]',
          },
          {
            name: 'organization',
            role_id: 'child',
            scope_type: 'org',
            scope_target: 'org:source',
            conditions_json: '{}',
            actions_json: '[]',
          },
          {
            name: 'global-with-target',
            role_id: 'child',
            scope_type: 'global',
            scope_target: 'org:source',
            conditions_json: '{}',
            actions_json: '[]',
          },
          {
            name: 'camel-case-resource-reference',
            role_id: 'child',
            scope_type: 'global',
            scope_target: '',
            conditions_json: '{"resourceId":"resource-source"}',
            actions_json: '[]',
          },
          {
            name: 'join-organization-auto',
            role_id: 'child',
            scope_type: 'global',
            scope_target: '',
            conditions_json: '{}',
            actions_json: '[{"type":"join_org","org_id":"auto"}]',
          },
          {
            name: 'tenant-scoped-action',
            role_id: 'child',
            scope_type: 'global',
            scope_target: '',
            conditions_json: '{}',
            actions_json:
              '[{"type":"assign_role","role_id":"child","scope_type":"tenant","scope_target":"source"}]',
          },
          {
            name: 'numeric-organization-reference',
            role_id: 'child',
            scope_type: 'global',
            scope_target: '',
            conditions_json: '{"organizationId":42}',
            actions_json: '[]',
          },
        ];
      }
      return [];
    });

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { roles: true } },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );
    const body = (await response.json()) as {
      cloned_items: { role_assignment_rules: number; role_assignment_rules_skipped: number };
    };

    expect(response.status).toBe(201);
    expect(body.cloned_items).toMatchObject({
      role_assignment_rules: 1,
      role_assignment_rules_skipped: 7,
    });
    const ruleInsert = mocks.target.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO role_assignment_rules')
    );
    expect(ruleInsert?.[1]).not.toContain('parent');
    expect(ruleInsert?.[1]).not.toContain('child');
    expect((ruleInsert?.[1] as unknown[]).slice(-2).every((value) => Number(value) < 1e10)).toBe(
      true
    );
  });

  it('rejects dependent secret options when their parent option is disabled', async () => {
    const response = await adminTenantCloneHandler(
      context(
        {
          id: 'destination',
          name: 'Destination',
          copy: { clients: false, client_credentials: true },
        },
        {}
      )
    );
    expect(response.status).toBe(400);
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON without provisioning a tenant', async () => {
    const c = context({}, {});
    (c as { req: { json: ReturnType<typeof vi.fn> } }).req.json.mockRejectedValue(
      new SyntaxError('Unexpected token')
    );
    const response = await adminTenantCloneHandler(c);

    expect(response.status).toBe(400);
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it('rejects a source tenant that is not active', async () => {
    mocks.source.queryOne.mockResolvedValue({
      id: 'source',
      name: 'Source tenant',
      lifecycle_state: 'suspended',
    });
    const response = await adminTenantCloneHandler(
      context({ id: 'destination', name: 'Destination' }, {})
    );

    expect(response.status).toBe(400);
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it('rejects cloning a tenant onto itself before reading source configuration', async () => {
    const response = await adminTenantCloneHandler(
      context({ id: 'source', name: 'Source copy' }, {})
    );

    expect(response.status).toBe(400);
    expect(mocks.source.queryOne).not.toHaveBeenCalled();
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it('rejects an unbounded synchronous clone before provisioning', async () => {
    mocks.source.queryOne
      .mockResolvedValueOnce({ id: 'source', name: 'Source tenant', lifecycle_state: 'active' })
      .mockResolvedValueOnce({ clients: 1001 });
    const response = await adminTenantCloneHandler(
      context({ id: 'destination', name: 'Destination', copy: { clients: true, roles: false } }, {})
    );

    expect(response.status).toBe(400);
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it('rejects an oversized KV clone before provisioning', async () => {
    const categories = [
      'oauth',
      'session',
      'security',
      'ciba',
      'rate-limit',
      'device-flow',
      'tokens',
      'feature-flags',
      'limits',
      'tenant',
      'login-ui',
    ];
    const settings = kvNamespace(
      Object.fromEntries(categories.map((category) => [`settings:tenant:source:${category}`, '{}']))
    );
    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination' },
        { SETTINGS: settings, AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(400);
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it('rejects an oversized KV value before provisioning', async () => {
    const settings = kvNamespace({
      'settings:tenant:source:login-ui': JSON.stringify({
        content: 'x'.repeat(256 * 1024),
      }),
    });
    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination' },
        { SETTINGS: settings, AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(400);
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it('rejects an oversized plugin registry before provisioning', async () => {
    const settings = kvNamespace({
      'plugins:registry': JSON.stringify({ content: 'x'.repeat(256 * 1024) }),
    });
    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination' },
        { SETTINGS: settings, AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(400);
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it('rechecks KV value size while copying and leaves the routed destination inactive', async () => {
    const settings = kvNamespace({
      'settings:tenant:source:login-ui': JSON.stringify({ content: 'small' }),
    });
    settings.get.mockImplementation(async (key: string | string[]) => {
      if (Array.isArray(key)) {
        return new Map(key.map((entry) => [entry, settings.values.get(entry) ?? null]));
      }
      if (key === 'settings:tenant:source:login-ui') {
        return JSON.stringify({ content: 'x'.repeat(256 * 1024) });
      }
      return settings.values.get(key) ?? null;
    });

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination' },
        { SETTINGS: settings, AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(500);
    expect(settings.put).not.toHaveBeenCalled();
    expect(mocks.rollback).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it('uses millisecond timestamps for cloned database records and expiry checks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'));
    const now = Date.now();
    mocks.source.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM oauth_clients')) return [{ client_id: 'client-one' }];
      return [];
    });

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { clients: true } },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );
    vi.useRealTimers();

    expect(response.status).toBe(201);
    const clientInsert = mocks.target.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO oauth_clients')
    );
    expect((clientInsert?.[1] as unknown[]).slice(-2)).toEqual([now, now]);
  });

  it('cleans the inactive destination when the source lifecycle changes during cloning', async () => {
    mocks.source.queryOne
      .mockResolvedValueOnce({ id: 'source', name: 'Source tenant', lifecycle_state: 'active' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ lifecycle_state: 'suspended' });

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { roles: false } },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(500);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.rollback).not.toHaveBeenCalled();
    expect(
      mocks.target.execute.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM '))
    ).toBe(true);
  });

  it('cleans the inactive destination when source KV settings change during cloning', async () => {
    const settings = kvNamespace({ 'settings:tenant:source:login-ui': '{"brand":"before"}' });
    let queryOneCalls = 0;
    mocks.source.queryOne.mockImplementation(async () => {
      queryOneCalls += 1;
      if (queryOneCalls === 1 || queryOneCalls === 4) {
        return {
          id: 'source',
          name: 'Source tenant',
          lifecycle_state: 'active',
          updated_at: 1,
        };
      }
      if (queryOneCalls === 3) {
        settings.values.set('settings:tenant:source:login-ui', '{"brand":"after"}');
      }
      return {};
    });

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { roles: false } },
        { SETTINGS: settings, AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(500);
    expect(mocks.activate).not.toHaveBeenCalled();
    expect(mocks.rollback).not.toHaveBeenCalled();
    expect(
      mocks.target.execute.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM '))
    ).toBe(true);
  });

  it('copies stored directory connector secrets only when explicitly selected', async () => {
    const settings = kvNamespace({
      'settings:tenant:source:directory-connector-secret:campus': '{"secret":"relay"}',
    });
    const response = await adminTenantCloneHandler(
      context(
        {
          id: 'destination',
          name: 'Destination',
          copy: { settings: true, secret_settings: true },
        },
        { SETTINGS: settings, AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(201);
    expect(
      settings.values.get('settings:tenant:destination:directory-connector-secret:campus')
    ).toBe('{"secret":"relay"}');
    const body = (await response.json()) as { warnings: string[] };
    expect(body.warnings.some((warning) => warning.includes('eventually consistent'))).toBe(true);
  });

  it('copies plugin settings from canonical and legacy tenant stores only when selected', async () => {
    const settings = kvNamespace({
      'plugins:registry': JSON.stringify({
        'notifier-resend': { id: 'notifier-resend' },
      }),
      'plugins:config:notifier-resend:tenant:source': JSON.stringify({
        _encrypted: ['apiKey'],
        apiKey: { ciphertext: 'encrypted' },
      }),
      'plugins:enabled:notifier-resend:tenant:source': 'true',
    });
    const config = kvNamespace({
      'settings:tenant:source:plugin': JSON.stringify({
        'plugin.notifier_resend_enabled': true,
      }),
    });

    const response = await adminTenantCloneHandler(
      context(
        {
          id: 'destination',
          name: 'Destination',
          copy: { settings: true, secret_settings: true },
        },
        { SETTINGS: settings, AUTHRIM_CONFIG: config, ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(201);
    expect(config.values.get('settings:tenant:destination:plugin')).toBe(
      config.values.get('settings:tenant:source:plugin')
    );
    expect(settings.values.get('plugins:config:notifier-resend:tenant:destination')).toBe(
      settings.values.get('plugins:config:notifier-resend:tenant:source')
    );
    expect(settings.values.get('plugins:enabled:notifier-resend:tenant:destination')).toBe('true');
    expect(
      settings.get.mock.calls.some(
        ([key]) =>
          Array.isArray(key) && key.includes('plugins:config:notifier-resend:tenant:source')
      )
    ).toBe(true);
  });

  it('reports plugin tenant records as skipped secrets by default', async () => {
    const settings = kvNamespace({
      'plugins:registry': JSON.stringify({
        'notifier-resend': { id: 'notifier-resend' },
      }),
      'plugins:config:notifier-resend:tenant:source': JSON.stringify({ apiKey: 'encrypted' }),
      'plugins:enabled:notifier-resend:tenant:source': 'true',
    });
    const config = kvNamespace({
      'settings:tenant:source:plugin': JSON.stringify({
        'plugin.notifier_resend_enabled': true,
      }),
    });

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination' },
        { SETTINGS: settings, AUTHRIM_CONFIG: config, ENVIRONMENT: 'test' }
      )
    );
    const body = (await response.json()) as {
      cloned_items: { secret_settings_skipped: number };
    };

    expect(response.status).toBe(201);
    expect(config.values.has('settings:tenant:destination:plugin')).toBe(false);
    expect(settings.values.has('plugins:config:notifier-resend:tenant:destination')).toBe(false);
    expect(settings.values.has('plugins:enabled:notifier-resend:tenant:destination')).toBe(false);
    expect(body.cloned_items.secret_settings_skipped).toBe(3);
  });

  it('copies every KV page', async () => {
    const settings = kvNamespace(
      {
        'settings:tenant:source:login-ui': '{"page":1}',
        'settings:tenant:source:session': '{"page":2}',
        'settings:tenant:source:security': '{"page":3}',
      },
      1
    );
    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination' },
        { SETTINGS: settings, AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(201);
    expect(settings.list).toHaveBeenCalledTimes(12);
    expect(JSON.parse(settings.values.get('settings:tenant:destination:security')!)).toEqual({
      page: 3,
      'security.trusted_redirect_origins': '[]',
    });
  });

  it('does not mutate the destination when source preflight fails', async () => {
    mocks.source.query.mockRejectedValueOnce(new Error('source D1 unavailable'));
    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { roles: true } },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );
    expect(response.status).toBe(500);
    expect(mocks.rollback).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.admin.execute).not.toHaveBeenCalled();
  });

  it('cleans partially copied Admin access when its copy step fails', async () => {
    mocks.admin.query.mockResolvedValueOnce([
      {
        id: 'custom-admin',
        name: 'custom_admin',
        permissions_json: '[]',
        is_system: 0,
      },
    ]);
    mocks.admin.execute.mockRejectedValueOnce(new Error('admin role insert failed'));

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { admin_access: true } },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(500);
    expect(
      mocks.admin.execute.mock.calls.some(([sql]) =>
        String(sql).includes('DELETE FROM admin_role_assignments')
      )
    ).toBe(true);
    expect(
      mocks.admin.execute.mock.calls.some(([sql]) =>
        String(sql).includes('DELETE FROM admin_roles')
      )
    ).toBe(true);
  });

  it('fails closed before destination mutation when source storage is unavailable', async () => {
    mocks.source.query.mockRejectedValueOnce(new Error('source D1 unavailable'));
    mocks.rollback.mockResolvedValue({
      ok: false,
      failures: ['webhook_configs', 'tenant_contract'],
    });
    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { roles: true } },
        { SETTINGS: kvNamespace(), AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(500);
    expect(mocks.rollback).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it('removes KV values written before a later clone step fails', async () => {
    const settings = kvNamespace({ 'settings:tenant:source:login-ui': '{"brand":"Source"}' });
    mocks.source.query.mockRejectedValueOnce(new Error('role copy failed'));
    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { settings: true, roles: true } },
        { SETTINGS: settings, AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(500);
    expect(settings.values.has('settings:tenant:destination:login-ui')).toBe(false);
    expect(mocks.rollback).not.toHaveBeenCalled();
  });

  it('restores destination seed settings when a later clone step fails', async () => {
    const settings = kvNamespace({
      'settings:tenant:source:login-ui': '{"brand":"Source"}',
      'settings:tenant:destination:login-ui': '{"brand":"Destination default"}',
    });
    mocks.source.query.mockRejectedValueOnce(new Error('role copy failed'));

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { settings: true, roles: true } },
        { SETTINGS: settings, AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(500);
    expect(settings.values.get('settings:tenant:destination:login-ui')).toBe(
      '{"brand":"Destination default"}'
    );
  });

  it('fails closed when a prepared KV artifact cannot be removed', async () => {
    const settings = kvNamespace({ 'settings:tenant:source:login-ui': '{"brand":"Source"}' });
    settings.delete.mockRejectedValueOnce(new Error('KV unavailable'));
    mocks.source.query.mockRejectedValueOnce(new Error('role copy failed'));

    const response = await adminTenantCloneHandler(
      context(
        { id: 'destination', name: 'Destination', copy: { settings: true, roles: true } },
        { SETTINGS: settings, AUTHRIM_CONFIG: kvNamespace(), ENVIRONMENT: 'test' }
      )
    );

    expect(response.status).toBe(500);
    expect(settings.delete).toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});
