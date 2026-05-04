/**
 * Audit Log Types
 *
 * This module defines the core types for the audit logging system.
 * The system separates Event Logs (non-PII) from PII Logs for GDPR compliance.
 *
 * Architecture:
 * - EventLog: What happened, results, errors (D1_CORE - no PII)
 * - PIILog: User data changes (D1_PII - encrypted)
 * - Both linked via anonymized_user_id (random UUID + mapping table)
 */
/**
 * Default PII configuration.
 */
export const DEFAULT_PII_CONFIG = {
    piiFields: {
        email: true,
        name: true,
        phone: true,
        ipAddress: false,
        userAgent: false,
        deviceFingerprint: true,
        address: true,
        birthdate: true,
        governmentId: true,
    },
    eventLogDetailLevel: 'standard',
    eventLogRetentionDays: 90,
    piiLogRetentionDays: 365,
    operationalLogRetentionDays: 90, // reason_detail retention (90 days default)
};
/**
 * Default audit write configuration.
 */
export const DEFAULT_AUDIT_WRITE_CONFIG = {
    mode: 'queued',
    queueConfig: {
        binding: 'AUDIT_QUEUE',
        maxBatchSize: 100,
        retryLimit: 5,
    },
};
