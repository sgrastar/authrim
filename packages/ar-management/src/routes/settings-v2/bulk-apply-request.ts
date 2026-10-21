/**
 * The request of POST /api/admin/settings/bulk-apply, read and checked before anything is looked
 * up: its shape, and its size against the limits (which are settings: KV, then the environment,
 * then the code defaults).
 */
import {
  BULK_APPLY_DEFAULT_MAX_KEYS,
  BULK_APPLY_DEFAULT_MAX_TENANTS,
  BULK_APPLY_MAX_KEYS_KEY,
  BULK_APPLY_MAX_TENANTS_KEY,
  clampBulkApplyLimit,
  createLogger,
  ALL_CATEGORY_META,
  resolvePlatformSettingsWithSources,
  sanitizeObject,
  type Env,
} from '@authrim/ar-lib-core';

import {
  estimateResponseBytes,
  MAX_ESTIMATED_RESPONSE_BYTES,
  jsonBytes,
  MAX_REQUEST_VALUE_BYTES,
  MAX_REQUEST_VALUES_BYTES,
} from './bulk-apply-size';

const log = createLogger().module('SETTINGS_BULK_APPLY');

export type BulkApplyMode = 'preview' | 'apply';
export type ExistingOverridePolicy = 'skip' | 'overwrite';

export interface BulkApplyChange {
  category: string;
  set: Record<string, unknown>;
  clear: string[];
}

export interface BulkApplyRequest {
  mode: BulkApplyMode;
  tenantIds: string[];
  changes: BulkApplyChange[];
  onExistingOverride: ExistingOverridePolicy;
  /** tenant ID -> category -> the version the preview returned. */
  expected: Record<string, Record<string, string>>;
}

export interface BulkApplyLimits {
  maxTenants: number;
  maxKeys: number;
}

export type BulkApplyRequestProblem = {
  status: 400;
  error: 'invalid_request';
  code: string;
  description: string;
  limit?: number;
};

/** The most changes (categories) one request may carry. */
const MAX_CHANGES = 20;
/** The most tenant IDs read from the body before it is refused outright (a bound on the work). */
const MAX_RAW_TENANT_IDS = 1000;
/** What a settings key part may look like (see the settings manager). */
const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CATEGORY_PATTERN = /^[a-z0-9-]{1,64}$/;
const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;
const TOP_LEVEL_FIELDS = new Set([
  'mode',
  'tenant_ids',
  'changes',
  'on_existing_override',
  'expected',
]);

/**
 * The limits in force: the platform's saved value, else the environment variable, else the
 * default, held between 1 and 100. A settings document that cannot be read leaves the defaults
 * (the smaller choice).
 */
export async function resolveBulkApplyLimits(env: Env): Promise<BulkApplyLimits> {
  try {
    const { values } = await resolvePlatformSettingsWithSources(env, 'bulk-apply', {
      fresh: true,
    });
    return {
      maxTenants: clampBulkApplyLimit(
        values[BULK_APPLY_MAX_TENANTS_KEY],
        BULK_APPLY_DEFAULT_MAX_TENANTS
      ),
      maxKeys: clampBulkApplyLimit(values[BULK_APPLY_MAX_KEYS_KEY], BULK_APPLY_DEFAULT_MAX_KEYS),
    };
  } catch {
    log.warn('Bulk apply limits could not be read; the defaults apply');
    return { maxTenants: BULK_APPLY_DEFAULT_MAX_TENANTS, maxKeys: BULK_APPLY_DEFAULT_MAX_KEYS };
  }
}

function problem(
  code: string,
  description: string,
  limit?: number
): { problem: BulkApplyRequestProblem } {
  return {
    problem: {
      status: 400,
      error: 'invalid_request',
      code,
      description,
      ...(limit === undefined ? {} : { limit }),
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads and checks the body; a problem names what is wrong with the request, never a value. */
export function parseBulkApplyRequest(
  raw: unknown,
  limits: BulkApplyLimits
): { request: BulkApplyRequest } | { problem: BulkApplyRequestProblem } {
  if (!isPlainObject(raw)) return problem('invalid_body', 'The body must be a JSON object');
  for (const field of Object.keys(raw)) {
    if (!TOP_LEVEL_FIELDS.has(field)) {
      return problem('unknown_field', `The request has a field that is not part of it: ${field}`);
    }
  }

  const mode = raw.mode;
  if (mode !== 'preview' && mode !== 'apply') {
    return problem('invalid_mode', 'mode must be "preview" or "apply"');
  }

  const onExistingOverride = raw.on_existing_override ?? 'skip';
  if (onExistingOverride !== 'skip' && onExistingOverride !== 'overwrite') {
    return problem(
      'invalid_on_existing_override',
      'on_existing_override must be "skip" or "overwrite"'
    );
  }

  if (
    !Array.isArray(raw.tenant_ids) ||
    raw.tenant_ids.length === 0 ||
    raw.tenant_ids.length > MAX_RAW_TENANT_IDS
  ) {
    return problem('invalid_tenant_ids', 'tenant_ids must be a non-empty list of tenant IDs');
  }
  const tenantIds: string[] = [];
  const seen = new Set<string>();
  for (const id of raw.tenant_ids as unknown[]) {
    if (typeof id !== 'string' || !TENANT_ID_PATTERN.test(id)) {
      return problem('invalid_tenant_id', 'tenant_ids must hold tenant IDs only');
    }
    if (!seen.has(id)) {
      seen.add(id);
      tenantIds.push(id);
    }
  }
  if (tenantIds.length > limits.maxTenants) {
    return problem(
      'too_many_tenants',
      `A request may name at most ${limits.maxTenants} tenants; send the rest in another request`,
      limits.maxTenants
    );
  }

  if (!Array.isArray(raw.changes) || raw.changes.length === 0) {
    return problem('invalid_changes', 'changes must be a non-empty list');
  }
  if (raw.changes.length > MAX_CHANGES) {
    return problem(
      'too_many_changes',
      `A request may carry at most ${MAX_CHANGES} changes (one for each category)`,
      MAX_CHANGES
    );
  }
  const changes: BulkApplyChange[] = [];
  const categories = new Set<string>();
  // Operations: a category and a key together, counted as they are read.
  let operations = 0;
  let valueBytes = 0;
  for (const entry of raw.changes as unknown[]) {
    if (!isPlainObject(entry)) return problem('invalid_change', 'Each change must be an object');
    for (const field of Object.keys(entry)) {
      if (field !== 'category' && field !== 'set' && field !== 'clear') {
        return problem('unknown_field', `A change has a field that is not part of it: ${field}`);
      }
    }
    const category = entry.category;
    if (typeof category !== 'string' || !CATEGORY_PATTERN.test(category)) {
      return problem('invalid_category', 'Each change must name a settings category');
    }
    if (categories.has(category)) {
      return problem('duplicate_category', 'A category may appear in one change only');
    }
    categories.add(category);
    // A category that does not exist is a malformed request, not a result for every tenant.
    if (!Object.hasOwn(ALL_CATEGORY_META, category)) {
      return problem('unknown_category', 'A change names a settings category that does not exist');
    }

    if (entry.set !== undefined && !isPlainObject(entry.set)) {
      return problem('invalid_set', 'set must be an object of setting keys and values');
    }
    if (entry.clear !== undefined && !Array.isArray(entry.clear)) {
      return problem('invalid_clear', 'clear must be a list of setting keys');
    }
    // Counted before the lists are worked on, so a long one is refused at once.
    operations += Object.keys(entry.set ?? {}).length + ((entry.clear as unknown[]) ?? []).length;
    if (operations > limits.maxKeys) {
      return problem(
        'too_many_keys',
        `A request may carry at most ${limits.maxKeys} settings; send the rest in another request`,
        limits.maxKeys
      );
    }
    const set = sanitizeObject(entry.set ?? {});
    if ((entry.clear as unknown[] | undefined)?.some((key) => typeof key !== 'string')) {
      return problem('invalid_clear', 'clear must be a list of setting keys');
    }
    const clear = [...new Set((entry.clear ?? []) as string[])];
    for (const value of Object.values(set)) {
      const bytes = jsonBytes(value);
      valueBytes += bytes;
      if (bytes > MAX_REQUEST_VALUE_BYTES || valueBytes > MAX_REQUEST_VALUES_BYTES) {
        return problem(
          'value_too_large',
          `A value may be at most ${MAX_REQUEST_VALUE_BYTES} bytes as JSON, and all values together ${MAX_REQUEST_VALUES_BYTES}`,
          MAX_REQUEST_VALUE_BYTES
        );
      }
    }

    for (const key of [...Object.keys(set), ...clear]) {
      if (!KEY_PATTERN.test(key)) return problem('invalid_key', 'A setting key is malformed');
    }
    for (const key of clear) {
      if (Object.hasOwn(set, key)) {
        return problem('conflicting_operations', 'A key may be set or cleared, not both');
      }
    }
    if (Object.keys(set).length + clear.length === 0) {
      return problem('empty_change', 'A change must set or clear at least one key');
    }
    changes.push({ category, set, clear });
  }
  if (estimateResponseBytes(mode, tenantIds, changes) > MAX_ESTIMATED_RESPONSE_BYTES) {
    return problem(
      'response_too_large',
      'The answer to this request could be too large to keep; name fewer tenants or settings'
    );
  }

  // No prototype: tenant IDs and categories come from the body.
  const expected = Object.create(null) as Record<string, Record<string, string>>;
  if (raw.expected !== undefined) {
    if (!isPlainObject(raw.expected)) {
      return problem('invalid_expected', 'expected must map tenant IDs to category versions');
    }
    for (const [tenantId, versions] of Object.entries(raw.expected)) {
      if (!isPlainObject(versions)) {
        return problem('invalid_expected', 'expected must map tenant IDs to category versions');
      }
      const forTenant = Object.create(null) as Record<string, string>;
      for (const [category, version] of Object.entries(versions)) {
        if (typeof version !== 'string') {
          return problem('invalid_expected', 'expected must map tenant IDs to category versions');
        }
        forTenant[category] = version;
      }
      expected[tenantId] = forTenant;
    }
  }

  return { request: { mode, tenantIds, changes, onExistingOverride, expected } };
}
