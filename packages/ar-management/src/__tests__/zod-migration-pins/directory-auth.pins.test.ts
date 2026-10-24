/**
 * zod 3 -> 4 migration pins for routes/directory-auth.ts
 * (TenantPolicySchema, CampaignSchema / CampaignUpdateSchema = .partial().refine(),
 *  UserStateResetSchema, RetentionPolicySchema with union + defaults, EvidenceExportCreateSchema,
 *  SupportBundleCreateSchema with nested strict objects / literal(true) / default,
 *  MaintenanceCleanupSchema).
 *
 * The REAL `createErrorResponse` is used: every schema failure returns the masked
 * ADMIN_INVALID_REQUEST body, so validation is pinned as pass/fail. Parsed values (defaults,
 * stripped keys) are pinned through the arguments handed to the (mocked) persistence functions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  coreAdapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
  updateTenantPolicy: vi.fn(),
  ensureTenantPolicy: vi.fn(),
  createCampaign: vi.fn(),
  updateCampaign: vi.fn(),
  resetUserState: vi.fn(),
  updateRetention: vi.fn(),
  getRetention: vi.fn(),
  ensureRetention: vi.fn(),
  createEvidenceJob: vi.fn(),
  createSupportBundle: vi.fn(),
  cleanup: vi.fn(),
  materialize: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.coreAdapter })),
    createAuditLogFromContext: vi.fn(async () => undefined),
    updateDirectoryAuthTenantPolicy: mocks.updateTenantPolicy,
    ensureDirectoryAuthTenantPolicy: mocks.ensureTenantPolicy,
    createDirectoryAuthMigrationCampaign: mocks.createCampaign,
    updateDirectoryAuthMigrationCampaign: mocks.updateCampaign,
    resetDirectoryAuthMigrationUserState: mocks.resetUserState,
    updateDirectoryAuthRetentionPolicy: mocks.updateRetention,
    getDirectoryAuthRetentionPolicy: mocks.getRetention,
    ensureDirectoryAuthRetentionPolicy: mocks.ensureRetention,
    createDirectoryAuthEvidenceExportJob: mocks.createEvidenceJob,
    createDirectoryAuthSupportBundleRequest: mocks.createSupportBundle,
    cleanupExpiredDirectoryAuthMaintenance: mocks.cleanup,
    tombstoneObjectCatalogEntryForTenant: vi.fn(async () => undefined),
  };
});
vi.mock('../../object-artifact-materialization', () => ({
  materializeEncryptedObjectArtifact: mocks.materialize,
}));

import {
  createDirectoryAuthEvidenceExportHandler,
  createDirectoryAuthMigrationCampaignHandler,
  createDirectoryAuthSupportBundleHandler,
  resetDirectoryAuthMigrationUserStateHandler,
  runDirectoryAuthMaintenanceCleanupHandler,
  updateDirectoryAuthMigrationCampaignHandler,
  updateDirectoryAuthRetentionPolicyHandler,
  updateDirectoryAuthTenantPolicyHandler,
} from '../../routes/directory-auth';

function context(body: unknown, bodyError = false) {
  return {
    req: {
      path: '/api/admin/tenants/tenant-a/directory-auth',
      header: vi.fn(() => undefined),
      param: vi.fn((name: string) =>
        name === 'tenantId' ? 'tenant-a' : name === 'campaignId' ? 'campaign-1' : 'state-1'
      ),
      query: vi.fn(),
      json: bodyError ? vi.fn().mockRejectedValue(new SyntaxError('bad')) : vi.fn(async () => body),
    },
    env: {
      EXPORT_ARTIFACTS: { put: vi.fn(), get: vi.fn(), delete: vi.fn() },
      OBJECT_ENCRYPTION_ROOT_KEY: 'a'.repeat(64),
      OBJECT_ENCRYPTION_KEY_VERSION: '1',
    },
    get: vi.fn((name: string) =>
      name === 'adminAuth'
        ? {
            userId: 'admin-1',
            roles: ['system_admin'],
            permissions: ['*'],
            tenantScope: ['tenant-a'],
            tenantId: 'tenant-a',
          }
        : undefined
    ),
    json: (payload: unknown, status = 200) => Response.json(payload, { status }),
  } as never;
}

type Outcome = { status: number; body: unknown } | { threw: string };
async function run(
  handler: (c: never) => Promise<Response>,
  body: unknown,
  bodyError = false
): Promise<Outcome> {
  try {
    const response = await handler(context(body, bodyError));
    return { status: response.status, body: await response.json() };
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) };
  }
}

const INVALID_REQUEST = {
  status: 400,
  body: { error: 'invalid_request', error_description: expect.any(String), error_code: 'AR060003' },
};
const STOP = { threw: 'stop after validation' };
/** Evidence export / support bundle: the persistence error is caught and turned into this body. */
const STOP_CAUGHT = {
  status: 500,
  body: {
    error: 'server_error',
    error_description: expect.any(String),
    error_code: 'AR900001',
    error_id: expect.any(String),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  const stop = () => {
    throw new Error('stop after validation');
  };
  mocks.ensureTenantPolicy.mockResolvedValue({ email_code_fallback_mode: 'disabled' });
  mocks.updateTenantPolicy.mockImplementation(stop);
  mocks.createCampaign.mockImplementation(stop);
  mocks.updateCampaign.mockImplementation(stop);
  mocks.resetUserState.mockImplementation(stop);
  mocks.updateRetention.mockImplementation(stop);
  mocks.getRetention.mockResolvedValue({
    authrim_audit_retention_days: 365,
    artifact_delete_grace_hours: 72,
  });
  mocks.ensureRetention.mockResolvedValue({ authrim_audit_retention_days: 365 });
  mocks.createEvidenceJob.mockImplementation(stop);
  mocks.createSupportBundle.mockImplementation(stop);
  mocks.cleanup.mockImplementation(stop);
  mocks.materialize.mockResolvedValue({ primaryObjectKey: 'k', catalogId: 'c' });
  mocks.coreAdapter.query.mockResolvedValue([]);
  mocks.coreAdapter.queryOne.mockResolvedValue(null);
  mocks.coreAdapter.execute.mockResolvedValue({ rowsAffected: 1 });
});

describe('zod pins: TenantPolicySchema (strict + enum)', () => {
  const put = (body: unknown, bodyError = false) =>
    run(updateDirectoryAuthTenantPolicyHandler, body, bodyError);

  it('rejects', async () => {
    expect(await put(null)).toEqual(INVALID_REQUEST);
    expect(await put([])).toEqual(INVALID_REQUEST);
    expect(await put({})).toEqual(INVALID_REQUEST);
    expect(await put(undefined, true)).toEqual(INVALID_REQUEST);
    expect(await put({ email_code_fallback_mode: 'tenant_default' })).toEqual(INVALID_REQUEST);
    expect(await put({ email_code_fallback_mode: 5 })).toEqual(INVALID_REQUEST);
    expect(await put({ email_code_fallback_mode: 'disabled', extra: 1 })).toEqual(INVALID_REQUEST);
  });

  it('accepts every fallback mode and passes it on', async () => {
    for (const mode of [
      'migration_recovery',
      'directory_unavailable_recovery',
      'admin_invitation_only',
      'login_method',
      'disabled',
    ]) {
      mocks.updateTenantPolicy.mockClear();
      expect(await put({ email_code_fallback_mode: mode })).toEqual(STOP);
      expect(mocks.updateTenantPolicy.mock.calls[0]?.[1]).toEqual({
        tenantId: 'tenant-a',
        emailCodeFallbackMode: mode,
        actorId: 'admin-1',
      });
    }
  });
});

describe('zod pins: CampaignSchema (create) and CampaignSchema.partial().refine(non-empty) (update)', () => {
  const create = (body: unknown) => run(createDirectoryAuthMigrationCampaignHandler, body);
  const update = (body: unknown) => run(updateDirectoryAuthMigrationCampaignHandler, body);

  it('create rejects', async () => {
    const bad: Array<[string, unknown]> = [
      ['null', null],
      ['array', []],
      ['empty', {}],
      ['name empty', { name: '' }],
      ['name 161 chars', { name: 'n'.repeat(161) }],
      ['name number', { name: 5 }],
      ['description 1001 chars', { name: 'n', description: 'd'.repeat(1001) }],
      ['status unknown', { name: 'n', status: 'live' }],
      ['mode unknown', { name: 'n', mode: 'force' }],
      ['passkey_prompt_mode unknown', { name: 'n', passkey_prompt_mode: 'always' }],
      ['fallback mode unknown', { name: 'n', email_code_fallback_mode: 'sometimes' }],
      ['grace_period_days -1', { name: 'n', grace_period_days: -1 }],
      ['grace_period_days 366', { name: 'n', grace_period_days: 366 }],
      ['grace_period_days float', { name: 'n', grace_period_days: 1.5 }],
      ['transaction_ttl_seconds 299', { name: 'n', transaction_ttl_seconds: 299 }],
      ['transaction_ttl_seconds 1801', { name: 'n', transaction_ttl_seconds: 1801 }],
    ];
    for (const [name, body] of bad) {
      expect([name, await create(body)]).toEqual([name, INVALID_REQUEST]);
    }
  });

  it('create accepts: nullable description, any target_policy, unknown keys stripped; fields reach persistence unchanged (no defaults)', async () => {
    expect(
      await create({
        name: 'n'.repeat(160),
        description: null,
        status: 'archived',
        mode: 'require_passkey_after_directory',
        passkey_prompt_mode: 'campaign_only',
        email_code_fallback_mode: 'tenant_default',
        grace_period_days: 365,
        transaction_ttl_seconds: 1800,
        target_policy: { anything: [1, 'x', null] },
        extra: 'dropped',
      })
    ).toEqual(STOP);
    expect(mocks.createCampaign.mock.calls[0]?.[1]).toEqual({
      tenantId: 'tenant-a',
      name: 'n'.repeat(160),
      description: null,
      status: 'archived',
      mode: 'require_passkey_after_directory',
      passkeyPromptMode: 'campaign_only',
      emailCodeFallbackMode: 'tenant_default',
      gracePeriodDays: 365,
      transactionTtlSeconds: 1800,
      targetPolicy: { anything: [1, 'x', null] },
      actorId: 'admin-1',
    });
    mocks.createCampaign.mockClear();
    expect(await create({ name: 'n' })).toEqual(STOP);
    expect(mocks.createCampaign.mock.calls[0]?.[1]).toEqual({
      tenantId: 'tenant-a',
      name: 'n',
      description: undefined,
      status: undefined,
      mode: undefined,
      passkeyPromptMode: undefined,
      emailCodeFallbackMode: undefined,
      gracePeriodDays: undefined,
      transactionTtlSeconds: undefined,
      targetPolicy: undefined,
      actorId: 'admin-1',
    });
    mocks.createCampaign.mockClear();
    // z.unknown().optional(): an explicit null target_policy is carried through
    expect(await create({ name: 'n', target_policy: null })).toEqual(STOP);
    expect(
      (mocks.createCampaign.mock.calls[0]?.[1] as { targetPolicy: unknown }).targetPolicy
    ).toBeNull();
  });

  it('update: partial() makes name optional, but an empty object fails the refine (default message)', async () => {
    expect(await update({})).toEqual(INVALID_REQUEST);
    expect(await update(null)).toEqual(INVALID_REQUEST);
    expect(await update([])).toEqual(INVALID_REQUEST);
    expect(await update({ extra: 1 })).toEqual(INVALID_REQUEST);
    expect(await update({ name: '' })).toEqual(INVALID_REQUEST);
    expect(await update({ grace_period_days: 366 })).toEqual(INVALID_REQUEST);
    expect(await update({ status: 'live' })).toEqual(INVALID_REQUEST);
    // accepted: a single optional field; the other fields stay undefined (no defaults on partial)
    expect(await update({ grace_period_days: 0 })).toEqual(STOP);
    expect(mocks.updateCampaign.mock.calls[0]?.[1]).toEqual({
      tenantId: 'tenant-a',
      campaignId: 'campaign-1',
      name: undefined,
      description: undefined,
      status: undefined,
      mode: undefined,
      passkeyPromptMode: undefined,
      emailCodeFallbackMode: undefined,
      gracePeriodDays: 0,
      transactionTtlSeconds: undefined,
      targetPolicy: undefined,
      actorId: 'admin-1',
    });
  });

  it('update: keys that are present but explicitly undefined-free nulls count toward the refine', async () => {
    // description is nullable, so { description: null } is a non-empty object
    expect(await update({ description: null })).toEqual(STOP);
    // unknown keys are stripped by the object schema BEFORE the refine: only-unknown = empty
    expect(await update({ unknown_only: true })).toEqual(INVALID_REQUEST);
    // target_policy: z.unknown().optional() accepts null and keeps the key
    expect(await update({ target_policy: null })).toEqual(STOP);
  });
});

describe('zod pins: UserStateResetSchema', () => {
  const reset = (body: unknown, bodyError = false) =>
    run(resetDirectoryAuthMigrationUserStateHandler, body, bodyError);

  it('null / malformed JSON bodies become {} ("body ?? {}") and are accepted', async () => {
    expect(await reset(null)).toEqual(STOP);
    expect(await reset(undefined, true)).toEqual(STOP);
    expect(mocks.resetUserState.mock.calls[0]?.[1]).toEqual({
      tenantId: 'tenant-a',
      stateId: 'state-1',
      actorId: 'admin-1',
      reason: undefined,
      nextState: undefined,
    });
  });

  it('rejects', async () => {
    expect(await reset([])).toEqual(INVALID_REQUEST);
    expect(await reset('x')).toEqual(INVALID_REQUEST);
    expect(await reset({ reason: 'r'.repeat(1001) })).toEqual(INVALID_REQUEST);
    expect(await reset({ reason: 5 })).toEqual(INVALID_REQUEST);
    expect(await reset({ next_state: 'gone' })).toEqual(INVALID_REQUEST);
    expect(await reset({ next_state: null })).toEqual(INVALID_REQUEST);
  });

  it('accepts every state value and strips unknown keys', async () => {
    for (const next_state of [
      'not_applicable',
      'eligible',
      'prompted',
      'deferred',
      'passkey_required',
      'enrolled',
      'blocked',
      'recovered',
    ]) {
      mocks.resetUserState.mockClear();
      expect(await reset({ reason: 'r'.repeat(1000), next_state, extra: 1 })).toEqual(STOP);
      expect(mocks.resetUserState.mock.calls[0]?.[1]).toMatchObject({
        reason: 'r'.repeat(1000),
        nextState: next_state,
      });
    }
  });
});

describe('zod pins: RetentionPolicySchema (union of null | int, defaults 14 / 72)', () => {
  const put = (body: unknown) => run(updateDirectoryAuthRetentionPolicyHandler, body);
  const good = { authrim_audit_retention_days: 365 };

  it('rejects', async () => {
    const bad: Array<[string, unknown]> = [
      ['null', null],
      ['empty', {}],
      ['audit days 29', { authrim_audit_retention_days: 29 }],
      ['audit days 2556', { authrim_audit_retention_days: 7 * 365 + 1 }],
      ['audit days float', { authrim_audit_retention_days: 365.5 }],
      ['audit days string', { authrim_audit_retention_days: '365' }],
      ['wordwarden 0', { ...good, wordwarden_local_retention_days: 0 }],
      ['wordwarden 31', { ...good, wordwarden_local_retention_days: 31 }],
      ['wordwarden float', { ...good, wordwarden_local_retention_days: 1.5 }],
      ['wordwarden string', { ...good, wordwarden_local_retention_days: '7' }],
      ['grace 23', { ...good, artifact_delete_grace_hours: 23 }],
      ['grace 169', { ...good, artifact_delete_grace_hours: 169 }],
      ['grace float', { ...good, artifact_delete_grace_hours: 24.5 }],
      ['grace null', { ...good, artifact_delete_grace_hours: null }],
    ];
    for (const [name, body] of bad) {
      expect([name, await put(body)]).toEqual([name, INVALID_REQUEST]);
    }
  });

  it('applies defaults wordwarden_local_retention_days=14 and artifact_delete_grace_hours=72', async () => {
    expect(await put({ ...good, extra: 1 })).toEqual(STOP);
    expect(mocks.updateRetention.mock.calls[0]?.[1]).toEqual({
      tenantId: 'tenant-a',
      authrimAuditRetentionDays: 365,
      wordwardenLocalRetentionDays: 14,
      artifactDeleteGraceHours: 72,
      actorId: 'admin-1',
    });
  });

  it('explicit null is a valid union member and is NOT replaced by the default; boundaries accepted', async () => {
    expect(
      await put({
        authrim_audit_retention_days: 30,
        wordwarden_local_retention_days: null,
        artifact_delete_grace_hours: 24,
      })
    ).toEqual(STOP);
    expect(mocks.updateRetention.mock.calls[0]?.[1]).toMatchObject({
      authrimAuditRetentionDays: 30,
      wordwardenLocalRetentionDays: null,
      artifactDeleteGraceHours: 24,
    });
    mocks.updateRetention.mockClear();
    expect(
      await put({
        authrim_audit_retention_days: 7 * 365,
        wordwarden_local_retention_days: 30,
        artifact_delete_grace_hours: 168,
      })
    ).toEqual(STOP);
    expect(mocks.updateRetention.mock.calls[0]?.[1]).toMatchObject({
      authrimAuditRetentionDays: 2555,
      wordwardenLocalRetentionDays: 30,
      artifactDeleteGraceHours: 168,
    });
  });
});

describe('zod pins: EvidenceExportCreateSchema (union of int | non-empty string)', () => {
  const create = (body: unknown) => run(createDirectoryAuthEvidenceExportHandler, body);
  const now = () => Date.now();

  it('rejects at schema level', async () => {
    const bad: Array<[string, unknown]> = [
      ['null', null],
      ['empty', {}],
      ['start missing', { period_end_at: 5 }],
      ['end missing', { period_start_at: 5 }],
      ['start float', { period_start_at: 1.5, period_end_at: 5 }],
      ['start empty string', { period_start_at: '', period_end_at: 5 }],
      ['start null', { period_start_at: null, period_end_at: 5 }],
      ['start boolean', { period_start_at: true, period_end_at: 5 }],
      ['size negative', { period_start_at: 1, period_end_at: 2, size_estimate_bytes: -1 }],
      ['size float', { period_start_at: 1, period_end_at: 2, size_estimate_bytes: 1.5 }],
      [
        'download flag string',
        { period_start_at: 1, period_end_at: 2, download_after_delete: 'yes' },
      ],
    ];
    for (const [name, body] of bad) {
      expect([name, await create(body)]).toEqual([name, INVALID_REQUEST]);
    }
  });

  it('accepted union members continue to the (non-zod) period checks: numbers and strings both reach the job', async () => {
    const end = now() - 1000;
    const start = end - 60_000;
    // number members
    expect(await create({ period_start_at: start, period_end_at: end })).toEqual(STOP_CAUGHT);
    expect(mocks.createEvidenceJob.mock.calls[0]?.[1]).toMatchObject({
      periodStartAt: start,
      periodEndAt: end,
    });
    mocks.createEvidenceJob.mockClear();
    // string members: a numeric string and an ISO date-time are both accepted by the union
    expect(
      await create({ period_start_at: String(start), period_end_at: new Date(end).toISOString() })
    ).toEqual(STOP_CAUGHT);
    expect(mocks.createEvidenceJob.mock.calls[0]?.[1]).toMatchObject({
      periodStartAt: start,
      periodEndAt: end,
    });
    mocks.createEvidenceJob.mockClear();
    // a non-empty string that is not a date passes the schema and is rejected afterwards (same masked body)
    expect(await create({ period_start_at: 'not-a-date', period_end_at: end })).toEqual(
      INVALID_REQUEST
    );
    expect(mocks.createEvidenceJob).not.toHaveBeenCalled();
  });
});

describe('zod pins: SupportBundleCreateSchema (default, nested strict, literal(true))', () => {
  const create = (body: unknown, bodyError = false) =>
    run(createDirectoryAuthSupportBundleHandler, body, bodyError);
  const consent = { operator_confirmed: true };

  it('rejects', async () => {
    const bad: Array<[string, unknown]> = [
      ['null body becomes {} and then misses consent_summary', null],
      ['empty', {}],
      ['array', []],
      ['consent missing', { redaction_level: 'standard' }],
      ['consent not an object', { consent_summary: true }],
      [
        'operator_confirmed false (literal true)',
        { consent_summary: { operator_confirmed: false } },
      ],
      ['operator_confirmed "true"', { consent_summary: { operator_confirmed: 'true' } }],
      ['operator_confirmed missing', { consent_summary: {} }],
      ['consent unknown key (strict)', { consent_summary: { ...consent, extra: 1 } }],
      [
        'warning flag not boolean',
        { consent_summary: { ...consent, detailed_warning_acknowledged: 'yes' } },
      ],
      ['redaction level unknown', { redaction_level: 'full', consent_summary: consent }],
      ['redaction level null', { redaction_level: null, consent_summary: consent }],
      ['scope unknown key (strict)', { consent_summary: consent, scope: { extra: 1 } }],
      [
        'scope connector_ids not array',
        { consent_summary: consent, scope: { connector_ids: 'a' } },
      ],
      ['scope connector id empty', { consent_summary: consent, scope: { connector_ids: [''] } }],
      [
        'scope connector id 129 chars',
        { consent_summary: consent, scope: { connector_ids: ['a'.repeat(129)] } },
      ],
      [
        'scope connector id bad chars',
        { consent_summary: consent, scope: { connector_ids: ['a b'] } },
      ],
      [
        'scope 21 connector ids',
        {
          consent_summary: consent,
          scope: { connector_ids: Array.from({ length: 21 }, (_, i) => `c${i}`) },
        },
      ],
      ['scope flag not boolean', { consent_summary: consent, scope: { include_advisories: 1 } }],
      [
        'detailed without acknowledgement (non-zod check)',
        { redaction_level: 'detailed', consent_summary: consent },
      ],
    ];
    for (const [name, body] of bad) {
      expect([name, await create(body)]).toEqual([name, INVALID_REQUEST]);
    }
    expect(await create(undefined, true)).toEqual(INVALID_REQUEST);
  });

  it('defaults redaction_level="standard"; scope stays undefined; unknown top-level keys are stripped', async () => {
    expect(await create({ consent_summary: consent, extra: 1 })).toEqual(STOP_CAUGHT);
    const args = mocks.createSupportBundle.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args).toMatchObject({
      tenantId: 'tenant-a',
      requestedBy: 'admin-1',
      redactionLevel: 'standard',
      scope: undefined,
      consentSummary: { operator_confirmed: true },
    });
  });

  it('explicit scope / detailed acknowledgement are carried through; connector id charset and boundaries', async () => {
    expect(
      await create({
        redaction_level: 'detailed',
        scope: {
          connector_ids: [
            'A.b_c:d-1',
            'x'.repeat(128),
            ...Array.from({ length: 18 }, (_, i) => `c${i}`),
          ],
          include_recent_episodes: false,
          include_advisories: true,
        },
        consent_summary: { operator_confirmed: true, detailed_warning_acknowledged: true },
      })
    ).toEqual(STOP_CAUGHT);
    const args = mocks.createSupportBundle.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.redactionLevel).toBe('detailed');
    expect(args.consentSummary).toEqual({
      operator_confirmed: true,
      detailed_warning_acknowledged: true,
    });
    expect(args.scope).toMatchObject({ include_recent_episodes: false, include_advisories: true });
    expect((args.scope as { connector_ids: string[] }).connector_ids).toHaveLength(20);
  });
});

describe('zod pins: MaintenanceCleanupSchema (strict)', () => {
  const cleanup = (body: unknown, bodyError = false) =>
    run(runDirectoryAuthMaintenanceCleanupHandler, body, bodyError);

  it('rejects null, arrays, unknown keys, bad reasons', async () => {
    expect(await cleanup(null)).toEqual(INVALID_REQUEST);
    expect(await cleanup(undefined, true)).toEqual(INVALID_REQUEST);
    expect(await cleanup([])).toEqual(INVALID_REQUEST);
    expect(await cleanup({ extra: 1 })).toEqual(INVALID_REQUEST);
    expect(await cleanup({ reason: 'r'.repeat(1001) })).toEqual(INVALID_REQUEST);
    expect(await cleanup({ reason: 5 })).toEqual(INVALID_REQUEST);
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it('accepts {} and a reason up to 1000 characters', async () => {
    expect(await cleanup({})).toEqual(STOP);
    expect(await cleanup({ reason: 'r'.repeat(1000) })).toEqual(STOP);
    expect(mocks.cleanup).toHaveBeenCalledTimes(2);
  });
});
