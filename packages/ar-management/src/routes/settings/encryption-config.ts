/**
 * PII Encryption Status Admin API
 *
 * GET /api/admin/settings/encryption/status - Get encryption status and diagnostics
 *
 * Note: Encryption settings are controlled via environment variables only.
 * This API provides read-only access for status monitoring and diagnostics.
 */

import type { Context } from 'hono';
import {
  createEncryptionConfigManager,
  ENCRYPTABLE_PII_FIELDS,
  getLogger,
  type Env,
} from '@authrim/ar-lib-core';

type AppContext = Context<{ Bindings: Env }>;

/**
 * GET /api/admin/settings/encryption/status
 * Get encryption status and diagnostics
 */
export async function getEncryptionStatus(c: AppContext) {
  const log = getLogger(c).module('EncryptionConfigAPI');
  const configManager = createEncryptionConfigManager(c.env);

  try {
    const status = configManager.getStatus();

    // Check if encryption key is configured
    const keyConfigured = !!c.env.PII_ENCRYPTION_KEY;

    // Determine overall status
    let overallStatus: 'disabled' | 'enabled' | 'misconfigured';
    const warnings: string[] = [];

    if (!status.enabled) {
      overallStatus = 'disabled';
    } else if (!keyConfigured) {
      overallStatus = 'misconfigured';
      warnings.push('PII_ENCRYPTION_KEY environment variable is not set');
    } else if (status.algorithm === 'NONE') {
      overallStatus = 'disabled';
      warnings.push('Algorithm is set to NONE, which disables encryption');
    } else {
      overallStatus = 'enabled';
    }

    // Security recommendations
    const recommendations: string[] = [];

    if (!status.enabled && keyConfigured) {
      recommendations.push(
        'Encryption key is configured but encryption is disabled. Consider enabling encryption.'
      );
    }

    if (status.algorithm === 'AES-256-CBC') {
      recommendations.push(
        'AES-256-GCM is recommended over AES-256-CBC for authenticated encryption.'
      );
    }

    if (status.fields.length < 3) {
      recommendations.push('Consider encrypting more PII fields for better data protection.');
    }

    return c.json({
      status: overallStatus,
      enabled: status.enabled,
      algorithm: status.algorithm,
      encryptedFields: status.fields,
      keyVersion: status.keyVersion,
      keyConfigured,
      warnings,
      recommendations,
      supportedAlgorithms: ['AES-256-GCM', 'AES-256-CBC', 'NONE'],
      allEncryptableFields: ENCRYPTABLE_PII_FIELDS,
      note: 'Encryption settings are controlled via environment variables. Redeploy to change settings.',
    });
  } catch (error) {
    log.error('Error getting status', {}, error as Error);
    return c.json(
      {
        error: 'server_error',
        error_description: 'Failed to get encryption status',
      },
      500
    );
  }
}
