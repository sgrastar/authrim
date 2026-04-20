/**
 * Core Plugin Types and Utilities
 *
 * This module exports the core interfaces and utilities for plugin development.
 */

// Types
export type {
  AuthrimPlugin,
  PluginCapability,
  PluginCategory,
  FlowNodeDefinition,
  FlowPortDefinition,
  PluginMeta,
  HealthStatus,
  PluginContext,
  PluginStorageAccess,
  PluginConfigStore,
  NotifierHandler,
  Notification,
  NotificationOptions,
  SendResult,
  IStorageInfra,
  IPolicyInfra,
  InfraHealthStatus,
  Logger,
  AuditLogger,
  AuditEvent,
  Env,
  // Store interfaces (for type-safe storage access)
  IUserStore,
  IClientStore,
  ISessionStore,
  IPasskeyStore,
  IOrganizationStore,
  IRoleStore,
  IRoleAssignmentStore,
  IRelationshipStore,
  // Plugin metadata types
  PluginAuthor,
  PluginSupport,
  ExternalDependency,
  // Trust level types
  PluginSource,
  PluginTrustLevel,
  // Entity types (for store interfaces)
  User,
  OAuthClient,
  Session,
  Passkey,
  Organization,
  Role,
  RoleAssignment,
  Relationship,
} from './types';

// Trust level utilities
export { getPluginTrustLevel, THIRD_PARTY_DISCLAIMER } from './types';

// Registry
export {
  CapabilityRegistry,
  globalRegistry,
  type IdPHandler,
  type IdPAuthParams,
  type IdPExchangeParams,
  type IdPTokenResult,
  type IdPUserInfo,
  type IdPClaims,
  type AuthenticatorHandler,
  type AuthChallengeParams,
  type AuthChallengeResult,
  type AuthVerifyParams,
  type AuthVerifyResult,
} from './registry';

// Schema utilities
export {
  zodToJSONSchema,
  extractPluginSchema,
  validatePluginConfig,
  validatePluginConfigFromPlugin,
  extractFormFieldHints,
  PluginSchemaRegistry,
  globalSchemaRegistry,
  type JSONSchema7,
  type JSONSchema7TypeName,
  type SchemaConversionOptions,
  type PluginSchemaInfo,
  type ValidationResult,
  type ValidationError,
  type FormFieldHint,
  type FormFieldType,
  type FormFieldValidation,
} from './schema';

// Plugin Loader
export {
  PluginLoader,
  createPluginLoader,
  type PluginLoadResult,
  type PluginStatus,
  type PluginLoaderOptions,
} from './loader';

// Plugin Context Utilities
// Note: PluginContext creation is done by Workers using ar-lib-core implementations
export {
  KVPluginConfigStore,
  ConsoleLogger,
  NoopAuditLogger,
  createPluginContext,
  type PluginContextOptions,
} from './context';

// Builtin Plugin Registry
export {
  registerBuiltinPlugins,
  needsBuiltinRegistration,
  getBuiltinPlugins,
  resolveBuiltinPluginBootstrapConfig,
  type PluginRegistryEntry,
  type RegisterBuiltinOptions,
} from './builtin-registry';

// Security Utilities
export {
  // Secret field support
  secretField,
  isSecretField,
  extractSecretFields,
  matchesSecretPattern,
  DEFAULT_SECRET_PATTERNS,
  SECRET_FIELD_MARKER,
  // URL validation
  validateExternalUrl,
  type UrlValidationResult,
  type UrlValidationOptions,
  // Recursive masking
  maskSensitiveFieldsRecursive,
  type MaskOptions,
  // Encryption (for KV storage)
  encryptValue,
  decryptValue,
  encryptSecretFields,
  decryptSecretFields,
  isEncryptedValue,
  type EncryptedConfig,
  // Encryption key management
  deriveEncryptionKey,
  getPluginEncryptionKey,
} from './security';
