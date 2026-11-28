/**
 * Check API: the resource registry of self-contract checks.
 *
 * - PUT /api/check/resources/:type/:id - register (or replace whole) one resource
 * - DELETE /api/check/resources/:type/:id - remove one resource
 * - POST /api/check/resources/batch - register up to 100 resources, all or none
 *
 * Only a `chk_` API key whose `allowed_operations` include `resources` may call these (the
 * operation is never in a key's default set), at its own tenant's host: the key's tenant must be
 * the tenant the request was sent to, and is the registry written. End-user
 * access tokens and the policy service secret are refused (403). What is registered here is the
 * application server's claim: owner and group ids are not checked for existence, exactly like the
 * server contract's `resource_context.owner_id`. Self-contract checks read it through
 * `StoredResourceContextResolver` (resource-context-resolvers.ts); in that contract the owner never
 * grants by itself.
 */

import { Hono, type Context } from 'hono';
import {
  AR_ERROR_CODES,
  BodyLimitExceededError,
  CHECK_RESOURCE_BATCH_MAX_ITEMS,
  checkResourceFromRow,
  checkResourceUpsertStatement,
  createErrorResponse,
  createLogger,
  isCheckResourceId,
  isCheckResourceName,
  parseCheckResourceFacts,
  readRequestJsonWithLimit,
  type CheckResourceFacts,
  type CheckResourceRow,
} from '@authrim/ar-lib-core';
import {
  authenticateCheckApiRequest,
  isOperationAllowed,
  resolveAuthorizedCheckTenantId,
} from '../middleware/check-auth';
import { addRateLimitHeaders, type RateLimitContext } from '../middleware/rate-limit';
import { getPolicyCoreAdapter } from '../rebac-storage-adapter';
import { checkAuthenticationFailure } from './check-auth-response';
import { isCheckApiEnabled } from './check-settings';
import { checkAuthContext, checkRateLimitOrUnavailable, type CheckRoutesEnv } from './check';

const log = createLogger().module('CHECK-RESOURCES');

type Env = CheckRoutesEnv;
type RouteContext = Context<{ Bindings: Env }>;

/** The largest request body of a single resource and of a batch, in bytes. */
export const CHECK_RESOURCE_BODY_MAX_BYTES = 16 * 1024;
export const CHECK_RESOURCE_BATCH_BODY_MAX_BYTES = 1024 * 1024;

const BATCH_ITEM_KEYS: ReadonlySet<string> = new Set(['resource_type', 'resource_id']);

function invalid(c: RouteContext, field: string): Response | Promise<Response> {
  return createErrorResponse(c, AR_ERROR_CODES.VALIDATION_INVALID_VALUE, {
    variables: { field },
  });
}

/**
 * The checks every registry request passes before its body is read: the Check API is on, the
 * credential is an API key allowed `resources`, the key's tenant is the tenant the request was
 * sent to (the host's, as the request context resolved it; none resolved is refused too), and
 * the key's rate limit has room. Returns the tenant and the rate limit headers, or the response
 * that refuses the request (nothing is written then).
 */
async function admitRegistryRequest(
  c: RouteContext
): Promise<{ tenantId: string; headers: Headers } | Response> {
  if (!(await isCheckApiEnabled(c.env))) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
  }
  const auth = await authenticateCheckApiRequest(
    c.req.header('Authorization'),
    checkAuthContext(c)
  );
  if (!auth.authenticated) return checkAuthenticationFailure(c, auth);
  if (auth.method !== 'api_key' || !isOperationAllowed(auth, 'resources')) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
  }
  const tenantId = resolveAuthorizedCheckTenantId(auth, undefined);
  // The host's tenant, as the request context set it (read as set: no default tenant stands in).
  const requestTenantId = (c as unknown as { get(key: 'tenantId'): unknown }).get('tenantId');
  if (!tenantId || typeof requestTenantId !== 'string' || requestTenantId !== tenantId) {
    return createErrorResponse(c, AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS);
  }

  const rateLimitCtx: RateLimitContext = { limiter: c.env.RATE_LIMITER };
  const rateLimit = await checkRateLimitOrUnavailable(auth, rateLimitCtx);
  if (rateLimit instanceof Response) return rateLimit;
  const headers = new Headers();
  addRateLimitHeaders(headers, rateLimit);
  if (!rateLimit.allowed) {
    return c.json(
      {
        error: 'slow_down',
        error_description: 'Too many requests. Please retry later.',
        retry_after: rateLimit.retryAfter,
      },
      { status: 429, headers: Object.fromEntries(headers.entries()) }
    );
  }
  return { tenantId, headers };
}

/**
 * The request body as JSON, read up to `maxBytes` (Content-Length and the bytes read both count):
 * `{ tooLarge: true }` past it, `undefined` when it is not JSON.
 */
async function readBoundedJson(
  c: RouteContext,
  maxBytes: number
): Promise<{ value: unknown } | { tooLarge: true } | undefined> {
  try {
    return { value: await readRequestJsonWithLimit<unknown>(c.req.raw, maxBytes) };
  } catch (error) {
    return error instanceof BodyLimitExceededError ? { tooLarge: true } : undefined;
  }
}

/** 413 for a body past the limit (nothing is read past it, nothing is written). */
function tooLarge(c: RouteContext, maxBytes: number): Response {
  return c.json(
    {
      error: 'invalid_request',
      error_description: `The request body is larger than ${maxBytes} bytes.`,
    },
    413
  );
}

/** The resource type and id of the path, or the field that is outside the grammar. */
function pathResource(
  c: RouteContext
): { ok: true; type: string; id: string } | { ok: false; field: string } {
  const type = c.req.param('type');
  const id = c.req.param('id');
  if (!isCheckResourceName(type)) return { ok: false, field: 'resource_type' };
  if (!isCheckResourceId(id)) return { ok: false, field: 'resource_id' };
  return { ok: true, type, id };
}

function storedRecord(
  tenantId: string,
  resourceType: string,
  resourceId: string,
  facts: CheckResourceFacts,
  now: number
) {
  const row: CheckResourceRow = {
    tenant_id: tenantId,
    resource_type: resourceType,
    resource_id: resourceId,
    owner_id: facts.owner_id,
    group_id: facts.group_id,
    attributes_json: facts.attributes === null ? null : JSON.stringify(facts.attributes),
    updated_at: now,
  };
  return checkResourceFromRow(row);
}

const checkResourceRoutes = new Hono<{ Bindings: Env }>();

/**
 * PUT /api/check/resources/:type/:id
 * Body: { owner_id?, group_id?, attributes? } - the whole resource (an omitted field is cleared).
 */
checkResourceRoutes.put('/resources/:type/:id', async (c) => {
  const admitted = await admitRegistryRequest(c);
  if (admitted instanceof Response) return admitted;
  const resource = pathResource(c);
  if (!resource.ok) return invalid(c, resource.field);
  const read = await readBoundedJson(c, CHECK_RESOURCE_BODY_MAX_BYTES);
  if (read === undefined) return invalid(c, 'body');
  if ('tooLarge' in read) return tooLarge(c, CHECK_RESOURCE_BODY_MAX_BYTES);
  const facts = parseCheckResourceFacts(read.value);
  if (!facts.ok) return invalid(c, facts.field);

  try {
    const now = Date.now();
    await getPolicyCoreAdapter(c).execute(
      ...statementArgs(
        checkResourceUpsertStatement(
          admitted.tenantId,
          resource.type,
          resource.id,
          facts.value,
          now
        )
      )
    );
    return c.json(storedRecord(admitted.tenantId, resource.type, resource.id, facts.value, now), {
      status: 200,
      headers: Object.fromEntries(admitted.headers.entries()),
    });
  } catch (error) {
    log.error('Resource registration failed', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * DELETE /api/check/resources/:type/:id
 * Idempotent: `deleted` says whether a registered resource was removed.
 */
checkResourceRoutes.delete('/resources/:type/:id', async (c) => {
  const admitted = await admitRegistryRequest(c);
  if (admitted instanceof Response) return admitted;
  const resource = pathResource(c);
  if (!resource.ok) return invalid(c, resource.field);

  try {
    const result = await getPolicyCoreAdapter(c).execute(
      'DELETE FROM check_resources WHERE tenant_id = ? AND resource_type = ? AND resource_id = ?',
      [admitted.tenantId, resource.type, resource.id]
    );
    return c.json(
      {
        resource_type: resource.type,
        resource_id: resource.id,
        deleted: result.rowsAffected > 0,
      },
      { status: 200, headers: Object.fromEntries(admitted.headers.entries()) }
    );
  } catch (error) {
    log.error('Resource removal failed', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

/**
 * POST /api/check/resources/batch
 * Body: { items: [{ resource_type, resource_id, owner_id?, group_id?, attributes? }] } - 1 to 100
 * items, each replacing its resource whole; one invalid item (or the same resource twice) refuses
 * the whole request, and the items are written in one atomic batch.
 */
checkResourceRoutes.post('/resources/batch', async (c) => {
  const admitted = await admitRegistryRequest(c);
  if (admitted instanceof Response) return admitted;
  const read = await readBoundedJson(c, CHECK_RESOURCE_BATCH_BODY_MAX_BYTES);
  if (read === undefined) return invalid(c, 'body');
  if ('tooLarge' in read) return tooLarge(c, CHECK_RESOURCE_BATCH_BODY_MAX_BYTES);
  const body = read.value;
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== 'items')
  ) {
    return invalid(c, 'body');
  }
  const items = (body as { items?: unknown }).items;
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    items.length > CHECK_RESOURCE_BATCH_MAX_ITEMS
  ) {
    return invalid(c, 'items');
  }

  const parsed: { type: string; id: string; facts: CheckResourceFacts }[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < items.length; index++) {
    const item: unknown = items[index];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return invalid(c, `items[${index}]`);
    }
    const { resource_type: type, resource_id: id } = item as Record<string, unknown>;
    if (!isCheckResourceName(type)) return invalid(c, `items[${index}].resource_type`);
    if (!isCheckResourceId(id)) return invalid(c, `items[${index}].resource_id`);
    const facts = parseCheckResourceFacts(item, BATCH_ITEM_KEYS);
    if (!facts.ok) return invalid(c, `items[${index}].${facts.field}`);
    const key = `${type}\u0000${id}`;
    if (seen.has(key)) return invalid(c, `items[${index}].resource_id`);
    seen.add(key);
    parsed.push({ type, id, facts: facts.value });
  }

  try {
    const now = Date.now();
    await getPolicyCoreAdapter(c).batch(
      parsed.map(({ type, id, facts }) =>
        checkResourceUpsertStatement(admitted.tenantId, type, id, facts, now)
      )
    );
    return c.json(
      {
        count: parsed.length,
        items: parsed.map(({ type, id, facts }) =>
          storedRecord(admitted.tenantId, type, id, facts, now)
        ),
      },
      { status: 200, headers: Object.fromEntries(admitted.headers.entries()) }
    );
  } catch (error) {
    log.error('Resource batch registration failed', { error: String(error) }, error as Error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  }
});

function statementArgs(statement: { sql: string; params?: unknown[] }): [string, unknown[]] {
  return [statement.sql, statement.params ?? []];
}

export { checkResourceRoutes };
