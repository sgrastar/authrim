import { describe, expect, it } from 'vitest';
import {
  buildResourceIdsFromLock,
  generateRoutes,
  generateWranglerConfig,
  parseWranglerToml,
  toToml,
} from '../core/wrangler.js';
import { createDefaultConfig } from '../core/config.js';
import type { AuthrimConfig } from '../core/config.js';
import type { AuthrimLock } from '../core/lock.js';
import { WORKER_COMPONENTS, getRequiredDataRolesForComponent } from '../core/naming.js';

describe('Worker placement generation', () => {
  it('defaults to off and permits an explicit Smart Placement experiment', () => {
    const config = createDefaultConfig('test');
    config.urls = {
      api: { custom: null, auto: 'https://test-ar-router.example.workers.dev' },
      loginUi: {
        custom: null,
        auto: 'https://test-ar-login-ui.example.workers.dev',
        sameAsApi: false,
      },
      adminUi: {
        custom: null,
        auto: 'https://test-ar-admin-ui.example.workers.dev',
        sameAsApi: false,
      },
    };
    expect(generateWranglerConfig('ar-management', config, { d1: {}, kv: {} }).placement).toEqual({
      mode: 'off',
    });
    expect(
      generateWranglerConfig('ar-management', config, { d1: {}, kv: {} }, undefined, {
        placementMode: 'smart',
      }).placement
    ).toEqual({ mode: 'smart' });
  });

  it('enables same-Worker loopback RPC exports only for ar-management', () => {
    const config = createDefaultConfig('test');
    config.urls = {
      api: { custom: null, auto: 'https://test-ar-router.example.workers.dev' },
      loginUi: {
        custom: null,
        auto: 'https://test-ar-login-ui.example.workers.dev',
        sameAsApi: false,
      },
      adminUi: {
        custom: null,
        auto: 'https://test-ar-admin-ui.example.workers.dev',
        sameAsApi: false,
      },
    };
    const resources = { d1: {}, kv: {} };

    expect(generateWranglerConfig('ar-management', config, resources).compatibility_flags).toEqual([
      'nodejs_compat',
      'enable_ctx_exports',
    ]);
    expect(generateWranglerConfig('ar-auth', config, resources).compatibility_flags).toEqual([
      'nodejs_compat',
    ]);
  });
});

describe('generateRoutes', () => {
  it('exposes protected customer profile routes on ar-userinfo', () => {
    const routes = generateRoutes('ar-userinfo', 'auth.example.com', 'example.com');

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pattern: 'auth.example.com/userinfo',
          zone_name: 'example.com',
        }),
        expect.objectContaining({
          pattern: 'auth.example.com/api/protected/customer-profiles/*',
          zone_name: 'example.com',
        }),
      ])
    );
  });

  it('exposes SAML and GakuNin/Shibboleth SAML2 compatibility routes on ar-saml', () => {
    const routes = generateRoutes('ar-saml', 'conformance.authrim.com', 'authrim.com');

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pattern: 'conformance.authrim.com/saml/*',
          zone_name: 'authrim.com',
        }),
        expect.objectContaining({
          pattern: 'conformance.authrim.com/idp/profile/SAML2/POST/SSO',
          zone_name: 'authrim.com',
        }),
        expect.objectContaining({
          pattern: 'conformance.authrim.com/idp/profile/SAML2/Redirect/SSO',
          zone_name: 'authrim.com',
        }),
        expect.objectContaining({
          pattern: 'conformance.authrim.com/idp/profile/SAML2/POST/SLO',
          zone_name: 'authrim.com',
        }),
        expect.objectContaining({
          pattern: 'conformance.authrim.com/idp/profile/SAML2/Redirect/SLO',
          zone_name: 'authrim.com',
        }),
      ])
    );
  });

  it('adds auth and management service bindings for email and external IdP flows', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'emailtest' },
      urls: {
        api: {
          custom: null,
          auto: 'https://emailtest-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://emailtest-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://emailtest-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Default Tenant',
        placementPolicy: 'tenant_exclusive',
        multiTenant: false,
        userIdFormat: 'nanoid',
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: true,
        policy: true,
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: {
          provider: 'cloudflare',
          fromAddress: 'noreply@example.com',
          fromName: 'Authrim',
          configured: true,
        },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      controlPlane: { automaticProvisioning: true },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const resourceIds = {
      d1: {},
      kv: {},
    };

    const authConfig = generateWranglerConfig('ar-auth', config, resourceIds);
    const libCoreConfig = generateWranglerConfig('ar-lib-core', config, resourceIds);
    const managementConfig = generateWranglerConfig('ar-management', config, resourceIds);
    const tokenConfig = generateWranglerConfig('ar-token', config, resourceIds);
    const discoveryConfig = generateWranglerConfig('ar-discovery', config, resourceIds);
    const vcConfig = generateWranglerConfig('ar-vc', config, resourceIds);
    const agentAccessConfig = generateWranglerConfig('ar-agent-access', config, resourceIds);
    const bridgeConfig = generateWranglerConfig('ar-bridge', config, resourceIds);
    const samlConfig = generateWranglerConfig('ar-saml', config, resourceIds);
    const routerConfig = generateWranglerConfig('ar-router', config, resourceIds);

    for (const challengeStoreConsumer of [authConfig, managementConfig, samlConfig, bridgeConfig]) {
      expect(challengeStoreConsumer.vars.AUTHRIM_CHALLENGE_SHARDS).toBe('4');
    }

    expect(authConfig.durable_objects?.bindings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'VERSION_MANAGER' })])
    );
    expect(tokenConfig.durable_objects?.bindings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'VERSION_MANAGER' })])
    );
    expect(managementConfig.durable_objects?.bindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'VERSION_MANAGER' })])
    );
    expect(managementConfig.triggers).toEqual({
      crons: ['* * * * *', '*/2 * * * *', '*/5 * * * *', '0 */6 * * *'],
    });

    expect(tokenConfig.durable_objects?.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'SESSION_REVOCATION_STORE',
          class_name: 'SessionRevocationStore',
          script_name: 'emailtest-ar-lib-core',
        }),
        expect.objectContaining({ name: 'DEVICE_CODE_STORE' }),
        expect.objectContaining({ name: 'CIBA_REQUEST_STORE' }),
      ])
    );
    expect(authConfig.durable_objects?.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'DIRECTORY_CONNECTOR_RELAY',
          class_name: 'DirectoryConnectorRelay',
        }),
      ])
    );
    expect(bridgeConfig.durable_objects?.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'KEY_MANAGER', script_name: 'emailtest-ar-lib-core' }),
        expect.objectContaining({
          name: 'SESSION_REVOCATION_STORE',
          class_name: 'SessionRevocationStore',
          script_name: 'emailtest-ar-lib-core',
        }),
      ])
    );
    expect(authConfig.migrations?.[0]?.new_sqlite_classes).toContain('DirectoryConnectorRelay');
    expect(vcConfig.durable_objects?.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'RATE_LIMITER', script_name: 'emailtest-ar-lib-core' }),
        expect.objectContaining({
          name: 'CREDENTIAL_OFFER_STORE',
          class_name: 'CredentialOfferStoreV2',
        }),
        expect.objectContaining({ name: 'VP_REQUEST_STORE', class_name: 'VPRequestStoreV2' }),
      ])
    );
    expect(vcConfig.migrations?.[0]?.new_sqlite_classes).toEqual([
      'CredentialOfferStore',
      'VPRequestStore',
    ]);
    expect(vcConfig.migrations?.[1]?.new_sqlite_classes).toEqual(['CredentialOfferStoreV2']);
    expect(vcConfig.migrations?.[2]?.new_sqlite_classes).toEqual(['VPRequestStoreV2']);
    expect(vcConfig.vars.VC_TRANSACTION_CODE_HMAC_SECRET).toBe('');
    expect(vcConfig.vars.VC_EVIDENCE_HMAC_SECRET).toBe('');
    expect(vcConfig.vars.VC_PROFILE_CONTRACT_HMAC_SECRET).toBe('');
    expect(vcConfig.vars.VC_ATTRIBUTE_ELEVATION_AUDIENCE).toBe('svc://op-vc/attribute-elevation');
    expect(managementConfig.vars.VC_PROFILE_CONTRACT_HMAC_SECRET).toBe('');
    expect(managementConfig.durable_objects?.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'DIRECTORY_CONNECTOR_RELAY',
          class_name: 'DirectoryConnectorRelay',
          script_name: 'emailtest-ar-auth',
        }),
      ])
    );
    expect(authConfig.send_email).toBeUndefined();
    expect(managementConfig.send_email).toBeUndefined();
    expect(authConfig.services).toEqual([
      { binding: 'EXTERNAL_IDP', service: 'emailtest-ar-bridge' },
      {
        binding: 'ACCOUNT_PROVISIONER',
        service: 'emailtest-ar-management',
        entrypoint: 'AuthAccountProvisioningEntrypoint',
        props: {
          caller: 'ar-auth',
          environmentId: 'emailtest',
          audience: 'authrim-auth-account-provisioning-v1',
        },
      },
      {
        binding: 'PLUGIN_RUNNER',
        service: 'emailtest-ar-plugin-runner',
        props: {
          caller: 'ar-auth',
          environmentId: 'emailtest',
          audience: 'authrim-plugin-runner-v1',
        },
      },
    ]);
    expect(bridgeConfig.services).toEqual([
      {
        binding: 'EXTERNAL_IDP_ACCOUNT_PROVISIONER',
        service: 'emailtest-ar-management',
        entrypoint: 'AuthAccountProvisioningEntrypoint',
        props: {
          caller: 'ar-bridge',
          environmentId: 'emailtest',
          audience: 'authrim-external-idp-account-provisioning-v1',
        },
      },
      {
        binding: 'PLUGIN_RUNNER',
        service: 'emailtest-ar-plugin-runner',
        props: {
          caller: 'ar-bridge',
          environmentId: 'emailtest',
          audience: 'authrim-plugin-runner-v1',
        },
      },
    ]);
    const bootstrapBridgeConfig = generateWranglerConfig(
      'ar-bridge',
      config,
      resourceIds,
      undefined,
      { includeExternalIdpAccountProvisioner: false }
    );
    expect(bootstrapBridgeConfig.services).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: 'EXTERNAL_IDP_ACCOUNT_PROVISIONER' }),
      ])
    );
    expect(bootstrapBridgeConfig.services).toEqual(
      bridgeConfig.services?.filter(
        (service) => service.binding !== 'EXTERNAL_IDP_ACCOUNT_PROVISIONER'
      )
    );
    const bootstrapAuthConfig = generateWranglerConfig('ar-auth', config, resourceIds, undefined, {
      includeAuthAccountProvisioner: false,
    });
    expect(bootstrapAuthConfig.services).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ binding: 'ACCOUNT_PROVISIONER' })])
    );
    expect(bootstrapAuthConfig.services).toEqual(
      authConfig.services?.filter((service) => service.binding !== 'ACCOUNT_PROVISIONER')
    );
    expect(managementConfig.services).toEqual([
      { binding: 'EXTERNAL_IDP', service: 'emailtest-ar-bridge' },
      {
        binding: 'CONTROL',
        service: 'emailtest-ar-control',
        props: {
          caller: 'ar-management',
          environmentId: 'emailtest',
          audience: 'authrim-control-v1',
        },
      },
      {
        binding: 'PLUGIN_RUNNER',
        service: 'emailtest-ar-plugin-runner',
        props: {
          caller: 'ar-management',
          environmentId: 'emailtest',
          audience: 'authrim-plugin-runner-v1',
        },
      },
    ]);
    expect(toToml(managementConfig, 'emailtest')).toContain(
      'props = { audience = "authrim-control-v1", caller = "ar-management", environmentId = "emailtest" }'
    );
    expect(toToml(managementConfig, 'emailtest')).not.toContain(
      'entrypoint = "VCIssuerEntrypoint"'
    );
    const vcEnabledManagement = generateWranglerConfig(
      'ar-management',
      { ...config, components: { ...config.components, vc: true } },
      resourceIds
    );
    expect(vcEnabledManagement.services).toContainEqual({
      binding: 'VC_ISSUER',
      service: 'emailtest-ar-vc',
      entrypoint: 'VCIssuerEntrypoint',
    });
    expect(discoveryConfig.durable_objects?.bindings ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'KEY_MANAGER' })])
    );
    expect(discoveryConfig.services).toEqual([
      {
        binding: 'KEY_MANAGER_PUBLIC',
        service: 'emailtest-ar-lib-core',
        entrypoint: 'KeyManagerPublicEntrypoint',
      },
    ]);
    expect(toToml(discoveryConfig, 'emailtest')).toContain(
      'entrypoint = "KeyManagerPublicEntrypoint"'
    );
    expect(tokenConfig.send_email).toBeUndefined();
    expect(agentAccessConfig.main).toBe('src/platform/cloudflare/worker.ts');
    expect(agentAccessConfig.vars.AUTHRIM_ENVIRONMENT_NAME).toBe('emailtest');
    expect(discoveryConfig.vars.AUTHRIM_ENVIRONMENT_NAME).toBe('emailtest');
    expect(agentAccessConfig.durable_objects?.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'AGENT_ACCESS_MCP',
          class_name: 'AgentAccessMcpAgent',
        }),
        expect.objectContaining({
          name: 'DPOP_JTI_STORE',
          script_name: 'emailtest-ar-lib-core',
        }),
      ])
    );
    expect(agentAccessConfig.migrations?.[0]).toMatchObject({
      tag: 'ar-agent-access-local-v1',
      new_sqlite_classes: ['AgentAccessMcpAgent'],
    });
    expect(agentAccessConfig.services).toEqual([
      { binding: 'OP_MANAGEMENT', service: 'emailtest-ar-management' },
      { binding: 'OP_DISCOVERY', service: 'emailtest-ar-discovery' },
      {
        binding: 'AGENT_DOWNSCOPE',
        service: 'emailtest-ar-token',
        entrypoint: 'AgentDownscopeEntrypoint',
      },
    ]);
    expect(routerConfig.services).toContainEqual({
      binding: 'OP_AGENT_ACCESS',
      service: 'emailtest-ar-agent-access',
    });
    expect(libCoreConfig.vars.AUTH_CODE_EXPIRY).toBe('600');
    expect(authConfig.vars.EMAIL_FROM).toBe('noreply@example.com');
    expect(authConfig.vars.EMAIL_FROM_NAME).toBe('Authrim');
  });

  it('omits ar-lib-core Durable Object migrations for existing environment worker updates', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'existing' },
      urls: {
        api: {
          custom: null,
          auto: 'https://existing-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://existing-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://existing-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Default Tenant',
        multiTenant: false,
        userIdFormat: 'nanoid',
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: true,
        policy: true,
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { configured: false },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const resourceIds = { d1: {}, kv: {} };
    const initialConfig = generateWranglerConfig('ar-lib-core', config, resourceIds);
    const updateConfig = generateWranglerConfig('ar-lib-core', config, resourceIds, undefined, {
      includeDurableObjectMigrations: false,
    });

    expect(initialConfig.migrations?.[0]?.new_sqlite_classes).toContain('SessionStore');
    expect(updateConfig.durable_objects?.bindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ class_name: 'SessionStore' })])
    );
    expect(updateConfig.migrations).toBeUndefined();
    expect(toToml(updateConfig, 'existing')).not.toContain('new_sqlite_classes');
  });

  it('keeps ar-auth local Durable Object migration during worker updates', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'existing' },
      urls: {
        api: {
          custom: null,
          auto: 'https://existing-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://existing-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://existing-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
        storageType: 'external',
      },
      cloudflare: {},
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { configured: false },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      components: {
        loginUi: true,
        adminUi: true,
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const updateConfig = generateWranglerConfig('ar-auth', config, { d1: {}, kv: {} }, undefined, {
      includeDurableObjectMigrations: false,
    });

    expect(updateConfig.migrations?.[0]?.new_sqlite_classes).toContain('DirectoryConnectorRelay');
  });

  it('serializes send_email bindings in env-scoped wrangler.toml output', () => {
    const config = {
      main: 'src/index.ts',
      compatibility_date: '2026-04-21',
      compatibility_flags: ['nodejs_compat'],
      name: 'authrim-email',
      workers_dev: false,
      vars: {},
      send_email: [
        {
          name: 'EMAIL',
        },
      ],
    };

    const toml = toToml(config, 'prod');

    expect(toml).toContain('[[env.prod.send_email]]');
    expect(toml).not.toContain('[[send_email]]');
    expect(toml).not.toContain('env.undefined.send_email');
  });

  it('escapes JSON strings in environment variables for valid TOML', () => {
    const registeredSchemas = JSON.stringify(['binding:DB:d1-core', 'binding:DB_ADMIN:d1-admin']);
    const config = {
      main: 'src/index.ts',
      compatibility_date: '2026-07-21',
      compatibility_flags: ['nodejs_compat'],
      name: 'authrim-management',
      workers_dev: false,
      vars: { AUTHRIM_REGISTERED_SCHEMA_REFS: registeredSchemas },
    };

    const scopedToml = toToml(config, 'test');
    const legacyToml = toToml(config);

    expect(scopedToml).toContain(
      'AUTHRIM_REGISTERED_SCHEMA_REFS = "[\\"binding:DB:d1-core\\",\\"binding:DB_ADMIN:d1-admin\\"]"'
    );
    expect(legacyToml).toContain(
      'AUTHRIM_REGISTERED_SCHEMA_REFS = "[\\"binding:DB:d1-core\\",\\"binding:DB_ADMIN:d1-admin\\"]"'
    );
  });

  it('serializes send_email bindings once in legacy wrangler.toml output', () => {
    const config = {
      main: 'src/index.ts',
      compatibility_date: '2026-04-21',
      compatibility_flags: ['nodejs_compat'],
      name: 'authrim-email',
      workers_dev: false,
      vars: {},
      send_email: [
        {
          name: 'EMAIL',
        },
      ],
    };

    const toml = toToml(config);

    expect(toml.match(/\[\[send_email\]\]/g) ?? []).toHaveLength(1);
    expect(toml).not.toContain('env.undefined.send_email');
  });

  it('adds the Bridge scheduled trigger and serializes it for env-scoped wrangler output', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'bridgecron' },
      urls: {
        api: {
          custom: null,
          auto: 'https://bridgecron-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://bridgecron-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://bridgecron-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Default Tenant',
        multiTenant: false,
        userIdFormat: 'nanoid',
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: true,
        policy: true,
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: {
          provider: 'none',
          configured: false,
        },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const bridgeConfig = generateWranglerConfig('ar-bridge', config, { d1: {}, kv: {} });
    const authConfig = generateWranglerConfig('ar-auth', config, { d1: {}, kv: {} });
    const toml = toToml(bridgeConfig, 'prod');

    expect(bridgeConfig.triggers).toEqual({ crons: ['*/15 * * * *'] });
    expect(authConfig.triggers).toBeUndefined();
    expect(toml).toContain('[env.prod.triggers]');
    expect(toml).toContain('crons = ["*/15 * * * *"]');
  });

  it('builds resource ids from the lock file for full wrangler regeneration', () => {
    const lock = {
      version: '1.0.0',
      createdAt: '2026-04-21T00:00:00.000Z',
      updatedAt: '2026-04-21T00:00:00.000Z',
      env: 'single',
      d1: {
        DB: { id: 'd1-core', name: 'single-core' },
      },
      kv: {
        SETTINGS: { id: 'kv-settings', name: 'single-settings', previewId: 'preview-settings' },
      },
      queues: {
        AUDIT_QUEUE: { id: 'queue-audit', name: 'single-audit' },
      },
      r2: {
        DIAGNOSTIC_LOGS: { name: 'single-logs' },
        IMPORT_ARTIFACTS: { name: 'single-import-artifacts' },
      },
    } satisfies AuthrimLock;

    expect(buildResourceIdsFromLock(lock)).toEqual({
      d1: {
        DB: { id: 'd1-core', name: 'single-core' },
      },
      kv: {
        SETTINGS: { id: 'kv-settings', name: 'single-settings' },
      },
      queues: {
        AUDIT_QUEUE: { id: 'queue-audit', name: 'single-audit' },
      },
      r2: {
        DIAGNOSTIC_LOGS: { name: 'single-logs' },
        IMPORT_ARTIFACTS: { name: 'single-import-artifacts' },
      },
    });
  });

  it('includes generated assignment bindings for tenant durable runtime workers', () => {
    const config = {
      version: '1.0.0',
      environment: { prefix: 'tenantd1' },
      urls: {
        api: { custom: null, auto: 'https://tenantd1-ar-router.workers.dev' },
      },
      tenant: { multiTenant: true },
      components: {},
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      features: { queue: { enabled: false }, r2: { enabled: false } },
      keys: {},
      cloudflare: {},
      database: {},
      security: {},
      profile: 'basic-op',
    } as unknown as AuthrimConfig;
    const resourceIds = {
      d1: {
        DB: { id: 'core-id', name: 'tenantd1-authrim-core-db' },
        DB_PII: { id: 'pii-id', name: 'tenantd1-authrim-pii-db' },
        DB_ADMIN: { id: 'admin-id', name: 'tenantd1-authrim-admin-db' },
        CONTROL_DB: { id: 'control-id', name: 'tenantd1-authrim-control-db' },
        LOOKUP_DB: { id: 'lookup-id', name: 'tenantd1-authrim-lookup-db' },
        TDB_LOOKUP_EXTRA_LOOKUP: {
          id: 'lookup-extra-id',
          name: 'authrim-tenantd1-lookup-extra',
        },
        PLUGIN_RUNNER_DB: {
          id: 'plugin-runner-id',
          name: 'tenantd1-authrim-plugin-runner-db',
        },
        TDB_DEFAULT_EXAMPLE_CORE: {
          id: 'tenant-default-id',
          name: 'authrim-tenantd1-example-default',
        },
        TDB_USERS_EXAMPLE_CORE: {
          id: 'tenant-users-id',
          name: 'authrim-tenantd1-example-users',
        },
        TDB_PII_EXAMPLE_PII: {
          id: 'tenant-pii-id',
          name: 'authrim-tenantd1-example-pii',
        },
      },
      kv: {
        INITIAL_ACCESS_TOKENS: {
          id: 'kv-initial-access-tokens',
          name: 'TENANTD1-INITIAL_ACCESS_TOKENS',
        },
        TENANT_RUNTIME_REGISTRY: {
          id: 'kv-tenant-runtime-registry',
          name: 'TENANTD1-TENANT_RUNTIME_REGISTRY',
        },
      },
    };

    const authConfig = generateWranglerConfig('ar-auth', config, resourceIds);
    const discoveryConfig = generateWranglerConfig('ar-discovery', config, resourceIds);
    const controlConfig = generateWranglerConfig(
      'ar-control',
      { ...config, cloudflare: { accountId: 'account-id' } },
      resourceIds
    );
    const managementConfig = generateWranglerConfig('ar-management', config, resourceIds);
    const agentAccessConfig = generateWranglerConfig('ar-agent-access', config, resourceIds);
    const asyncConfig = generateWranglerConfig('ar-async', config, resourceIds);
    const policyConfig = generateWranglerConfig('ar-policy', config, resourceIds);
    const routerConfig = generateWranglerConfig('ar-router', config, resourceIds);

    expect(authConfig.d1_databases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: 'TDB_DEFAULT_EXAMPLE_CORE' }),
        expect.objectContaining({ binding: 'TDB_USERS_EXAMPLE_CORE' }),
        expect.objectContaining({ binding: 'TDB_PII_EXAMPLE_PII' }),
      ])
    );
    expect(discoveryConfig.d1_databases).toEqual(
      expect.arrayContaining([expect.objectContaining({ binding: 'TDB_DEFAULT_EXAMPLE_CORE' })])
    );
    expect(discoveryConfig.d1_databases).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ binding: 'DB' })])
    );
    expect(discoveryConfig.d1_databases).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: 'TDB_USERS_EXAMPLE_CORE' }),
        expect.objectContaining({ binding: 'TDB_PII_EXAMPLE_PII' }),
        expect.objectContaining({ binding: 'LOOKUP_DB' }),
      ])
    );
    expect(authConfig.d1_databases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: 'LOOKUP_DB' }),
        expect.objectContaining({ binding: 'TDB_LOOKUP_EXTRA_LOOKUP' }),
      ])
    );
    expect(managementConfig.d1_databases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: 'LOOKUP_DB' }),
        expect.objectContaining({ binding: 'TDB_LOOKUP_EXTRA_LOOKUP' }),
      ])
    );
    expect(authConfig.d1_databases).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: 'CONTROL_DB' }),
        expect.objectContaining({ binding: 'PLUGIN_RUNNER_DB' }),
      ])
    );
    expect(controlConfig.d1_databases).toEqual([
      {
        binding: 'CONTROL_DB',
        database_name: 'tenantd1-authrim-control-db',
        database_id: 'control-id',
      },
    ]);
    expect(controlConfig.workers_dev).toBe(false);
    expect(controlConfig.compatibility_date).toBe('2026-07-01');
    expect(controlConfig.triggers).toEqual({ crons: ['* * * * *'] });
    expect(controlConfig.vars).toMatchObject({
      AUTHRIM_ENVIRONMENT_NAME: 'tenantd1',
      AUTHRIM_DEPLOYMENT_TARGET: 'default',
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CONTROL_DESTRUCTIVE_OPERATIONS_ENABLED: 'false',
      RUNTIME_REGISTRY_SIGNING_ACTIVE_SLOT: 'A',
    });
    expect(controlConfig.kv_namespaces).toEqual([
      {
        binding: 'TENANT_RUNTIME_REGISTRY',
        id: 'kv-tenant-runtime-registry',
      },
    ]);
    expect(controlConfig.services).toHaveLength(13);
    expect(controlConfig.services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: 'SMOKE_AR_LIB_CORE',
          service: 'tenantd1-ar-lib-core',
          entrypoint: 'RuntimeSmokeEntrypoint',
          props: {
            audience: 'authrim-runtime-smoke-v1',
            caller: 'ar-control',
            environmentId: 'tenantd1',
            targetWorker: 'tenantd1-ar-lib-core',
          },
        }),
        expect.objectContaining({
          binding: 'SMOKE_AR_DISCOVERY',
          service: 'tenantd1-ar-discovery',
          entrypoint: 'RuntimeSmokeEntrypoint',
          props: {
            audience: 'authrim-runtime-smoke-v1',
            caller: 'ar-control',
            environmentId: 'tenantd1',
            targetWorker: 'tenantd1-ar-discovery',
          },
        }),
        expect.objectContaining({
          binding: 'SMOKE_AR_AUTH',
          service: 'tenantd1-ar-auth',
          entrypoint: 'RuntimeSmokeEntrypoint',
          props: {
            audience: 'authrim-runtime-smoke-v1',
            caller: 'ar-control',
            environmentId: 'tenantd1',
            targetWorker: 'tenantd1-ar-auth',
          },
        }),
        expect.objectContaining({
          binding: 'SMOKE_AR_MANAGEMENT',
          service: 'tenantd1-ar-management',
          entrypoint: 'RuntimeSmokeEntrypoint',
          props: {
            audience: 'authrim-runtime-smoke-v1',
            caller: 'ar-control',
            environmentId: 'tenantd1',
            targetWorker: 'tenantd1-ar-management',
          },
        }),
      ])
    );
    expect(controlConfig.durable_objects).toBeUndefined();
    expect(controlConfig.d1_databases).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ binding: 'TDB_DEFAULT_EXAMPLE_CORE' })])
    );
    expect(controlConfig.d1_databases).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ binding: 'TDB_LOOKUP_EXTRA_LOOKUP' })])
    );
    expect(authConfig.kv_namespaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ binding: 'TENANT_RUNTIME_REGISTRY' })])
    );
    expect(managementConfig.kv_namespaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ binding: 'TENANT_RUNTIME_REGISTRY' })])
    );
    expect(agentAccessConfig.d1_databases).toEqual(
      expect.arrayContaining([expect.objectContaining({ binding: 'DB_ADMIN' })])
    );
    expect(agentAccessConfig.d1_databases).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ binding: 'DB' })])
    );
    expect(agentAccessConfig.d1_databases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: 'TDB_DEFAULT_EXAMPLE_CORE' }),
        expect.objectContaining({ binding: 'TDB_USERS_EXAMPLE_CORE' }),
      ])
    );
    expect(agentAccessConfig.d1_databases).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ binding: 'TDB_PII_EXAMPLE_PII' })])
    );
    expect(asyncConfig.d1_databases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: 'TDB_DEFAULT_EXAMPLE_CORE' }),
        expect.objectContaining({ binding: 'TDB_USERS_EXAMPLE_CORE' }),
        expect.objectContaining({ binding: 'TDB_PII_EXAMPLE_PII' }),
      ])
    );
    expect(asyncConfig.d1_databases).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: 'DB' }),
        expect.objectContaining({ binding: 'DB_PII' }),
      ])
    );
    expect(asyncConfig.kv_namespaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: 'INITIAL_ACCESS_TOKENS' }),
        expect.objectContaining({ binding: 'TENANT_RUNTIME_REGISTRY' }),
      ])
    );
    expect(policyConfig.kv_namespaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ binding: 'TENANT_RUNTIME_REGISTRY' })])
    );
    for (const component of WORKER_COMPONENTS.filter((candidate) =>
      getRequiredDataRolesForComponent(candidate).some(
        (role) => role === 'lookup' || role.startsWith('tenant_')
      )
    )) {
      expect(
        generateWranglerConfig(component, config, resourceIds).kv_namespaces,
        `${component} must receive the signed tenant runtime registry`
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ binding: 'TENANT_RUNTIME_REGISTRY' })])
      );
    }
    expect(routerConfig.d1_databases).toBeUndefined();
  });

  it('serializes configured Hyperdrive bindings for non-router workers', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:00:00.000Z',
      environment: { prefix: 'portable' },
      urls: {
        api: { custom: null, auto: 'https://portable-ar-router.example.workers.dev' },
        loginUi: {
          custom: null,
          auto: 'https://portable-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://portable-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Default Tenant',
        multiTenant: false,
        userIdFormat: 'nanoid',
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: true,
        policy: true,
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { provider: 'none', configured: false },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
      profiles: {
        defaults: {
          audit: 'builtin:audit:standard',
          residency: 'builtin:residency:default',
        },
        registry: { backend: 'kv' },
        references: {
          hyperdrive: {
            'core-primary': {
              binding: 'HYPERDRIVE_CORE_PRIMARY',
              id: 'hyperdrive-core-id',
              driver: 'postgres',
            },
          },
        },
        seed: {
          audit: [],
          residency: [],
        },
      },
    } satisfies AuthrimConfig;

    const resourceIds = { d1: {}, kv: {} };
    const authConfig = generateWranglerConfig('ar-auth', config, resourceIds);
    const routerConfig = generateWranglerConfig('ar-router', config, resourceIds);

    expect(authConfig.hyperdrive).toEqual([
      { binding: 'HYPERDRIVE_CORE_PRIMARY', id: 'hyperdrive-core-id' },
    ]);
    expect(routerConfig.hyperdrive).toBeUndefined();

    const toml = toToml(authConfig, 'portable');
    expect(toml).toContain('[[env.portable.hyperdrive]]');
    expect(parseWranglerToml(toml, 'portable').hyperdrive).toEqual({
      HYPERDRIVE_CORE_PRIMARY: 'hyperdrive-core-id',
    });
  });

  it('escapes environment names before parsing generated wrangler bindings', () => {
    const toml = `
[[env.portable.prod.kv_namespaces]]
binding = "SESSION_STORE"
id = "kv-id"
`;

    expect(parseWranglerToml(toml, 'portable.prod').kv).toEqual({ SESSION_STORE: 'kv-id' });
    expect(parseWranglerToml(toml, 'portableXprod').kv).toEqual({});
  });

  it('assigns AUDIT_QUEUE producer bindings to auth/token and a consumer to management', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'queuephase4' },
      urls: {
        api: {
          custom: null,
          auto: 'https://queuephase4-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://queuephase4-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://queuephase4-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Default Tenant',
        multiTenant: false,
        userIdFormat: 'nanoid',
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: false,
        policy: false,
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      features: {
        queue: { enabled: true },
        r2: { enabled: true },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const resourceIds = {
      d1: {},
      kv: {},
      queues: {
        AUDIT_QUEUE: { id: 'queue-audit', name: 'queuephase4-audit' },
        LOGGING_DELIVERY_CRITICAL_QUEUE: {
          id: 'queue-logging-critical',
          name: 'queuephase4-logging-critical',
        },
        LOGGING_DELIVERY_QUEUE: {
          id: 'queue-logging-default',
          name: 'queuephase4-logging-default',
        },
        LOGGING_DELIVERY_BULK_QUEUE: {
          id: 'queue-logging-bulk',
          name: 'queuephase4-logging-bulk',
        },
      },
      r2: {
        DIAGNOSTIC_LOGS: { name: 'queuephase4-logs' },
      },
    };

    const authConfig = generateWranglerConfig('ar-auth', config, resourceIds);
    const tokenConfig = generateWranglerConfig('ar-token', config, resourceIds);
    const userinfoConfig = generateWranglerConfig('ar-userinfo', config, resourceIds);
    const managementConfig = generateWranglerConfig('ar-management', config, resourceIds);

    expect(authConfig.queues?.producers).toEqual([
      { queue: 'queuephase4-audit', binding: 'AUDIT_QUEUE' },
      {
        queue: 'queuephase4-logging-critical',
        binding: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
      },
      { queue: 'queuephase4-logging-default', binding: 'LOGGING_DELIVERY_QUEUE' },
      { queue: 'queuephase4-logging-bulk', binding: 'LOGGING_DELIVERY_BULK_QUEUE' },
    ]);
    expect(tokenConfig.queues?.producers).toEqual([
      { queue: 'queuephase4-audit', binding: 'AUDIT_QUEUE' },
      {
        queue: 'queuephase4-logging-critical',
        binding: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
      },
      { queue: 'queuephase4-logging-default', binding: 'LOGGING_DELIVERY_QUEUE' },
      { queue: 'queuephase4-logging-bulk', binding: 'LOGGING_DELIVERY_BULK_QUEUE' },
    ]);
    expect(userinfoConfig.queues?.producers).toEqual([
      {
        queue: 'queuephase4-logging-critical',
        binding: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
      },
      { queue: 'queuephase4-logging-default', binding: 'LOGGING_DELIVERY_QUEUE' },
      { queue: 'queuephase4-logging-bulk', binding: 'LOGGING_DELIVERY_BULK_QUEUE' },
    ]);
    expect(managementConfig.queues?.producers).toEqual([
      {
        queue: 'queuephase4-logging-critical',
        binding: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
      },
      { queue: 'queuephase4-logging-default', binding: 'LOGGING_DELIVERY_QUEUE' },
      { queue: 'queuephase4-logging-bulk', binding: 'LOGGING_DELIVERY_BULK_QUEUE' },
    ]);
    expect(managementConfig.queues?.consumers).toEqual([
      { queue: 'queuephase4-audit' },
      { queue: 'queuephase4-logging-critical' },
      { queue: 'queuephase4-logging-default' },
      { queue: 'queuephase4-logging-bulk' },
    ]);
    expect(managementConfig.vars.LOGGING_DELIVERY_QUEUE_NAMES).toBe(
      'queuephase4-logging-critical,queuephase4-logging-default,queuephase4-logging-bulk'
    );
  });

  it('serializes queue consumers in wrangler.toml output', () => {
    const config = {
      main: 'src/index.ts',
      compatibility_date: '2026-04-24',
      compatibility_flags: ['nodejs_compat'],
      name: 'authrim-queue-consumer',
      workers_dev: false,
      vars: {},
      queues: {
        consumers: [{ queue: 'audit-queue' }],
      },
    };

    const toml = toToml(config);

    expect(toml).toContain('[[queues.consumers]]');
    expect(toml).toContain('queue = "audit-queue"');
  });

  it('routes admin setup and admin auth endpoints to ar-auth', () => {
    const routes = generateRoutes('ar-auth', 'conformance.authrim.com', 'authrim.com');
    const patterns = routes.map((route) => route.pattern);

    expect(patterns).toContain('conformance.authrim.com/api/admin/setup-token/*');
    expect(patterns).toContain('conformance.authrim.com/api/admin/auth/*');
  });

  it('does not assign broad admin API routes to ar-management', () => {
    const routes = generateRoutes('ar-management', 'conformance.authrim.com', 'authrim.com');
    const patterns = routes.map((route) => route.pattern);

    expect(patterns).toContain('conformance.authrim.com/register');
    expect(patterns).not.toContain('conformance.authrim.com/api/admin/*');
  });

  it('assigns custom-domain routes only to ar-router in router mode', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'conformance' },
      urls: {
        api: {
          custom: 'https://conformance.authrim.com',
          auto: 'https://conformance-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: 'https://conformance.authrim.com',
          auto: 'https://conformance-ar-login-ui.workers.dev',
          sameAsApi: true,
        },
        adminUi: {
          custom: 'https://conformance.authrim.com',
          auto: 'https://conformance-ar-admin-ui.workers.dev',
          sameAsApi: true,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Default Tenant',
        multiTenant: false,
        userIdFormat: 'nanoid',
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: true,
        policy: true,
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { provider: 'none', configured: false },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const resourceIds = {
      d1: {},
      kv: {},
    };

    const routerConfig = generateWranglerConfig('ar-router', config, resourceIds);
    const authConfig = generateWranglerConfig('ar-auth', config, resourceIds);
    const managementConfig = generateWranglerConfig('ar-management', config, resourceIds);

    expect(routerConfig.routes).toEqual([
      { pattern: 'conformance.authrim.com/*', zone_name: 'authrim.com' },
    ]);
    expect(authConfig.routes).toBeUndefined();
    expect(authConfig.vars.ENABLE_LOGIN_RUNTIME_FLOW).toBe('true');
    expect(authConfig.vars.FLOW_RUNTIME_HMAC_SECRET).toBe('');
    expect(authConfig.vars.AUTHRIM_TRUST_FORWARDED_HOST).toBe('true');
    expect(managementConfig.vars.AUTHRIM_TRUST_FORWARDED_HOST).toBe('true');
    expect(routerConfig.vars.AUTHRIM_TRUST_FORWARDED_HOST).toBeUndefined();
    expect(managementConfig.routes).toBeUndefined();
  });

  it('uses custom_domain=true for the base domain and wildcard routes for tenant subdomains', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'test' },
      urls: {
        api: {
          custom: 'https://test.authrim.com',
          auto: 'https://test-ar-router.example.workers.dev',
          customDomainBinding: true,
        },
        loginUi: {
          custom: null,
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://test-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Default Tenant',
        multiTenant: true,
        userIdFormat: 'nanoid',
        baseDomain: 'test.authrim.com',
        nakedDomain: true,
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: false,
        policy: false,
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { provider: 'none', configured: false },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const resourceIds = { d1: {}, kv: {} };
    const routerConfig = generateWranglerConfig('ar-router', config, resourceIds);

    expect(routerConfig.routes).toEqual([
      { pattern: 'test.authrim.com', custom_domain: true },
      { pattern: '*.test.authrim.com', zone_name: 'authrim.com' },
      { pattern: '*.test.authrim.com/*', zone_name: 'authrim.com' },
    ]);
    // workers_dev should be false when custom domain is set
    expect(routerConfig.workers_dev).toBe(false);
  });

  it('uses tenant.baseDomain, not api.custom, as the multi-tenant wildcard route base', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'test' },
      urls: {
        api: {
          custom: 'https://first.example.com',
          auto: 'https://test-ar-router.example.workers.dev',
          customDomainBinding: true,
        },
        loginUi: {
          custom: 'https://login.example.com',
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: 'https://admin.example.com',
          auto: 'https://test-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'first',
        displayName: 'First Tenant',
        multiTenant: true,
        userIdFormat: 'nanoid',
        baseDomain: 'example.com',
        nakedDomain: false,
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: false,
        policy: false,
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { provider: 'none', configured: false },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const routerConfig = generateWranglerConfig('ar-router', config, { d1: {}, kv: {} });

    expect(routerConfig.routes).toEqual([
      { pattern: 'example.com', custom_domain: true },
      { pattern: '*.example.com', zone_name: 'example.com' },
      { pattern: '*.example.com/*', zone_name: 'example.com' },
    ]);
  });

  it('adds wildcard tenant routes in route mode when BASE_DOMAIN is configured', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'test' },
      urls: {
        api: {
          custom: 'https://test.authrim.com',
          auto: 'https://test-ar-router.example.workers.dev',
          customDomainBinding: false,
        },
        loginUi: {
          custom: null,
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://test-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Default Tenant',
        multiTenant: true,
        userIdFormat: 'nanoid',
        baseDomain: 'test.authrim.com',
        nakedDomain: false,
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: false,
        policy: false,
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { provider: 'none', configured: false },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const resourceIds = { d1: {}, kv: {} };
    const routerConfig = generateWranglerConfig('ar-router', config, resourceIds);

    expect(routerConfig.routes).toEqual([
      { pattern: 'test.authrim.com/*', zone_name: 'authrim.com' },
      { pattern: '*.test.authrim.com', zone_name: 'authrim.com' },
      { pattern: '*.test.authrim.com/*', zone_name: 'authrim.com' },
    ]);
  });

  it('adds OP_VC service binding to ar-router when VC is enabled', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'test' },
      urls: {
        api: {
          custom: null,
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://test-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Default Tenant',
        multiTenant: false,
        userIdFormat: 'nanoid',
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: true,
        bridge: false,
        policy: false,
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { provider: 'none', configured: false },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const resourceIds = { d1: {}, kv: {} };
    const routerConfig = generateWranglerConfig('ar-router', config, resourceIds);

    expect(routerConfig.services).toEqual(
      expect.arrayContaining([
        { binding: 'OP_VC', service: 'test-ar-vc' },
        { binding: 'LOGIN_UI_WORKER', service: 'test-ar-login-ui' },
        { binding: 'ADMIN_UI_WORKER', service: 'test-ar-admin-ui' },
      ])
    );
  });

  it('adds service site binding to ar-router when configured', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
      environment: { prefix: 'test' },
      urls: {
        api: {
          custom: null,
          auto: 'https://test-ar-router.example.workers.dev',
        },
        loginUi: {
          custom: null,
          auto: 'https://test-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://test-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Default Tenant',
        multiTenant: false,
        userIdFormat: 'nanoid',
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: false,
        policy: false,
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: false },
        email: { provider: 'none', configured: false },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      serviceSite: {
        enabled: true,
        binding: 'SERVICE_SITE',
        workerName: 'customer-service-site',
        fallbackMode: 'worker_service_binding',
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const resourceIds = {
      d1: {},
      kv: {
        SETTINGS: { id: 'kv-settings', name: 'TEST-SETTINGS' },
        AUTHRIM_CONFIG: { id: 'kv-authrim-config', name: 'TEST-AUTHRIM_CONFIG' },
        TENANT_RUNTIME_REGISTRY: {
          id: 'kv-runtime-registry',
          name: 'TEST-TENANT-RUNTIME-REGISTRY',
        },
      },
    };
    const routerConfig = generateWranglerConfig('ar-router', config, resourceIds);
    const discoveryConfig = generateWranglerConfig('ar-discovery', config, resourceIds);
    const agentAccessConfig = generateWranglerConfig('ar-agent-access', config, resourceIds);

    expect(routerConfig.kv_namespaces).toEqual(
      expect.arrayContaining([
        { binding: 'SETTINGS', id: 'kv-settings' },
        { binding: 'AUTHRIM_CONFIG', id: 'kv-authrim-config' },
      ])
    );
    expect(discoveryConfig.kv_namespaces).toEqual(
      expect.arrayContaining([
        { binding: 'SETTINGS', id: 'kv-settings' },
        { binding: 'AUTHRIM_CONFIG', id: 'kv-authrim-config' },
        { binding: 'TENANT_RUNTIME_REGISTRY', id: 'kv-runtime-registry' },
      ])
    );
    expect(agentAccessConfig.kv_namespaces).toEqual(
      expect.arrayContaining([
        { binding: 'SETTINGS', id: 'kv-settings' },
        { binding: 'AUTHRIM_CONFIG', id: 'kv-authrim-config' },
      ])
    );
    expect(routerConfig.services).toEqual(
      expect.arrayContaining([
        { binding: 'LOGIN_UI_WORKER', service: 'test-ar-login-ui' },
        { binding: 'ADMIN_UI_WORKER', service: 'test-ar-admin-ui' },
        { binding: 'SERVICE_SITE', service: 'customer-service-site' },
      ])
    );
    expect(routerConfig.vars.SERVICE_SITE_BINDING).toBe('SERVICE_SITE');
  });

  it('binds import artifacts only to management and diagnostic logs to bridge', () => {
    const config = {
      version: '1.0.0',
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
      environment: { prefix: 'imports' },
      urls: {
        api: { custom: null, auto: 'https://imports-ar-router.example.workers.dev' },
        loginUi: {
          custom: null,
          auto: 'https://imports-ar-login-ui.workers.dev',
          sameAsApi: false,
        },
        adminUi: {
          custom: null,
          auto: 'https://imports-ar-admin-ui.workers.dev',
          sameAsApi: false,
        },
      },
      tenant: {
        name: 'default',
        displayName: 'Default Tenant',
        multiTenant: false,
        userIdFormat: 'nanoid',
      },
      components: {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: false,
        policy: false,
      },
      oidc: {
        accessTokenTtl: 3600,
        refreshTokenTtl: 604800,
        authCodeTtl: 600,
        pkceRequired: true,
        responseTypes: ['code'],
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      sharding: {
        authCodeShards: 4,
        refreshTokenShards: 4,
        sessionShards: 4,
        challengeShards: 4,
      },
      features: {
        queue: { enabled: false },
        r2: { enabled: true },
        email: { configured: false },
      },
      keys: {
        secretsPath: './keys/',
        includeSecrets: false,
        storageType: 'external',
      },
      cloudflare: {},
      database: {
        core: { location: 'auto', jurisdiction: 'none' },
        pii: { location: 'auto', jurisdiction: 'none' },
      },
      security: {
        piiEncryptionEnabled: true,
        domainHashEnabled: true,
      },
      profile: 'basic-op',
    } satisfies AuthrimConfig;

    const resourceIds = {
      d1: {},
      kv: {},
      r2: {
        PUBLIC_ASSETS: { name: 'imports-public-assets' },
        AVATARS: { name: 'imports-authrim-avatars' },
        DIAGNOSTIC_LOGS: { name: 'imports-diagnostic-logs' },
        IMPORT_ARTIFACTS: { name: 'imports-import-artifacts' },
        EXPORT_ARTIFACTS: { name: 'imports-export-artifacts' },
        SENSITIVE_DETAILS: { name: 'imports-sensitive-details' },
      },
    };

    const managementConfig = generateWranglerConfig('ar-management', config, resourceIds);
    const authConfig = generateWranglerConfig('ar-auth', config, resourceIds);
    const bridgeConfig = generateWranglerConfig('ar-bridge', config, resourceIds);

    expect(managementConfig.r2_buckets).toEqual(
      expect.arrayContaining([
        {
          binding: 'IMPORT_ARTIFACTS',
          bucket_name: 'imports-import-artifacts',
        },
        {
          binding: 'EXPORT_ARTIFACTS',
          bucket_name: 'imports-export-artifacts',
        },
        {
          binding: 'SENSITIVE_DETAILS',
          bucket_name: 'imports-sensitive-details',
        },
      ])
    );
    expect(authConfig.r2_buckets).not.toEqual(
      expect.arrayContaining([
        {
          binding: 'IMPORT_ARTIFACTS',
          bucket_name: 'imports-import-artifacts',
        },
        {
          binding: 'EXPORT_ARTIFACTS',
          bucket_name: 'imports-export-artifacts',
        },
        {
          binding: 'SENSITIVE_DETAILS',
          bucket_name: 'imports-sensitive-details',
        },
      ])
    );
    expect(bridgeConfig.r2_buckets).toEqual(
      expect.arrayContaining([
        {
          binding: 'DIAGNOSTIC_LOGS',
          bucket_name: 'imports-diagnostic-logs',
        },
      ])
    );
    expect(bridgeConfig.r2_buckets).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: 'IMPORT_ARTIFACTS' }),
        expect.objectContaining({ binding: 'EXPORT_ARTIFACTS' }),
        expect.objectContaining({ binding: 'SENSITIVE_DETAILS' }),
      ])
    );
  });
});

describe('registered schema references', () => {
  it('rejects a management Worker variable larger than Cloudflare allows', () => {
    const config = createDefaultConfig('prod');
    config.urls = {
      api: { custom: null, auto: 'https://prod-ar-router.example.workers.dev' },
      loginUi: {
        custom: null,
        auto: 'https://prod-ar-login-ui.example.workers.dev',
        sameAsApi: false,
      },
      adminUi: {
        custom: null,
        auto: 'https://prod-ar-admin-ui.example.workers.dev',
        sameAsApi: false,
      },
    };
    const references = Array.from(
      { length: 200 },
      (_, index) =>
        `connection:external-${index.toString().padStart(3, '0')}-${'x'.repeat(30)}:d1-core`
    );

    expect(() =>
      generateWranglerConfig('ar-management', config, {
        d1: {},
        kv: {},
        registeredSchemaReferences: references,
      })
    ).toThrow('registered_schema_references_exceed_cloudflare_variable_limit');
  });
});
