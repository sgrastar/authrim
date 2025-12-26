/**
 * Contract Default Values
 *
 * Default values for TenantContract and ClientContract sub-policies.
 * These are used when creating new contracts from presets or when
 * fields are not explicitly specified.
 *
 * Design principle: Defaults favor security over convenience.
 */

import type {
  TenantOAuthPolicy,
  TenantSessionPolicy,
  TenantSecurityPolicy,
  TenantEncryptionPolicy,
  TenantScopePolicy,
  TenantAuthMethodPolicy,
  TenantConsentPolicy,
  TenantCibaPolicy,
  TenantDeviceFlowPolicy,
  TenantExternalIdpPolicy,
  TenantFederationPolicy,
  TenantScimPolicy,
  TenantRateLimitPolicy,
  TenantTokensPolicy,
  TenantCredentialsPolicy,
  TenantDataResidencyPolicy,
  TenantAuditPolicy,
} from './tenant';

import type {
  ClientOAuthConfig,
  ClientEncryptionConfig,
  ClientScopeConfig,
  ClientAuthMethodConfig,
  ClientConsentConfig,
  ClientRedirectConfig,
  ClientTypeConfig,
  ClientTokenConfig,
} from './client';

// =============================================================================
// Tenant Policy Defaults
// =============================================================================

/**
 * Default OAuth policy (B2C standard profile).
 */
export const DEFAULT_TENANT_OAUTH_POLICY: TenantOAuthPolicy = {
  // Token expiry upper bounds
  maxAccessTokenExpiry: 3600, // 1 hour
  maxRefreshTokenExpiry: 2592000, // 30 days
  maxIdTokenExpiry: 3600, // 1 hour
  maxAuthCodeTtl: 600, // 10 minutes

  // Security requirements - recommended as default, not required
  pkceRequirement: 'recommended',
  parRequirement: 'optional',
  jarmEnabled: false,

  // Response types - code flow only by default (most secure)
  allowedResponseTypes: ['code'],

  // Signing algorithms - RS256 and ES256 as common choices
  allowedIdTokenSigningAlgs: ['RS256', 'ES256'],

  // Behavioral settings
  refreshTokenRotation: true, // Security: rotate on each refresh
  refreshIdTokenReissue: false, // Performance: don't reissue unless needed
  offlineAccessRequired: true, // Explicit scope required for refresh tokens
};

/**
 * Default session policy.
 */
export const DEFAULT_TENANT_SESSION_POLICY: TenantSessionPolicy = {
  maxSessionAge: 86400, // 24 hours
  idleTimeout: 3600, // 1 hour
  maxConcurrentSessions: undefined, // No limit by default
  allowSessionExtension: true,
  slidingSessionEnabled: true,
};

/**
 * Default security policy.
 */
export const DEFAULT_TENANT_SECURITY_POLICY: TenantSecurityPolicy = {
  tier: 'standard',
  complianceModules: [],
  mfa: {
    requirement: 'optional',
    allowedMethods: ['totp', 'passkey', 'email'],
    rememberDurationMax: 2592000, // 30 days
    conditions: [],
  },
  passwordPolicy: {
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireNumbers: true,
    requireSpecialChars: false, // Optional for usability
    historyCount: 3,
    maxAgeDays: 0, // No expiry by default
  },
};

/**
 * Default encryption policy.
 */
export const DEFAULT_TENANT_ENCRYPTION_POLICY: TenantEncryptionPolicy = {
  allowedSigningAlgorithms: ['RS256', 'ES256', 'PS256'],
  allowedKeyEncryptionAlgorithms: ['RSA-OAEP', 'RSA-OAEP-256', 'ECDH-ES'],
  allowedContentEncryptionAlgorithms: ['A128GCM', 'A256GCM'],
  piiEncryptionRequired: false, // Not required by default
};

/**
 * Default scope policy.
 */
export const DEFAULT_TENANT_SCOPE_POLICY: TenantScopePolicy = {
  allowedScopes: ['openid', 'profile', 'email', 'offline_access'],
  forbiddenScopes: [],
  customScopes: [],
  customClaims: [],
};

/**
 * Default authentication method policy.
 */
export const DEFAULT_TENANT_AUTH_METHOD_POLICY: TenantAuthMethodPolicy = {
  passkey: 'enabled',
  emailCode: 'enabled',
  password: 'enabled',
  externalIdp: 'enabled',
  did: 'disabled', // Emerging technology, disabled by default
};

/**
 * Default consent policy.
 */
export const DEFAULT_TENANT_CONSENT_POLICY: TenantConsentPolicy = {
  firstPartyDefault: 'skip', // Trust first-party apps
  thirdPartyDefault: 'always', // Always show consent for third-party
  maxRememberDuration: 31536000, // 1 year
  allowImplicitScopes: true,
};

/**
 * Default CIBA policy.
 */
export const DEFAULT_TENANT_CIBA_POLICY: TenantCibaPolicy = {
  enabled: false, // Disabled by default
  allowedModes: ['poll'],
  maxRequestExpiry: 300, // 5 minutes
  pollingInterval: 5, // 5 seconds
};

/**
 * Default device flow policy.
 */
export const DEFAULT_TENANT_DEVICE_FLOW_POLICY: TenantDeviceFlowPolicy = {
  enabled: false, // Disabled by default
  userCodeLength: 8,
  deviceCodeExpiry: 1800, // 30 minutes
  pollingInterval: 5, // 5 seconds
};

/**
 * Default external IdP policy.
 */
export const DEFAULT_TENANT_EXTERNAL_IDP_POLICY: TenantExternalIdpPolicy = {
  enabled: true,
  allowedProviders: [], // Empty = all allowed
  jitProvisioningEnabled: true,
  accountLinkingEnabled: true,
};

/**
 * Default federation policy.
 */
export const DEFAULT_TENANT_FEDERATION_POLICY: TenantFederationPolicy = {
  enabled: false, // Disabled by default
  samlEnabled: false,
  oidcEnabled: false,
  maxAssertionLifetime: 300, // 5 minutes
};

/**
 * Default SCIM policy.
 */
export const DEFAULT_TENANT_SCIM_POLICY: TenantScimPolicy = {
  enabled: false, // Disabled by default
  autoProvisioningEnabled: false,
  allowedOperations: ['create', 'read', 'update', 'delete'],
};

/**
 * Default rate limit policy.
 */
export const DEFAULT_TENANT_RATE_LIMIT_POLICY: TenantRateLimitPolicy = {
  loginAttemptsPerMinute: 10,
  tokenRequestsPerMinute: 100,
  apiRequestsPerMinute: 1000,
  lockoutDuration: 300, // 5 minutes
};

/**
 * Default tokens policy.
 */
export const DEFAULT_TENANT_TOKENS_POLICY: TenantTokensPolicy = {
  idTokenAudFormat: 'array',
  issResponseParam: true, // RFC 9207 compliance
  introspectionEnabled: true,
  revocationEnabled: true,
};

/**
 * Default credentials policy.
 */
export const DEFAULT_TENANT_CREDENTIALS_POLICY: TenantCredentialsPolicy = {
  clientSecretMinLength: 32,
  clientSecretRotationRequired: false,
  maxClientSecretAgeDays: 0, // No expiry by default
};

/**
 * Default data residency policy.
 */
export const DEFAULT_TENANT_DATA_RESIDENCY_POLICY: TenantDataResidencyPolicy = {
  enabled: false,
  primaryRegion: undefined,
  allowedRegions: undefined,
  piiStoragePolicy: undefined,
};

/**
 * Default audit policy.
 */
export const DEFAULT_TENANT_AUDIT_POLICY: TenantAuditPolicy = {
  retentionDays: 90, // 3 months
  detailLevel: 'standard',
  flowReplayEnabled: false, // Privacy-conscious default
};

// =============================================================================
// Client Config Defaults
// =============================================================================

/**
 * Default client type config (public SPA).
 */
export const DEFAULT_CLIENT_TYPE_CONFIG: ClientTypeConfig = {
  type: 'public',
  isFirstParty: false,
  authenticationMethod: undefined, // Not applicable for public
};

/**
 * Default client OAuth config.
 */
export const DEFAULT_CLIENT_OAUTH_CONFIG: ClientOAuthConfig = {
  // Token expiry
  accessTokenExpiry: 3600, // 1 hour
  refreshTokenExpiry: 2592000, // 30 days
  idTokenExpiry: 3600, // 1 hour
  authCodeTtl: 600, // 10 minutes

  // Signing algorithm
  idTokenSigningAlg: 'RS256',

  // Response types and grant types
  allowedResponseTypes: ['code'],
  allowedGrantTypes: ['authorization_code', 'refresh_token'],

  // Security requirements
  pkceRequired: true, // Security default
  parRequired: false,

  // Behavioral settings
  refreshTokenRotation: true, // Security: rotate on each refresh
  refreshIdTokenReissue: false, // Performance: don't reissue unless needed
  offlineAccessRequired: true, // Explicit scope required for refresh tokens
};

/**
 * Default client encryption config.
 */
export const DEFAULT_CLIENT_ENCRYPTION_CONFIG: ClientEncryptionConfig = {
  keyEncryptionAlg: undefined, // No encryption by default
  contentEncryptionAlg: undefined,
  encryptIdToken: false,
  encryptUserInfo: false,
};

/**
 * Default client scope config.
 */
export const DEFAULT_CLIENT_SCOPE_CONFIG: ClientScopeConfig = {
  allowedScopes: ['openid', 'profile', 'email'],
  defaultScopes: ['openid'],
  allowDynamicScopes: true,
  claimMappings: [],
};

/**
 * Default client auth method config.
 */
export const DEFAULT_CLIENT_AUTH_METHOD_CONFIG: ClientAuthMethodConfig = {
  passkey: true,
  emailCode: true,
  password: true,
  externalIdp: true,
  did: false,
  preferredMethod: undefined,
};

/**
 * Default client consent config.
 */
export const DEFAULT_CLIENT_CONSENT_CONFIG: ClientConsentConfig = {
  policy: 'remember',
  rememberDuration: 31536000, // 1 year
  implicitScopes: [],
  scopeDescriptions: {},
  allowGranularConsent: false, // Simple consent by default
};

/**
 * Default client redirect config.
 */
export const DEFAULT_CLIENT_REDIRECT_CONFIG: ClientRedirectConfig = {
  allowedRedirectUris: [],
  allowedRedirectPatterns: [],
  allowLocalhost: false, // Security default
  postLogoutRedirectUris: [],
};

/**
 * Default client token config.
 */
export const DEFAULT_CLIENT_TOKEN_CONFIG: ClientTokenConfig = {
  idTokenAudFormat: 'array',
  issResponseParam: true, // RFC 9207 compliance
  introspectionEnabled: true,
  revocationEnabled: true,
  accessTokenFormat: 'jwt',
  customAccessTokenClaims: undefined,
};

// =============================================================================
// All Tenant Defaults Combined
// =============================================================================

/**
 * All tenant policy defaults combined.
 * Use with spread operator: { ...DEFAULT_TENANT_POLICIES, oauth: customOAuth }
 */
export const DEFAULT_TENANT_POLICIES = {
  oauth: DEFAULT_TENANT_OAUTH_POLICY,
  session: DEFAULT_TENANT_SESSION_POLICY,
  security: DEFAULT_TENANT_SECURITY_POLICY,
  encryption: DEFAULT_TENANT_ENCRYPTION_POLICY,
  scopes: DEFAULT_TENANT_SCOPE_POLICY,
  authMethods: DEFAULT_TENANT_AUTH_METHOD_POLICY,
  consent: DEFAULT_TENANT_CONSENT_POLICY,
  ciba: DEFAULT_TENANT_CIBA_POLICY,
  deviceFlow: DEFAULT_TENANT_DEVICE_FLOW_POLICY,
  externalIdp: DEFAULT_TENANT_EXTERNAL_IDP_POLICY,
  federation: DEFAULT_TENANT_FEDERATION_POLICY,
  scim: DEFAULT_TENANT_SCIM_POLICY,
  rateLimit: DEFAULT_TENANT_RATE_LIMIT_POLICY,
  tokens: DEFAULT_TENANT_TOKENS_POLICY,
  credentials: DEFAULT_TENANT_CREDENTIALS_POLICY,
  dataResidency: DEFAULT_TENANT_DATA_RESIDENCY_POLICY,
  audit: DEFAULT_TENANT_AUDIT_POLICY,
} as const;

/**
 * All client config defaults combined.
 */
export const DEFAULT_CLIENT_CONFIGS = {
  clientType: DEFAULT_CLIENT_TYPE_CONFIG,
  oauth: DEFAULT_CLIENT_OAUTH_CONFIG,
  encryption: DEFAULT_CLIENT_ENCRYPTION_CONFIG,
  scopes: DEFAULT_CLIENT_SCOPE_CONFIG,
  authMethods: DEFAULT_CLIENT_AUTH_METHOD_CONFIG,
  consent: DEFAULT_CLIENT_CONSENT_CONFIG,
  redirect: DEFAULT_CLIENT_REDIRECT_CONFIG,
  tokens: DEFAULT_CLIENT_TOKEN_CONFIG,
} as const;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get a deep copy of default tenant policies.
 * Use this to get mutable defaults that can be modified.
 */
export function getDefaultTenantPolicies(): typeof DEFAULT_TENANT_POLICIES {
  return JSON.parse(JSON.stringify(DEFAULT_TENANT_POLICIES));
}

/**
 * Get a deep copy of default client configs.
 * Use this to get mutable defaults that can be modified.
 */
export function getDefaultClientConfigs(): typeof DEFAULT_CLIENT_CONFIGS {
  return JSON.parse(JSON.stringify(DEFAULT_CLIENT_CONFIGS));
}

/**
 * Merge partial policies with defaults.
 * Useful for applying presets or user overrides.
 */
export function mergeTenantPolicies<K extends keyof typeof DEFAULT_TENANT_POLICIES>(
  category: K,
  overrides: Partial<(typeof DEFAULT_TENANT_POLICIES)[K]>
): (typeof DEFAULT_TENANT_POLICIES)[K] {
  return {
    ...DEFAULT_TENANT_POLICIES[category],
    ...overrides,
  } as (typeof DEFAULT_TENANT_POLICIES)[K];
}
