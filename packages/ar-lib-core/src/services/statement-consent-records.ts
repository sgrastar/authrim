/**
 * Statement consent record reads
 *
 * Reads a subject's `user_consent_records` from the account database alone. The result names the
 * statement and version each record was given for but carries no definition; callers that need a
 * title or requirement read the definition from the metadata database and join in the application.
 */

import type { DatabaseAdapter } from '../db';
import type { ConsentRecordStatus, ConsentStatementUserRecord } from '../types/consent-statements';

/** All of a subject's statement consent records in a tenant, from the account database. */
export async function listUserStatementConsentRecords(
  account: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<ConsentStatementUserRecord[]> {
  const rows = await account.query<{
    id: string;
    tenant_id: string;
    user_id: string;
    statement_id: string;
    version_id: string;
    version: string;
    content_hash: string | null;
    status: string;
    granted_at: number | null;
    withdrawn_at: number | null;
    expires_at: number | null;
    retain_until: number | null;
    consent_settings_snapshot_at: number | null;
    record_retention_days_snapshot: number | null;
    reconsent_interval_days_snapshot: number | null;
    client_id: string | null;
    ip_address_hash: string | null;
    user_agent: string | null;
    receipt_id: string | null;
    created_at: number;
    updated_at: number;
  }>(`SELECT * FROM user_consent_records WHERE tenant_id = ? AND user_id = ?`, [tenantId, userId]);

  // node-postgres returns BIGINT as a string; the expiry and re-consent checks add to these.
  const optionalNumber = (value: number | null): number | undefined =>
    value === null || value === undefined ? undefined : Number(value);

  return rows.map((r) => ({
    ...r,
    status: r.status as ConsentRecordStatus,
    content_hash: r.content_hash ?? undefined,
    granted_at: optionalNumber(r.granted_at),
    withdrawn_at: optionalNumber(r.withdrawn_at),
    expires_at: optionalNumber(r.expires_at),
    retain_until: optionalNumber(r.retain_until),
    consent_settings_snapshot_at: optionalNumber(r.consent_settings_snapshot_at),
    record_retention_days_snapshot: optionalNumber(r.record_retention_days_snapshot),
    reconsent_interval_days_snapshot: optionalNumber(r.reconsent_interval_days_snapshot),
    client_id: r.client_id ?? undefined,
    ip_address_hash: r.ip_address_hash ?? undefined,
    user_agent: r.user_agent ?? undefined,
    receipt_id: r.receipt_id ?? undefined,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  }));
}
