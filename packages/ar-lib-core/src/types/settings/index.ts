/**
 * Settings Types Index
 *
 * Exports all setting category types and metadata.
 */

// Common types
export * from './common';

// Category types
export * from './oauth';
export * from './session';
export * from './security';
export * from './infrastructure';
export * from './ciba';
export * from './rate-limit';
export * from './device-flow';
export * from './tokens';
export * from './external-idp';
export * from './credentials';
export * from './federation';
export * from './client';
export * from './encryption';
export * from './cache';
export * from './feature-flags';
export * from './limits';
export * from './tenant';
export * from './verifiable-credentials';
export * from './discovery';
export * from './plugin';
export * from './assurance-levels';
export * from './check-api-audit';
export * from './dcr';
export * from './login-ui';
export * from './authentication-methods';
export * from './account-lifecycle';
export * from './diagnostic-logging';
export * from './dr-backup';
export * from './login-entry';
export * from './tenant-discovery-ui';
export * from './support-ops';
export * from './self-service';
export * from './service-site';

// Re-export SettingsManager types
export type {
  SettingScope,
  SettingSource,
  SettingMeta,
  CategoryMeta,
  SettingsGetResult,
  SettingsPatchRequest,
  SettingsPatchResult,
  SettingsValidationError,
  SettingsValidationResult,
  SettingsAuditEvent,
} from '../../utils/settings-manager';

// Re-export scope types
export type { SettingScopeLevel, ScopePermission, ScopedCategoryMeta } from './common';
export { DEFAULT_SCOPE_PERMISSIONS, defineScopedCategory } from './common';

export {
  DISABLED_MARKER,
  isDisabled,
  generateVersion,
  SettingsManager,
  ConflictError,
  createSettingsManager,
} from '../../utils/settings-manager';

// The catalog (all category metadata, scopes, access rules)
export * from './catalog';
