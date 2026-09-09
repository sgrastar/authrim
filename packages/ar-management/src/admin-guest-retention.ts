import type { Context } from 'hono';
import {
  GuestLifecycleRepository,
  ensureDatabaseAdapter,
  getTenantIdFromContext,
  getGuestDeletionDueAt,
  resolveGuestSettings,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  resolveTenantDatabaseSourceFromRegistry,
  createAuditLog,
  type Env,
  type GuestLifecycleRow,
  type AdminAuthContext,
} from '@authrim/ar-lib-core';

import { canAccessTenant, hasTenantSettingsPermission } from './routes/settings-v2';

function authorized(c: C, action: 'view' | 'edit'): boolean {
  const admin = (c as unknown as { get(key: string): unknown }).get('adminAuth') as
    | AdminAuthContext
    | undefined;
  return (
    canAccessTenant(admin, getTenantIdFromContext(c)) &&
    hasTenantSettingsPermission(admin, 'account-lifecycle', action)
  );
}

type C = Context<{ Bindings: Env }>;
interface Inventory {
  bindings: string[];
  index: number;
  afterUserId: string;
  cutoff: number;
  policyVersion: string;
  days: number | null;
  expiresAt: number;
}
interface Entry {
  bindingRef: string;
  userId: string;
  revision: number;
  createdAt: number;
  previousDueAt: number | null;
  newDueAt: number | null;
}
interface Preview {
  tenantId: string;
  id: string;
  policyVersion: string;
  days: number | null;
  expiresAt: number;
  entries: Entry[];
}
const TOKEN = /^[a-f0-9-]{36}$/;
const PREFIX = 'guest-retention-v1';
function error(c: C, code: string, status: 400 | 403 | 409 | 503 = 400) {
  return c.json({ error: code }, status);
}
function key(c: C, kind: string, token: string) {
  return `${PREFIX}:${getTenantIdFromContext(c)}:${kind}:${token}`;
}
async function readJson<T>(c: C, kind: string, token: string): Promise<T | null> {
  if (!TOKEN.test(token)) return null;
  const raw = await c.env.AUTHRIM_CONFIG?.get(key(c, kind, token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** A preview is a bounded immutable page. The next opaque cursor retains its source inventory. */
export async function previewGuestRetentionHandler(c: C): Promise<Response> {
  if (!authorized(c, 'view')) return error(c, 'forbidden', 403);
  c.header('Cache-Control', 'no-store');
  try {
    const body = await c.req.json<{ cursor?: unknown; limit?: unknown }>().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return error(c, 'invalid_request');
    const limit = body.limit ?? 100;
    if (
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000 ||
      (body.cursor !== undefined && typeof body.cursor !== 'string')
    )
      return error(c, 'invalid_request');
    if (!c.env.AUTHRIM_CONFIG) return error(c, 'retention_preview_unavailable', 503);
    const tenantId = getTenantIdFromContext(c);
    const now = Math.floor(Date.now() / 1000);
    const settings = await resolveGuestSettings(c.env, tenantId);
    let inventory: Inventory;
    if (typeof body.cursor === 'string') {
      const existing = await readJson<Inventory>(c, 'cursor', body.cursor);
      if (
        !existing ||
        existing.expiresAt <= now ||
        existing.policyVersion !== settings.policyVersion ||
        existing.days !== settings.policy.deletionAfterDays
      )
        return error(c, 'retention_preview_expired', 409);
      inventory = existing;
    } else {
      const sources = await resolveTenantAssignedDatabaseSourcesFromRegistry(c.env, {
        tenantId,
        role: 'tenant_core',
        dataRole: 'tenant_core/users',
        maxStores: 32,
        concurrency: 4,
      });
      inventory = {
        bindings: sources.map((source) => source.bindingRef).sort(),
        index: 0,
        afterUserId: '',
        cutoff: now,
        policyVersion: settings.policyVersion,
        days: settings.policy.deletionAfterDays,
        expiresAt: now + 900,
      };
    }
    if (
      !Array.isArray(inventory.bindings) ||
      inventory.bindings.length > 32 ||
      inventory.bindings.some((binding) => typeof binding !== 'string') ||
      !Number.isSafeInteger(inventory.index) ||
      inventory.index < 0 ||
      inventory.index > inventory.bindings.length ||
      typeof inventory.afterUserId !== 'string' ||
      !Number.isSafeInteger(inventory.cutoff)
    )
      return error(c, 'retention_preview_invalid', 409);
    const entries: Entry[] = [];
    while (inventory.index < inventory.bindings.length && entries.length < limit) {
      const bindingRef = inventory.bindings[inventory.index];
      const source = await resolveTenantDatabaseSourceFromRegistry(c.env, {
        tenantId,
        role: 'tenant_core',
        dataRole: 'tenant_core/users',
        bindingRef,
      });
      const adapter = ensureDatabaseAdapter(source.source, `guest-retention:${bindingRef}`);
      const remaining = limit - entries.length;
      const rows = await adapter.query<GuestLifecycleRow>(
        `SELECT * FROM guest_account_lifecycle WHERE tenant_id = ? AND phase = 'active' AND user_id > ? AND created_at < ? ORDER BY user_id LIMIT ?`,
        [tenantId, inventory.afterUserId, inventory.cutoff, remaining + 1],
        { consistencyClass: 'primary_required' }
      );
      for (const row of rows.slice(0, remaining)) {
        entries.push({
          bindingRef,
          userId: row.user_id,
          revision: row.revision,
          createdAt: row.created_at,
          previousDueAt: row.deletion_due_at,
          newDueAt: getGuestDeletionDueAt(row.created_at, inventory.days),
        });
      }
      if (rows.length > remaining) {
        inventory.afterUserId = rows[remaining - 1].user_id;
        break;
      }
      inventory.index += 1;
      inventory.afterUserId = '';
    }
    const preview: Preview = {
      tenantId,
      id: crypto.randomUUID(),
      policyVersion: inventory.policyVersion,
      days: inventory.days,
      expiresAt: inventory.expiresAt,
      entries,
    };
    await c.env.AUTHRIM_CONFIG.put(key(c, 'preview', preview.id), JSON.stringify(preview), {
      expirationTtl: Math.max(60, inventory.expiresAt - now),
    });
    let nextCursor: string | null = null;
    if (inventory.index < inventory.bindings.length) {
      nextCursor = crypto.randomUUID();
      await c.env.AUTHRIM_CONFIG.put(key(c, 'cursor', nextCursor), JSON.stringify(inventory), {
        expirationTtl: Math.max(60, inventory.expiresAt - now),
      });
    }
    return c.json({
      preview_token: preview.id,
      expires_at: preview.expiresAt,
      policy_version: preview.policyVersion,
      deletion_after_days: preview.days,
      count: entries.length,
      due_now: entries.filter((entry) => entry.newDueAt !== null && entry.newDueAt <= now).length,
      next_cursor: nextCursor,
      items: entries.map((entry) => ({
        user_id: entry.userId,
        created_at: entry.createdAt,
        previous_due_at: entry.previousDueAt,
        new_due_at: entry.newDueAt,
      })),
    });
  } catch {
    return error(c, 'retention_preview_unavailable', 503);
  }
}

/** Only revisions captured by the preview can change. Replaying the same page is idempotent. */
export async function applyGuestRetentionHandler(c: C): Promise<Response> {
  if (!authorized(c, 'edit')) return error(c, 'forbidden', 403);
  c.header('Cache-Control', 'no-store');
  try {
    const body = await c.req.json<{ preview_token?: unknown }>().catch(() => null);
    if (!body || typeof body.preview_token !== 'string') return error(c, 'invalid_request');
    const tenantId = getTenantIdFromContext(c);
    const now = Math.floor(Date.now() / 1000);
    const preview = await readJson<Preview>(c, 'preview', body.preview_token);
    if (
      !preview ||
      preview.tenantId !== tenantId ||
      preview.id !== body.preview_token ||
      !Number.isSafeInteger(preview.expiresAt) ||
      preview.expiresAt <= now
    )
      return error(c, 'retention_preview_expired', 409);
    if (
      !Array.isArray(preview.entries) ||
      preview.entries.length > 1000 ||
      preview.entries.some(
        (entry) =>
          typeof entry.bindingRef !== 'string' ||
          typeof entry.userId !== 'string' ||
          !Number.isSafeInteger(entry.revision) ||
          entry.revision < 1 ||
          !Number.isSafeInteger(entry.createdAt) ||
          entry.newDueAt !== getGuestDeletionDueAt(entry.createdAt, preview.days)
      )
    )
      return error(c, 'retention_preview_invalid', 409);
    const settings = await resolveGuestSettings(c.env, tenantId);
    if (
      settings.policyVersion !== preview.policyVersion ||
      settings.policy.deletionAfterDays !== preview.days
    )
      return error(c, 'retention_policy_changed', 409);
    let applied = 0;
    let unchanged = 0;
    let skipped = 0;
    const sources = new Map<string, GuestLifecycleRepository>();
    for (const entry of preview.entries) {
      let lifecycle = sources.get(entry.bindingRef);
      if (!lifecycle) {
        const source = await resolveTenantDatabaseSourceFromRegistry(c.env, {
          tenantId,
          role: 'tenant_core',
          dataRole: 'tenant_core/users',
          bindingRef: entry.bindingRef,
        });
        lifecycle = new GuestLifecycleRepository(
          ensureDatabaseAdapter(source.source, `guest-retention:${entry.bindingRef}`),
          tenantId
        );
        sources.set(entry.bindingRef, lifecycle);
      }
      const current = await lifecycle.get(entry.userId);
      if (current?.retention_application_id === preview.id) {
        applied += 1;
        continue;
      }
      if (!current || current.phase !== 'active' || current.revision !== entry.revision) {
        skipped += 1;
        continue;
      }
      if (entry.previousDueAt === entry.newDueAt) {
        unchanged += 1;
        continue;
      }
      if (
        await lifecycle.applyRetention(
          entry.userId,
          entry.revision,
          preview.days,
          preview.policyVersion,
          now,
          preview.id
        )
      )
        applied += 1;
      else skipped += 1;
    }
    const admin = (c as unknown as { get(key: string): unknown }).get(
      'adminAuth'
    ) as AdminAuthContext | null;
    await createAuditLog(c.env, {
      tenantId,
      userId: admin?.userId ?? 'unknown',
      action: 'guest.retention.applied',
      resource: 'account_lifecycle',
      resourceId: preview.id,
      severity: 'info',
      ipAddress: c.req.header('CF-Connecting-IP') ?? 'unknown',
      userAgent: c.req.header('User-Agent') ?? 'unknown',
      metadata: JSON.stringify({
        policyVersion: preview.policyVersion,
        applied,
        unchanged,
        skipped,
      }),
    });
    return c.json({ applied, unchanged, skipped, total: preview.entries.length });
  } catch {
    return error(c, 'retention_apply_unavailable', 503);
  }
}

/** Observational KV data is optional; malformed history must not hide Core progress. */
function readMaintenanceObservation(
  raw: string | null
): { state: string; attempted_at: number } | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.state !== 'string' ||
      !['processing', 'pending', 'completed', 'retrying'].includes(entry.state) ||
      typeof entry.attempted_at !== 'number' ||
      !Number.isSafeInteger(entry.attempted_at) ||
      entry.attempted_at < 0
    )
      return null;
    return { state: entry.state, attempted_at: entry.attempted_at };
  } catch {
    return null;
  }
}

/** Bounded inspection across a pinned tenant shard inventory; never changes lifecycle rows. */
export async function listGuestLifecycleHandler(c: C): Promise<Response> {
  if (!authorized(c, 'view')) return error(c, 'forbidden', 403);
  c.header('Cache-Control', 'no-store');
  try {
    const limit = Number(c.req.query('limit') ?? 100);
    const cursor = c.req.query('cursor');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return error(c, 'invalid_request');
    const config = c.env.AUTHRIM_CONFIG;
    if (!config) return error(c, 'lifecycle_inspection_unavailable', 503);
    const tenantId = getTenantIdFromContext(c);
    const now = Math.floor(Date.now() / 1000);
    type Position = { bindings: string[]; index: number; afterUserId: string; expiresAt: number };
    let position: Position;
    if (cursor !== undefined) {
      const saved = await readJson<Position>(c, 'inspection', cursor);
      if (!saved || !Number.isSafeInteger(saved.expiresAt) || saved.expiresAt <= now)
        return error(c, 'lifecycle_cursor_expired', 409);
      if (
        !Array.isArray(saved.bindings) ||
        saved.bindings.length > 32 ||
        saved.bindings.some((binding) => typeof binding !== 'string' || !binding) ||
        !Number.isInteger(saved.index) ||
        saved.index < 0 ||
        saved.index > saved.bindings.length ||
        typeof saved.afterUserId !== 'string'
      )
        return error(c, 'lifecycle_cursor_invalid', 409);
      position = { ...saved };
    } else {
      const sources = await resolveTenantAssignedDatabaseSourcesFromRegistry(c.env, {
        tenantId,
        role: 'tenant_core',
        dataRole: 'tenant_core/users',
        maxStores: 32,
        concurrency: 4,
      });
      position = {
        bindings: sources.map((s) => s.bindingRef).sort(),
        index: 0,
        afterUserId: '',
        expiresAt: now + 900,
      };
    }
    const items: Array<{
      user_id: string;
      phase: string;
      created_at: number;
      deletion_due_at: number | null;
      upgrade_hold_until: number | null;
      upgraded_at: number | null;
      deleted_at: number | null;
      updated_at: number;
      overdue_seconds: number;
      maintenance: unknown;
    }> = [];
    while (position.index < position.bindings.length && items.length < limit) {
      const source = await resolveTenantDatabaseSourceFromRegistry(c.env, {
        tenantId,
        role: 'tenant_core',
        dataRole: 'tenant_core/users',
        bindingRef: position.bindings[position.index],
      });
      const adapter = ensureDatabaseAdapter(source.source, 'guest-lifecycle-inspection');
      const remaining = limit - items.length;
      const rows = await adapter.query<GuestLifecycleRow>(
        'SELECT * FROM guest_account_lifecycle WHERE tenant_id = ? AND user_id > ? ORDER BY user_id LIMIT ?',
        [tenantId, position.afterUserId, remaining + 1],
        { consistencyClass: 'primary_required' }
      );
      for (const row of rows.slice(0, remaining)) {
        const raw = await config.get(`guest-maintenance-status:${tenantId}:${row.user_id}`);
        const maintenance = readMaintenanceObservation(raw);
        items.push({
          user_id: row.user_id,
          phase: row.phase,
          created_at: row.created_at,
          deletion_due_at: row.deletion_due_at,
          upgrade_hold_until: row.upgrade_hold_until,
          upgraded_at: row.upgraded_at,
          deleted_at: row.deleted_at,
          updated_at: row.updated_at,
          overdue_seconds:
            ['active', 'deleting'].includes(row.phase) && row.deletion_due_at !== null
              ? Math.max(0, now - Math.max(row.deletion_due_at, row.upgrade_hold_until ?? 0))
              : 0,
          maintenance,
        });
      }
      if (rows.length > remaining) position.afterUserId = rows[remaining - 1].user_id;
      else {
        position.index++;
        position.afterUserId = '';
      }
    }
    let nextCursor: string | null = null;
    if (position.index < position.bindings.length) {
      nextCursor = crypto.randomUUID();
      await config.put(key(c, 'inspection', nextCursor), JSON.stringify(position), {
        expirationTtl: 900,
      });
    }
    return c.json({ items, next_cursor: nextCursor, observed_at: now });
  } catch {
    return error(c, 'lifecycle_inspection_unavailable', 503);
  }
}
