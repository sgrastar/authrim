/**
 * The one grammar of end-user permission strings.
 *
 * A permission a role holds (a "granted" permission) is one of:
 * - `resource:action`        (type level, e.g. `documents:read`)
 * - `resource:<id>:action`   (one resource, e.g. `documents:doc_42:read`)
 * - `resource:*`             (every action on the resource type and on each of its resources)
 * - `*:*` or `*`             (everything)
 *
 * A permission that is checked (the Check API's `permission`) names one concrete action: only the
 * first two forms.
 *
 * `resource` and `action` are `[a-z][a-z0-9_]*`. An id is any non-empty string without whitespace,
 * control characters (NUL included) and `:` (the separator), so an id that contains a colon cannot
 * be named in a permission.
 */

/** A resource type or action name. */
export const PERMISSION_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** A resource id: non-empty, no whitespace, no control character (C0, DEL, C1), no `:`. */
// eslint-disable-next-line no-control-regex
export const PERMISSION_ID_PATTERN = /^[^\s:\u0000-\u001f\u007f-\u009f]+$/;

/** A permission string as it is checked: one concrete action. */
export type ConcretePermission =
  | { kind: 'type_level'; resource: string; action: string }
  | { kind: 'id_level'; resource: string; id: string; action: string };

/** A permission string as a role holds it. */
export type GrantedPermission =
  | ConcretePermission
  | { kind: 'resource_wildcard'; resource: string }
  | { kind: 'all' };

/** Whether the value is a valid resource type or action name. */
export function isValidPermissionName(value: unknown): value is string {
  return typeof value === 'string' && PERMISSION_NAME_PATTERN.test(value);
}

/** Whether the value is a valid resource id of a permission. */
export function isValidPermissionId(value: unknown): value is string {
  return typeof value === 'string' && PERMISSION_ID_PATTERN.test(value);
}

/** A checked permission string (`resource:action` or `resource:<id>:action`), or null. */
export function parseConcretePermission(value: unknown): ConcretePermission | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.length === 2) {
    const [resource, action] = parts;
    if (!isValidPermissionName(resource) || !isValidPermissionName(action)) return null;
    return { kind: 'type_level', resource, action };
  }
  if (parts.length === 3) {
    const [resource, id, action] = parts;
    if (
      !isValidPermissionName(resource) ||
      !isValidPermissionId(id) ||
      !isValidPermissionName(action)
    ) {
      return null;
    }
    return { kind: 'id_level', resource, id, action };
  }
  return null;
}

/** The keys of a checked permission in object form. */
const PERMISSION_OBJECT_KEYS: ReadonlySet<string> = new Set(['resource', 'id', 'action']);

/**
 * A checked permission as an API takes it (the Check API, the Admin access check): a string, or
 * `{ resource, id?, action }` with no other key. In the object form an `id` that is present must be
 * a valid id: `""` or `null` is not "no id" but an invalid permission. Null when invalid.
 */
export function parseCheckPermissionInput(value: unknown): ConcretePermission | null {
  if (typeof value === 'string') return parseConcretePermission(value);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !PERMISSION_OBJECT_KEYS.has(key))) return null;
  const { resource, id, action } = input;
  if (!isValidPermissionName(resource) || !isValidPermissionName(action)) return null;
  if (!('id' in input) || id === undefined) return { kind: 'type_level', resource, action };
  return isValidPermissionId(id) ? { kind: 'id_level', resource, id, action } : null;
}

/** A permission string a role may hold, or null when it is not one. */
export function parsePermissionString(value: unknown): GrantedPermission | null {
  if (typeof value !== 'string') return null;
  if (value === '*' || value === '*:*') return { kind: 'all' };
  const parts = value.split(':');
  if (parts.length === 2 && parts[1] === '*') {
    return isValidPermissionName(parts[0])
      ? { kind: 'resource_wildcard', resource: parts[0] }
      : null;
  }
  return parseConcretePermission(value);
}

/**
 * The lowest grant tier a role holding these permissions may have: 3 with `*` or `*:*`
 * (everything), 2 with a `resource:*`, 1 otherwise. A wildcard grants more than any listed
 * permission, so only an administrator of that tier may create, grant or edit such a role.
 */
export function minimumGrantTierForPermissions(permissions: readonly unknown[]): 1 | 2 | 3 {
  let tier: 1 | 2 | 3 = 1;
  for (const permission of permissions) {
    const parsed = parsePermissionString(permission);
    if (parsed?.kind === 'all') return 3;
    if (parsed?.kind === 'resource_wildcard') tier = 2;
  }
  return tier;
}

/**
 * Whether a permission a role holds covers a checked one: the same string, `resource:*` of its
 * resource, `*:*` or `*`. The one matcher of the Check API and of permission embedding. A held
 * permission outside the grammar covers nothing.
 */
export function grantedPermissionCovers(granted: unknown, checked: ConcretePermission): boolean {
  const held = parsePermissionString(granted);
  if (!held) return false;
  switch (held.kind) {
    case 'all':
      return true;
    case 'resource_wildcard':
      return held.resource === checked.resource;
    case 'type_level':
      return (
        checked.kind === 'type_level' &&
        held.resource === checked.resource &&
        held.action === checked.action
      );
    case 'id_level':
      return (
        checked.kind === 'id_level' &&
        held.resource === checked.resource &&
        held.id === checked.id &&
        held.action === checked.action
      );
  }
}

/** The refusal code of a role whose stored grant tier is below what its wildcards need. */
export const ROLE_TIER_BELOW_WILDCARD = 'role_grant_tier_below_wildcard';

/**
 * Whether a stored role's `grant_tier` is at least what its wildcards need
 * (minimumGrantTierForPermissions). Role create and update enforce it; every path that gives a
 * role (direct and group grants, invitations, JIT rules, adding a member to a group carrying it)
 * refuses a role that falls short, so a row written before the rule cannot be handed out. An
 * unreadable permission list falls short (fail closed).
 */
export function roleTierCoversWildcards(role: {
  grant_tier: number | string | null;
  permissions_json: string | null;
}): boolean {
  let permissions: unknown;
  try {
    permissions = JSON.parse(role.permissions_json ?? '[]');
  } catch {
    return false;
  }
  if (!Array.isArray(permissions)) return false;
  const floor = minimumGrantTierForPermissions(permissions);
  // Without a wildcard there is no floor: any tier holds.
  if (floor === 1) return true;
  const tier = Number(role.grant_tier);
  return Number.isInteger(tier) && tier >= floor;
}

/** Whether the value is a permission string a role may hold. */
export function isValidPermission(value: unknown): value is string {
  return parsePermissionString(value) !== null;
}
