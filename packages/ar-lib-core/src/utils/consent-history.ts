/**
 * The history of a user's consent to an app's requested scopes (`consent_history`): granted,
 * updated, withdrawn. Consent to statements (documents) has its own history
 * (`consent_item_history`, statement-consent-writes.ts).
 *
 * @packageDocumentation
 */

import type { DatabaseAdapter } from '../db';
import type { ConsentHistoryAction } from '../types/consent';

/** Records a scope consent action in the history, for the audit trail. Returns its id. */
export async function recordConsentHistory(
  adapter: DatabaseAdapter,
  params: {
    tenantId: string;
    userId: string;
    clientId: string;
    action: ConsentHistoryAction;
    scopesBefore?: string[];
    scopesAfter?: string[];
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
      ip_address_hash, user_agent,
      created_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      historyId,
      params.tenantId,
      params.userId,
      params.clientId,
      params.action,
      params.scopesBefore ? JSON.stringify(params.scopesBefore) : null,
      params.scopesAfter ? JSON.stringify(params.scopesAfter) : null,
      params.ipAddressHash ?? null,
      params.userAgent ?? null,
      now,
      params.metadata ? JSON.stringify(params.metadata) : null,
    ]
  );

  return historyId;
}
