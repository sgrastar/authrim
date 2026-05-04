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
arrayBufferToBase64, base64ToArrayBuffer, 
// Key normalization for blacklist
normalizeKey, SECRET_FIELD_NORMALIZED_BLACKLIST, 
// Sanitization
sanitizeEventDetails, sanitizeErrorMessage, 
// Details auto-evacuation
writeEventDetails, readEventDetails, writePIIValues, 
// AAD generation for encryption
generateAAD, 
// Retention calculation
calculateRetentionUntil, 
// PII decryption
decryptPIIValues, readAndDecryptPIIValues, 
// Async audit logging helper
logAuditAsync, 
// Constants
DETAILS_INLINE_LIMIT_BYTES, PII_VALUES_INLINE_LIMIT_BYTES, ERROR_MESSAGE_MAX_LENGTH, } from './utils';
// Anonymization Service
export { AnonymizationService, createAnonymizationService, batchGetAnonymizedUserIds, listAnonymizationMappings, } from './anonymization';
// Audit Service
export { AuditService, createAuditService } from './audit-service';
export { resolveAuditPersistenceSourcesFromEnv, resolveAuditPersistenceAdapterFromEnv, resolveLegacyAuditLogAdapterFromEnv, } from './runtime-sources';
export { createAuditPrimaryDatabaseAdapter, createAuditPrimaryStorageAdapter, createExternalAuditDatabaseAdapter, createExternalAuditStorageAdapter, } from './external-primary';
// Queue Consumer
export { processAuditQueue, processDLQQueue, cleanupExpiredEventLogs, cleanupExpiredPIILogs, } from './queue-consumer';
// Storage Adapters
export { 
// Interface and types
DEFAULT_AUDIT_STORAGE_CONFIG, hasAuditStorageRoutingTargets, normalizeAuditStorageRoutingTargets, auditRoutingRuleMatches, resolveAuditRoutingTargets, 
// D1 Adapter
D1AuditAdapter, createD1EventLogAdapter, createD1PIILogAdapter, 
// R2 Adapter
R2AuditAdapter, createR2AuditAdapter, 
// Hyperdrive Adapter
HyperdriveAuditAdapter, createHyperdriveAuditAdapter, MysqlAuditAdapter, createMysqlAuditAdapter, resolveHyperdriveBindingForAuditTarget, } from './storage';
export { AUDIT_CANONICAL_LOG_FORMAT_V1, buildCanonicalAuditBatch, buildCanonicalAuditArchiveRecordFromEntry, buildCanonicalAuditRecord, extractAuditEntryFromCanonicalPayload, } from './canonical-format';
export { auditTargetFromBackendConfig, buildAuditStorageBackendsFromProfile, buildAuditStorageConfigFromProfile, buildPrimaryBackendMap, targetToBackendId, } from './runtime-targets';
// Operational Logs (reason_detail storage with encryption)
export { storeOperationalLog, getOperationalLog, listOperationalLogs, deleteUserOperationalLogs, } from './operational-logs';
