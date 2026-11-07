/**
 * The response records of a screen (`GET /api/admin/screens/:id/responses`): what signed-in
 * people answered to its parts whose answers go to the record, newest first.
 *
 * A record lives in the PII database of the person who answered (`screen_responses`), so the
 * tenant's PII databases are each read and their pages merged. The cursor is the last row given
 * (its time and id), so a page never repeats or skips a row while new ones arrive.
 */
import { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  ensureDatabaseAdapter,
  getLogger,
  getTenantIdFromContext,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';

type AdminContext = Context<{ Bindings: Env }>;

export const SCREEN_RESPONSES_DEFAULT_LIMIT = 50;
export const SCREEN_RESPONSES_MAX_LIMIT = 100;
const PII_STORE_CONCURRENCY = 4;

interface ResponseRow {
  id: string;
  user_id: string;
  screen_key: string;
  flow_id: string | null;
  flow_version_id: string | null;
  interaction_id: string | null;
  step_id: string | null;
  answers_json: string;
  created_at: number | string;
  updated_at: number | string;
}

interface Cursor {
  createdAt: number;
  id: string;
}

export interface ScreenResponseItem {
  id: string;
  user_id: string;
  screen_key: string;
  flow_id: string | null;
  flow_version_id: string | null;
  interaction_id: string | null;
  step_id: string | null;
  answers: Record<string, string | boolean>;
  created_at: number;
  updated_at: number;
}

function invalid(c: AdminContext, description: string) {
  return c.json({ error: 'invalid_request', error_description: description }, 400);
}

function readLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return SCREEN_RESPONSES_DEFAULT_LIMIT;
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) return null;
  const limit = Number(raw);
  return limit <= SCREEN_RESPONSES_MAX_LIMIT ? limit : null;
}

export function encodeScreenResponsesCursor(cursor: Cursor): string {
  return btoa(JSON.stringify([cursor.createdAt, cursor.id]))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeScreenResponsesCursor(raw: string | undefined): Cursor | null | 'invalid' {
  if (raw === undefined || raw === '') return null;
  if (raw.length > 600 || !/^[A-Za-z0-9_-]+$/.test(raw)) return 'invalid';
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    const value: unknown = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      (value[0] as number) >= 0 &&
      typeof value[1] === 'string' &&
      value[1].length > 0 &&
      value[1].length <= 256
    ) {
      return { createdAt: value[0] as number, id: value[1] };
    }
  } catch {
    // Falls through to an invalid cursor.
  }
  return 'invalid';
}

function readAnswers(raw: string): Record<string, string | boolean> {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const answers: Record<string, string | boolean> = {};
    for (const [key, answer] of Object.entries(value as Record<string, unknown>)) {
      if (typeof answer === 'string' || typeof answer === 'boolean') answers[key] = answer;
    }
    return answers;
  } catch {
    return {};
  }
}

function toItem(row: ResponseRow): ScreenResponseItem {
  return {
    id: row.id,
    user_id: row.user_id,
    screen_key: row.screen_key,
    flow_id: row.flow_id,
    flow_version_id: row.flow_version_id,
    interaction_id: row.interaction_id,
    step_id: row.step_id,
    answers: readAnswers(row.answers_json),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

/** Newest first; a tie in time is broken by id, as each database orders its page. */
function compareNewestFirst(left: ScreenResponseItem, right: ScreenResponseItem): number {
  if (left.created_at !== right.created_at) return right.created_at - left.created_at;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

async function readStorePage(
  pii: DatabaseAdapter,
  tenantId: string,
  screenId: string,
  cursor: Cursor | null,
  limit: number
): Promise<ScreenResponseItem[]> {
  const after = cursor ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
  const rows = await pii.query<ResponseRow>(
    `SELECT id, user_id, screen_key, flow_id, flow_version_id, interaction_id, step_id,
            answers_json, created_at, updated_at
       FROM screen_responses
      WHERE tenant_id = ? AND screen_id = ?${after}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    [
      tenantId,
      screenId,
      ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
      limit + 1,
    ]
  );
  return rows.map(toItem);
}

/**
 * Merges the pages each PII database gave (each newest first, at most `limit + 1` rows) into one
 * page of `limit` rows and the cursor to the next, if there is more.
 */
export function mergeScreenResponsePages(
  pages: ScreenResponseItem[][],
  limit: number
): { responses: ScreenResponseItem[]; next_cursor: string | null } {
  const merged = pages.flat().sort(compareNewestFirst);
  const responses = merged.slice(0, limit);
  const last = responses[responses.length - 1];
  return {
    responses,
    next_cursor:
      merged.length > limit && last
        ? encodeScreenResponsesCursor({ createdAt: last.created_at, id: last.id })
        : null,
  };
}

export async function adminScreenResponsesHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_SCREENS');
  const limit = readLimit(c.req.query('limit'));
  if (limit === null) {
    return invalid(c, `limit must be an integer from 1 to ${SCREEN_RESPONSES_MAX_LIMIT}`);
  }
  const cursor = decodeScreenResponsesCursor(c.req.query('cursor'));
  if (cursor === 'invalid') return invalid(c, 'cursor is not valid');
  try {
    const tenantId = getTenantIdFromContext(c);
    const screenId = c.req.param('id') ?? '';
    const screen = await createAuthContextFromHono(c, tenantId).coreAdapter.queryOne<{
      id: string;
    }>('SELECT id FROM screens WHERE tenant_id = ? AND id = ?', [tenantId, screenId]);
    if (!screen) {
      return c.json({ error: 'not_found', error_description: 'Screen not found' }, 404);
    }
    const stores = await resolveTenantAssignedDatabaseSourcesFromRegistry(c.env, {
      tenantId,
      role: 'tenant_pii',
      dataRole: 'tenant_pii',
      maxStores: 32,
      concurrency: PII_STORE_CONCURRENCY,
    });
    const pages: ScreenResponseItem[][] = [];
    for (let index = 0; index < stores.length; index += PII_STORE_CONCURRENCY) {
      const batch = stores.slice(index, index + PII_STORE_CONCURRENCY);
      pages.push(
        ...(await Promise.all(
          batch.map((store) =>
            readStorePage(
              ensureDatabaseAdapter(store.source, `screen-responses:${store.bindingRef}`),
              tenantId,
              screen.id,
              cursor,
              limit
            )
          )
        ))
      );
    }
    c.header('Cache-Control', 'no-store');
    return c.json(mergeScreenResponsePages(pages, limit));
  } catch (error) {
    log.error('Failed to list screen responses', { action: 'list_responses' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to list screen responses' },
      500
    );
  }
}
