/**
 * Authrim Configuration Schema
 *
 * This module defines the configuration schema using Zod for type safety
 * and validation. The configuration is stored in authrim-config.json.
 */

import { z } from 'zod';

// =============================================================================
// URL Configuration
// =============================================================================

export const UrlConfigSchema = z.object({
  /** Custom domain (null = use auto-generated URL) */
  custom: z.string().url().nullable().optional(),
  /** Auto-generated URL (workers.dev or pages.dev) */
  auto: z.string().url().optional(),
});

export const UrlsConfigSchema = z.object({
  /** API / OIDC issuer URL */
  api: UrlConfigSchema,
  /** Login UI URL */
  loginUi: UrlConfigSchema,
  /** Admin UI URL */
  adminUi: UrlConfigSchema,
});

// =============================================================================
// Source Information
// =============================================================================

export const SourceInfoSchema = z.object({
  /** GitHub repository (e.g., "sgrastar/authrim") */
  repository: z.string(),
  /** Git reference (tag or branch) */
  gitRef: z.string(),
  /** Full commit hash */
  commitHash: z.string(),
  /** SHA256 hash of the source artifact */
  artifactHash: z.string().optional(),
});

// =============================================================================
// Environment Configuration
// =============================================================================

export const EnvironmentConfigSchema = z.object({
  /** Environment prefix (e.g., "prod", "staging", "dev") */
  prefix: z.string().regex(/^[a-z][a-z0-9-]*$/, {
    message:
      'Prefix must start with a letter and contain only lowercase letters, numbers, and hyphens',
  }),
});

// =============================================================================
// Tenant Configuration
// =============================================================================

export const TenantConfigSchema = z.object({
  /** Default tenant identifier (used in single-tenant mode) */
  name: z.string().default('default'),
  /** Human-readable tenant/organization name */
  displayName: z.string().default('Default Tenant'),
  /**
   * Multi-tenant mode with subdomain-based tenant isolation
   * - true: issuer = https://{tenant}.{baseDomain}
   * - false: issuer = ISSUER_URL (single-tenant)
   */
  multiTenant: z.boolean().default(false),
  /**
   * Base domain for multi-tenant mode (e.g., "authrim.com")
   * Issuer URL will be: https://{tenant}.{baseDomain}
   */
  baseDomain: z.string().optional(),
});

// =============================================================================
// Components Configuration
// =============================================================================

export const ComponentsConfigSchema = z.object({
  /** Core API components (always enabled) */
  api: z.boolean().default(true),
  /** Login UI component */
  loginUi: z.boolean().default(true),
  /** Admin UI component */
  adminUi: z.boolean().default(true),
  /** SAML IdP/SP support */
  saml: z.boolean().default(false),
  /** Async queue processing */
  async: z.boolean().default(false),
  /** Verifiable Credentials */
  vc: z.boolean().default(false),
  /** External IdP Bridge (Social Login) - standard component */
  bridge: z.boolean().default(true),
  /** ReBAC Policy service - standard component */
  policy: z.boolean().default(true),
});

// =============================================================================
// OIDC Configuration
// =============================================================================

export const OidcConfigSchema = z.object({
  /** Access token TTL in seconds */
  accessTokenTtl: z.number().int().positive().default(3600),
  /** Refresh token TTL in seconds */
  refreshTokenTtl: z.number().int().positive().default(604800),
  /** Authorization code TTL in seconds */
  authCodeTtl: z.number().int().positive().default(600),
  /** Require PKCE for all clients */
  pkceRequired: z.boolean().default(true),
  /** Supported response types */
  responseTypes: z.array(z.string()).default(['code']),
  /** Supported grant types */
  grantTypes: z.array(z.string()).default(['authorization_code', 'refresh_token']),
});

// =============================================================================
// Sharding Configuration
// =============================================================================

export const ShardingConfigSchema = z.object({
  /** Number of authorization code store shards */
  authCodeShards: z.number().int().positive().default(64),
  /** Number of refresh token rotator shards */
  refreshTokenShards: z.number().int().positive().default(8),
});

// =============================================================================
// Feature Flags
// =============================================================================

export const QueueFeatureSchema = z.object({
  enabled: z.boolean().default(false),
});

export const R2FeatureSchema = z.object({
  enabled: z.boolean().default(false),
});

export const EmailFeatureSchema = z.object({
  /** Email provider (resend, sendgrid, ses, or none) */
  provider: z.enum(['none', 'resend', 'sendgrid', 'ses']).default('none'),
  /** Sender email address (e.g., "noreply@yourdomain.com") */
  fromAddress: z.string().email().optional(),
  /** Sender display name (e.g., "Authrim") */
  fromName: z.string().optional(),
  /**
   * Whether email provider is configured (API key uploaded as secret)
   * This is set to true after successful setup
   */
  configured: z.boolean().default(false),
});

export const FeaturesConfigSchema = z.object({
  queue: QueueFeatureSchema.default({}),
  r2: R2FeatureSchema.default({}),
  email: EmailFeatureSchema.default({}),
});

// =============================================================================
// Keys Configuration
// =============================================================================

export const KeysConfigSchema = z.object({
  /** Key ID (kid) for JWK */
  keyId: z.string().optional(),
  /** Public key in JWK format */
  publicKeyJwk: z.record(z.unknown()).optional(),
  /**
   * Path to secrets directory (relative from config file location)
   * - New structure (.authrim/{env}/): './keys/'
   * - Legacy structure: './.keys/{env}/'
   */
  secretsPath: z.string().default('./keys/'),
  /** Whether to include secrets in config (not recommended) */
  includeSecrets: z.boolean().default(false),
});

// =============================================================================
// Cloudflare Configuration
// =============================================================================

export const CloudflareConfigSchema = z.object({
  /** Cloudflare account ID */
  accountId: z.string().optional(),
});

// =============================================================================
// Database Configuration
// =============================================================================

/** D1 location hints (geographic preference) */
export const D1LocationSchema = z.enum([
  'auto', // Automatic (nearest to you)
  'wnam', // Western North America
  'enam', // Eastern North America
  'weur', // Western Europe
  'eeur', // Eastern Europe
  'apac', // Asia Pacific
  'oc', // Oceania
]);

/** D1 jurisdiction (legal compliance) */
export const D1JurisdictionSchema = z.enum([
  'none', // No jurisdiction restriction
  'eu', // European Union (GDPR)
]);

export const DatabaseLocationSchema = z.object({
  /** D1 location hint - geographic preference for database placement */
  location: D1LocationSchema.default('auto'),
  /** D1 jurisdiction - overrides location if set (for legal compliance) */
  jurisdiction: D1JurisdictionSchema.default('none'),
});

export const DatabaseConfigSchema = z.object({
  /** Core database location (OAuth clients, tokens, sessions, audit logs) */
  core: DatabaseLocationSchema.default({}),
  /** PII database location (user profiles, emails, credentials) */
  pii: DatabaseLocationSchema.default({}),
});

// =============================================================================
// Profile Types
// =============================================================================

export const ProfileSchema = z.enum([
  'basic-op', // Basic OpenID Provider
  'fapi-rw', // Financial-grade API Read-Write
  'fapi2-security', // FAPI 2.0 Security Profile
]);

// =============================================================================
// Main Configuration Schema
// =============================================================================

export const AuthrimConfigSchema = z.object({
  /** Configuration schema version */
  version: z.string().default('1.0.0'),
  /** Creation timestamp */
  createdAt: z.string().datetime().optional(),
  /** Last update timestamp */
  updatedAt: z.string().datetime().optional(),

  /** Source information */
  source: SourceInfoSchema.optional(),

  /** Environment configuration */
  environment: EnvironmentConfigSchema,

  /** URL configuration */
  urls: UrlsConfigSchema.optional(),

  /** Tenant configuration */
  tenant: TenantConfigSchema.default({}),

  /** Enabled components */
  components: ComponentsConfigSchema.default({}),

  /** OIDC profile */
  profile: ProfileSchema.default('basic-op'),

  /** OIDC settings */
  oidc: OidcConfigSchema.default({}),

  /** Sharding configuration */
  sharding: ShardingConfigSchema.default({}),

  /** Feature flags */
  features: FeaturesConfigSchema.default({}),

  /** Key configuration */
  keys: KeysConfigSchema.default({}),

  /** Cloudflare configuration */
  cloudflare: CloudflareConfigSchema.default({}),

  /** Database configuration (D1 location/jurisdiction) */
  database: DatabaseConfigSchema.default({}),
});

export type AuthrimConfig = z.infer<typeof AuthrimConfigSchema>;
export type UrlConfig = z.infer<typeof UrlConfigSchema>;
export type UrlsConfig = z.infer<typeof UrlsConfigSchema>;
export type SourceInfo = z.infer<typeof SourceInfoSchema>;
export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;
export type TenantConfig = z.infer<typeof TenantConfigSchema>;
export type ComponentsConfig = z.infer<typeof ComponentsConfigSchema>;
export type OidcConfig = z.infer<typeof OidcConfigSchema>;
export type ShardingConfig = z.infer<typeof ShardingConfigSchema>;
export type FeaturesConfig = z.infer<typeof FeaturesConfigSchema>;
export type KeysConfig = z.infer<typeof KeysConfigSchema>;
export type CloudflareConfig = z.infer<typeof CloudflareConfigSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type D1Location = z.infer<typeof D1LocationSchema>;
export type D1Jurisdiction = z.infer<typeof D1JurisdictionSchema>;
export type DatabaseLocation = z.infer<typeof DatabaseLocationSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Create a default configuration with minimal settings
 */
export function createDefaultConfig(prefix: string): AuthrimConfig {
  const now = new Date().toISOString();
  return AuthrimConfigSchema.parse({
    version: '1.0.0',
    createdAt: now,
    updatedAt: now,
    environment: { prefix },
  });
}

/**
 * Validate and parse a configuration object
 */
export function parseConfig(data: unknown): AuthrimConfig {
  return AuthrimConfigSchema.parse(data);
}

/**
 * Safely validate a configuration object (returns result instead of throwing)
 */
export function safeParseConfig(data: unknown) {
  return AuthrimConfigSchema.safeParse(data);
}
