/**
 * zod 3 -> 4 migration pins for compliance/report-routes.ts (CreateSchema: strict objects,
 * z.enum, trim, datetime({ offset: true }), superRefine with custom issues).
 *
 * `createErrorResponse` is mocked: status comes from the real implementation, the body is
 * `{ error: code, ...options }` so `variables.reason` (joined zod messages) is pinned.
 * A body that passes validation is detected by the handler's next step: the missing report
 * storage bindings produce `503 report_storage_unavailable`.
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
vi.mock('../../object-artifact-materialization', () => ({
  materializeEncryptedObjectArtifact: vi.fn(),
}));
vi.mock('../../admin-compliance', () => ({ readComplianceStatus: vi.fn() }));

import { createComplianceReport } from '../../compliance/report-routes';

function context(body: unknown, bodyError = false) {
  return {
    get: vi.fn((key: string) => (key === 'adminAuth' ? { userId: 'admin-1' } : undefined)),
    req: {
      path: '/api/admin/compliance/reports',
      header: vi.fn(() => undefined),
      param: vi.fn(),
      query: vi.fn(),
      json: bodyError
        ? vi.fn().mockRejectedValue(new SyntaxError('bad'))
        : vi.fn().mockResolvedValue(body),
    },
    env: {},
    json: vi.fn((value: unknown, status = 200) => Response.json(value, { status })),
  } as never;
}

async function create(body: unknown, bodyError = false) {
  const response = await createComplianceReport(context(body, bodyError));
  return { status: response.status, body: await response.json() };
}

const invalid = (reason: string) => ({
  status: 400,
  body: { error: 'AR130003', variables: { field: 'body', reason } },
});
/** Schema accepted the body; stopped by the unconfigured report storage. */
const ACCEPTED = {
  status: 503,
  body: {
    error: 'report_storage_unavailable',
    error_description:
      'Report storage (admin database, artifact bucket, encryption key) is not configured',
  },
};
const TYPE_ENUM = "'access_review' | 'mfa_coverage' | 'compliance_status' | 'audit_log'";
const AUDIT_PARAM_MSG = 'from and to (after from) are required for an audit log report';

describe('zod pins: compliance report CreateSchema', () => {
  beforeEach(() => vi.clearAllMocks());

  it('root / type issues', async () => {
    expect(await create(null)).toEqual(invalid('Expected object, received null'));
    expect(await create([])).toEqual(invalid('Expected object, received array'));
    expect(await create({})).toEqual(invalid('Required'));
    expect(await create(undefined, true)).toEqual(invalid('Expected object, received null'));
    expect(await create({ type: 'nope' })).toEqual(
      invalid(`Invalid enum value. Expected ${TYPE_ENUM}, received 'nope'`)
    );
    expect(await create({ type: 5 })).toEqual(invalid(`Expected ${TYPE_ENUM}, received number`));
  });

  it('strict(): unknown keys at both levels', async () => {
    expect(await create({ type: 'mfa_coverage', extra: 1 })).toEqual(
      invalid("Unrecognized key(s) in object: 'extra'")
    );
    expect(await create({ type: 'mfa_coverage', extra: 1, other: 2 })).toEqual(
      invalid("Unrecognized key(s) in object: 'extra', 'other'")
    );
    expect(await create({ type: 'mfa_coverage', parameters: { foo: 1 } })).toEqual(
      invalid("Unrecognized key(s) in object: 'foo'")
    );
  });

  it('name: trim then min(1)/max(200)', async () => {
    expect(await create({ type: 'mfa_coverage', name: '' })).toEqual(
      invalid('String must contain at least 1 character(s)')
    );
    expect(await create({ type: 'mfa_coverage', name: '   ' })).toEqual(
      invalid('String must contain at least 1 character(s)')
    );
    expect(await create({ type: 'mfa_coverage', name: 'n'.repeat(201) })).toEqual(
      invalid('String must contain at most 200 character(s)')
    );
    expect(await create({ type: 'mfa_coverage', name: 5 })).toEqual(
      invalid('Expected string, received number')
    );
    expect(await create({ type: 'mfa_coverage', name: ` ${'n'.repeat(200)} ` })).toEqual(ACCEPTED);
    expect(await create({ type: 'mfa_coverage', name: 'a' })).toEqual(ACCEPTED);
  });

  it('parameters field issues', async () => {
    expect(await create({ type: 'mfa_coverage', parameters: null })).toEqual(
      invalid('Expected object, received null')
    );
    expect(await create({ type: 'mfa_coverage', parameters: [] })).toEqual(
      invalid('Expected object, received array')
    );
    expect(await create({ type: 'mfa_coverage', parameters: { review_id: '' } })).toEqual(
      invalid('String must contain at least 1 character(s)')
    );
    expect(await create({ type: 'mfa_coverage', parameters: { review_id: '   ' } })).toEqual(
      invalid('String must contain at least 1 character(s)')
    );
    expect(
      await create({ type: 'mfa_coverage', parameters: { review_id: 'r'.repeat(129) } })
    ).toEqual(invalid('String must contain at most 128 character(s)'));
    expect(await create({ type: 'mfa_coverage', parameters: { review_id: 5 } })).toEqual(
      invalid('Expected string, received number')
    );
    expect(await create({ type: 'mfa_coverage', parameters: { from: 'yesterday' } })).toEqual(
      invalid('Invalid datetime')
    );
    expect(await create({ type: 'mfa_coverage', parameters: { to: 5 } })).toEqual(
      invalid('Expected string, received number')
    );
  });

  it('superRefine: access_review needs parameters.review_id', async () => {
    expect(await create({ type: 'access_review' })).toEqual(
      invalid('Required for an access review report')
    );
    expect(await create({ type: 'access_review', parameters: {} })).toEqual(
      invalid('Required for an access review report')
    );
    expect(await create({ type: 'access_review', parameters: { review_id: 'rev-1' } })).toEqual(
      ACCEPTED
    );
    expect(await create({ type: 'access_review', parameters: { review_id: '  rev-1  ' } })).toEqual(
      ACCEPTED
    );
  });

  it('superRefine: audit_log needs a from/to window (message, ordering, 366-day cap)', async () => {
    expect(await create({ type: 'audit_log' })).toEqual(invalid(AUDIT_PARAM_MSG));
    expect(
      await create({ type: 'audit_log', parameters: { from: '2026-01-01T00:00:00Z' } })
    ).toEqual(invalid(AUDIT_PARAM_MSG));
    expect(
      await create({
        type: 'audit_log',
        parameters: { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
      })
    ).toEqual(invalid(AUDIT_PARAM_MSG));
    expect(
      await create({
        type: 'audit_log',
        parameters: { from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
      })
    ).toEqual(invalid(AUDIT_PARAM_MSG));
    expect(
      await create({
        type: 'audit_log',
        parameters: { from: '2025-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' },
      })
    ).toEqual(invalid('An audit log report covers at most 366 days'));
    expect(
      await create({
        type: 'audit_log',
        parameters: { from: '2025-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' },
      })
    ).toEqual(ACCEPTED);
    expect(
      await create({
        type: 'audit_log',
        parameters: { from: '2025-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' },
      })
    ).toEqual(invalid('An audit log report covers at most 366 days'));
  });

  it('zod 3: superRefine still runs when an earlier field is merely "dirty" (min/max), not when it is wrongly typed', async () => {
    // name too short (dirty) + the audit_log custom issue: both reported, field issue first
    expect(await create({ type: 'audit_log', name: '' })).toEqual(
      invalid(`String must contain at least 1 character(s), ${AUDIT_PARAM_MSG}`)
    );
    expect(
      await create({ type: 'access_review', name: '', parameters: { review_id: '' } })
    ).toEqual(
      invalid(
        'String must contain at least 1 character(s), String must contain at least 1 character(s), Required for an access review report'
      )
    );
    // wrongly typed name (aborted object): the superRefine is skipped
    expect(await create({ type: 'audit_log', name: 5 })).toEqual(
      invalid('Expected string, received number')
    );
    // invalid datetime is dirty: refinement still runs and adds its own issue
    expect(await create({ type: 'audit_log', parameters: { from: 'bad', to: 'bad' } })).toEqual(
      invalid(`Invalid datetime, Invalid datetime, ${AUDIT_PARAM_MSG}`)
    );
  });

  it('datetime({ offset: true }) edge cases (status per from value, audit_log with a fixed `to`)', async () => {
    const values = [
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00Z',
      '2026-01-01T09:00:00+09:00',
      '2026-01-01T09:00:00+0900',
      '2026-01-01T09:00:00+09',
      '2026-01-01T09:00:00-00:00',
      '2026-01-01T00:00:00.123456789Z',
      '2026-01-01T00:00:00',
      '2026-01-01',
      '2026-01-01T09:00:00 +09:00',
      '2026-13-01T00:00:00Z',
    ];
    const statuses: Record<string, number> = {};
    for (const from of values) {
      const result = await create({
        type: 'audit_log',
        parameters: { from, to: '2026-03-01T00:00:00Z' },
      });
      statuses[from] = result.status;
    }
    expect(statuses).toEqual({
      '2026-01-01T00:00:00Z': 503,
      '2026-01-01T00:00Z': 503,
      '2026-01-01T09:00:00+09:00': 503,
      '2026-01-01T09:00:00+0900': 503,
      '2026-01-01T09:00:00+09': 400,
      '2026-01-01T09:00:00-00:00': 503,
      '2026-01-01T00:00:00.123456789Z': 503,
      '2026-01-01T00:00:00': 400,
      '2026-01-01': 400,
      '2026-01-01T09:00:00 +09:00': 400,
      '2026-13-01T00:00:00Z': 400,
    });
  });

  it('types without extra requirements pass with or without optional parameters', async () => {
    expect(await create({ type: 'mfa_coverage' })).toEqual(ACCEPTED);
    expect(await create({ type: 'compliance_status', name: 'Status', parameters: {} })).toEqual(
      ACCEPTED
    );
    expect(
      await create({
        type: 'compliance_status',
        parameters: { review_id: 'x', from: '2026-01-01T00:00:00Z' },
      })
    ).toEqual(ACCEPTED);
  });
});
