/**
 * Consent Versioning Utility
 *
 * Manages policy versions and determines when re-consent is required.
 * Implements GDPR Article 7 requirement for informed, specific consent.
 *
 * @packageDocumentation
 */

import type { DatabaseAdapter } from '../db';
import type { PolicyVersion, CurrentPolicyVersions, ConsentHistoryAction } from '../types/consent';

/**
 * Get the current active policy versions for a tenant
 *
 * @param adapter - Database adapter
 * @param tenantId - Tenant ID
 * @returns Current policy versions or null if none exist
 */
export async function getCurrentPolicyVersions(
  adapter: DatabaseAdapter,
  tenantId: string
): Promise<CurrentPolicyVersions | null> {
  const now = Date.now();

  // Query the latest effective version for each policy type
  const result = await adapter.query<{
    policy_type: string;
    version: string;
    policy_uri: string | null;
    effective_at: number;
  }>(
    `SELECT policy_type, version, policy_uri, effective_at
     FROM consent_policy_versions
     WHERE tenant_id = ? AND effective_at <= ?
     ORDER BY effective_at DESC`,
    [tenantId, now]
  );

  if (result.length === 0) {
    return null;
  }

  // Extract the latest version for each policy type
  const versions: CurrentPolicyVersions = {};
  const seenTypes = new Set<string>();

  for (const row of result) {
    if (seenTypes.has(row.policy_type)) continue;
    seenTypes.add(row.policy_type);

    switch (row.policy_type) {
      case 'privacy_policy':
        versions.privacyPolicy = {
          version: row.version,
          policyType: 'privacy_policy',
          effectiveAt: row.effective_at,
          policyUri: row.policy_uri ?? undefined,
        };
        break;
      case 'terms_of_service':
        versions.termsOfService = {
          version: row.version,
          policyType: 'terms_of_service',
          effectiveAt: row.effective_at,
          policyUri: row.policy_uri ?? undefined,
        };
        break;
      case 'cookie_policy':
        versions.cookiePolicy = {
          version: row.version,
          policyType: 'cookie_policy',
          effectiveAt: row.effective_at,
          policyUri: row.policy_uri ?? undefined,
        };
        break;
    }
  }

  return Object.keys(versions).length > 0 ? versions : null;
}

/**
 * Check if a user needs to re-consent due to policy version changes
 *
 * @param adapter - Database adapter
 * @param userId - User ID
 * @param clientId - Client ID
 * @param tenantId - Tenant ID
 * @param currentVersions - Current policy versions to compare against
 * @returns Object indicating if re-consent is needed and which policies changed
 */
export async function checkRequiresReconsent(
  adapter: DatabaseAdapter,
  userId: string,
  clientId: string,
  tenantId: string,
  currentVersions: CurrentPolicyVersions | null
): Promise<{
  requiresReconsent: boolean;
  changedPolicies: string[];
  existingConsent: {
    privacyPolicyVersion: string | null;
    tosVersion: string | null;
    consentVersion: number;
  } | null;
}> {
  // Get existing consent
  const existingConsent = await adapter.query<{
    privacy_policy_version: string | null;
    tos_version: string | null;
    consent_version: number | null;
  }>(
    `SELECT privacy_policy_version, tos_version, consent_version
     FROM oauth_client_consents
     WHERE tenant_id = ? AND user_id = ? AND client_id = ?`,
    [tenantId, userId, clientId]
  );

  if (existingConsent.length === 0) {
    // No existing consent - no re-consent needed (first time consent)
    return {
      requiresReconsent: false,
      changedPolicies: [],
      existingConsent: null,
    };
  }

  const consent = existingConsent[0];
  const changedPolicies: string[] = [];

  // If no current versions defined, no re-consent required
  if (!currentVersions) {
    return {
      requiresReconsent: false,
      changedPolicies: [],
      existingConsent: {
        privacyPolicyVersion: consent.privacy_policy_version,
        tosVersion: consent.tos_version,
        consentVersion: consent.consent_version ?? 1,
      },
    };
  }

  // Compare privacy policy version
  if (
    currentVersions.privacyPolicy &&
    consent.privacy_policy_version !== currentVersions.privacyPolicy.version
  ) {
    changedPolicies.push('privacy_policy');
  }

  // Compare terms of service version
  if (
    currentVersions.termsOfService &&
    consent.tos_version !== currentVersions.termsOfService.version
  ) {
    changedPolicies.push('terms_of_service');
  }

  return {
    requiresReconsent: changedPolicies.length > 0,
    changedPolicies,
    existingConsent: {
      privacyPolicyVersion: consent.privacy_policy_version,
      tosVersion: consent.tos_version,
      consentVersion: consent.consent_version ?? 1,
    },
  };
}

/**
 * Record consent action in history table for audit trail
 *
 * @param adapter - Database adapter
 * @param params - History record parameters
 */
export async function recordConsentHistory(
  adapter: DatabaseAdapter,
  params: {
    tenantId: string;
    userId: string;
    clientId: string;
    action: ConsentHistoryAction;
    scopesBefore?: string[];
    scopesAfter?: string[];
    privacyPolicyVersion?: string;
    tosVersion?: string;
    ipAddressHash?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<string> {
  const historyId = crypto.randomUUID();
  const now = Date.now();

  await adapter.execute(
    `INSERT INTO consent_history (
      id, tenant_id, user_id, client_id, action,
      scopes_before, scopes_after,
      privacy_policy_version, tos_version,
      ip_address_hash, user_agent,
      created_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      historyId,
      params.tenantId,
      params.userId,
      params.clientId,
      params.action,
      params.scopesBefore ? JSON.stringify(params.scopesBefore) : null,
      params.scopesAfter ? JSON.stringify(params.scopesAfter) : null,
      params.privacyPolicyVersion ?? null,
      params.tosVersion ?? null,
      params.ipAddressHash ?? null,
      params.userAgent ?? null,
      now,
      params.metadata ? JSON.stringify(params.metadata) : null,
    ]
  );

  return historyId;
}

/**
 * Update consent with new policy versions and increment version counter
 *
 * @param adapter - Database adapter
 * @param userId - User ID
 * @param clientId - Client ID
 * @param tenantId - Tenant ID
 * @param newVersions - New policy versions to set
 * @returns The new consent version number
 */
export async function upgradeConsentVersion(
  adapter: DatabaseAdapter,
  userId: string,
  clientId: string,
  tenantId: string,
  newVersions: {
    privacyPolicyVersion?: string;
    tosVersion?: string;
  }
): Promise<number> {
  const now = Date.now();

  // Atomically increment version and update policy versions
  await adapter.execute(
    `UPDATE oauth_client_consents
     SET consent_version = COALESCE(consent_version, 0) + 1,
         privacy_policy_version = COALESCE(?, privacy_policy_version),
         tos_version = COALESCE(?, tos_version),
         granted_at = ?
     WHERE tenant_id = ? AND user_id = ? AND client_id = ?`,
    [
      newVersions.privacyPolicyVersion ?? null,
      newVersions.tosVersion ?? null,
      now,
      tenantId,
      userId,
      clientId,
    ]
  );

  // Return the new version
  const result = await adapter.query<{ consent_version: number }>(
    `SELECT consent_version FROM oauth_client_consents
     WHERE tenant_id = ? AND user_id = ? AND client_id = ?`,
    [tenantId, userId, clientId]
  );

  return result.length > 0 ? result[0].consent_version : 1;
}

/**
 * Create a new policy version record
 *
 * @param adapter - Database adapter
 * @param params - Policy version parameters
 * @returns The created policy version ID
 */
export async function createPolicyVersion(
  adapter: DatabaseAdapter,
  params: {
    tenantId: string;
    policyType: 'privacy_policy' | 'terms_of_service' | 'cookie_policy';
    version: string;
    policyUri?: string;
    policyHash?: string;
    effectiveAt: number;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();

  await adapter.execute(
    `INSERT INTO consent_policy_versions (
      id, tenant_id, version, policy_type, policy_uri, policy_hash, effective_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.tenantId,
      params.version,
      params.policyType,
      params.policyUri ?? null,
      params.policyHash ?? null,
      params.effectiveAt,
      now,
    ]
  );

  return id;
}

/**
 * List policy version history for a tenant
 *
 * @param adapter - Database adapter
 * @param tenantId - Tenant ID
 * @param policyType - Optional filter by policy type
 * @param limit - Maximum number of records to return
 * @returns Array of policy versions ordered by effective date descending
 */
export async function listPolicyVersions(
  adapter: DatabaseAdapter,
  tenantId: string,
  policyType?: 'privacy_policy' | 'terms_of_service' | 'cookie_policy',
  limit: number = 50
): Promise<
  Array<{
    id: string;
    policyType: string;
    version: string;
    policyUri?: string;
    effectiveAt: number;
    createdAt: number;
  }>
> {
  let query = `SELECT id, policy_type, version, policy_uri, effective_at, created_at
               FROM consent_policy_versions
               WHERE tenant_id = ?`;
  const params: (string | number)[] = [tenantId];

  if (policyType) {
    query += ' AND policy_type = ?';
    params.push(policyType);
  }

  query += ' ORDER BY effective_at DESC LIMIT ?';
  params.push(limit);

  const result = await adapter.query<{
    id: string;
    policy_type: string;
    version: string;
    policy_uri: string | null;
    effective_at: number;
    created_at: number;
  }>(query, params);

  return result.map((row) => ({
    id: row.id,
    policyType: row.policy_type,
    version: row.version,
    policyUri: row.policy_uri ?? undefined,
    effectiveAt: row.effective_at,
    createdAt: row.created_at,
  }));
}
