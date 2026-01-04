/**
 * Audit Log Service
 *
 * Provides unified audit logging with:
 * - Event logging (non-PII) in D1_CORE
 * - PII change logging in D1_PII with encryption
 * - User anonymization for GDPR compliance
 * - Automatic detail evacuation to R2 for large payloads
 */

// Types
export * from './types';

// Utilities
export {
  // Base64 utilities (chunking for large data)
  arrayBufferToBase64,
  base64ToArrayBuffer,

  // Key normalization for blacklist
  normalizeKey,
  SECRET_FIELD_NORMALIZED_BLACKLIST,

  // Sanitization
  sanitizeEventDetails,
  sanitizeErrorMessage,

  // Details auto-evacuation
  writeEventDetails,
  readEventDetails,
  writePIIValues,

  // AAD generation for encryption
  generateAAD,

  // Retention calculation
  calculateRetentionUntil,

  // PII decryption
  decryptPIIValues,
  readAndDecryptPIIValues,

  // Async audit logging helper
  logAuditAsync,

  // Constants
  DETAILS_INLINE_LIMIT_BYTES,
  PII_VALUES_INLINE_LIMIT_BYTES,
  ERROR_MESSAGE_MAX_LENGTH,
} from './utils';

export type {
  EventDetailsResult,
  PIIValuesResult,
  EncryptedValueForDecrypt,
  DecryptionKeyProvider,
  AsyncAuditLogParams,
  IAuditServiceForAsync,
  ILoggerForAsync,
} from './utils';

// Anonymization Service
export {
  AnonymizationService,
  createAnonymizationService,
  batchGetAnonymizedUserIds,
  listAnonymizationMappings,
} from './anonymization';

export type { IAnonymizationService } from './anonymization';

// Audit Service
export { AuditService, createAuditService } from './audit-service';

export type { AuditServiceDependencies } from './audit-service';

// Queue Consumer
export {
  processAuditQueue,
  processDLQQueue,
  cleanupExpiredEventLogs,
  cleanupExpiredPIILogs,
} from './queue-consumer';

export type { AuditQueueConsumerEnv } from './queue-consumer';

// Storage Adapters
export {
  // Interface and types
  DEFAULT_AUDIT_STORAGE_CONFIG,
  // D1 Adapter
  D1AuditAdapter,
  createD1EventLogAdapter,
  createD1PIILogAdapter,
  // R2 Adapter
  R2AuditAdapter,
  createR2AuditAdapter,
  // Hyperdrive Adapter
  HyperdriveAuditAdapter,
  createHyperdriveAuditAdapter,
} from './storage';

export type {
  IAuditStorageAdapter,
  AuditStorageBackendType,
  AuditLogType,
  AuditWriteResult,
  AuditQueryOptions,
  AuditQueryResult,
  AuditStorageHealth,
  AuditBackendConfig,
  AuditRetentionConfig,
  AuditStorageRoutingRule,
  AuditStorageConfig,
  D1AuditAdapterConfig,
  R2AuditAdapterConfig,
  HyperdriveAuditAdapterConfig,
} from './storage';

// Operational Logs (reason_detail storage with encryption)
export {
  storeOperationalLog,
  getOperationalLog,
  listOperationalLogs,
  deleteUserOperationalLogs,
} from './operational-logs';

export type { OperationalLogEntry, StoreOperationalLogParams } from './operational-logs';
