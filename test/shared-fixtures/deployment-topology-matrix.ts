/**
 * Deployment Matrix Test Fixtures v2
 *
 * 27 representative scenarios with ALL expected values hardcoded.
 * No calculation logic — every expected value is a string literal.
 *
 * Constants:
 *   BASE_DOMAIN        = "auth.example.com"
 *   WORKERS_SUBDOMAIN  = "my-project"
 *   DEFAULT_TENANT     = "default"
 *   PRIMARY_TENANT     = "primary"
 *   API_CUSTOM         = "https://api.example.com"
 *   API_WORKERS_DEV    = "https://prod-ar-router.my-project.workers.dev"
 *   LOGIN_UI_CUSTOM    = "https://login.example.com"
 *   LOGIN_UI_PAGES_DEV = "https://prod-ar-login-ui.my-project.pages.dev"
 *   ADMIN_UI_CUSTOM    = "https://admin.example.com"
 *   ADMIN_UI_PAGES_DEV = "https://prod-ar-admin-ui.my-project.pages.dev"
 */

// =============================================================================
// Constants
// =============================================================================

export const BASE_DOMAIN = 'auth.example.com';
export const WORKERS_SUBDOMAIN = 'my-project';
export const DEFAULT_TENANT = 'default';
export const PRIMARY_TENANT = 'primary';
export const ENV_PREFIX = 'prod';

export const API_CUSTOM = 'https://api.example.com';
export const API_WORKERS_DEV = 'https://prod-ar-router.my-project.workers.dev';
export const LOGIN_UI_CUSTOM = 'https://login.example.com';
export const LOGIN_UI_PAGES_DEV = 'https://prod-ar-login-ui.my-project.pages.dev';
export const ADMIN_UI_CUSTOM = 'https://admin.example.com';
export const ADMIN_UI_PAGES_DEV = 'https://prod-ar-admin-ui.my-project.pages.dev';

// =============================================================================
// Types
// =============================================================================

export type NakedPattern = 'N1' | 'N2' | 'N3';

export interface ScenarioConfig {
  apiCustom: string | null;
  apiAuto: string;
  loginUiCustom: string | null;
  loginUiAuto: string | null;
  loginUiSameAsApi: boolean;
  adminUiCustom: string | null;
  adminUiAuto: string | null;
  adminUiSameAsApi: boolean;
  baseDomain: string | null;
  defaultTenantId: string;
  primaryTenantId: string | null;
  nakedDomain: boolean;
  /** Whether login UI component is enabled */
  hasLoginUi: boolean;
  /** Whether admin UI component is enabled */
  hasAdminUi: boolean;
}

export interface ScenarioExpected {
  /** buildIssuerUrl(env) with default tenant */
  issuerUrl: string;
  /** buildIssuerUrl(env, 'acme') with explicit tenant */
  issuerUrlWithTenant: string;
  /** deriveAllowedOrigins result (sorted) */
  allowedOrigins: string[];
  /** Base URL for setup admin-init-setup URL */
  setupUrlBase: string;
  /** generateEnvVars for ar-auth */
  arAuthEnvVars: {
    ISSUER_URL: string;
    UI_URL: string;
    ADMIN_UI_URL: string;
    ALLOWED_ORIGINS: string;
    BASE_DOMAIN?: string;
    DEFAULT_TENANT_ID: string;
    PRIMARY_TENANT_ID?: string;
    NAKED_DOMAIN_AS_ISSUER?: string;
    COOKIE_SAME_SITE: string;
    ADMIN_COOKIE_SAME_SITE: string;
  };
  /** generateEnvVars for ar-management (subset) */
  arManagementEnvVars: {
    ISSUER_URL: string;
    ADMIN_UI_URL: string;
    ADMIN_COOKIE_SAME_SITE: string;
    DEFAULT_TENANT_ID: string;
    ALLOWED_ORIGINS: string;
  };
  /** generateEnvVars for ar-router (subset) */
  arRouterEnvVars: {
    DEFAULT_TENANT_ID: string;
    ALLOWED_ORIGINS: string;
    /** ar-router does NOT get ISSUER_URL */
    ISSUER_URL?: undefined;
  };
}

export interface Scenario {
  id: number;
  name: string;
  naked: NakedPattern;
  config: ScenarioConfig;
  expected: ScenarioExpected;
}

// =============================================================================
// Helper: Build AuthrimConfig from ScenarioConfig (input only, no expected)
// =============================================================================

export function buildAuthrimConfig(scenario: Scenario) {
  const c = scenario.config;
  return {
    version: '1.0.0',
    environment: { prefix: ENV_PREFIX },
    urls: {
      api: {
        custom: c.apiCustom,
        auto: c.apiAuto,
      },
      loginUi: {
        custom: c.loginUiCustom,
        auto: c.loginUiAuto,
        sameAsApi: c.loginUiSameAsApi,
      },
      adminUi: {
        custom: c.adminUiCustom,
        auto: c.adminUiAuto,
        sameAsApi: c.adminUiSameAsApi,
      },
    },
    tenant: {
      name: c.defaultTenantId,
      displayName: 'Default Tenant',
      multiTenant: c.baseDomain !== null,
      baseDomain: c.baseDomain ?? undefined,
      userIdFormat: 'nanoid' as const,
      primaryTenant: c.primaryTenantId ?? undefined,
      nakedDomain: c.nakedDomain,
    },
    components: {
      api: true,
      loginUi: c.hasLoginUi,
      adminUi: c.hasAdminUi,
      saml: false,
      async: false,
      vc: false,
      bridge: true,
      policy: true,
    },
    profile: 'basic-op' as const,
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
      flowStateShards: 32,
    },
    features: {
      queue: { enabled: false },
      r2: { enabled: false },
      email: { provider: 'none' as const, configured: false },
    },
    keys: {
      keyId: 'test-key-1',
      secretsPath: './keys/',
      includeSecrets: false,
      storageType: 'external' as const,
    },
    cloudflare: {},
    database: {
      core: { location: 'auto' as const, jurisdiction: 'none' as const },
      pii: { location: 'auto' as const, jurisdiction: 'none' as const },
    },
    security: {
      piiEncryptionEnabled: true,
      domainHashEnabled: true,
    },
  };
}

// =============================================================================
// Helper: Build Env from ScenarioConfig (for issuer.ts tests)
// =============================================================================

export function buildEnvFromScenario(scenario: Scenario) {
  const c = scenario.config;
  const env: Record<string, string | undefined> = {
    ISSUER_URL: c.apiCustom || c.apiAuto,
    DEFAULT_TENANT_ID: c.defaultTenantId,
  };

  if (c.baseDomain) {
    env.BASE_DOMAIN = c.baseDomain;
  }
  if (c.primaryTenantId) {
    env.PRIMARY_TENANT_ID = c.primaryTenantId;
  }
  if (c.nakedDomain) {
    env.NAKED_DOMAIN_AS_ISSUER = 'true';
  }

  return env;
}

// =============================================================================
// 27 Scenarios — ALL expected values hardcoded
// =============================================================================

export const SCENARIOS: Scenario[] = [
  // =========================================================================
  // Deploy A (API only) — 7 scenarios
  // =========================================================================

  // #1: workers.dev, single tenant
  {
    id: 1,
    name: 'A: workers.dev, single tenant',
    naked: 'N1',
    config: {
      apiCustom: null,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: null,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: null,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: false,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: API_WORKERS_DEV,
      issuerUrlWithTenant: API_WORKERS_DEV,
      allowedOrigins: [API_WORKERS_DEV],
      setupUrlBase: API_WORKERS_DEV,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
      },
    },
  },

  // #2: custom domain, single tenant
  {
    id: 2,
    name: 'A: custom domain, single tenant',
    naked: 'N1',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: null,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: null,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: false,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: API_CUSTOM,
      issuerUrlWithTenant: API_CUSTOM,
      allowedOrigins: [API_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_CUSTOM,
        UI_URL: API_CUSTOM,
        ADMIN_UI_URL: API_CUSTOM,
        ALLOWED_ORIGINS: API_CUSTOM,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_CUSTOM,
        ADMIN_UI_URL: API_CUSTOM,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_CUSTOM,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_CUSTOM,
      },
    },
  },

  // #3: custom + baseDomain, multi-tenant, N1
  {
    id: 3,
    name: 'A: custom + baseDomain, multi-tenant',
    naked: 'N1',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: null,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: BASE_DOMAIN,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: false,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: `https://${DEFAULT_TENANT}.${BASE_DOMAIN}`,
      issuerUrlWithTenant: `https://acme.${BASE_DOMAIN}`,
      allowedOrigins: [API_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ALLOWED_ORIGINS: API_CUSTOM,
        BASE_DOMAIN: BASE_DOMAIN,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_CUSTOM,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_CUSTOM,
      },
    },
  },

  // #4: custom + baseDomain + primary tenant, N2
  {
    id: 4,
    name: 'A: custom + baseDomain + primary tenant (N2)',
    naked: 'N2',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: null,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: BASE_DOMAIN,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: PRIMARY_TENANT,
      nakedDomain: false,
      hasLoginUi: false,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: `https://${DEFAULT_TENANT}.${BASE_DOMAIN}`,
      issuerUrlWithTenant: `https://acme.${BASE_DOMAIN}`,
      allowedOrigins: [API_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ALLOWED_ORIGINS: API_CUSTOM,
        BASE_DOMAIN: BASE_DOMAIN,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        PRIMARY_TENANT_ID: PRIMARY_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_CUSTOM,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_CUSTOM,
      },
    },
  },

  // #5: custom + baseDomain + naked domain (N3)
  {
    id: 5,
    name: 'A: custom + baseDomain + naked domain (N3)',
    naked: 'N3',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: null,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: BASE_DOMAIN,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: true,
      hasLoginUi: false,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: `https://${BASE_DOMAIN}`,
      issuerUrlWithTenant: `https://acme.${BASE_DOMAIN}`,
      allowedOrigins: [API_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ALLOWED_ORIGINS: API_CUSTOM,
        BASE_DOMAIN: BASE_DOMAIN,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        NAKED_DOMAIN_AS_ISSUER: 'true',
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_CUSTOM,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_CUSTOM,
      },
    },
  },

  // #6: workers.dev + baseDomain, multi-tenant, N1
  {
    id: 6,
    name: 'A: workers.dev + baseDomain, multi-tenant',
    naked: 'N1',
    config: {
      apiCustom: null,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: null,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: BASE_DOMAIN,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: false,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: `https://${DEFAULT_TENANT}.${BASE_DOMAIN}`,
      issuerUrlWithTenant: `https://acme.${BASE_DOMAIN}`,
      allowedOrigins: [API_WORKERS_DEV],
      setupUrlBase: API_WORKERS_DEV,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
        BASE_DOMAIN: BASE_DOMAIN,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
      },
    },
  },

  // #7: workers.dev + baseDomain + primary tenant (N2)
  {
    id: 7,
    name: 'A: workers.dev + baseDomain + primary (N2)',
    naked: 'N2',
    config: {
      apiCustom: null,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: null,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: BASE_DOMAIN,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: PRIMARY_TENANT,
      nakedDomain: false,
      hasLoginUi: false,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: `https://${DEFAULT_TENANT}.${BASE_DOMAIN}`,
      issuerUrlWithTenant: `https://acme.${BASE_DOMAIN}`,
      allowedOrigins: [API_WORKERS_DEV],
      setupUrlBase: API_WORKERS_DEV,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
        BASE_DOMAIN: BASE_DOMAIN,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        PRIMARY_TENANT_ID: PRIMARY_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
      },
    },
  },

  // =========================================================================
  // Deploy D (API + Login UI, separate domains) — 6 scenarios
  // =========================================================================

  // #8: custom API + custom LoginUI, no baseDomain, N1
  {
    id: 8,
    name: 'D: custom API + custom LoginUI, no baseDomain',
    naked: 'N1',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: LOGIN_UI_CUSTOM,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: null,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: API_CUSTOM,
      issuerUrlWithTenant: API_CUSTOM,
      allowedOrigins: [API_CUSTOM, LOGIN_UI_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_CUSTOM,
        UI_URL: LOGIN_UI_CUSTOM,
        ADMIN_UI_URL: API_CUSTOM,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_CUSTOM,
        ADMIN_UI_URL: API_CUSTOM,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
      },
    },
  },

  // #9: custom API + custom LoginUI + baseDomain, N1
  {
    id: 9,
    name: 'D: custom API + custom LoginUI + baseDomain',
    naked: 'N1',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: LOGIN_UI_CUSTOM,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: BASE_DOMAIN,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: `https://${DEFAULT_TENANT}.${BASE_DOMAIN}`,
      issuerUrlWithTenant: `https://acme.${BASE_DOMAIN}`,
      allowedOrigins: [API_CUSTOM, LOGIN_UI_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: LOGIN_UI_CUSTOM,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
        BASE_DOMAIN: BASE_DOMAIN,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
      },
    },
  },

  // #10: custom API + pages.dev LoginUI, no baseDomain, N1
  {
    id: 10,
    name: 'D: custom API + pages.dev LoginUI, no baseDomain',
    naked: 'N1',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: null,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: API_CUSTOM,
      issuerUrlWithTenant: API_CUSTOM,
      allowedOrigins: [API_CUSTOM, LOGIN_UI_PAGES_DEV],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_CUSTOM,
        UI_URL: LOGIN_UI_PAGES_DEV,
        ADMIN_UI_URL: API_CUSTOM,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_PAGES_DEV}`,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_CUSTOM,
        ADMIN_UI_URL: API_CUSTOM,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_PAGES_DEV}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_PAGES_DEV}`,
      },
    },
  },

  // #11: workers.dev API + pages.dev LoginUI, no baseDomain, N1
  {
    id: 11,
    name: 'D: workers.dev API + pages.dev LoginUI',
    naked: 'N1',
    config: {
      apiCustom: null,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: null,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: API_WORKERS_DEV,
      issuerUrlWithTenant: API_WORKERS_DEV,
      allowedOrigins: [API_WORKERS_DEV, LOGIN_UI_PAGES_DEV],
      setupUrlBase: API_WORKERS_DEV,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: LOGIN_UI_PAGES_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ALLOWED_ORIGINS: `${API_WORKERS_DEV},${LOGIN_UI_PAGES_DEV}`,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_WORKERS_DEV},${LOGIN_UI_PAGES_DEV}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_WORKERS_DEV},${LOGIN_UI_PAGES_DEV}`,
      },
    },
  },

  // #12: custom API + custom LoginUI + baseDomain, N2
  {
    id: 12,
    name: 'D: custom API + custom LoginUI + baseDomain (N2)',
    naked: 'N2',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: LOGIN_UI_CUSTOM,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: BASE_DOMAIN,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: PRIMARY_TENANT,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: `https://${DEFAULT_TENANT}.${BASE_DOMAIN}`,
      issuerUrlWithTenant: `https://acme.${BASE_DOMAIN}`,
      allowedOrigins: [API_CUSTOM, LOGIN_UI_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: LOGIN_UI_CUSTOM,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
        BASE_DOMAIN: BASE_DOMAIN,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        PRIMARY_TENANT_ID: PRIMARY_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
      },
    },
  },

  // #13: custom API + custom LoginUI + baseDomain, N3
  {
    id: 13,
    name: 'D: custom API + custom LoginUI + baseDomain (N3)',
    naked: 'N3',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: LOGIN_UI_CUSTOM,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: BASE_DOMAIN,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: true,
      hasLoginUi: true,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: `https://${BASE_DOMAIN}`,
      issuerUrlWithTenant: `https://acme.${BASE_DOMAIN}`,
      allowedOrigins: [API_CUSTOM, LOGIN_UI_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: LOGIN_UI_CUSTOM,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
        BASE_DOMAIN: BASE_DOMAIN,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        NAKED_DOMAIN_AS_ISSUER: 'true',
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
      },
    },
  },

  // =========================================================================
  // Deploy E (API + Login UI sameAsApi) — 4 scenarios
  // =========================================================================

  // #14: custom API + sameAsApi LoginUI, no baseDomain
  {
    id: 14,
    name: 'E: custom API + sameAsApi, no baseDomain',
    naked: 'N1',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: true,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: null,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: API_CUSTOM,
      issuerUrlWithTenant: API_CUSTOM,
      // sameAsApi: UI is proxied through API domain, so origin deduplicates
      allowedOrigins: [API_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_CUSTOM,
        // sameAsApi=true → UI_URL uses API domain
        UI_URL: API_CUSTOM,
        ADMIN_UI_URL: API_CUSTOM,
        ALLOWED_ORIGINS: API_CUSTOM,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'Lax',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_CUSTOM,
        ADMIN_UI_URL: API_CUSTOM,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_CUSTOM,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_CUSTOM,
      },
    },
  },

  // #15: custom API + sameAsApi + baseDomain
  {
    id: 15,
    name: 'E: custom API + sameAsApi + baseDomain',
    naked: 'N1',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: true,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: BASE_DOMAIN,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: `https://${DEFAULT_TENANT}.${BASE_DOMAIN}`,
      issuerUrlWithTenant: `https://acme.${BASE_DOMAIN}`,
      // sameAsApi: origin deduplicates with API
      allowedOrigins: [API_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        // sameAsApi=true → UI_URL uses API domain
        UI_URL: API_CUSTOM,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ALLOWED_ORIGINS: API_CUSTOM,
        BASE_DOMAIN: BASE_DOMAIN,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'Lax',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_CUSTOM,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_CUSTOM,
      },
    },
  },

  // #16: workers.dev API + sameAsApi, no baseDomain
  {
    id: 16,
    name: 'E: workers.dev + sameAsApi, no baseDomain',
    naked: 'N1',
    config: {
      apiCustom: null,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: true,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: null,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: API_WORKERS_DEV,
      issuerUrlWithTenant: API_WORKERS_DEV,
      // sameAsApi: origin deduplicates with API
      allowedOrigins: [API_WORKERS_DEV],
      setupUrlBase: API_WORKERS_DEV,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        // sameAsApi=true → UI_URL uses API domain
        UI_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'Lax',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
      },
    },
  },

  // #17: workers.dev + sameAsApi + baseDomain
  {
    id: 17,
    name: 'E: workers.dev + sameAsApi + baseDomain',
    naked: 'N1',
    config: {
      apiCustom: null,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: true,
      adminUiCustom: null,
      adminUiAuto: null,
      adminUiSameAsApi: false,
      baseDomain: BASE_DOMAIN,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: false,
    },
    expected: {
      issuerUrl: `https://${DEFAULT_TENANT}.${BASE_DOMAIN}`,
      issuerUrlWithTenant: `https://acme.${BASE_DOMAIN}`,
      // sameAsApi: origin deduplicates with API
      allowedOrigins: [API_WORKERS_DEV],
      setupUrlBase: API_WORKERS_DEV,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        // sameAsApi=true → UI_URL uses API domain
        UI_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
        BASE_DOMAIN: BASE_DOMAIN,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'Lax',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: API_WORKERS_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_WORKERS_DEV,
      },
    },
  },

  // =========================================================================
  // Deploy F (API + Login UI + Admin UI) — 10 scenarios
  // =========================================================================

  // #18: all custom, no baseDomain, N1
  {
    id: 18,
    name: 'F: all custom, no baseDomain',
    naked: 'N1',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: LOGIN_UI_CUSTOM,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: false,
      adminUiCustom: ADMIN_UI_CUSTOM,
      adminUiAuto: ADMIN_UI_PAGES_DEV,
      adminUiSameAsApi: false,
      baseDomain: null,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: true,
    },
    expected: {
      issuerUrl: API_CUSTOM,
      issuerUrlWithTenant: API_CUSTOM,
      allowedOrigins: [API_CUSTOM, LOGIN_UI_CUSTOM, ADMIN_UI_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_CUSTOM,
        UI_URL: LOGIN_UI_CUSTOM,
        ADMIN_UI_URL: ADMIN_UI_CUSTOM,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM},${ADMIN_UI_CUSTOM}`,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_CUSTOM,
        ADMIN_UI_URL: ADMIN_UI_CUSTOM,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM},${ADMIN_UI_CUSTOM}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM},${ADMIN_UI_CUSTOM}`,
      },
    },
  },

  // #19: all custom + baseDomain, N1
  {
    id: 19,
    name: 'F: all custom + baseDomain',
    naked: 'N1',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: LOGIN_UI_CUSTOM,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: false,
      adminUiCustom: ADMIN_UI_CUSTOM,
      adminUiAuto: ADMIN_UI_PAGES_DEV,
      adminUiSameAsApi: false,
      baseDomain: BASE_DOMAIN,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: true,
    },
    expected: {
      issuerUrl: `https://${DEFAULT_TENANT}.${BASE_DOMAIN}`,
      issuerUrlWithTenant: `https://acme.${BASE_DOMAIN}`,
      allowedOrigins: [API_CUSTOM, LOGIN_UI_CUSTOM, ADMIN_UI_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: LOGIN_UI_CUSTOM,
        ADMIN_UI_URL: ADMIN_UI_CUSTOM,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM},${ADMIN_UI_CUSTOM}`,
        BASE_DOMAIN: BASE_DOMAIN,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: ADMIN_UI_CUSTOM,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM},${ADMIN_UI_CUSTOM}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM},${ADMIN_UI_CUSTOM}`,
      },
    },
  },

  // #20: all custom + baseDomain, N2
  {
    id: 20,
    name: 'F: all custom + baseDomain (N2)',
    naked: 'N2',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: LOGIN_UI_CUSTOM,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: false,
      adminUiCustom: ADMIN_UI_CUSTOM,
      adminUiAuto: ADMIN_UI_PAGES_DEV,
      adminUiSameAsApi: false,
      baseDomain: BASE_DOMAIN,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: PRIMARY_TENANT,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: true,
    },
    expected: {
      issuerUrl: `https://${DEFAULT_TENANT}.${BASE_DOMAIN}`,
      issuerUrlWithTenant: `https://acme.${BASE_DOMAIN}`,
      allowedOrigins: [API_CUSTOM, LOGIN_UI_CUSTOM, ADMIN_UI_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: LOGIN_UI_CUSTOM,
        ADMIN_UI_URL: ADMIN_UI_CUSTOM,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM},${ADMIN_UI_CUSTOM}`,
        BASE_DOMAIN: BASE_DOMAIN,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        PRIMARY_TENANT_ID: PRIMARY_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: ADMIN_UI_CUSTOM,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM},${ADMIN_UI_CUSTOM}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM},${ADMIN_UI_CUSTOM}`,
      },
    },
  },

  // #21: all custom + baseDomain, N3
  {
    id: 21,
    name: 'F: all custom + baseDomain (N3)',
    naked: 'N3',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: LOGIN_UI_CUSTOM,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: false,
      adminUiCustom: ADMIN_UI_CUSTOM,
      adminUiAuto: ADMIN_UI_PAGES_DEV,
      adminUiSameAsApi: false,
      baseDomain: BASE_DOMAIN,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: true,
      hasLoginUi: true,
      hasAdminUi: true,
    },
    expected: {
      issuerUrl: `https://${BASE_DOMAIN}`,
      issuerUrlWithTenant: `https://acme.${BASE_DOMAIN}`,
      allowedOrigins: [API_CUSTOM, LOGIN_UI_CUSTOM, ADMIN_UI_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: LOGIN_UI_CUSTOM,
        ADMIN_UI_URL: ADMIN_UI_CUSTOM,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM},${ADMIN_UI_CUSTOM}`,
        BASE_DOMAIN: BASE_DOMAIN,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        NAKED_DOMAIN_AS_ISSUER: 'true',
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: ADMIN_UI_CUSTOM,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM},${ADMIN_UI_CUSTOM}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM},${ADMIN_UI_CUSTOM}`,
      },
    },
  },

  // #22: custom API + pages.dev LoginUI + pages.dev AdminUI, N1
  {
    id: 22,
    name: 'F: custom API + pages.dev UIs',
    naked: 'N1',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: ADMIN_UI_PAGES_DEV,
      adminUiSameAsApi: false,
      baseDomain: null,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: true,
    },
    expected: {
      issuerUrl: API_CUSTOM,
      issuerUrlWithTenant: API_CUSTOM,
      allowedOrigins: [API_CUSTOM, LOGIN_UI_PAGES_DEV],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_CUSTOM,
        UI_URL: LOGIN_UI_PAGES_DEV,
        ADMIN_UI_URL: ADMIN_UI_PAGES_DEV,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_PAGES_DEV}`,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_CUSTOM,
        ADMIN_UI_URL: ADMIN_UI_PAGES_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_PAGES_DEV}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_PAGES_DEV}`,
      },
    },
  },

  // #23: workers.dev API + pages.dev UIs, N1
  {
    id: 23,
    name: 'F: workers.dev API + pages.dev UIs',
    naked: 'N1',
    config: {
      apiCustom: null,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: ADMIN_UI_PAGES_DEV,
      adminUiSameAsApi: false,
      baseDomain: null,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: true,
    },
    expected: {
      issuerUrl: API_WORKERS_DEV,
      issuerUrlWithTenant: API_WORKERS_DEV,
      allowedOrigins: [API_WORKERS_DEV, LOGIN_UI_PAGES_DEV],
      setupUrlBase: API_WORKERS_DEV,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: LOGIN_UI_PAGES_DEV,
        ADMIN_UI_URL: ADMIN_UI_PAGES_DEV,
        ALLOWED_ORIGINS: `${API_WORKERS_DEV},${LOGIN_UI_PAGES_DEV}`,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: ADMIN_UI_PAGES_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_WORKERS_DEV},${LOGIN_UI_PAGES_DEV}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_WORKERS_DEV},${LOGIN_UI_PAGES_DEV}`,
      },
    },
  },

  // #24: custom API + sameAsApi LoginUI + custom AdminUI, N1
  {
    id: 24,
    name: 'F: custom API + sameAsApi LoginUI + custom AdminUI',
    naked: 'N1',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: true,
      adminUiCustom: ADMIN_UI_CUSTOM,
      adminUiAuto: ADMIN_UI_PAGES_DEV,
      adminUiSameAsApi: false,
      baseDomain: null,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: true,
    },
    expected: {
      issuerUrl: API_CUSTOM,
      issuerUrlWithTenant: API_CUSTOM,
      // sameAsApi LoginUI: origin deduplicates with API
      allowedOrigins: [API_CUSTOM, ADMIN_UI_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_CUSTOM,
        // sameAsApi=true → UI_URL uses API domain
        UI_URL: API_CUSTOM,
        ADMIN_UI_URL: ADMIN_UI_CUSTOM,
        ALLOWED_ORIGINS: `${API_CUSTOM},${ADMIN_UI_CUSTOM}`,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'Lax',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_CUSTOM,
        ADMIN_UI_URL: ADMIN_UI_CUSTOM,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${ADMIN_UI_CUSTOM}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${ADMIN_UI_CUSTOM}`,
      },
    },
  },

  // #25: custom API + custom LoginUI + sameAsApi AdminUI, N1
  {
    id: 25,
    name: 'F: custom API + custom LoginUI + sameAsApi AdminUI',
    naked: 'N1',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: LOGIN_UI_CUSTOM,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: ADMIN_UI_PAGES_DEV,
      adminUiSameAsApi: true,
      baseDomain: null,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: true,
    },
    expected: {
      issuerUrl: API_CUSTOM,
      issuerUrlWithTenant: API_CUSTOM,
      // sameAsApi AdminUI: origin deduplicates with API
      allowedOrigins: [API_CUSTOM, LOGIN_UI_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_CUSTOM,
        UI_URL: LOGIN_UI_CUSTOM,
        // sameAsApi=true → ADMIN_UI_URL uses API domain
        ADMIN_UI_URL: API_CUSTOM,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'Lax',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_CUSTOM,
        ADMIN_UI_URL: API_CUSTOM,
        ADMIN_COOKIE_SAME_SITE: 'Lax',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_CUSTOM},${LOGIN_UI_CUSTOM}`,
      },
    },
  },

  // #26: custom API + sameAsApi LoginUI + sameAsApi AdminUI, N1
  {
    id: 26,
    name: 'F: custom API + both sameAsApi',
    naked: 'N1',
    config: {
      apiCustom: API_CUSTOM,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: true,
      adminUiCustom: null,
      adminUiAuto: ADMIN_UI_PAGES_DEV,
      adminUiSameAsApi: true,
      baseDomain: null,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: true,
    },
    expected: {
      issuerUrl: API_CUSTOM,
      issuerUrlWithTenant: API_CUSTOM,
      // both sameAsApi: all origins deduplicate to API
      allowedOrigins: [API_CUSTOM],
      setupUrlBase: API_CUSTOM,
      arAuthEnvVars: {
        ISSUER_URL: API_CUSTOM,
        // sameAsApi=true → UI_URL uses API domain
        UI_URL: API_CUSTOM,
        // sameAsApi=true → ADMIN_UI_URL uses API domain
        ADMIN_UI_URL: API_CUSTOM,
        ALLOWED_ORIGINS: API_CUSTOM,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'Lax',
        ADMIN_COOKIE_SAME_SITE: 'Lax',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_CUSTOM,
        ADMIN_UI_URL: API_CUSTOM,
        ADMIN_COOKIE_SAME_SITE: 'Lax',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_CUSTOM,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: API_CUSTOM,
      },
    },
  },

  // #27: workers.dev + pages.dev UIs + baseDomain, N1
  {
    id: 27,
    name: 'F: workers.dev + pages.dev UIs + baseDomain',
    naked: 'N1',
    config: {
      apiCustom: null,
      apiAuto: API_WORKERS_DEV,
      loginUiCustom: null,
      loginUiAuto: LOGIN_UI_PAGES_DEV,
      loginUiSameAsApi: false,
      adminUiCustom: null,
      adminUiAuto: ADMIN_UI_PAGES_DEV,
      adminUiSameAsApi: false,
      baseDomain: BASE_DOMAIN,
      defaultTenantId: DEFAULT_TENANT,
      primaryTenantId: null,
      nakedDomain: false,
      hasLoginUi: true,
      hasAdminUi: true,
    },
    expected: {
      issuerUrl: `https://${DEFAULT_TENANT}.${BASE_DOMAIN}`,
      issuerUrlWithTenant: `https://acme.${BASE_DOMAIN}`,
      allowedOrigins: [API_WORKERS_DEV, LOGIN_UI_PAGES_DEV],
      setupUrlBase: API_WORKERS_DEV,
      arAuthEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        UI_URL: LOGIN_UI_PAGES_DEV,
        ADMIN_UI_URL: ADMIN_UI_PAGES_DEV,
        ALLOWED_ORIGINS: `${API_WORKERS_DEV},${LOGIN_UI_PAGES_DEV}`,
        BASE_DOMAIN: BASE_DOMAIN,
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        COOKIE_SAME_SITE: 'None',
        ADMIN_COOKIE_SAME_SITE: 'None',
      },
      arManagementEnvVars: {
        ISSUER_URL: API_WORKERS_DEV,
        ADMIN_UI_URL: ADMIN_UI_PAGES_DEV,
        ADMIN_COOKIE_SAME_SITE: 'None',
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_WORKERS_DEV},${LOGIN_UI_PAGES_DEV}`,
      },
      arRouterEnvVars: {
        DEFAULT_TENANT_ID: DEFAULT_TENANT,
        ALLOWED_ORIGINS: `${API_WORKERS_DEV},${LOGIN_UI_PAGES_DEV}`,
      },
    },
  },
];

// =============================================================================
// Helpers for test files
// =============================================================================

/** Format scenario label for test names */
export function scenarioLabel(s: Scenario): string {
  return `#${s.id} ${s.name}`;
}

/** Get scenarios with baseDomain set (multi-tenant) */
export function getScenariosWithBaseDomain(): Scenario[] {
  return SCENARIOS.filter(s => s.config.baseDomain !== null);
}

/** Get scenarios without baseDomain (single-tenant) */
export function getScenariosWithoutBaseDomain(): Scenario[] {
  return SCENARIOS.filter(s => s.config.baseDomain === null);
}
