import type { Context } from 'hono';
import {
  getTenantIdFromContext,
  loadGroupFields,
  compileGroups,
  evaluateGroups,
  bumpTenantRBACCacheVersion,
  evaluateAndPublishDynamicMemberships,
  removeDynamicGroup,
  dependentGroups,
  groupsCarryingRoles,
  resolveDynamicFreshnessSeconds,
  selfWritableGroups,
  expireDynamicGroupMemberships,
  getLogger,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
  type ServiceGroup,
  type GroupInputReader,
  type SavedGroupInputReader,
  type DynamicGroupStore,
  stableStringify,
} from '@authrim/ar-lib-core';
import { serviceGroupRuntime } from './dynamic-groups-runtime';
import { tenantRBACStores } from './rbac-account-stores';
import { canManageGroupMembership, type MembershipChange } from './group-role-management';
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
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('group_request_invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('group_request_invalid');
  return value as Record<string, unknown>;
}
function actor(c: Ctx): string {
  const auth = c.get('adminAuth') as { userId?: string; adminUserId?: string } | undefined;
  return auth?.adminUserId ?? auth?.userId ?? 'admin';
}
/** The subject's dynamic rows could not be expired from here: the reconcile's scan does it. */
function expiryPending(c: Ctx) {
  return c.json(
    { error: 'group_input_unavailable', publication: { status: 'expiry_pending' } },
    503
  );
}
function failure(c: Ctx, error: unknown) {
  const code =
    error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : 'group_input_unavailable';
  if (code === 'group_expiry_pending') return expiryPending(c);
  const status =
    code === 'role_delegation_denied'
      ? 403
      : code.includes('conflict') || code.includes('busy')
        ? 409
        : code.includes('unavailable')
          ? 503
          : code.includes('not_found')
            ? 404
            : 400;
  return c.json({ error: code }, status);
}
function adminAuthOf(c: Ctx): AdminAuthContext | null {
  return (c.get('adminAuth') as AdminAuthContext | undefined) ?? null;
}
/**
 * Delegation: a change to a rule (its condition, SCIM link, on/off, its removal) changes who is
 * a member of that group and of every group whose rule references it,
 * transitively. Each of those groups that carries roles (on it or an ancestor) needs the same
 * permission and grant ceiling as granting those roles (canManageGroupMembership).
 */
async function assertMayAffectGroups(
  db: Parameters<typeof canManageGroupMembership>[0],
  tenantId: string,
  auth: AdminAuthContext | null,
  groupIds: Iterable<string>,
  change: MembershipChange
) {
  for (const id of new Set(groupIds))
    if (!(await canManageGroupMembership(db, tenantId, auth, id, change)))
      throw new Error('role_delegation_denied');
}
const ruleChanged = (before: ServiceGroup | undefined, after: ServiceGroup) =>
  !before ||
  stableStringify(before.condition) !== stableStringify(after.condition) ||
  before.enabled !== after.enabled ||
  (before.scimRoleId ?? null) !== (after.scimRoleId ?? null);
/**
 * A service group is a canonical group: like the groups API, its deletion waits while another
 * group has it as parent or a group role grant has it as scope. This read gives the answer its
 * own error; the catalog save checks the same in its write (in its batch, and on PostgreSQL under
 * the group catalog lock), so a parent or grant added between the two still stops the deletion
 * (a version conflict). On D1 the groups API's reparent and grant writes take no lock: the
 * batch's own check narrows that window, it does not close it.
 */
async function refuseCanonicalDependents(store: DynamicGroupStore, groupId: string) {
  const children = await store.db.queryOne<{ count: number | string | null }>(
    'SELECT COUNT(*) AS count FROM "groups" WHERE tenant_id = ? AND parent_group_id = ?',
    [store.tenantId, groupId],
    primary
  );
  const scoped = await store.db.queryOne<{ count: number | string | null }>(
    "SELECT COUNT(*) AS count FROM group_role_assignments WHERE tenant_id = ? AND scope_type = 'group' AND scope_target = ?",
    [store.tenantId, `group:${groupId}`],
    primary
  );
  if (Number(children?.count ?? 0) > 0 || Number(scoped?.count ?? 0) > 0)
    throw new Error('group_delete_conflict');
}
/**
 * Every shard on its own: one that fails does not keep the others from expiring. Each shard's
 * expiry records the subjects' pending cache invalidation in its own batch. Answers whether every
 * shard was reached (else the reconcile's scan of that shard expires the rows later).
 */
async function expireChangedRuleMemberships(
  c: Ctx,
  store: DynamicGroupStore,
  groupIds: Iterable<string>
): Promise<boolean> {
  const log = getLogger(c as unknown as Context<{ Bindings: Env }>).module('SERVICE-GROUPS');
  let accounts: DatabaseAdapter[];
  try {
    accounts = (await tenantRBACStores(c as unknown as Context<{ Bindings: Env }>, store.tenantId))
      .accounts;
  } catch {
    log.warn('Dynamic memberships under a changed rule: account databases unavailable', {
      tenantId: store.tenantId,
    });
    return false;
  }
  let complete = true;
  for (const account of new Set(accounts)) {
    try {
      for (const groupId of groupIds)
        await expireDynamicGroupMemberships(account, store.tenantId, groupId, {
          cache: c.env?.REBAC_CACHE,
          log,
        });
    } catch {
      complete = false;
      log.warn('Dynamic memberships under a changed rule could not be expired on a shard', {
        tenantId: store.tenantId,
      });
    }
  }
  return complete;
}
/** Evaluates the subject and publishes the committed result into its group memberships. */
async function evaluateAndPublish(c: Ctx, store: DynamicGroupStore, reader: SavedGroupInputReader) {
  const { snapshot, publication } = await evaluateAndPublishDynamicMemberships(store, reader, {
    cache: c.env?.REBAC_CACHE,
    freshnessSeconds: await resolveDynamicFreshnessSeconds(
      c.env,
      store.tenantId,
      getLogger(c as unknown as Context<{ Bindings: Env }>).module('SERVICE-GROUPS')
    ),
  });
  return { ...snapshot, publication };
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
    let seeds: string[] = [];
    // Deleting or only disabling a rule takes memberships away ('remove': never refused for a
    // role below its wildcard tier); any other rule change may hand them out ('add').
    let change: MembershipChange = 'add';
    if (deleting) {
      groups = groups.filter((g) => g.id !== id);
      seeds = [id!];
      change = 'remove';
    } else {
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
      // The SCIM link names a SCIM Group: a canonical group of kind `scim` (see inputs.ts).
      if (
        group.scimRoleId &&
        !(await store.db.queryOne(
          `SELECT id FROM "groups" WHERE tenant_id = ? AND id = ? AND kind = 'scim'`,
          [store.tenantId, group.scimRoleId],
          primary
        ))
      )
        throw new Error('group_scim_reference_invalid');
      groups = [...groups.filter((g) => g.id !== group.id), group];
      // A rename alone changes no membership.
      if (ruleChanged(existing, group)) seeds = [group.id];
      const onlyDisabled =
        existing !== undefined &&
        existing.enabled !== false &&
        group.enabled === false &&
        stableStringify(existing.condition) === stableStringify(group.condition) &&
        (existing.scimRoleId ?? null) === (group.scimRoleId ?? null);
      if (onlyDisabled) change = 'remove';
    }
    if (typeof input.ifMatch !== 'number') throw new Error('group_version_invalid');
    const next = compileGroups(store.tenantId, groups, fields);
    // Every group whose membership the change can reach, in the catalog before and after.
    const affected = new Set([
      ...dependentGroups(next, seeds),
      ...(catalog ? dependentGroups(catalog.plan, seeds) : []),
    ]);
    const selfWritable = selfWritableGroups(next);
    // The role checks run right before the write: on PostgreSQL inside the save's transaction,
    // after the group catalog lock that grants and reparents also take; on D1 they narrow the
    // window to the write only.
    const check = async (db: Parameters<typeof groupsCarryingRoles>[0]) => {
      await assertMayAffectGroups(db, store.tenantId, adminAuthOf(c), affected, change);
      // A field the person writes themselves must not decide a role grant.
      if (
        (
          await groupsCarryingRoles(
            db,
            store.tenantId,
            [...affected].filter((groupId) => selfWritable.has(groupId))
          )
        ).size
      )
        throw new Error('group_self_writable_attribute');
    };
    if (deleting) await refuseCanonicalDependents(store, id!);
    const saved = await store.save(groups, fields, input.ifMatch, actor(c), check);
    const log = getLogger(c as unknown as Context<{ Bindings: Env }>).module('SERVICE-GROUPS');
    // The canonical group's name and state are in cached claims (authrim_groups). A failed bump
    // is logged; it does not stop the expiry below.
    const cache = c.env?.REBAC_CACHE;
    if (cache)
      await bumpTenantRBACCacheVersion(cache, store.tenantId).catch(() =>
        log.warn('Tenant claims cache version not bumped after a service group save', {
          tenantId: store.tenantId,
        })
      );
    // A changed rule (condition, SCIM link, on/off): the memberships published under the old one
    // stop granting now, on every shard, until each subject's next publication decides again.
    const expired =
      deleting || !affected.size ? true : await expireChangedRuleMemberships(c, store, affected);
    if (deleting) {
      try {
        const stores = await tenantRBACStores(
          c as unknown as Context<{ Bindings: Env }>,
          store.tenantId
        );
        // The tenant version was bumped just above.
        await removeDynamicGroup(store.db, stores.accounts, store.tenantId, id!, cache, {
          bumpTenant: false,
        });
      } catch {
        // The catalog no longer has the group and its canonical row is inactive (no grants):
        // the service-group reconcile finishes the removal on every shard.
      }
    }
    return c.json({
      revision: saved.revision,
      groups: saved.plan.groups,
      // A shard not reached: its rows under the old rule are expired by the reconcile's scan.
      ...(expired ? {} : { publication: { status: 'expiry_pending' } }),
    });
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
    let runtime: Awaited<ReturnType<typeof serviceGroupRuntime>>;
    try {
      runtime = await serviceGroupRuntime(c.env, getTenantIdFromContext(c), id);
    } catch (error) {
      // The subject's account database cannot be reached now: its dynamic rows cannot be expired
      // from here. The reconcile's scan of that database expires them when it can.
      if (c.req.method !== 'POST') throw error;
      return expiryPending(c);
    }
    const { store, reader } = runtime;
    if (!reader) throw new Error('group_input_unavailable');
    if (c.req.method !== 'POST') {
      const snapshot = await store.snapshot(id, reader);
      return c.json({ ...snapshot, unsettledWrites: await reader.unsettledWrites() });
    }
    // The status follows the publication, decided before any supplementary read.
    const result = await evaluateAndPublish(c, store, reader);
    if (result.publication.status === 'expiry_pending') return expiryPending(c);
    let unsettledWrites: Awaited<ReturnType<SavedGroupInputReader['unsettledWrites']>> | undefined;
    try {
      unsettledWrites = await reader.unsettledWrites();
    } catch {
      unsettledWrites = undefined;
    }
    return c.json({ ...result, ...(unsettledWrites ? { unsettledWrites } : {}) });
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
    const at = Date.now();
    const audit = await store.prepareAudit({
      userId: '',
      ruleVersion: catalog.revision,
      generation: 0,
      eventType: 'reconcile_requested',
      createdAt: at,
      detail: { actorId: actor(c) },
    });
    if (audit.state === 'committed' || audit.state === 'published') {
      await audit.dispatch();
      return c.json({ status: 'pending' }, 202);
    }
    await store.db.batch(
      audit.wrapBusinessBatch(
        [
          {
            sql: `UPDATE service_group_scans SET cursor_id='',processed=0,failures=0,status='pending',lease_until=0,lease_token=NULL,updated_at=?
        WHERE tenant_id=? AND EXISTS(SELECT 1 FROM service_group_catalog WHERE tenant_id=? AND revision=?)`,
            params: [at, store.tenantId, store.tenantId, catalog.revision],
          },
        ],
        {
          where: `EXISTS(SELECT 1 FROM service_group_catalog WHERE tenant_id=? AND revision=?) AND
      NOT EXISTS(SELECT 1 FROM service_group_scans WHERE tenant_id=? AND (cursor_id!='' OR processed!=0 OR failures!=0 OR status!='pending' OR lease_until!=0 OR lease_token IS NOT NULL OR updated_at!=?))`,
          params: [store.tenantId, catalog.revision, store.tenantId, at],
        }
      )
    );
    await store.finishAudit(audit);
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
    return c.json(await evaluateAndPublish(c, store, reader));
  } catch (error) {
    return failure(c, error);
  }
}
