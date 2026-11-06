/**
 * Login UI Theme Repository
 *
 * Saved Login UI themes of a tenant: named sets of appearance settings (see LOGIN_UI_THEME_KEYS)
 * that an admin keeps, edits and applies. A theme only holds values; what the Login UI shows is
 * the tenant's login-ui settings document, which "apply" writes.
 *
 * Every read and write is keyed by the tenant, so another tenant's theme is never found. Names are
 * unique per tenant ignoring case (name_key); a tenant holds at most LOGIN_UI_THEME_LIMIT themes,
 * checked by the INSERT itself so that two requests cannot both take the last place.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { generateId, getCurrentTimestamp } from '../base';

/** Most themes one tenant may keep. */
export const LOGIN_UI_THEME_LIMIT = 50;

export interface LoginUITheme {
  id: string;
  name: string;
  values: Record<string, unknown>;
  version: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface LoginUIThemeInput {
  name: string;
  values: Record<string, unknown>;
}

export type LoginUIThemeCreateResult =
  | { status: 'created'; theme: LoginUITheme }
  | { status: 'name_taken' }
  | { status: 'limit_reached' };

export type LoginUIThemeUpdateResult =
  | { status: 'updated'; theme: LoginUITheme }
  | { status: 'not_found' }
  | { status: 'name_taken' }
  | { status: 'conflict'; currentVersion: number };

/** The key names are compared by: trimmed, lower-cased. */
export function loginUIThemeNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint/i.test(error.message);
}

function toTheme(row: Record<string, unknown>): LoginUITheme {
  let values: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(row.values_json));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      values = parsed as Record<string, unknown>;
    }
  } catch {
    // The column is CHECKed as JSON; an unreadable value reads as an empty theme.
  }
  return {
    id: String(row.id),
    name: String(row.name),
    values,
    version: Number(row.version),
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export class LoginUIThemeRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  /** The tenant's themes, most recently changed first. */
  async list(tenantId: string): Promise<LoginUITheme[]> {
    const rows = await this.adapter.query<Record<string, unknown>>(
      `SELECT * FROM login_ui_themes WHERE tenant_id = ?
        ORDER BY updated_at DESC, id ASC LIMIT ?`,
      [tenantId, LOGIN_UI_THEME_LIMIT]
    );
    return rows.map(toTheme);
  }

  async find(tenantId: string, id: string): Promise<LoginUITheme | null> {
    const row = await this.adapter.queryOne<Record<string, unknown>>(
      'SELECT * FROM login_ui_themes WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    return row ? toTheme(row) : null;
  }

  async create(
    tenantId: string,
    input: LoginUIThemeInput,
    createdBy: string | null,
    now: number = getCurrentTimestamp()
  ): Promise<LoginUIThemeCreateResult> {
    const id = generateId();
    try {
      const result = await this.adapter.execute(
        `INSERT INTO login_ui_themes (id, tenant_id, name, name_key, values_json, version,
           created_by, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, 1, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM login_ui_themes WHERE tenant_id = ?) < ?`,
        [
          id,
          tenantId,
          input.name,
          loginUIThemeNameKey(input.name),
          JSON.stringify(input.values),
          createdBy,
          now,
          now,
          tenantId,
          LOGIN_UI_THEME_LIMIT,
        ]
      );
      if (result.rowsAffected === 0) return { status: 'limit_reached' };
    } catch (error) {
      if (isUniqueViolation(error)) return { status: 'name_taken' };
      throw error;
    }
    const theme = await this.find(tenantId, id);
    if (!theme) throw new Error('login_ui_theme_missing_after_insert');
    return { status: 'created', theme };
  }

  /** Replace a theme's name and values when its version is still `expectedVersion`. */
  async update(
    tenantId: string,
    id: string,
    input: LoginUIThemeInput,
    expectedVersion: number,
    now: number = getCurrentTimestamp()
  ): Promise<LoginUIThemeUpdateResult> {
    try {
      const result = await this.adapter.execute(
        `UPDATE login_ui_themes
            SET name = ?, name_key = ?, values_json = ?, version = version + 1, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND version = ?`,
        [
          input.name,
          loginUIThemeNameKey(input.name),
          JSON.stringify(input.values),
          now,
          tenantId,
          id,
          expectedVersion,
        ]
      );
      if (result.rowsAffected === 0) {
        const current = await this.find(tenantId, id);
        return current
          ? { status: 'conflict', currentVersion: current.version }
          : { status: 'not_found' };
      }
    } catch (error) {
      if (isUniqueViolation(error)) return { status: 'name_taken' };
      throw error;
    }
    // Answered with what this update wrote: a later update, saved between the two statements,
    // must not be taken for it (its version would let this caller overwrite it unseen).
    const theme = await this.find(tenantId, id);
    if (!theme) return { status: 'not_found' };
    return {
      status: 'updated',
      theme: {
        ...theme,
        name: input.name,
        values: input.values,
        version: expectedVersion + 1,
        updated_at: now,
      },
    };
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.adapter.execute(
      'DELETE FROM login_ui_themes WHERE tenant_id = ? AND id = ?',
      [tenantId, id]
    );
    return result.rowsAffected > 0;
  }
}
