/**
 * zod 3 -> 4 migration pins for compliance/access-reviews.ts (CreateSchema and DecisionSchema).
 *
 * These handlers report ONLY `issues[0]`: `variables.field = issue.path.join('.') || 'body'` and
 * `variables.reason = issue.message`. `createErrorResponse` is mocked (status from the real
 * implementation, body `{ error: code, ...options }`) so both strings are pinned.
 * A body that passes validation is detected by the next step: no `adminAuth` -> 403.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    getTenantIdFromContext: vi.fn(() => 'tenant-a'),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: {} })),
    createAuditLogFromContext: vi.fn(),
    createErrorResponse: vi.fn(async (c, code, options) => {
      const real = await actual.createErrorResponse(c, code, options);
      return Response.json({ error: code, ...options }, { status: real.status });
    }),
    getLogger: vi.fn(() => ({
      module: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    })),
  };
});
vi.mock('../../cross-shard-account-list', () => ({
  CrossShardAccountExactSearchService: class {},
}));
vi.mock('../../access-revocation', () => ({
  AccountLifecycleSupersededError: class extends Error {},
  removeRoleAssignment: vi.fn(),
  removeOrganizationMembership: vi.fn(),
  suspendAccount: vi.fn(),
}));

import { createAccessReview, decideAccessReviewItems } from '../../compliance/access-reviews';

function context(body: unknown, bodyError = false) {
  return {
    get: vi.fn(() => null),
    req: {
      path: '/api/admin/compliance/access-reviews',
      header: vi.fn(() => undefined),
      param: vi.fn(() => 'review-1'),
      query: vi.fn(),
      json: bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad'))
        : vi.fn().mockResolvedValue(body),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

async function run(handler: (c: never) => Promise<Response>, body: unknown, bodyError = false) {
  const response = await handler(context(body, bodyError));
  return { status: response.status, body: await response.json() };
}

const invalid = (field: string, reason: string) => ({
  status: 400,
  body: { error: 'AR130003', variables: { field, reason } },
});
/** Passed the schema; stopped because the fixture has no adminAuth. */
const ACCEPTED = { status: 403, body: { error: 'AR060002' } };
const SCOPE_ENUM = "'all_users' | 'role' | 'organization' | 'inactive_users'";

describe('zod pins: access review CreateSchema (POST /access-reviews)', () => {
  beforeEach(() => vi.clearAllMocks());
  const create = (body: unknown, bodyError = false) => run(createAccessReview, body, bodyError);
  const good = { name: 'Q3 review', scope: 'all_users' };

  it('only the first issue is reported; root issues use field "body"', async () => {
    expect(await create(null)).toEqual(invalid('body', 'Expected object, received null'));
    expect(await create([])).toEqual(invalid('body', 'Expected object, received array'));
    expect(await create('x')).toEqual(invalid('body', 'Expected object, received string'));
    expect(await create(undefined, true)).toEqual(
      invalid('body', 'Expected object, received null')
    );
    // {} has issues for name and scope: only name (first) is reported
    expect(await create({})).toEqual(invalid('name', 'Required'));
    expect(await create({ name: 'x' })).toEqual(invalid('scope', 'Required'));
  });

  it('per-field messages and dotted path', async () => {
    expect(await create({ ...good, name: '' })).toEqual(
      invalid('name', 'String must contain at least 1 character(s)')
    );
    expect(await create({ ...good, name: '   ' })).toEqual(
      invalid('name', 'String must contain at least 1 character(s)')
    );
    expect(await create({ ...good, name: 'n'.repeat(201) })).toEqual(
      invalid('name', 'String must contain at most 200 character(s)')
    );
    expect(await create({ ...good, name: 7 })).toEqual(
      invalid('name', 'Expected string, received number')
    );
    expect(await create({ ...good, description: 'd'.repeat(1001) })).toEqual(
      invalid('description', 'String must contain at most 1000 character(s)')
    );
    expect(await create({ ...good, description: 1 })).toEqual(
      invalid('description', 'Expected string, received number')
    );
    expect(await create({ ...good, scope: 'everyone' })).toEqual(
      invalid('scope', `Invalid enum value. Expected ${SCOPE_ENUM}, received 'everyone'`)
    );
    expect(await create({ ...good, scope: null })).toEqual(
      invalid('scope', `Expected ${SCOPE_ENUM}, received null`)
    );
    expect(await create({ ...good, scope_value: '' })).toEqual(
      invalid('scope_value', 'String must contain at least 1 character(s)')
    );
    expect(await create({ ...good, scope_value: 'v'.repeat(256) })).toEqual(
      invalid('scope_value', 'String must contain at most 255 character(s)')
    );
    expect(await create({ ...good, inactive_days: 0 })).toEqual(
      invalid('inactive_days', 'Number must be greater than or equal to 1')
    );
    expect(await create({ ...good, inactive_days: 3651 })).toEqual(
      invalid('inactive_days', 'Number must be less than or equal to 3650')
    );
    expect(await create({ ...good, inactive_days: 1.5 })).toEqual(
      invalid('inactive_days', 'Expected integer, received float')
    );
    expect(await create({ ...good, inactive_days: '30' })).toEqual(
      invalid('inactive_days', 'Expected number, received string')
    );
    expect(await create({ ...good, due_date: 5 })).toEqual(
      invalid('due_date', 'Expected string, received number')
    );
  });

  it('first issue wins when several fields are wrong (schema key order, not input order)', async () => {
    expect(await create({ inactive_days: 0, scope: 'x', name: 1 })).toEqual(
      invalid('name', 'Expected string, received number')
    );
    expect(await create({ name: 'ok', inactive_days: 0, scope: 'x' })).toEqual(
      invalid('scope', `Invalid enum value. Expected ${SCOPE_ENUM}, received 'x'`)
    );
  });

  it('refine() on due_date: custom message, date/date-time shapes (status per value)', async () => {
    const values = [
      '2026-12-31',
      '2026-02-29',
      '2028-02-29',
      '2026-02-31',
      '2026-12-31T10:00:00Z',
      '2026-12-31T10:00Z',
      '2026-12-31T10:00:00+09:00',
      '2026-12-31T10:00:00+0900',
      '2026-12-31T10:00:00',
      '2026-02-31T10:00:00Z',
      '2026-12-31 10:00:00',
      'tomorrow',
      '',
      '20261231',
    ];
    const outcome: Record<string, string> = {};
    for (const due_date of values) {
      const result = await create({ ...good, due_date });
      outcome[due_date] =
        result.status === 403
          ? 'accepted'
          : `${(result.body as { variables: { field: string; reason: string } }).variables.field}: ${
              (result.body as { variables: { reason: string } }).variables.reason
            }`;
    }
    expect(outcome).toEqual({
      '2026-12-31': 'accepted',
      '2026-02-29': 'due_date: Must be a date or a date-time',
      '2028-02-29': 'accepted',
      '2026-02-31': 'due_date: Must be a date or a date-time',
      '2026-12-31T10:00:00Z': 'accepted',
      '2026-12-31T10:00Z': 'accepted',
      '2026-12-31T10:00:00+09:00': 'accepted',
      '2026-12-31T10:00:00+0900': 'accepted',
      '2026-12-31T10:00:00': 'accepted',
      '2026-02-31T10:00:00Z': 'due_date: Must be a date or a date-time',
      '2026-12-31 10:00:00': 'due_date: Must be a date or a date-time',
      tomorrow: 'due_date: Must be a date or a date-time',
      '': 'due_date: Must be a date or a date-time',
      '20261231': 'due_date: Must be a date or a date-time',
    });
  });

  it('superRefine: role / organization scopes need scope_value (path scope_value)', async () => {
    expect(await create({ name: 'n', scope: 'role' })).toEqual(
      invalid('scope_value', 'Required for this scope')
    );
    expect(await create({ name: 'n', scope: 'organization' })).toEqual(
      invalid('scope_value', 'Required for this scope')
    );
    expect(await create({ name: 'n', scope: 'role', scope_value: 'admin' })).toEqual(ACCEPTED);
    // whitespace-only scope_value is trimmed to "" -> min(1) issue; the superRefine is skipped
    // because the trimmed empty string already failed (first issue = min(1))
    expect(await create({ name: 'n', scope: 'role', scope_value: '   ' })).toEqual(
      invalid('scope_value', 'String must contain at least 1 character(s)')
    );
    // the superRefine is evaluated even when an earlier field is only "dirty" (zod 3): first issue is still the field
    expect(await create({ name: '', scope: 'role' })).toEqual(
      invalid('name', 'String must contain at least 1 character(s)')
    );
  });

  it('accepted bodies: unknown keys are stripped, boundaries pass', async () => {
    expect(await create({ ...good, extra: true })).toEqual(ACCEPTED);
    expect(
      await create({
        name: ` ${'n'.repeat(200)} `,
        description: 'd'.repeat(1000),
        scope: 'inactive_users',
        inactive_days: 3650,
        due_date: '2026-12-31',
      })
    ).toEqual(ACCEPTED);
    expect(await create({ name: 'n', scope: 'inactive_users', inactive_days: 1 })).toEqual(
      ACCEPTED
    );
    expect(await create({ name: 'n', scope: 'all_users', scope_value: 'ignored' })).toEqual(
      ACCEPTED
    );
  });
});

describe('zod pins: access review DecisionSchema (POST /access-reviews/:id/decisions)', () => {
  beforeEach(() => vi.clearAllMocks());
  const decide = (body: unknown, bodyError = false) =>
    run(decideAccessReviewItems, body, bodyError);
  const good = { item_ids: ['item-1'], decision: 'approved' };

  it('first issue only; paths include array indexes', async () => {
    expect(await decide(null)).toEqual(invalid('body', 'Expected object, received null'));
    expect(await decide(undefined, true)).toEqual(
      invalid('body', 'Expected object, received null')
    );
    expect(await decide({})).toEqual(invalid('item_ids', 'Required'));
    expect(await decide({ item_ids: ['a'] })).toEqual(invalid('decision', 'Required'));
    expect(await decide({ ...good, item_ids: [] })).toEqual(
      invalid('item_ids', 'Array must contain at least 1 element(s)')
    );
    expect(
      await decide({ ...good, item_ids: Array.from({ length: 101 }, (_, i) => `i${i}`) })
    ).toEqual(invalid('item_ids', 'Array must contain at most 100 element(s)'));
    expect(await decide({ ...good, item_ids: 'item-1' })).toEqual(
      invalid('item_ids', 'Expected array, received string')
    );
    expect(await decide({ ...good, item_ids: ['ok', ''] })).toEqual(
      invalid('item_ids.1', 'String must contain at least 1 character(s)')
    );
    expect(await decide({ ...good, item_ids: ['ok', 5] })).toEqual(
      invalid('item_ids.1', 'Expected string, received number')
    );
    expect(await decide({ ...good, item_ids: ['x'.repeat(65)] })).toEqual(
      invalid('item_ids.0', 'String must contain at most 64 character(s)')
    );
    expect(await decide({ ...good, decision: 'maybe' })).toEqual(
      invalid('decision', "Invalid enum value. Expected 'approved' | 'revoked', received 'maybe'")
    );
    expect(await decide({ ...good, decision: 1 })).toEqual(
      invalid('decision', "Expected 'approved' | 'revoked', received number")
    );
    expect(await decide({ ...good, justification: 'j'.repeat(1001) })).toEqual(
      invalid('justification', 'String must contain at most 1000 character(s)')
    );
    expect(await decide({ ...good, justification: null })).toEqual(
      invalid('justification', 'Expected string, received null')
    );
    expect(await decide({ item_ids: [5, ''], decision: 'x', justification: 1 })).toEqual(
      invalid('item_ids.0', 'Expected string, received number')
    );
  });

  it('accepted bodies: duplicates are not rejected by the schema; unknown keys stripped; boundaries', async () => {
    expect(await decide({ ...good, extra: true })).toEqual(ACCEPTED);
    expect(await decide({ item_ids: ['a', 'a'], decision: 'revoked', justification: '' })).toEqual(
      ACCEPTED
    );
    expect(
      await decide({
        item_ids: Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(64, 'x')),
        decision: 'revoked',
        justification: 'j'.repeat(1000),
      })
    ).toEqual(ACCEPTED);
  });
});
