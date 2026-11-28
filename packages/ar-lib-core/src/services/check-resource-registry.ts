/**
 * The resource registry of self-contract Check API requests (core migration 021).
 *
 * An end-user access token asks only "may I do <action> on <type>:<id>": the resource's owner,
 * group and attributes, and the relation that would grant the action, are never taken from that
 * request. They are registered here instead:
 *
 * - `check_resource_types`: a tenant's settings for a resource type, kept by its administrators
 *   (Admin API). `relations_json` maps an action to the ReBAC relation that grants it.
 * - `check_resources`: what the tenant's application server registered about one resource (Check
 *   API, with a `chk_` key allowed the `resources` operation): owner, group and attributes. Owner
 *   and group are the server's claim; their existence is not checked.
 *
 * `StoredResourceContextResolver` reads both for a self-contract check. In the self contract the
 * owner never grants by itself: it is material for the tenant's attribute-based rules.
 */

import type { DatabaseAdapter, PreparedStatement } from '../db/adapter';
import { isValidPermissionId } from '../utils/permission-grammar';
import type {
  ResolvedResourceContext,
  ResourceContextLookup,
  ResourceContextResolver,
} from '../types/check-api';

// =============================================================================
// Grammar and limits
// =============================================================================

/** A resource type, action or relation name: lower case, starting with a letter. */
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
/** An owner or group id: no whitespace, no `:`, no control character. */
// eslint-disable-next-line no-control-regex
const ID_FORBIDDEN = /[\s:\u0000-\u001f\u007f]/u;

export const CHECK_RESOURCE_NAME_MAX_LENGTH = 64;
export const CHECK_RESOURCE_ID_MAX_LENGTH = 256;
/** The attributes of one resource, as UTF-8 JSON. */
export const CHECK_RESOURCE_ATTRIBUTES_MAX_BYTES = 8 * 1024;
/** The resources one batch registers. */
export const CHECK_RESOURCE_BATCH_MAX_ITEMS = 100;
/** The actions one resource type maps to relations. */
export const CHECK_RESOURCE_TYPE_MAX_RELATIONS = 64;

/** A resource type, action or relation name (`[a-z][a-z0-9_]*`, at most 64 characters). */
export function isCheckResourceName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= CHECK_RESOURCE_NAME_MAX_LENGTH &&
    NAME_PATTERN.test(value)
  );
}

/** Characters (code points, as OpenAPI's maxLength counts), not UTF-16 units. */
function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

/**
 * A resource id: the permission grammar's id rule (`isValidPermissionId`: no whitespace, `:` or
 * control characters), so every registered resource is one a check can name, and at most 256
 * characters. `.` and `..` are refused: the grammar allows them, but as the last path segment of
 * PUT / DELETE the URL layer normalises them away, so a registered one could never be addressed.
 */
export function isCheckResourceId(value: unknown): value is string {
  return (
    isValidPermissionId(value) &&
    value !== '.' &&
    value !== '..' &&
    codePointLength(value) <= CHECK_RESOURCE_ID_MAX_LENGTH
  );
}

/** An owner or group id: non-empty, at most 256 characters, no whitespace, `:` or control. */
export function isCheckSubjectRefId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    codePointLength(value) <= CHECK_RESOURCE_ID_MAX_LENGTH &&
    !ID_FORBIDDEN.test(value)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// =============================================================================
// Request parsing
// =============================================================================

/** What the application server registers about a resource (a row is replaced whole). */
export interface CheckResourceFacts {
  owner_id: string | null;
  group_id: string | null;
  attributes: Record<string, unknown> | null;
}

export type CheckRegistryParseResult<T> = { ok: true; value: T } | { ok: false; field: string };

const FACT_KEYS: ReadonlySet<string> = new Set(['owner_id', 'group_id', 'attributes']);

/**
 * The facts of a resource from a request body (`{ owner_id?, group_id?, attributes? }`; `null`
 * or absent is none). Unknown keys, ids outside the grammar and attributes that are not an
 * object of at most 8 KiB (UTF-8 JSON) are refused, naming the field.
 */
export function parseCheckResourceFacts(
  input: unknown,
  allowedExtraKeys: ReadonlySet<string> = new Set()
): CheckRegistryParseResult<CheckResourceFacts> {
  if (!isPlainObject(input)) return { ok: false, field: 'body' };
  for (const key of Object.keys(input)) {
    if (!FACT_KEYS.has(key) && !allowedExtraKeys.has(key)) return { ok: false, field: key };
  }
  const facts: CheckResourceFacts = { owner_id: null, group_id: null, attributes: null };
  for (const field of ['owner_id', 'group_id'] as const) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (!isCheckSubjectRefId(value)) return { ok: false, field };
    facts[field] = value;
  }
  const attributes = input.attributes;
  if (attributes !== undefined && attributes !== null) {
    if (!isPlainObject(attributes)) return { ok: false, field: 'attributes' };
    if (
      new TextEncoder().encode(JSON.stringify(attributes)).byteLength >
      CHECK_RESOURCE_ATTRIBUTES_MAX_BYTES
    ) {
      return { ok: false, field: 'attributes' };
    }
    facts.attributes = attributes;
  }
  return { ok: true, value: facts };
}

/**
 * The action-to-relation map of a resource type (`{ "<action>": "<relation>" }`, both names in
 * the resource grammar, at most 64 entries).
 */
export function parseCheckResourceRelations(
  input: unknown
): CheckRegistryParseResult<Record<string, string>> {
  if (!isPlainObject(input)) return { ok: false, field: 'relations' };
  const entries = Object.entries(input);
  if (entries.length > CHECK_RESOURCE_TYPE_MAX_RELATIONS) return { ok: false, field: 'relations' };
  const relations: Record<string, string> = {};
  for (const [action, relation] of entries) {
    const field = `relations.${action}`;
    if (!isCheckResourceName(action)) return { ok: false, field };
    if (!isCheckResourceName(relation)) return { ok: false, field };
    relations[action] = relation;
  }
  return { ok: true, value: relations };
}

// =============================================================================
// Rows
// =============================================================================

export interface CheckResourceTypeRow {
  tenant_id: string;
  resource_type: string;
  relations_json: string;
  /** A random id given at insert (a re-created row gets another); not part of the record. */
  row_token?: string;
  /** The row's write count (Admin API writes are conditional on it); not part of the record. */
  revision?: number | string;
  created_at: number | string;
  updated_at: number | string;
}

export interface CheckResourceRow {
  tenant_id: string;
  resource_type: string;
  resource_id: string;
  owner_id: string | null;
  group_id: string | null;
  attributes_json: string | null;
  updated_at: number | string;
}

/** A resource type as the APIs return it (times in milliseconds, as stored). */
export interface CheckResourceTypeRecord {
  resource_type: string;
  relations: Record<string, string>;
  created_at: number;
  updated_at: number;
}

/** A registered resource as the APIs return it (time in milliseconds, as stored). */
export interface CheckResourceRecord {
  resource_type: string;
  resource_id: string;
  owner_id: string | null;
  group_id: string | null;
  attributes: Record<string, unknown> | null;
  updated_at: number;
}

/** The stored relations of a type; anything that is not a valid map is none (no relation). */
export function storedCheckResourceRelations(relationsJson: string): Record<string, string> {
  try {
    const parsed = parseCheckResourceRelations(JSON.parse(relationsJson));
    return parsed.ok ? parsed.value : {};
  } catch {
    return {};
  }
}

/** The stored attributes of a resource. A value that is not a JSON object is an error. */
function storedAttributes(attributesJson: string | null): Record<string, unknown> | null {
  if (attributesJson === null) return null;
  const parsed: unknown = JSON.parse(attributesJson);
  if (!isPlainObject(parsed)) throw new Error('check_resources.attributes_json is not an object');
  return parsed;
}

export function checkResourceTypeFromRow(row: CheckResourceTypeRow): CheckResourceTypeRecord {
  return {
    resource_type: row.resource_type,
    relations: storedCheckResourceRelations(row.relations_json),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function checkResourceFromRow(row: CheckResourceRow): CheckResourceRecord {
  return {
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    owner_id: row.owner_id,
    group_id: row.group_id,
    attributes: storedAttributes(row.attributes_json),
    updated_at: Number(row.updated_at),
  };
}

// =============================================================================
// Statements
// =============================================================================

/** Registers (or replaces whole) one resource of a tenant; `now` in milliseconds. */
export function checkResourceUpsertStatement(
  tenantId: string,
  resourceType: string,
  resourceId: string,
  facts: CheckResourceFacts,
  now: number
): PreparedStatement {
  return {
    sql: `INSERT INTO check_resources
            (tenant_id, resource_type, resource_id, owner_id, group_id, attributes_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, resource_type, resource_id) DO UPDATE SET
            owner_id = excluded.owner_id,
            group_id = excluded.group_id,
            attributes_json = excluded.attributes_json,
            updated_at = excluded.updated_at`,
    params: [
      tenantId,
      resourceType,
      resourceId,
      facts.owner_id,
      facts.group_id,
      facts.attributes === null ? null : JSON.stringify(facts.attributes),
      now,
    ],
  };
}

// =============================================================================
// Resolver
// =============================================================================

/**
 * Resolves a self-contract check's resource from the tenant's registry.
 *
 * - Nothing registered (neither the type's settings nor the resource): `null`.
 * - The resource's owner, group and attributes as stored (type-level permissions have no
 *   resource, so none).
 * - `rebac` only for an id-level permission whose action the type's `relations_json` maps to a
 *   relation: the check service then asks the ReBAC service whether the bound subject has that
 *   relation on the object, decided as for any check (direct tuples, group usersets, the
 *   tenant's relation definitions with their computed relations, declared paths and exclusion).
 *
 * A read failure or a stored attribute value that is not an object throws: the check service then
 * checks without a resource context.
 */
export class StoredResourceContextResolver implements ResourceContextResolver {
  constructor(private readonly db: DatabaseAdapter) {}

  async resolve(lookup: ResourceContextLookup): Promise<ResolvedResourceContext | null> {
    const [type, resource] = await Promise.all([
      this.db.queryOne<Pick<CheckResourceTypeRow, 'relations_json'>>(
        'SELECT relations_json FROM check_resource_types WHERE tenant_id = ? AND resource_type = ?',
        [lookup.tenantId, lookup.resourceType]
      ),
      lookup.resourceId
        ? this.db.queryOne<Pick<CheckResourceRow, 'owner_id' | 'group_id' | 'attributes_json'>>(
            `SELECT owner_id, group_id, attributes_json FROM check_resources
              WHERE tenant_id = ? AND resource_type = ? AND resource_id = ?`,
            [lookup.tenantId, lookup.resourceType, lookup.resourceId]
          )
        : Promise.resolve(null),
    ]);

    const resolved: ResolvedResourceContext = {};
    if (resource) {
      if (resource.owner_id) resolved.owner_id = resource.owner_id;
      if (resource.group_id) resolved.group_id = resource.group_id;
      const attributes = storedAttributes(resource.attributes_json);
      if (attributes) resolved.attributes = attributes;
    }
    const relation = type ? storedCheckResourceRelations(type.relations_json) : {};
    if (lookup.resourceId && Object.prototype.hasOwnProperty.call(relation, lookup.action)) {
      resolved.rebac = {
        relation: relation[lookup.action],
        object_type: lookup.resourceType,
        object_id: lookup.resourceId,
      };
    }
    return Object.keys(resolved).length > 0 ? resolved : null;
  }
}

export function createStoredResourceContextResolver(
  db: DatabaseAdapter
): StoredResourceContextResolver {
  return new StoredResourceContextResolver(db);
}
