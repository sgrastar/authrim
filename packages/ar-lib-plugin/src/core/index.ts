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
} from './types';

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

// Plugin Context
export {
  DefaultPluginContext,
  KVPluginConfigStore,
  ConsoleLogger,
  D1AuditLogger,
  NoopAuditLogger,
  createPluginContext,
  type PluginContextOptions,
  type CreatePluginContextOptions,
} from './context';
