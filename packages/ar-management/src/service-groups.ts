import type { Context } from 'hono';
import {
  getTenantIdFromContext,
  loadGroupFields,
  compileGroups,
  evaluateGroups,
  type Env,
  type ServiceGroup,
  type GroupInputReader,
} from '@authrim/ar-lib-core';
import { serviceGroupRuntime } from './dynamic-groups-runtime';
type Ctx = Context<{
  Bindings: Env;
  Variables: { adminAuth: { userId?: string; adminUserId?: string } };
}>;
const primary = { consistencyClass: 'primary_required' as const };
function userId(c: Ctx): string {
  const value = c.req.param('userId') ?? c.req.query('userId') ?? '';
  if (!/^[a-zA-Z0-9_:-]{1,128}$/.test(value)) throw new Error('group_subject_invalid');
  return value;
}
async function body(c: Ctx): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).length > 70000) throw new Error('group_request_limit');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('group_request_invalid');
  return value as Record<string, unknown>;
}
function actor(c: Ctx): string {
  const auth = c.get('adminAuth') as { userId?: string; adminUserId?: string } | undefined;
  return auth?.adminUserId ?? auth?.userId ?? 'admin';
}
function failure(c: Ctx, error: unknown) {
  const code =
    error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : 'group_input_unavailable';
  const status =
    code.includes('conflict') || code.includes('busy')
      ? 409
      : code.includes('unavailable')
        ? 503
        : code.includes('not_found')
          ? 404
          : 400;
  return c.json({ error: code }, status);
}
export async function serviceGroupsRead(c: Ctx) {
  try {
    const { store } = await serviceGroupRuntime(c.env, getTenantIdFromContext(c));
    const catalog = await store.catalog();
    const fields = await loadGroupFields(store.db, store.tenantId);
    const scans = await store.db.query(
      'SELECT binding_ref, rule_version, cursor_id, processed, failures, status, updated_at FROM service_group_scans WHERE tenant_id = ? ORDER BY binding_ref',
      [store.tenantId],
      primary
    );
    return c.json({
      revision: catalog?.revision ?? 0,
      groups: catalog?.plan.groups ?? [],
      dependencies: catalog?.plan.dependencies ?? {},
      fields,
      scans,
    });
  } catch (error) {
    return failure(c, error);
  }
}
export async function serviceGroupWrite(c: Ctx) {
  try {
    const { store } = await serviceGroupRuntime(c.env, getTenantIdFromContext(c));
    const input = await body(c);
    const catalog = await store.catalog();
    const id = c.req.param('id');
    const existing = catalog?.plan.groups.find((g) => g.id === id);
    if (id && !existing) throw new Error('group_not_found');
    const fields = await loadGroupFields(store.db, store.tenantId);
    const deleting = c.req.method === 'DELETE';
    let groups = [...(catalog?.plan.groups ?? [])];
    if (deleting) groups = groups.filter((g) => g.id !== id);
    else {
      const group = {
        id: existing?.id ?? crypto.randomUUID(),
        tenantId: store.tenantId,
        key: input.key,
        displayName: input.displayName,
        description: input.description ?? '',
        enabled: input.enabled ?? true,
        condition: input.condition ?? null,
        ...(input.scimRoleId ? { scimRoleId: input.scimRoleId } : {}),
      } as ServiceGroup;
      if (
        group.scimRoleId &&
        !(await store.db.queryOne(
          'SELECT id FROM roles WHERE tenant_id = ? AND id = ?',
          [store.tenantId, group.scimRoleId],
          primary
        ))
      )
        throw new Error('group_scim_reference_invalid');
      groups = [...groups.filter((g) => g.id !== group.id), group];
    }
    if (typeof input.ifMatch !== 'number') throw new Error('group_version_invalid');
    const saved = await store.save(groups, fields, input.ifMatch, actor(c));
    return c.json({ revision: saved.revision, groups: saved.plan.groups });
  } catch (error) {
    return failure(c, error);
  }
}
export async function serviceGroupValidate(c: Ctx) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const input = await body(c);
    const { store } = await serviceGroupRuntime(c.env, tenantId);
    const catalog = await store.catalog();
    const candidate = {
      id: typeof input.id === 'string' ? input.id : 'preview',
      tenantId,
      key: input.key ?? 'preview',
      displayName: input.displayName ?? 'Preview',
      description: input.description ?? '',
      enabled: input.enabled ?? true,
      condition: input.condition ?? null,
      ...(input.scimRoleId ? { scimRoleId: input.scimRoleId } : {}),
    } as ServiceGroup;
    const plan = compileGroups(
      tenantId,
      [...(catalog?.plan.groups.filter((g) => g.id !== candidate.id) ?? []), candidate],
      await loadGroupFields(store.db, tenantId)
    );
    let evaluation = null;
    if (input.userId !== undefined) {
      if (typeof input.userId !== 'string' || !/^[a-zA-Z0-9_:-]{1,128}$/.test(input.userId))
        throw new Error('group_subject_invalid');
      const { reader } = await serviceGroupRuntime(c.env, tenantId, input.userId);
      if (!reader) throw new Error('group_input_unavailable');
      const before = await reader.version();
      const attributes = await reader.load(plan);
      const after = await reader.version();
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('group_input_changed');
      evaluation = evaluateGroups(plan, attributes);
    }
    return c.json({ valid: true, dependencies: plan.dependencies, order: plan.order, evaluation });
  } catch (error) {
    return failure(c, error);
  }
}
export async function serviceGroupSubject(c: Ctx) {
  try {
    const id = userId(c);
    const { store, reader } = await serviceGroupRuntime(c.env, getTenantIdFromContext(c), id);
    if (!reader) throw new Error('group_input_unavailable');
    const snapshot =
      c.req.method === 'POST' ? await store.evaluate(id, reader) : await store.snapshot(id, reader);
    return c.json({ ...snapshot, unsettledWrites: await reader.unsettledWrites() });
  } catch (error) {
    return failure(c, error);
  }
}
export async function serviceGroupManual(c: Ctx) {
  try {
    const id = userId(c);
    const { store, reader } = await serviceGroupRuntime(c.env, getTenantIdFromContext(c), id);
    if (!reader) throw new Error('group_subject_unavailable');
    const input = await body(c);
    if (typeof input.present !== 'boolean') throw new Error('group_request_invalid');
    const catalog = await store.catalog();
    if (!catalog) throw new Error('group_catalog_missing');
    await reader.load(catalog.plan); // Resolve and validate the actual service account before writing.
    await store.setManual(id, c.req.param('id')!, input.present, actor(c));
    return c.json(await store.evaluate(id, reader));
  } catch (error) {
    return failure(c, error);
  }
}
export async function serviceGroupMembers(c: Ctx) {
  try {
    const { store } = await serviceGroupRuntime(c.env, getTenantIdFromContext(c));
    const catalog = await store.catalog();
    const id = c.req.param('id');
    if (!catalog?.plan.groups.some((g) => g.id === id)) throw new Error('group_not_found');
    const after = c.req.query('after') ?? '';
    const rows = await store.db.query<{ user_id: string }>(
      'SELECT user_id FROM service_group_results WHERE tenant_id = ? AND user_id > ? ORDER BY user_id LIMIT 20',
      [store.tenantId, after],
      primary
    );
    const members = [];
    for (const row of rows) {
      let reader: GroupInputReader;
      try {
        const runtime = await serviceGroupRuntime(c.env, store.tenantId, row.user_id);
        if (!runtime.reader) throw new Error('group_input_unavailable');
        reader = runtime.reader;
      } catch {
        // A deleted or temporarily unroutable account must not block every other member.
        // Preserve its committed result, explicitly failed, without reading a fallback shard.
        const unavailable = async (): Promise<never> => {
          throw new Error('group_input_unavailable');
        };
        reader = {
          tenantId: store.tenantId,
          userId: row.user_id,
          version: unavailable,
          load: unavailable,
        };
      }
      const snapshot = await store.snapshot(row.user_id, reader);
      if (snapshot.evaluation?.groups[id!]?.member === true)
        members.push({
          userId: row.user_id,
          freshness: snapshot.freshness,
          ruleVersion: snapshot.ruleVersion,
          reason: snapshot.evaluation.groups[id!],
        });
    }
    return c.json({
      members,
      nextCursor: rows.length === 20 ? rows[rows.length - 1].user_id : null,
      coverage: 'evaluated_subjects',
    });
  } catch (error) {
    return failure(c, error);
  }
}

export async function serviceGroupRestart(c: Ctx) {
  try {
    const { store } = await serviceGroupRuntime(c.env, getTenantIdFromContext(c));
    const input = await body(c);
    const catalog = await store.catalog();
    if (!catalog || input.ifMatch !== catalog.revision) throw new Error('group_version_conflict');
    await store.db.batch([
      {
        sql: "UPDATE service_group_scans SET cursor_id = '', processed = 0, failures = 0, status = 'pending', lease_until = 0, lease_token = NULL, updated_at = ? WHERE tenant_id = ?",
        params: [Date.now(), store.tenantId],
      },
      {
        sql: "INSERT INTO service_group_audit(id, tenant_id, user_id, rule_version, generation, event_type, detail_json, created_at) VALUES (?, ?, '', ?, 0, 'reconcile_requested', ?, ?)",
        params: [
          crypto.randomUUID(),
          store.tenantId,
          catalog.revision,
          JSON.stringify({ actorId: actor(c) }),
          Date.now(),
        ],
      },
    ]);
    return c.json({ status: 'pending' }, 202);
  } catch (error) {
    return failure(c, error);
  }
}

export async function serviceGroupRecover(c: Ctx) {
  try {
    const id = userId(c);
    const input = await body(c);
    if (
      input.acceptSavedAttributes !== true ||
      !Array.isArray(input.boundaryIds) ||
      input.boundaryIds.some((id) => typeof id !== 'string')
    )
      throw new Error('group_recovery_invalid');
    const { store, reader } = await serviceGroupRuntime(c.env, getTenantIdFromContext(c), id);
    if (!reader) throw new Error('group_input_unavailable');
    await reader.acceptFailedWrites(input.boundaryIds as string[], actor(c));
    return c.json(await store.evaluate(id, reader));
  } catch (error) {
    return failure(c, error);
  }
}
