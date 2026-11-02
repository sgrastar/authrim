/**
 * Credential Status Slot Reservation
 *
 * Reserves an unpredictable slot on a Token Status List and records the credential as `pending`
 * in one D1 `batch()`:
 * 1. `UPDATE status_lists SET used_count = used_count + 1, last_operation_id = ? ... WHERE
 *    state = 'active' AND used_count < capacity / 2` (the half-capacity limit keeps index
 *    collisions rare and is enforced by the SQL, not by a prior read);
 * 2. `INSERT INTO issued_credentials ... SELECT ... WHERE EXISTS (list carries this operation id)`
 *    under the unique `(status_list_internal_id, status_list_index)` index.
 * An index collision is a constraint error that rolls the whole batch back (counter included) and
 * is retried with a new index; zero rows means the list reached half capacity, so it is sealed and
 * a new list is used.
 */

import type { DatabaseAdapter } from '../db/adapter';
import { D1StatusListRepository } from '../repositories/vc/status-list';
import { IETF_TSL_FORMAT } from './status-list-codec';
import { StatusListManager, type StatusListPurpose } from './status-list-manager';

export interface ReserveCredentialStatusSlotInput {
  tenantId: string;
  userId: string;
  credentialType: string;
  /** Credential format, e.g. 'dc+sd-jwt' */
  format: string;
  holderBinding?: object | null;
  /** Signed credential expiry (`exp`, epoch seconds) */
  expiresAt?: number | null;
  purpose?: StatusListPurpose;
  now?: number;
}

export interface ReservedCredentialStatusSlot {
  /** issued_credentials.public_id */
  credentialId: string;
  credentialInternalId: string;
  /** status_lists.public_id (the list URI path segment) */
  listId: string;
  listInternalId: string;
  index: number;
}

/** Index collisions are rare (list under half full): this many draws fail with negligible odds */
const MAX_COLLISION_RETRIES = 32;
const MAX_LIST_ROLLOVERS = 4;

interface ActiveList {
  internal_id: string;
  id: string;
  capacity: number;
}

/** Uniform draw in [0, capacity) for a power-of-two capacity */
function randomIndex(capacity: number): number {
  const mask = capacity - 1;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] & mask;
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed|constraint failed/i.test(message);
}

async function findUsableList(
  adapter: DatabaseAdapter,
  tenantId: string,
  purpose: StatusListPurpose
): Promise<ActiveList | null> {
  return adapter.queryOne<ActiveList>(
    `SELECT internal_id, public_id AS id, capacity FROM status_lists
      WHERE tenant_id = ? AND purpose = ? AND state = 'active' AND format = ?
        AND used_count < capacity / 2
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, purpose, IETF_TSL_FORMAT]
  );
}

/**
 * The slot an earlier attempt of this very reservation committed (its response was lost), read
 * back in full from the stored row: list, internal list id and index all come from that row.
 */
async function findOwnReservation(
  adapter: DatabaseAdapter,
  tenantId: string,
  credentialId: string,
  credentialInternalId: string
): Promise<ReservedCredentialStatusSlot | null> {
  const row = await adapter.queryOne<{
    status_list_id: string;
    status_list_internal_id: string;
    status_list_index: number;
  }>(
    `SELECT status_list_id, status_list_internal_id, status_list_index FROM issued_credentials
      WHERE tenant_id = ? AND public_id = ?`,
    [tenantId, credentialId]
  );
  if (!row) return null;
  return {
    credentialId,
    credentialInternalId,
    listId: row.status_list_id,
    listInternalId: row.status_list_internal_id,
    index: row.status_list_index,
  };
}

export async function reserveCredentialStatusSlot(
  adapter: DatabaseAdapter,
  input: ReserveCredentialStatusSlotInput
): Promise<ReservedCredentialStatusSlot> {
  const { tenantId, userId, credentialType, format } = input;
  const purpose = input.purpose ?? 'revocation';
  const now = input.now ?? Date.now();
  const credentialId = crypto.randomUUID();
  const credentialInternalId = crypto.randomUUID();
  const manager = new StatusListManager(new D1StatusListRepository(adapter));

  let collisions = 0;
  let rollovers = 0;
  let list = await findUsableList(adapter, tenantId, purpose);

  while (true) {
    if (!list) {
      // Lists at half capacity are done: seal them, then start a new one.
      const sealedAt = new Date(now).toISOString();
      await adapter.execute(
        `UPDATE status_lists SET state = 'sealed', sealed_at = ?, updated_at = ?
          WHERE tenant_id = ? AND purpose = ? AND state = 'active' AND format = ?
            AND used_count >= capacity / 2`,
        [sealedAt, sealedAt, tenantId, purpose, IETF_TSL_FORMAT]
      );
      const created = await manager.createStatusList(tenantId, purpose);
      list = { internal_id: created.internal_id, id: created.id, capacity: created.capacity };
    }

    const index = randomIndex(list.capacity);
    const operationId = crypto.randomUUID();
    const isoNow = new Date(now).toISOString();

    let results;
    try {
      results = await adapter.batch([
        {
          sql: `UPDATE status_lists
                   SET used_count = used_count + 1, last_operation_id = ?, updated_at = ?
                 WHERE internal_id = ? AND tenant_id = ? AND state = 'active' AND format = ?
                   AND used_count < capacity / 2`,
          params: [operationId, isoNow, list.internal_id, tenantId, IETF_TSL_FORMAT],
        },
        {
          sql: `INSERT INTO issued_credentials (
                  internal_id, public_id, tenant_id, user_id, credential_type, format, claims,
                  status, status_list_id, status_list_internal_id, status_list_index,
                  holder_binding, expires_at, created_at, updated_at)
                SELECT ?, ?, ?, ?, ?, ?, '{}', 'pending', ?, ?, ?, ?, CAST(? AS INTEGER), ?, ?
                 WHERE EXISTS (
                   SELECT 1 FROM status_lists WHERE internal_id = ? AND last_operation_id = ?)`,
          params: [
            credentialInternalId,
            credentialId,
            tenantId,
            userId,
            credentialType,
            format,
            list.id,
            list.internal_id,
            index,
            input.holderBinding ? JSON.stringify(input.holderBinding) : null,
            input.expiresAt ?? null,
            now,
            now,
            list.internal_id,
            operationId,
          ],
        },
      ]);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      // The batch rolled back. If an earlier attempt of this very reservation committed (its
      // response was lost), the row exists at its slot; otherwise this index was taken.
      const existing = await findOwnReservation(
        adapter,
        tenantId,
        credentialId,
        credentialInternalId
      );
      if (existing) return existing;
      if (++collisions > MAX_COLLISION_RETRIES) {
        throw new Error('credential_status_slot_unavailable');
      }
      continue;
    }

    const [counter, inserted] = results;
    if (counter.rowsAffected === 1 && inserted.rowsAffected === 1) {
      return {
        credentialId,
        credentialInternalId,
        listId: list.id,
        listInternalId: list.internal_id,
        index,
      };
    }
    if (counter.rowsAffected !== 0 || inserted.rowsAffected !== 0) {
      throw new Error('credential_status_reservation_inconsistent');
    }

    // (0, 0) can also be the re-execution of a batch that already committed: never move on to
    // another list before checking for this reservation's own row.
    const committed = await findOwnReservation(
      adapter,
      tenantId,
      credentialId,
      credentialInternalId
    );
    if (committed) return committed;

    // The list reached half capacity (or was sealed): seal it and move on to another list.
    if (++rollovers > MAX_LIST_ROLLOVERS) throw new Error('credential_status_slot_unavailable');
    await adapter.execute(
      `UPDATE status_lists SET state = 'sealed', sealed_at = ?, updated_at = ?
        WHERE internal_id = ? AND tenant_id = ? AND state = 'active' AND used_count >= capacity / 2`,
      [isoNow, isoNow, list.internal_id, tenantId]
    );
    list = await findUsableList(adapter, tenantId, purpose);
  }
}
