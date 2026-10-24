/**
 * GET / PUT /api/admin/identity-mapping/test-users
 *
 * The calling tenant's test users: made-up sets of Authrim attributes an administrator keeps to
 * explain the release of claims (`POST /api/admin/identity-mapping/explain`) without looking at a
 * real person. A test user is not an account: there is no user row, nothing else reads it, and the
 * explanation reads nothing keyed by its ID.
 *
 * An attribute is named by a key a mapping can read: a canonical field of the tenant's or the
 * platform's field catalog, or one of the tenant's custom fields. The values are what the
 * administrator typed (strings, numbers, booleans, lists of those, or one object of strings such
 * as an address), and are given back as they are: they are fixtures, not anyone's data. The audit
 * record of a save names how many test users and attributes there are, never a value.
 *
 * A PUT replaces the whole list in one batch, so the list is never half saved.
 */
import type { Context } from 'hono';
import {
  createAuditLogFromContext,
  createLogger,
  ensureAdminDatabaseAdapter,
  getTenantIdFromContext,
  PLATFORM_MAPPING_TENANT_ID,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';

type TestUsersContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;

const log = createLogger().module('IDENTITY_MAPPING_TEST_USERS');
const PARTITION = 'identity-mapping-test-users';

export const TEST_USER_LIMITS = {
  maxUsers: 10,
  maxAttributes: 50,
  maxLabelChars: 100,
  maxStringChars: 256,
  maxListItems: 20,
  maxObjectKeys: 10,
  maxAttributesBytes: 8192,
} as const;

const TEST_USER_ID_PATTERN = /^tu_[A-Za-z0-9_-]{1,61}$/;
const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Never an attribute: the subject of an explanation is the test user's ID. */
const RESERVED_ATTRIBUTE_KEYS = new Set(['sub']);

export type TestUserAttributeValue =
  | string
  | number
  | boolean
  | null
  | Array<string | number | boolean>
  | Record<string, string>;

export interface TestUser {
  userId: string;
  label: string;
  attributes: Record<string, TestUserAttributeValue>;
  createdAt: number;
  updatedAt: number;
}

interface TestUserRow {
  id: string;
  label: string;
  attributes_json: string;
  created_at: number;
  updated_at: number;
}

function toTestUser(row: TestUserRow): TestUser {
  let attributes: Record<string, TestUserAttributeValue> = {};
  try {
    const parsed = JSON.parse(row.attributes_json) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      attributes = parsed as Record<string, TestUserAttributeValue>;
    }
  } catch {
    // The column is checked to hold a JSON object; anything else reads as no attributes.
  }
  return {
    userId: row.id,
    label: row.label,
    attributes,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** The calling tenant's test users, in their saved order. */
export async function listTestUsers(admin: DatabaseAdapter, tenantId: string): Promise<TestUser[]> {
  const rows = await admin.query<TestUserRow>(
    `SELECT id, label, attributes_json, created_at, updated_at
       FROM identity_mapping_test_users
      WHERE tenant_id = ?
      ORDER BY position ASC, id ASC`,
    [tenantId]
  );
  return rows.map(toTestUser);
}

/** One of the calling tenant's test users, or null. */
export async function findTestUser(
  admin: DatabaseAdapter,
  tenantId: string,
  userId: string
): Promise<TestUser | null> {
  const row = await admin.queryOne<TestUserRow>(
    `SELECT id, label, attributes_json, created_at, updated_at
       FROM identity_mapping_test_users
      WHERE tenant_id = ? AND id = ?`,
    [tenantId, userId]
  );
  return row ? toTestUser(row) : null;
}

/**
 * The attribute keys a test user may hold: the canonical fields of the tenant's and the
 * platform's field catalogs (a set compiles against a catalog in any state, a draft one too), and
 * the tenant's active custom fields. Names only: they bound what can be typed in, nothing else.
 */
export async function readTestUserAttributeKeys(
  admin: DatabaseAdapter,
  tenantId: string
): Promise<Set<string>> {
  const [catalog, custom] = await Promise.all([
    admin.query<{ path: string }>(
      `SELECT DISTINCT path
         FROM field_catalog_entries
        WHERE tenant_id IN (?, ?)
          AND target_taxonomy = 'canonical'`,
      [tenantId, PLATFORM_MAPPING_TENANT_ID]
    ),
    admin.query<{ custom_key: string }>(
      `SELECT custom_key FROM custom_field_catalog_entries
        WHERE tenant_id = ? AND lifecycle_state = 'active'`,
      [tenantId]
    ),
  ]);
  return new Set([...catalog.map((row) => row.path), ...custom.map((row) => row.custom_key)]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    (typeof value === 'string' && value.length <= TEST_USER_LIMITS.maxStringChars) ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean'
  );
}

function isAttributeValue(value: unknown): value is TestUserAttributeValue {
  if (value === null || isScalar(value)) return true;
  if (Array.isArray(value)) {
    return value.length <= TEST_USER_LIMITS.maxListItems && value.every(isScalar);
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return (
      entries.length <= TEST_USER_LIMITS.maxObjectKeys &&
      entries.every(
        ([key, item]) =>
          ATTRIBUTE_KEY_PATTERN.test(key) &&
          typeof item === 'string' &&
          item.length <= TEST_USER_LIMITS.maxStringChars
      )
    );
  }
  return false;
}

interface ParsedTestUser {
  userId: string | null;
  label: string;
  attributes: Record<string, TestUserAttributeValue>;
}

type Parsed = { ok: true; users: ParsedTestUser[] } | { ok: false; description: string };

/** Reads a PUT body; the keys are checked against the catalog afterwards. */
export function parseTestUsersRequest(body: unknown): Parsed {
  const fail = (description: string): Parsed => ({ ok: false, description });
  if (!isRecord(body) || Object.keys(body).some((key) => key !== 'test_users')) {
    return fail('The body must be an object with test_users only');
  }
  const list = body.test_users;
  if (!Array.isArray(list)) return fail('test_users must be an array');
  if (list.length > TEST_USER_LIMITS.maxUsers) {
    return fail(`At most ${TEST_USER_LIMITS.maxUsers} test users`);
  }
  const users: ParsedTestUser[] = [];
  const seen = new Set<string>();
  for (const [index, item] of list.entries()) {
    const at = `test_users[${index}]`;
    if (
      !isRecord(item) ||
      Object.keys(item).some((key) => !['user_id', 'label', 'attributes'].includes(key))
    ) {
      return fail(`${at} must be an object with user_id, label and attributes only`);
    }
    let userId: string | null = null;
    if (item.user_id !== undefined) {
      if (typeof item.user_id !== 'string' || !TEST_USER_ID_PATTERN.test(item.user_id)) {
        return fail(`${at}.user_id must be an ID this endpoint gave (tu_…)`);
      }
      if (seen.has(item.user_id)) return fail(`${at}.user_id is given twice`);
      seen.add(item.user_id);
      userId = item.user_id;
    }
    const label = item.label;
    if (
      typeof label !== 'string' ||
      label.trim().length === 0 ||
      label.length > TEST_USER_LIMITS.maxLabelChars
    ) {
      return fail(`${at}.label must be 1 to ${TEST_USER_LIMITS.maxLabelChars} characters`);
    }
    if (!isRecord(item.attributes)) return fail(`${at}.attributes must be an object`);
    const entries = Object.entries(item.attributes);
    if (entries.length > TEST_USER_LIMITS.maxAttributes) {
      return fail(`${at}.attributes has at most ${TEST_USER_LIMITS.maxAttributes} keys`);
    }
    for (const [key, value] of entries) {
      if (!ATTRIBUTE_KEY_PATTERN.test(key) || RESERVED_ATTRIBUTE_KEYS.has(key)) {
        return fail(`${at}.attributes has a key that cannot be an attribute`);
      }
      if (!isAttributeValue(value)) {
        return fail(`${at}.attributes.${key} is not a value a test user can hold`);
      }
    }
    if (JSON.stringify(item.attributes).length > TEST_USER_LIMITS.maxAttributesBytes) {
      return fail(`${at}.attributes is too large`);
    }
    users.push({
      userId,
      label,
      attributes: item.attributes as Record<string, TestUserAttributeValue>,
    });
  }
  return { ok: true, users };
}

function describe(users: TestUser[]) {
  return {
    test_users: users.map((user) => ({
      user_id: user.userId,
      label: user.label,
      attributes: user.attributes,
      updated_at: user.updatedAt,
    })),
    limits: {
      max_users: TEST_USER_LIMITS.maxUsers,
      max_attributes: TEST_USER_LIMITS.maxAttributes,
    },
  };
}

function unavailable(c: TestUsersContext) {
  return c.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'The test users cannot be read right now',
    },
    503
  );
}

export async function adminIdentityMappingTestUsersListHandler(c: TestUsersContext) {
  const tenantId = getTenantIdFromContext(c);
  const admin = ensureAdminDatabaseAdapter(c.env, PARTITION);
  if (!admin) return unavailable(c);
  try {
    return c.json(describe(await listTestUsers(admin, tenantId)));
  } catch {
    return unavailable(c);
  }
}

export async function adminIdentityMappingTestUsersReplaceHandler(c: TestUsersContext) {
  // An Agent's settings writes each need an approval, which this replace does not carry.
  if (c.get('adminAuth')?.actorType === 'agent') {
    return c.json(
      { error: 'forbidden', error_description: 'An Agent cannot replace the test users' },
      403
    );
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', error_description: 'Invalid JSON body' }, 400);
  }
  const parsed = parseTestUsersRequest(body);
  if (!parsed.ok) {
    return c.json({ error: 'invalid_request', error_description: parsed.description }, 400);
  }

  const tenantId = getTenantIdFromContext(c);
  const admin = ensureAdminDatabaseAdapter(c.env, PARTITION);
  if (!admin) return unavailable(c);
  let current: TestUser[];
  let allowedKeys: Set<string>;
  try {
    [current, allowedKeys] = await Promise.all([
      listTestUsers(admin, tenantId),
      readTestUserAttributeKeys(admin, tenantId),
    ]);
  } catch {
    return unavailable(c);
  }
  const unknownKeys = [
    ...new Set(
      parsed.users.flatMap((user) =>
        Object.keys(user.attributes).filter((key) => !allowedKeys.has(key))
      )
    ),
  ].sort();
  if (unknownKeys.length > 0) {
    return c.json(
      {
        error: 'invalid_request',
        error_description: 'Some attributes are not fields of the catalog or custom fields',
        unknown_attributes: unknownKeys,
      },
      400
    );
  }
  // A user_id names a test user of this tenant: a made-up one, or another tenant's, is refused.
  const existing = new Map(current.map((user) => [user.userId, user]));
  const stray = parsed.users.find((user) => user.userId !== null && !existing.has(user.userId));
  if (stray) {
    return c.json(
      { error: 'invalid_request', error_description: 'A user_id is not one of the test users' },
      400
    );
  }

  const now = Date.now();
  const saved = parsed.users.map((user, position) => {
    const userId = user.userId ?? `tu_${crypto.randomUUID()}`;
    return {
      userId,
      label: user.label,
      attributes: user.attributes,
      position,
      createdAt: existing.get(userId)?.createdAt ?? now,
    };
  });
  try {
    await admin.batch([
      {
        sql: 'DELETE FROM identity_mapping_test_users WHERE tenant_id = ?',
        params: [tenantId],
      },
      ...saved.map((user) => ({
        sql: `INSERT INTO identity_mapping_test_users
                (tenant_id, id, label, attributes_json, position, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          tenantId,
          user.userId,
          user.label,
          JSON.stringify(user.attributes),
          user.position,
          Math.min(user.createdAt, now),
          now,
        ],
      })),
    ]);
  } catch {
    log.error('The test users could not be saved');
    return c.json(
      { error: 'internal_error', error_description: 'The test users could not be saved' },
      500
    );
  }
  try {
    await createAuditLogFromContext(
      c as unknown as Parameters<typeof createAuditLogFromContext>[0],
      'identity_mapping.test_users.replaced',
      'identity_mapping_test_users',
      tenantId,
      {
        test_user_count: saved.length,
        attribute_count: saved.reduce((sum, user) => sum + Object.keys(user.attributes).length, 0),
        removed_count: current.filter((user) => !saved.some((s) => s.userId === user.userId))
          .length,
      }
    );
  } catch {
    log.warn('The audit record of a test users save could not be written');
  }
  return c.json(
    describe(
      saved.map((user) => ({
        userId: user.userId,
        label: user.label,
        attributes: user.attributes,
        createdAt: user.createdAt,
        updatedAt: now,
      }))
    )
  );
}
