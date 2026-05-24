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

/**
 * Accepts a full URL or a bare hostname and normalizes to a full https:// URL.
 * e.g. "example.com" → "https://example.com"
 */
const urlOrHostname = z
  .string()
  .transform((val) => {
    if (!val.includes('://')) {
      return `https://${val}`;
    }
    return val;
  })
  .pipe(z.string().url());

export const UrlConfigSchema = z.object({
  /** Custom domain (null = use auto-generated URL) */
  custom: urlOrHostname.nullable().optional(),
  /** Auto-generated Workers URL */
  auto: urlOrHostname.optional(),
  /** Cloudflare zone ID for custom domain (populated during setup) */
  zoneId: z.string().nullable().optional(),
  /** Whether to configure Workers custom domain binding */
  customDomainBinding: z.boolean().optional(),
});

export const UiUrlConfigSchema = z.object({
  /** Custom domain (null = use auto-generated URL) */
  custom: urlOrHostname.nullable().optional(),
  /** Auto-generated Workers URL */
  auto: urlOrHostname.optional(),
  /**
   * Whether to serve this UI from the same domain as the API via proxy
   * - true: UI is proxied through ar-router (e.g., https://api.example.com/admin)
   * - false: UI is served from its own UI Worker URL (e.g., https://admin.example.workers.dev)
   */
  sameAsApi: z.boolean().default(false),
});

export const UrlsConfigSchema = z.object({
  /** API / OIDC issuer URL */
  api: UrlConfigSchema,
  /** Login UI URL */
  loginUi: UiUrlConfigSchema,
  /** Admin UI URL */
  adminUi: UiUrlConfigSchema,
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

/**
 * User ID format options
 * - nanoid: URL-safe 21-character IDs (default, recommended)
 * - uuid: Standard UUID v4 format
 */
export const UserIdFormatSchema = z.enum(['nanoid', 'uuid']).default('nanoid');

export const TenantConfigSchema = z.object({
  /** Default tenant identifier */
  name: z.string().default('default'),
  /** Human-readable tenant/organization name */
  displayName: z.string().default('Initial Tenant'),
  /**
   * @deprecated Multi-tenant mode is always enabled.
   * Kept for backward compatibility during migration.
   */
  multiTenant: z.boolean().default(false),
  /**
   * Base domain (root domain only, e.g., "authrim.com", "example.com")
   * All tenant domains are subdomains of this: {tenant}.{baseDomain}
   */
  baseDomain: z.string().optional(),
  /**
   * User ID format for new users
   * - nanoid: URL-safe 21-character IDs (default, recommended)
   * - uuid: Standard UUID v4 format (36 characters with hyphens)
   *
   * Note: This setting cannot be changed after users are created.
   */
  userIdFormat: UserIdFormatSchema,
  /**
   * Primary tenant ID for naked domain access.
   * When set, naked domain (e.g., example.com) routes to this tenant.
   * When unset, naked domain routes to the initial tenant (name field).
   */
  primaryTenant: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  /**
   * Use naked domain as issuer URL.
   * When true: https://example.com (no tenant subdomain)
   * When false: https://tenant.example.com (with tenant subdomain)
   */
  nakedDomain: z.boolean().default(false).optional(),
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
  authCodeShards: z.number().int().positive().default(4),
  /** Number of refresh token rotator shards */
  refreshTokenShards: z.number().int().positive().default(4),
  /** Number of session store shards */
  sessionShards: z.number().int().positive().default(4),
  /** Number of challenge store shards */
  challengeShards: z.number().int().positive().default(4),
});

// =============================================================================
// Feature Flags
// =============================================================================

export const QueueFeatureSchema = z.object({
  enabled: z.boolean().default(false),
});

export const R2FeatureSchema = z.object({
  enabled: z.boolean().default(true),
});

export const EmailFeatureSchema = z.object({
  /** Email provider (cloudflare, resend, sendgrid, ses, or none) */
  provider: z.enum(['none', 'cloudflare', 'resend', 'sendgrid', 'ses']).default('none'),
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
   * Path to secrets directory
   * - External (.authrim-keys/{env}/): absolute path
   * - Internal (.authrim/{env}/keys/): './keys/'
   * - Legacy (.keys/{env}/): './.keys/{env}/'
   */
  secretsPath: z.string().default('./keys/'),
  /** Whether to include secrets in config (not recommended) */
  includeSecrets: z.boolean().default(false),
  /**
   * Key storage type
   * - 'external': Keys stored in {cwd}/.authrim-keys/{env}/ (new default)
   * - 'internal': Keys stored in .authrim/{env}/keys/ (within source)
   */
  storageType: z.enum(['internal', 'external']).optional().default('external'),
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

export const TenantD1ConfigSchema = z.object({
  /**
   * Number of tenant D1 slots to pre-create during initial setup.
   * Each slot creates one core D1 and one PII D1.
   */
  preallocatedSlots: z.number().int().min(1).max(500).default(3),
});

// =============================================================================
// Runtime Profile Configuration
// =============================================================================

export const ProfileIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9:_-]+$/, { message: 'Profile ID may only contain letters, numbers, :, _, -' });
const REMOVED_MINIMAL_AUDIT_PROFILE_MESSAGE =
  'builtin:audit:minimal is not supported. Use builtin:audit:standard or a setup-defined custom audit profile.';
export const AuditProfileIdSchema = ProfileIdSchema.refine(
  (value) => value !== 'builtin:audit:minimal',
  { message: REMOVED_MINIMAL_AUDIT_PROFILE_MESSAGE }
);

export const ProfileRegistryBackendSchema = z.enum(['kv', 'database']);

export const ProfileDefaultsConfigSchema = z.object({
  /**
   * Environment default storage profile ID.
   *
   * Common built-ins:
   * - builtin:storage:shared-d1
   * - builtin:storage:tenant-d1
   * - builtin:storage:external-durable
   * - builtin:storage:standard (legacy alias)
   * - builtin:storage:single-db
   * - builtin:storage:eu-pii-split
   * - builtin:storage:external-postgres
   */
  storage: ProfileIdSchema.default('builtin:storage:shared-d1'),
  /** Environment default audit profile ID */
  audit: AuditProfileIdSchema.default('builtin:audit:standard'),
  /** Environment default residency profile ID */
  residency: ProfileIdSchema.default('builtin:residency:default'),
});

export const ProfileRegistryConfigSchema = z.object({
  /**
   * Registry storage backend for runtime profiles.
   * - kv: lightweight install, no dedicated DB required for profile definitions
   * - database: profile definitions stored in the configured database backend
   */
  backend: ProfileRegistryBackendSchema.default('kv'),
});

const HyperdriveReferenceSchema = z.object({
  binding: z.string().min(1),
  id: z.string().min(1),
  driver: z.enum(['postgres', 'mysql']),
});

export const ProfileReferencesConfigSchema = z.object({
  hyperdrive: z.record(z.string(), HyperdriveReferenceSchema).default({}),
});

const RuntimeProfileMetadataSchema = z.record(z.string(), z.unknown()).optional();
const RuntimeProfileVersionSchema = z.number().int().positive().optional();

const StorageTargetSeedSchema = z
  .object({
    driver: z.enum(['d1', 'postgres', 'mysql']),
    bindingRef: z.string().min(1).optional(),
    connectionRef: z.string().min(1).optional(),
    role: z.enum(['core', 'pii', 'admin', 'custom']).optional(),
  })
  .refine((value) => Boolean(value.bindingRef || value.connectionRef), {
    message: 'Storage targets require bindingRef or connectionRef',
  });

const StorageProfileSeedSchema = z.object({
  id: ProfileIdSchema,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  version: RuntimeProfileVersionSchema,
  metadata: RuntimeProfileMetadataSchema,
  transientAuth: z
    .object({
      sessionColdPersistence: z.enum(['enabled', 'disabled']),
      sessionClientMirror: z.enum(['sync', 'async', 'disabled']),
      deviceCibaColdPersistence: z.enum(['enabled', 'disabled']),
      externalDurableMirror: z.enum(['disabled', 'future']),
    })
    .optional(),
  residencyProfileId: ProfileIdSchema.optional(),
  slices: z
    .object({
      users_core: StorageTargetSeedSchema.optional(),
      users_pii: StorageTargetSeedSchema.optional(),
      custom_claims: StorageTargetSeedSchema.optional(),
      registration_fields: StorageTargetSeedSchema.optional(),
      custom_pii: StorageTargetSeedSchema.optional(),
    })
    .superRefine((value, ctx) => {
      if (
        !value.users_core &&
        !value.users_pii &&
        !value.custom_claims &&
        !value.registration_fields &&
        !value.custom_pii
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'At least one storage slice must be configured',
        });
      }
    }),
});

const DatabaseAuditTargetSeedSchema = z
  .object({
    type: z.enum(['d1', 'postgres', 'mysql']),
    bindingRef: z.string().min(1).optional(),
    connectionRef: z.string().min(1).optional(),
    dataset: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.bindingRef || value.connectionRef), {
    message: 'Database audit targets require bindingRef or connectionRef',
  });

const HttpAuditTargetSeedSchema = z
  .object({
    type: z.literal('http'),
    url: z
      .string()
      .url()
      .refine((value) => value.startsWith('https://'), {
        message: 'HTTP audit targets must use https URLs',
      })
      .optional(),
    urlRef: z.string().min(1).optional(),
    authTokenRef: z.string().min(1).optional(),
    method: z.literal('POST').optional(),
    headers: z.record(z.string(), z.string()).optional(),
    format: z.literal('json').optional(),
  })
  .refine((value) => Boolean(value.url || value.urlRef), {
    message: 'HTTP audit targets require url or urlRef',
  });

const _AuditTargetSeedSchema = z.union([
  DatabaseAuditTargetSeedSchema,
  z.object({
    type: z.literal('r2'),
    bucketRef: z.string().min(1),
    prefix: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('logpush'),
    destinationRef: z.string().min(1),
    dataset: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('firehose'),
    streamRef: z.string().min(1),
  }),
  HttpAuditTargetSeedSchema,
]);

const AuditRetentionSeedSchema = z.object({
  eventLogRetentionDays: z.number().int().positive().nullable().optional(),
  piiLogRetentionDays: z.number().int().positive().nullable().optional(),
  archiveBeforeDelete: z.boolean().optional(),
  minimumRetentionDays: z.number().int().positive().nullable().optional(),
  primaryDays: z.number().int().positive().nullable().optional(),
  archiveDays: z.number().int().positive().nullable().optional(),
});

const AuditBackpressureSeedSchema = z.object({
  mode: z.enum(['event_class', 'fail_closed_all']),
  allowTenantOverride: z.boolean().optional(),
  eventCategoryOverrides: z
    .record(z.string(), z.enum(['inherit', 'fail_open', 'fail_closed']))
    .optional(),
});

const AuditProfileSeedSchema = z.object({
  id: ProfileIdSchema,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  version: RuntimeProfileVersionSchema,
  metadata: RuntimeProfileMetadataSchema,
  primary: DatabaseAuditTargetSeedSchema.nullable(),
  archive: z
    .union([
      DatabaseAuditTargetSeedSchema,
      z.object({
        type: z.literal('r2'),
        bucketRef: z.string().min(1),
        prefix: z.string().min(1).optional(),
      }),
    ])
    .nullable()
    .optional(),
  sinks: z
    .array(
      z.union([
        z.object({
          type: z.literal('logpush'),
          destinationRef: z.string().min(1),
          dataset: z.string().min(1).optional(),
        }),
        z.object({
          type: z.literal('firehose'),
          streamRef: z.string().min(1),
        }),
        HttpAuditTargetSeedSchema,
      ])
    )
    .default([]),
  retention: AuditRetentionSeedSchema.optional(),
  archiveFailureMode: z.enum(['best_effort', 'gate_cleanup']).optional(),
  sinkFailureMode: z.enum(['best_effort', 'retry_until_ttl']).optional(),
  backpressure: AuditBackpressureSeedSchema.optional(),
});

const ResidencyProfileSeedSchema = z.object({
  id: ProfileIdSchema,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  version: RuntimeProfileVersionSchema,
  metadata: RuntimeProfileMetadataSchema,
  locationHint: z.enum(['auto', 'wnam', 'enam', 'weur', 'eeur', 'apac', 'oc']),
  jurisdiction: z.enum(['none', 'eu', 'jp', 'us']),
  allowedRegions: z.array(z.string().min(1)).optional(),
});

export const ProfileSeedConfigSchema = z.object({
  storage: z.array(StorageProfileSeedSchema).default([]),
  audit: z.array(AuditProfileSeedSchema).default([]),
  residency: z.array(ResidencyProfileSeedSchema).default([]),
});

export const ProfilesConfigSchema = z.object({
  defaults: ProfileDefaultsConfigSchema.default({}),
  registry: ProfileRegistryConfigSchema.default({}),
  references: ProfileReferencesConfigSchema.default({}),
  seed: ProfileSeedConfigSchema.default({}),
});

// =============================================================================
// Security Configuration
// =============================================================================

export const SecurityConfigSchema = z.object({
  /**
   * Enable application-level PII encryption
   * - true: Encrypt PII data at application level (recommended for D1)
   * - false: Rely on database-level encryption (for managed DBs like Aurora)
   *
   * WARNING: Cannot be changed after initial data is stored
   */
  piiEncryptionEnabled: z.boolean().default(true),
  /**
   * Enable email domain hashing for privacy
   * - true: Hash email domains for analytics/rate-limiting
   * - false: Store email domains in plain text
   *
   * WARNING: Cannot be changed after initial data is stored
   */
  domainHashEnabled: z.boolean().default(true),
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

  /** Tenant D1 preallocated pool configuration */
  tenantD1: TenantD1ConfigSchema.default({}),

  /** Runtime profile defaults and registry backend selection */
  profiles: ProfilesConfigSchema.default({}),

  /** Security configuration (PII encryption, domain hashing) */
  security: SecurityConfigSchema.default({}),
});

export type AuthrimConfig = z.infer<typeof AuthrimConfigSchema>;
export type UrlConfig = z.infer<typeof UrlConfigSchema>;
export type UiUrlConfig = z.infer<typeof UiUrlConfigSchema>;
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
export type ProfileId = z.infer<typeof ProfileIdSchema>;
export type ProfileRegistryBackend = z.infer<typeof ProfileRegistryBackendSchema>;
export type ProfileDefaultsConfig = z.infer<typeof ProfileDefaultsConfigSchema>;
export type ProfileRegistryConfig = z.infer<typeof ProfileRegistryConfigSchema>;
export type ProfileReferencesConfig = z.infer<typeof ProfileReferencesConfigSchema>;
export type ProfileSeedConfig = z.infer<typeof ProfileSeedConfigSchema>;
export type ProfilesConfig = z.infer<typeof ProfilesConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

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
