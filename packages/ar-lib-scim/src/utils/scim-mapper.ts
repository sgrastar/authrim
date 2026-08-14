/**
 * SCIM 2.0 Resource Mapping Utilities
 *
 * Maps between internal database models and SCIM resource formats
 */

import type {
  ScimUser,
  ScimGroup,
  ScimName,
  ScimEmail,
  ScimPhoneNumber,
  ScimAddress,
  UserToScimContext,
  GroupToScimContext,
  ScimPatchValue,
} from '../types/scim';
import { SCIM_SCHEMAS } from '../types/scim';

/**
 * SCIM Enterprise User Extension attributes
 * RFC 7643 Section 4.3 - Enterprise User Schema Extension
 */
interface ScimEnterpriseExtension {
  employeeNumber?: string;
  costCenter?: string;
  organization?: string;
  division?: string;
  department?: string;
  manager?: {
    value: string;
    $ref: string;
  };
}

/**
 * Resource with timestamp fields for ETag generation
 */
interface ResourceWithTimestamp {
  updated_at?: string;
  created_at: string;
}

/**
 * Generic resource type for patch operations
 * Uses index signature to allow dynamic property access during patching
 *
 * Note: The any type is intentionally used here because SCIM patch operations
 * require dynamic property access with arbitrary depth (e.g., "name.givenName",
 * "emails[type eq \"work\"].value"). TypeScript's index signatures cannot
 * represent this pattern type-safely without losing the convenience of dynamic access.
 *
 * The applyPatchOperations function uses generics to preserve the input type
 * for the caller, while internally using this flexible type for manipulation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PatchableRecord = { [key: string]: any };

interface PatchPathSegment {
  key: string;
  filter?: {
    attr: string;
    value: string;
  };
}

const DANGEROUS_PATCH_PROPS = new Set(['__proto__', 'constructor', 'prototype']);

function isDangerousPatchKey(key: string): boolean {
  return DANGEROUS_PATCH_PROPS.has(key);
}

function splitPatchPath(path: string): string[] {
  const parts: string[] = [];
  let current = '';
  let bracketDepth = 0;

  for (const char of path) {
    if (char === '[') bracketDepth++;
    if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);

    if (char === '.' && bracketDepth === 0) {
      if (current) parts.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

function parsePatchPath(path: string): PatchPathSegment[] {
  return splitPatchPath(path).map((part) => {
    const filterMatch = part.match(/^([^\[]+)\[([A-Za-z0-9_$.-]+)\s+eq\s+["']([^"']*)["']\]$/);
    if (!filterMatch) {
      return { key: part };
    }

    return {
      key: filterMatch[1],
      filter: {
        attr: filterMatch[2],
        value: filterMatch[3],
      },
    };
  });
}

function pathHasDangerousSegment(segments: PatchPathSegment[]): boolean {
  return segments.some(
    (segment) =>
      isDangerousPatchKey(segment.key) ||
      (segment.filter ? isDangerousPatchKey(segment.filter.attr) : false)
  );
}

function findFilteredArrayItem(
  target: PatchableRecord,
  segment: PatchPathSegment,
  createIfMissing: boolean
): PatchableRecord | null {
  const filter = segment.filter;
  if (!filter) {
    return null;
  }

  const currentValue = target[segment.key];
  const items = Array.isArray(currentValue) ? currentValue : [];
  if (!Array.isArray(currentValue) && createIfMissing) {
    Object.defineProperty(target, segment.key, {
      value: items,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  const existing = items.find(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      String((item as PatchableRecord)[filter.attr]) === filter.value
  ) as PatchableRecord | undefined;

  if (existing) {
    return existing;
  }

  if (!createIfMissing) {
    return null;
  }

  const created: PatchableRecord = { [filter.attr]: filter.value };
  items.push(created);
  return created;
}

function getPatchParent(
  root: PatchableRecord,
  segments: PatchPathSegment[],
  createIfMissing: boolean
): PatchableRecord | null {
  let current = root;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];

    if (segment.filter) {
      const filtered = findFilteredArrayItem(current, segment, createIfMissing);
      if (!filtered) return null;
      current = filtered;
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(current, segment.key)) {
      if (!createIfMissing) return null;
      Object.defineProperty(current, segment.key, {
        value: {},
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    const nextValue = current[segment.key];
    if (typeof nextValue !== 'object' || nextValue === null) {
      if (!createIfMissing) return null;
      Object.defineProperty(current, segment.key, {
        value: {},
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    current = current[segment.key] as PatchableRecord;
  }

  return current;
}

function setPatchPath(
  root: PatchableRecord,
  segments: PatchPathSegment[],
  value: ScimPatchValue | undefined
): void {
  const parent = getPatchParent(root, segments, true);
  if (!parent) return;

  const target = segments[segments.length - 1];
  if (target.filter) {
    const items = Array.isArray(parent[target.key])
      ? (parent[target.key] as PatchableRecord[])
      : [];
    if (!Array.isArray(parent[target.key])) {
      Object.defineProperty(parent, target.key, {
        value: items,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    const matchIndex = items.findIndex(
      (item) => String(item[target.filter!.attr]) === target.filter!.value
    );
    const normalizedValue =
      typeof value === 'object' && value !== null
        ? (value as PatchableRecord)
        : { [target.filter.attr]: target.filter.value, value };

    if (matchIndex >= 0) {
      items[matchIndex] = normalizedValue;
    } else {
      items.push(normalizedValue);
    }
    return;
  }

  Object.defineProperty(parent, target.key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function removePatchPath(root: PatchableRecord, segments: PatchPathSegment[]): void {
  const parent = getPatchParent(root, segments, false);
  if (!parent) return;

  const target = segments[segments.length - 1];
  if (target.filter) {
    const items = parent[target.key];
    if (!Array.isArray(items)) return;
    parent[target.key] = items.filter(
      (item) =>
        typeof item !== 'object' ||
        item === null ||
        String((item as PatchableRecord)[target.filter!.attr]) !== target.filter!.value
    );
    return;
  }

  delete parent[target.key];
}

/**
 * Internal User model (from database)
 */
export interface InternalUser {
  id: string;
  tenant_id?: string;
  email: string;
  email_verified: number;
  name?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  middle_name?: string | null;
  nickname?: string | null;
  preferred_username?: string | null;
  profile?: string | null;
  picture?: string | null;
  website?: string | null;
  gender?: string | null;
  birthdate?: string | null;
  zoneinfo?: string | null;
  locale?: string | null;
  phone_number?: string | null;
  phone_number_verified?: number;
  address_json?: string | null;
  updated_at: string;
  created_at: string;
  custom_attributes_json?: string | null;
  password_hash?: string | null;
  external_id?: string | null;
  active?: number;
}

/**
 * Internal Group/Role model (from database)
 */
export interface InternalGroup {
  id: string;
  name: string;
  description?: string | null;
  created_at: string;
  updated_at?: string;
  external_id?: string | null;
}

/**
 * Convert internal user to SCIM User resource
 */
export function userToScim(user: InternalUser, context: UserToScimContext): ScimUser {
  const { baseUrl, includeGroups = false, groups } = context;

  // Parse address if present
  let addresses: ScimAddress[] | undefined;
  if (user.address_json) {
    try {
      const addr = JSON.parse(user.address_json);
      addresses = [
        {
          formatted: addr.formatted,
          streetAddress: addr.street_address,
          locality: addr.locality,
          region: addr.region,
          postalCode: addr.postal_code,
          country: addr.country,
          primary: true,
        },
      ];
    } catch {
      // Ignore invalid JSON
    }
  }

  // Build name object
  const name: ScimName | undefined =
    user.given_name || user.family_name || user.middle_name
      ? {
          formatted: user.name || undefined,
          givenName: user.given_name || undefined,
          familyName: user.family_name || undefined,
          middleName: user.middle_name || undefined,
        }
      : undefined;

  // Build emails array
  const emails: ScimEmail[] = [
    {
      value: user.email,
      type: 'work',
      primary: true,
    },
  ];

  // Build phone numbers array
  const phoneNumbers: ScimPhoneNumber[] | undefined = user.phone_number
    ? [
        {
          value: user.phone_number,
          type: 'work',
          primary: true,
        },
      ]
    : undefined;

  // Parse custom attributes for enterprise extension
  let enterpriseExtension: ScimEnterpriseExtension | undefined = undefined;
  let customAttributes: Record<string, unknown> = {};
  if (user.custom_attributes_json) {
    try {
      const customAttrs = JSON.parse(user.custom_attributes_json) as Record<string, unknown>;
      customAttributes = customAttrs;
      const employeeNumber = stringAttribute(customAttrs, 'employee_number', 'employeeNumber');
      const costCenter = stringAttribute(customAttrs, 'cost_center', 'costCenter');
      const organization = stringAttribute(customAttrs, 'organization');
      const division = stringAttribute(customAttrs, 'division');
      const department = stringAttribute(customAttrs, 'department');
      const managerValue = managerAttribute(customAttrs.manager);
      if (employeeNumber || costCenter || organization || division || department || managerValue) {
        enterpriseExtension = {
          employeeNumber,
          costCenter,
          organization,
          division,
          department,
          manager: managerValue
            ? {
                value: managerValue,
                $ref: `${baseUrl}/scim/v2/Users/${managerValue}`,
              }
            : undefined,
        };
      }
    } catch {
      // Ignore invalid JSON
    }
  }

  const scimUser: ScimUser = {
    schemas: [SCIM_SCHEMAS.USER],
    id: user.id,
    externalId: user.external_id || undefined,
    userName: user.preferred_username || user.email,
    name,
    displayName: user.name || undefined,
    nickName: user.nickname || undefined,
    profileUrl: user.profile || undefined,
    title: stringAttribute(customAttributes, 'title'),
    userType: stringAttribute(customAttributes, 'user_type', 'userType'),
    preferredLanguage: user.locale || undefined,
    locale: user.locale || undefined,
    timezone: user.zoneinfo || undefined,
    active: user.active !== undefined ? Boolean(user.active) : true,
    emails,
    phoneNumbers,
    addresses,
    meta: {
      resourceType: 'User',
      created: new Date(user.created_at).toISOString(),
      lastModified: new Date(user.updated_at).toISOString(),
      location: `${baseUrl}/scim/v2/Users/${user.id}`,
      version: generateEtag(user),
    },
  };

  // Add enterprise extension if present
  if (enterpriseExtension) {
    scimUser.schemas.push(SCIM_SCHEMAS.ENTERPRISE_USER);
    scimUser['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'] = enterpriseExtension;
  }

  if (includeGroups) {
    scimUser.groups = groups ?? [];
  }

  return scimUser;
}

function stringAttribute(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof source[key] === 'string' && source[key]) return source[key] as string;
  }
  return undefined;
}

function managerAttribute(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { value?: unknown }).value === 'string'
  ) {
    return (value as { value: string }).value;
  }
  return undefined;
}

/**
 * Convert internal group/role to SCIM Group resource
 */
export function groupToScim(
  group: InternalGroup,
  context: GroupToScimContext,
  members?: Array<{ user_id: string; email: string }>
): ScimGroup {
  const { baseUrl, includeMembers = true } = context;

  const scimGroup: ScimGroup = {
    schemas: [SCIM_SCHEMAS.GROUP],
    id: group.id,
    externalId: group.external_id || undefined,
    displayName: group.name,
    meta: {
      resourceType: 'Group',
      created: new Date(group.created_at).toISOString(),
      lastModified: new Date(group.updated_at || group.created_at).toISOString(),
      location: `${baseUrl}/scim/v2/Groups/${group.id}`,
      version: generateEtag(group),
    },
  };

  if (includeMembers && members && members.length > 0) {
    scimGroup.members = members.map((m) => ({
      value: m.user_id,
      $ref: `${baseUrl}/scim/v2/Users/${m.user_id}`,
      type: 'User',
      display: m.email,
    }));
  }

  return scimGroup;
}

/**
 * Convert SCIM Group to internal group model
 */
export function scimToGroup(scimGroup: Partial<ScimGroup>): Partial<InternalGroup> {
  const group: Partial<InternalGroup> = {};

  if (scimGroup.externalId) group.external_id = scimGroup.externalId;
  if (scimGroup.displayName) group.name = scimGroup.displayName;

  return group;
}

/**
 * Generate ETag for versioning
 */
export function generateEtag(resource: ResourceWithTimestamp): string {
  // Simple implementation: hash of updated_at timestamp
  const timestamp = resource.updated_at || resource.created_at;
  const date = new Date(timestamp).getTime();
  return `W/"${date}"`;
}

/**
 * Parse ETag from If-Match header
 */
export function parseEtag(etag: string): string {
  return etag.replace(/^W\/"|"$/g, '');
}

/**
 * Apply SCIM Patch operations to a resource
 *
 * Uses generics to preserve the input type for the caller.
 * Internally uses PatchableRecord for dynamic property manipulation.
 *
 * @template T - The resource type (e.g., ScimUser, ScimGroup)
 * @param resource - The resource to patch
 * @param operations - SCIM patch operations to apply
 * @returns The patched resource with the same type as input
 */
export function applyPatchOperations<T extends object>(
  resource: T,
  operations: Array<{ op: 'add' | 'remove' | 'replace'; path?: string; value?: ScimPatchValue }>
): T {
  // Cast to PatchableRecord for dynamic manipulation
  const result: PatchableRecord = { ...resource };

  for (const operation of operations) {
    const { op, path, value } = operation;

    if (!path) {
      // No path means replace entire attributes
      if (op === 'replace' || op === 'add') {
        Object.assign(result, value);
      }
      continue;
    }

    const pathSegments = parsePatchPath(path);

    // SECURITY: Prevent prototype pollution by rejecting dangerous property names
    if (pathHasDangerousSegment(pathSegments)) {
      continue; // Skip operations that could cause prototype pollution
    }

    switch (op) {
      case 'add':
      case 'replace':
        setPatchPath(result, pathSegments, value);
        break;

      case 'remove':
        removePatchPath(result, pathSegments);
        break;
    }
  }

  // Cast back to original type - the structure is preserved
  return result as T;
}

/**
 * Validate required SCIM User fields
 */
export function validateScimUser(user: Partial<ScimUser>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!user.userName) {
    errors.push('userName is required');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate required SCIM Group fields
 */
export function validateScimGroup(group: Partial<ScimGroup>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!group.displayName) {
    errors.push('displayName is required');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
