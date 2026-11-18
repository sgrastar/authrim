/**
 * Admin Onboarding Progress Repository
 *
 * Which first-steps checklist items an admin has finished in the admin console, per tenant. The
 * items themselves belong to the console; the server keeps only their identifiers and when each
 * was finished, so the list follows the admin across browsers.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { getCurrentTimestamp } from '../base';

/** An item identifier: lowercase words joined by hyphens, 40 characters at most. */
export const ADMIN_ONBOARDING_ITEM_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const ADMIN_ONBOARDING_ITEM_MAX_LENGTH = 40;
/** Finished items kept per admin and tenant; more than the console will ever list. */
export const ADMIN_ONBOARDING_ITEM_LIMIT = 50;

export interface AdminOnboardingCompletion {
  item_id: string;
  completed_at: number;
}

export function isAdminOnboardingItemId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= ADMIN_ONBOARDING_ITEM_MAX_LENGTH &&
    ADMIN_ONBOARDING_ITEM_PATTERN.test(value)
  );
}

export class AdminOnboardingRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async list(adminUserId: string, tenantId: string): Promise<AdminOnboardingCompletion[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT item_id, completed_at FROM admin_onboarding_progress
        WHERE admin_user_id = ? AND tenant_id = ?
        ORDER BY completed_at, item_id`,
      [adminUserId, tenantId]
    );
    return rows.map((row) => ({
      item_id: String(row.item_id),
      completed_at: Number(row.completed_at),
    }));
  }

  /**
   * Marks an item finished. Finishing it again keeps the first time. Returns false when the
   * admin already has the most items kept for the tenant and this one is not among them.
   */
  async complete(
    adminUserId: string,
    tenantId: string,
    itemId: string,
    now: number = getCurrentTimestamp()
  ): Promise<boolean> {
    // The limit only keeps the table from being filled with made-up identifiers; requests at the
    // very same moment may pass it by one or two, which does no harm. The casts give PostgreSQL
    // the parameter types it cannot infer in INSERT … SELECT.
    await this.adapter.execute(
      `INSERT INTO admin_onboarding_progress (admin_user_id, tenant_id, item_id, completed_at)
       SELECT CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS BIGINT)
        WHERE (SELECT COUNT(*) FROM admin_onboarding_progress
                WHERE admin_user_id = ? AND tenant_id = ?) < ?
       ON CONFLICT(admin_user_id, tenant_id, item_id) DO NOTHING`,
      [adminUserId, tenantId, itemId, now, adminUserId, tenantId, ADMIN_ONBOARDING_ITEM_LIMIT]
    );
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      `SELECT 1 AS found FROM admin_onboarding_progress
        WHERE admin_user_id = ? AND tenant_id = ? AND item_id = ?`,
      [adminUserId, tenantId, itemId]
    );
    return row !== null && row !== undefined;
  }

  /** Marks an item not finished. Nothing happens when it was not finished. */
  async reopen(adminUserId: string, tenantId: string, itemId: string): Promise<void> {
    await this.adapter.execute(
      `DELETE FROM admin_onboarding_progress
        WHERE admin_user_id = ? AND tenant_id = ? AND item_id = ?`,
      [adminUserId, tenantId, itemId]
    );
  }
}
