/**
 * Tenants that a machine principal's all-tenants scope does not include
 * (`machine_access.all_scope_excluded_tenants`).
 *
 * Saving refuses what could not be used. Reading is stricter than a value being absent: a saved
 * value that is not valid (it can only get there around the Settings API) is "invalid", never
 * "unset", and a value that cannot be read at all is treated the same way. For both, the decision
 * is to exclude every tenant from an all-tenants scope: a protection is not dropped because its
 * setting is broken, and only machine tokens of the kind the setting limits are affected (never a
 * human session, never a platform principal), so the operator is not locked out.
 */
import {
  MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS_KEY,
  MACHINE_ACCESS_CATEGORY,
  MAX_MACHINE_ACCESS_EXCLUDED_TENANTS,
} from '../types/settings/machine-access';
import { isPlatformMachinePrincipal } from '../repositories/admin/admin-machine-grant';
import { isValidTenantIdentifier } from '../utils/tenant-request-policy';
import { resolvePlatformSettingsWithSources } from './effective-settings';
import type { AdminAuthContext } from '../types/admin';
import type { EffectiveSettingsEnv } from './effective-settings';

/** A DNS label is at most 63 characters, which is also the longest tenant ID. */
const MAX_TENANT_ID_LENGTH = 63;
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** A value of a request shown in a message: short, without control characters. */
function printable(value: string): string {
  const shown = value.length > 64 ? `${value.slice(0, 64)}...` : value;
  return shown.replace(CONTROL_CHARACTER, '?');
}

function splitTenants(value: string): string[] {
  return value.split(',').map((entry) => entry.trim());
}

/**
 * Why `machine_access.all_scope_excluded_tenants` is not valid as saved (null when it is): a
 * comma-separated list of at most {@link MAX_MACHINE_ACCESS_EXCLUDED_TENANTS} distinct lowercase
 * tenant IDs. The empty string is the empty list.
 */
export function machineExcludedTenantsProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be a comma-separated list of tenant IDs';
  if (value.trim() === '') return null;
  const entries = splitTenants(value);
  if (entries.length > MAX_MACHINE_ACCESS_EXCLUDED_TENANTS) {
    return `must list at most ${MAX_MACHINE_ACCESS_EXCLUDED_TENANTS} tenants`;
  }
  for (const entry of entries) {
    if (entry === '') return 'must not contain an empty entry';
    if (entry.includes('*')) return 'must not be a wildcard';
    if (entry.length > MAX_TENANT_ID_LENGTH || !isValidTenantIdentifier(entry)) {
      return `tenant ID "${printable(entry)}" must be a lowercase DNS-label tenant ID`;
    }
  }
  if (new Set(entries).size !== entries.length) return 'must not list a tenant twice';
  return null;
}

/**
 * What the platform excludes from an all-tenants scope, as the check reads it.
 * - `none`: no tenant (the default).
 * - `list`: these tenants.
 * - `all`: every tenant: the setting is not valid or could not be read.
 */
export type MachineExcludedTenants =
  | { kind: 'none' }
  | { kind: 'list'; tenants: ReadonlySet<string> }
  | { kind: 'all' };

export function readMachineExcludedTenants(value: unknown): MachineExcludedTenants {
  // Only "not set" (undefined) and the empty text are no tenant. A stored null is not a list: it
  // reads as every tenant, so it cannot override an environment list and lift the protection.
  if (value === undefined || value === '') return { kind: 'none' };
  if (machineExcludedTenantsProblem(value) !== null) return { kind: 'all' };
  const entries = splitTenants(value as string);
  return entries.length === 0 || (entries.length === 1 && entries[0] === '')
    ? { kind: 'none' }
    : { kind: 'list', tenants: new Set(entries) };
}

/**
 * The tenants excluded from an all-tenants scope right now, read without the per-isolate cache so
 * a saved change applies to the next request (a value just written is subject only to the KV
 * propagation of the settings store). Settings that cannot be read exclude every tenant.
 */
export async function resolveMachineExcludedTenants(
  env: EffectiveSettingsEnv
): Promise<MachineExcludedTenants> {
  try {
    const { values } = await resolvePlatformSettingsWithSources(env, MACHINE_ACCESS_CATEGORY, {
      fresh: true,
    });
    return readMachineExcludedTenants(values[MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS_KEY]);
  } catch {
    return { kind: 'all' };
  }
}

/** Compare tenant IDs the way the path check does: NFKC, trimmed, lowercase. */
export function normalizeTenantIdForExclusion(tenantId: string): string {
  return tenantId.normalize('NFKC').trim().toLowerCase();
}

/**
 * Whether the setting can apply to this caller at all: a machine access token whose tenant scope
 * is all tenants, of a principal that is not a platform principal. Everything else (a human
 * session, a token limited to named tenants, an agent token, the setup tool, the Admin console
 * relay, an internal service) is not subject to it, so the caller can skip reading the setting.
 */
export function isAllScopeNonPlatformMachine(auth: AdminAuthContext | undefined): boolean {
  return (
    auth !== undefined &&
    auth.authMethod === 'machine_access_token' &&
    (auth.tenantScope ?? []).includes('*') &&
    !isPlatformMachinePrincipal({
      id: auth.actorId ?? auth.userId,
      clientId: auth.clientId,
      principalType: auth.principalType,
    })
  );
}

/**
 * Whether the caller's all-tenants scope does not reach `tenantId`: the setting excludes it and
 * the caller's principal and credential do not name it in their own allow-lists.
 * `tenantId` null stands for a tenant that could not be read from the request: it counts as any
 * excluded tenant.
 */
export function allScopeExcludesTenant(
  auth: AdminAuthContext,
  excluded: MachineExcludedTenants,
  tenantId: string | null
): boolean {
  if (!isAllScopeNonPlatformMachine(auth)) return false;
  if (excluded.kind === 'none') return false;
  if (tenantId === null) return true;
  const normalized = normalizeTenantIdForExclusion(tenantId);
  if (excluded.kind === 'list' && !excluded.tenants.has(normalized)) return false;
  return !(auth.tenantScopeExplicit ?? []).some(
    (named) => normalizeTenantIdForExclusion(named) === normalized
  );
}

// ---------------------------------------------------------------------------------------------
// The shared decision for handlers that take their target tenant from somewhere other than the
// request tenant and the path (a body field, a query value, a stored row)
// ---------------------------------------------------------------------------------------------

/** What a handler needs of its Hono context. */
export interface MachineExclusionContext {
  env: unknown;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  json(body: unknown, status?: number): Response;
}

const MEMO_KEY = 'machineExcludedTenantsMemo';

/**
 * The tenants excluded from an all-tenants machine scope for this request, read at most once per
 * request (the answer is kept on the context, as a promise, so concurrent callers share one read).
 * A caller the setting cannot apply to (a human, a platform principal, a token naming its
 * tenants) reads nothing and gets `none`.
 */
export function machineExcludedTenantsOf(
  c: MachineExclusionContext
): Promise<MachineExcludedTenants> {
  const auth = c.get('adminAuth') as AdminAuthContext | undefined;
  if (!isAllScopeNonPlatformMachine(auth)) return Promise.resolve({ kind: 'none' });
  return machineExcludedTenantsSetting(c);
}

/**
 * The setting itself, for whoever a decision needs it for (a human's granting operation, for
 * example), through the same per-request memo as `machineExcludedTenantsOf`. Read only where a
 * decision needs it.
 */
export function machineExcludedTenantsSetting(
  c: MachineExclusionContext
): Promise<MachineExcludedTenants> {
  const memo = c.get(MEMO_KEY) as Promise<MachineExcludedTenants> | undefined;
  if (memo) return memo;
  const read = resolveMachineExcludedTenants(c.env as EffectiveSettingsEnv);
  c.set(MEMO_KEY, read);
  return read;
}

/** The refusal of a tenant outside a machine token's reach: the one the middleware gives. */
export function machineTenantRefusal(c: Pick<MachineExclusionContext, 'json'>): Response {
  return c.json(
    {
      error: 'access_denied',
      error_description: 'Admin machine credential is not valid for this tenant.',
    },
    403
  );
}

/**
 * Pure: whether the caller's machine scope reaches `tenantId` once the exclusion applies. For
 * filtering what a cross-tenant read returns. A caller the setting does not apply to reaches
 * every tenant it otherwise does. `null` is a tenant that could not be read.
 */
export function machineReachesTenant(
  auth: AdminAuthContext | undefined,
  excluded: MachineExcludedTenants,
  tenantId: string | null
): boolean {
  return auth === undefined || !allScopeExcludesTenant(auth, excluded, tenantId);
}

/**
 * Call with the tenant a handler resolved as its target (from a body, a query, a stored row).
 * Null when the caller may act on that tenant, else the 403 response to return.
 * - a tenant ID: judged;
 * - `undefined`: no tenant was named, the operation is platform-wide: nothing to judge here;
 * - `null`: a tenant was named but could not be resolved: refused for a caller the setting limits.
 * A machine token for every tenant of a non-platform principal is refused on an excluded tenant
 * unless it names the tenant itself. The setting is read once per request.
 */
export async function refuseMachineOnExcludedTenant(
  c: MachineExclusionContext,
  tenantId: string | null | undefined
): Promise<Response | null> {
  if (tenantId === undefined) return null;
  const auth = c.get('adminAuth') as AdminAuthContext | undefined;
  if (!isAllScopeNonPlatformMachine(auth)) return null;
  const excluded = await machineExcludedTenantsOf(c);
  if (excluded.kind === 'none') return null;
  return machineReachesTenant(auth, excluded, tenantId) ? null : machineTenantRefusal(c);
}

/** Filters the items of a cross-tenant list down to the tenants the caller reaches. */
export async function filterTenantsReachableByMachine<T>(
  c: MachineExclusionContext,
  items: readonly T[],
  tenantOf: (item: T) => string | null
): Promise<T[]> {
  const auth = c.get('adminAuth') as AdminAuthContext | undefined;
  if (!isAllScopeNonPlatformMachine(auth)) return [...items];
  const excluded = await machineExcludedTenantsOf(c);
  if (excluded.kind === 'none') return [...items];
  return items.filter((item) => machineReachesTenant(auth, excluded, tenantOf(item)));
}

const RESOLVED_KEY = 'machineExcludedTenantsResolved';

/**
 * For routers whose synchronous helpers decide on a list of target tenants: reads the setting once
 * (through the per-request memo) and keeps the answer on the context for `resolvedMachineExcluded`.
 * Mount it after the authentication middleware.
 */
export async function loadMachineExcludedTenants(c: MachineExclusionContext): Promise<void> {
  c.set(RESOLVED_KEY, await machineExcludedTenantsOf(c));
}

/**
 * What `loadMachineExcludedTenants` kept. For a caller the setting applies to and that was not
 * loaded, `all` (fail closed); for any other caller, `none`.
 */
export function resolvedMachineExcluded(
  c: Pick<MachineExclusionContext, 'get'>
): MachineExcludedTenants {
  const auth = c.get('adminAuth') as AdminAuthContext | undefined;
  if (!isAllScopeNonPlatformMachine(auth)) return { kind: 'none' };
  return (c.get(RESOLVED_KEY) as MachineExcludedTenants | undefined) ?? { kind: 'all' };
}

/**
 * For a cross-tenant list read from a database: the SQL condition (and its parameters) that keeps
 * only the tenants the caller reaches, to be used for the count and the page alike, so that totals,
 * pages and cursors stay right. Null when nothing is to be hidden (the caller is not limited, or
 * nothing is excluded). `column` is a trusted column name, never a request value.
 */
export async function machineTenantSqlCondition(
  c: MachineExclusionContext,
  column: string
): Promise<{ sql: string; params: string[] } | null> {
  const auth = c.get('adminAuth') as AdminAuthContext | undefined;
  if (!auth || !isAllScopeNonPlatformMachine(auth)) return null;
  const excluded = await machineExcludedTenantsOf(c);
  if (excluded.kind === 'none') return null;
  const named = (auth.tenantScopeExplicit ?? []).map(normalizeTenantIdForExclusion);
  if (excluded.kind === 'all') {
    return named.length > 0
      ? { sql: `${column} IN (${named.map(() => '?').join(',')})`, params: named }
      : { sql: '1 = 0', params: [] };
  }
  const hidden = [...excluded.tenants].filter((tenantId) => !named.includes(tenantId));
  return hidden.length > 0
    ? { sql: `${column} NOT IN (${hidden.map(() => '?').join(',')})`, params: hidden }
    : null;
}
