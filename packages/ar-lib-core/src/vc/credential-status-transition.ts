/**
 * Credential Status Transition
 *
 * The one write path for credential status changes (revoke, suspend, activate and the issuance
 * path's "abandon"). `issued_credentials` and `status_lists` live in the same tenant core DB, so a
 * change is one D1 `batch()`: the list bit and the credential row move together or not at all.
 *
 * A batch rolls back only on an error, not on a zero-row update, so both statements are guarded and
 * both row counts are checked:
 * 1. the list update is guarded by its `version` and by the credential still being in an allowed
 *    status at the expected list slot, and stamps a fresh `last_operation_id`;
 * 2. the credential update applies only while the list carries that operation id, i.e. only when
 *    statement 1 of the same batch won.
 * (1, 1) is success; (0, 0) means a concurrent change, so everything is re-read and recomputed.
 */

import type { DatabaseAdapter } from '../db/adapter';
import type { CredentialStatus } from '../repositories/vc/issued-credential';
import {
  IETF_TSL_FORMAT,
  TSL_STATUS_SUSPENDED,
  TSL_STATUS_INVALID,
  TSL_STATUS_VALID,
  bitOrderForFormat,
  decodeStatusListBytes,
  encodeStatusListBytes,
  isStatusListFormat,
  isValidStatusBits,
  statusListByteLength,
  writeStatusEntry,
  type StatusListFormat,
} from './status-list-codec';

export type CredentialStatusTransitionTarget = 'revoked' | 'suspended' | 'active';

export interface CredentialStatusTransitionInput {
  tenantId: string;
  /** issued_credentials.public_id (what admin APIs use today) */
  credentialId: string;
  /** Allowed current statuses */
  from: CredentialStatus[];
  to: CredentialStatusTransitionTarget;
  /** Stored in revoked_reason when `to` is 'revoked' */
  reason?: string;
  now?: number;
}

export type CredentialStatusTransitionResult =
  | { outcome: 'changed'; previous: CredentialStatus }
  /** Already in `to` */
  | { outcome: 'unchanged' }
  | { outcome: 'not_found' }
  /** The current status is not in `from` (and is not `to`) */
  | { outcome: 'not_allowed'; current: CredentialStatus }
  /** Bounded retries exhausted */
  | { outcome: 'conflict' };

const MAX_ATTEMPTS = 5;

interface CredentialRow {
  status: CredentialStatus;
  status_list_internal_id: string | null;
  status_list_index: number | null;
}

interface ListRow {
  encoded_list: string;
  version: number;
  format: string;
  bits: number;
  capacity: number;
}

/** Entry value a target status is stored as in a list of the given format */
export function statusEntryValueFor(
  format: StatusListFormat,
  to: CredentialStatusTransitionTarget
): number {
  if (to === 'active') return TSL_STATUS_VALID;
  if (to === 'revoked') return TSL_STATUS_INVALID;
  // The W3C Bitstring format has one bit: suspended is "set", as before.
  return format === IETF_TSL_FORMAT ? TSL_STATUS_SUSPENDED : TSL_STATUS_INVALID;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function jitter(attempt: number): Promise<void> {
  const delay = 5 * (attempt + 1) + Math.floor(Math.random() * 20);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export async function transitionCredentialStatus(
  adapter: DatabaseAdapter,
  input: CredentialStatusTransitionInput
): Promise<CredentialStatusTransitionResult> {
  const { tenantId, credentialId, to } = input;
  // Nothing ever leaves `revoked`: it can be a source only of a (no-op) revoke.
  const from = to === 'revoked' ? input.from : input.from.filter((status) => status !== 'revoked');
  const now = input.now ?? Date.now();
  const revokedAt = to === 'revoked' ? new Date(now).toISOString() : null;
  const revokedReason = to === 'revoked' ? (input.reason ?? null) : null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await jitter(attempt);

    const credential = await adapter.queryOne<CredentialRow>(
      `SELECT status, status_list_internal_id, status_list_index
         FROM issued_credentials WHERE tenant_id = ? AND public_id = ?`,
      [tenantId, credentialId]
    );
    if (!credential) return { outcome: 'not_found' };
    if (credential.status === to) return { outcome: 'unchanged' };
    if (credential.status === 'revoked' || !from.includes(credential.status)) {
      return { outcome: 'not_allowed', current: credential.status };
    }

    // Without a status entry only the row changes (guarded by the status that was read).
    if (credential.status_list_internal_id === null || credential.status_list_index === null) {
      const result = await adapter.execute(
        `UPDATE issued_credentials
            SET status = ?, revoked_at = COALESCE(?, revoked_at), revoked_reason = COALESCE(?, revoked_reason),
                updated_at = ?
          WHERE tenant_id = ? AND public_id = ? AND status = ?`,
        [to, revokedAt, revokedReason, now, tenantId, credentialId, credential.status]
      );
      if (result.rowsAffected === 1) return { outcome: 'changed', previous: credential.status };
      continue;
    }

    const list = await adapter.queryOne<ListRow>(
      `SELECT encoded_list, version, format, bits, capacity
         FROM status_lists WHERE internal_id = ? AND tenant_id = ?`,
      [credential.status_list_internal_id, tenantId]
    );
    if (!list) throw new Error('credential_status_list_missing');
    if (!isStatusListFormat(list.format) || !isValidStatusBits(list.bits)) {
      throw new Error('credential_status_list_unsupported');
    }

    const bytes = await decodeStatusListBytes(
      list.encoded_list,
      list.format,
      statusListByteLength(list.capacity, list.bits)
    );
    writeStatusEntry(
      bytes,
      credential.status_list_index,
      list.bits,
      bitOrderForFormat(list.format),
      statusEntryValueFor(list.format, to)
    );
    const encoded = await encodeStatusListBytes(bytes, list.format);
    const operationId = crypto.randomUUID();
    const fromSql = placeholders(from.length);

    const [listResult, rowResult] = await adapter.batch([
      {
        sql: `UPDATE status_lists
                 SET encoded_list = ?, version = version + 1, last_operation_id = ?, updated_at = ?
               WHERE internal_id = ? AND tenant_id = ? AND version = ?
                 AND EXISTS (
                   SELECT 1 FROM issued_credentials
                    WHERE tenant_id = ? AND public_id = ?
                      AND status_list_internal_id = ? AND status_list_index = ?
                      AND status IN (${fromSql}))`,
        params: [
          encoded,
          operationId,
          new Date(now).toISOString(),
          credential.status_list_internal_id,
          tenantId,
          list.version,
          tenantId,
          credentialId,
          credential.status_list_internal_id,
          credential.status_list_index,
          ...from,
        ],
      },
      {
        sql: `UPDATE issued_credentials
                 SET status = ?, revoked_at = COALESCE(?, revoked_at),
                     revoked_reason = COALESCE(?, revoked_reason), updated_at = ?
               WHERE tenant_id = ? AND public_id = ? AND status IN (${fromSql})
                 AND EXISTS (SELECT 1 FROM status_lists WHERE internal_id = ? AND last_operation_id = ?)`,
        params: [
          to,
          revokedAt,
          revokedReason,
          now,
          tenantId,
          credentialId,
          ...from,
          credential.status_list_internal_id,
          operationId,
        ],
      },
    ]);

    if (listResult.rowsAffected === 1 && rowResult.rowsAffected === 1) {
      return { outcome: 'changed', previous: credential.status };
    }
    if (listResult.rowsAffected === 0 && rowResult.rowsAffected === 0) continue;
    // The guards tie the two statements together, so any other combination is a broken invariant.
    throw new Error('credential_status_transition_inconsistent');
  }

  return { outcome: 'conflict' };
}
