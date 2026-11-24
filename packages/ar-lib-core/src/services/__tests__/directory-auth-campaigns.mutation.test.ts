import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, ExecuteResult } from '../../db';
import { emitLogIcebergRow } from '../log-iceberg-emitter';
import {
  createDirectoryAuthMigrationCampaign,
  resetDirectoryAuthMigrationUserState,
  updateDirectoryAuthMigrationCampaign,
  type DirectoryAuthMigrationCampaignRow,
} from '../directory-auth';

vi.mock('../log-iceberg-emitter', () => ({ emitLogIcebergRow: vi.fn(async () => ({})) }));

interface Handlers {
  query?: (sql: string, params: unknown[]) => unknown[];
  queryOne?: (sql: string, params: unknown[]) => unknown;
  execute?: (sql: string, params: unknown[]) => ExecuteResult | Promise<ExecuteResult>;
}

function makeAdapter(handlers: Handlers = {}) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) =>
    handlers.query ? handlers.query(sql, params) : []
  );
  const queryOne = vi.fn(async (sql: string, params: unknown[] = []) =>
    handlers.queryOne ? handlers.queryOne(sql, params) : null
  );
  const execute = vi.fn(async (sql: string, params: unknown[] = []) =>
    handlers.execute ? handlers.execute(sql, params) : { rowsAffected: 1, success: true }
  );
  const adapter = { query, queryOne, execute } as unknown as DatabaseAdapter;
  return { adapter, query, queryOne, execute };
}

function executeCalls(h: ReturnType<typeof makeAdapter>, needle: string) {
  return h.execute.mock.calls.filter(([sql]) => sql.includes(needle));
}

function campaignRow(
  overrides: Partial<DirectoryAuthMigrationCampaignRow> = {}
): DirectoryAuthMigrationCampaignRow {
  return {
    id: 'damc_1',
    tenant_id: 'tenant-a',
    name: 'Existing name',
    description: 'Existing description',
    status: 'active',
    mode: 'prompt_passkey',
    passkey_prompt_mode: 'optional',
    email_code_fallback_mode: 'login_method',
    grace_period_days: 14,
    transaction_ttl_seconds: 900,
    enforcement_start_mode: 'first_directory_login',
    target_policy_json: '{"type":"all"}',
    is_template: 0,
    created_by: 'admin-0',
    created_at: 10,
    updated_at: 20,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(emitLogIcebergRow).mockClear();
});

describe('createDirectoryAuthMigrationCampaign', () => {
  it('applies defaults and records history', async () => {
    const h = makeAdapter();
    const row = await createDirectoryAuthMigrationCampaign(h.adapter, {
      tenantId: 'tenant-a',
      name: '  Spring  ',
      now: 1000,
    });
    expect(row).toMatchObject({
      tenant_id: 'tenant-a',
      name: 'Spring',
      description: null,
      status: 'disabled',
      mode: 'directory_login_allowed',
      passkey_prompt_mode: 'campaign_only',
      email_code_fallback_mode: 'tenant_default',
      grace_period_days: 30,
      transaction_ttl_seconds: 600,
      enforcement_start_mode: 'first_directory_login',
      target_policy_json: '{}',
      is_template: 0,
      created_by: null,
      created_at: 1000,
      updated_at: 1000,
    });
    const [sql, params] = h.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO directory_auth_migration_campaigns');
    expect(params).toStrictEqual([
      row.id,
      'tenant-a',
      'Spring',
      null,
      'disabled',
      'directory_login_allowed',
      'campaign_only',
      'tenant_default',
      30,
      600,
      'first_directory_login',
      '{}',
      0,
      null,
      1000,
      1000,
    ]);
    const history = executeCalls(h, 'directory_auth_config_history')[0][1];
    expect(history.slice(1)).toStrictEqual([
      'tenant-a',
      null,
      'migration',
      'migration_campaign.created',
      'directory_auth_migration_campaign',
      row.id,
      '{}',
      JSON.stringify({
        id: row.id,
        status: 'disabled',
        mode: 'directory_login_allowed',
        passkey_prompt_mode: 'campaign_only',
        email_code_fallback_mode: 'tenant_default',
        grace_period_days: 30,
        transaction_ttl_seconds: 600,
        is_template: false,
      }),
      1000,
    ]);
  });

  it('honours explicit values', async () => {
    const h = makeAdapter();
    const row = await createDirectoryAuthMigrationCampaign(h.adapter, {
      tenantId: 'tenant-a',
      name: 'N',
      description: '  desc  ',
      status: 'active',
      mode: 'prompt_passkey',
      passkeyPromptMode: 'none',
      emailCodeFallbackMode: 'disabled',
      gracePeriodDays: 0,
      transactionTtlSeconds: 1000,
      targetPolicy: { user_ids: ['u'] },
      isTemplate: true,
      actorId: 'admin-1',
      now: 5,
    });
    expect(row).toMatchObject({
      description: 'desc',
      status: 'active',
      mode: 'prompt_passkey',
      passkey_prompt_mode: 'none',
      email_code_fallback_mode: 'disabled',
      grace_period_days: 0,
      transaction_ttl_seconds: 1000,
      target_policy_json: '{"user_ids":["u"]}',
      is_template: 1,
      created_by: 'admin-1',
    });
    const history = executeCalls(h, 'directory_auth_config_history')[0][1];
    expect(history[2]).toBe('admin-1');
    expect((JSON.parse(history[8] as string) as { is_template: boolean }).is_template).toBe(true);
  });

  it.each([
    [0, 300],
    [299, 300],
    [300, 300],
    [300.9, 300],
    [301, 301],
    [1799, 1799],
    [1800, 1800],
    [1801, 1800],
    [100000, 1800],
    [Number.NaN, 600],
    [Number.POSITIVE_INFINITY, 600],
  ])('clamps transaction ttl %s to %s', async (input, expected) => {
    const h = makeAdapter();
    const row = await createDirectoryAuthMigrationCampaign(h.adapter, {
      tenantId: 'tenant-a',
      name: 'N',
      transactionTtlSeconds: input,
      now: 1,
    });
    expect(row.transaction_ttl_seconds).toBe(expected);
  });

  it('treats blank descriptions as null and defaults now to Date.now()', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(4242);
      const h = makeAdapter();
      const row = await createDirectoryAuthMigrationCampaign(h.adapter, {
        tenantId: 'tenant-a',
        name: 'N',
        description: '   ',
      });
      expect(row.description).toBeNull();
      expect(row.created_at).toBe(4242);
      expect(row.updated_at).toBe(4242);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('updateDirectoryAuthMigrationCampaign', () => {
  it('returns null and writes nothing for an unknown campaign', async () => {
    const h = makeAdapter();
    expect(
      await updateDirectoryAuthMigrationCampaign(h.adapter, {
        tenantId: 'tenant-a',
        campaignId: 'nope',
        name: 'x',
      })
    ).toBeNull();
    expect(h.queryOne.mock.calls[0][0]).toContain('WHERE tenant_id = ? AND id = ?');
    expect(h.queryOne.mock.calls[0][1]).toStrictEqual(['tenant-a', 'nope']);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('keeps existing values when nothing is provided', async () => {
    const existing = campaignRow();
    const h = makeAdapter({ queryOne: () => existing });
    const next = await updateDirectoryAuthMigrationCampaign(h.adapter, {
      tenantId: 'tenant-a',
      campaignId: 'damc_1',
      now: 99,
    });
    expect(next).toStrictEqual({ ...existing, updated_at: 99 });
    expect(h.execute.mock.calls[0][0]).toContain('UPDATE directory_auth_migration_campaigns');
    expect(h.execute.mock.calls[0][1]).toStrictEqual([
      'Existing name',
      'Existing description',
      'active',
      'prompt_passkey',
      'optional',
      'login_method',
      14,
      900,
      '{"type":"all"}',
      99,
      'tenant-a',
      'damc_1',
    ]);
  });

  it('applies every provided field and records before/after history', async () => {
    const existing = campaignRow();
    const h = makeAdapter({ queryOne: () => existing });
    const next = await updateDirectoryAuthMigrationCampaign(h.adapter, {
      tenantId: 'tenant-a',
      campaignId: 'damc_1',
      name: '  Renamed ',
      description: ' New desc ',
      status: 'paused',
      mode: 'require_passkey_after_directory',
      passkeyPromptMode: 'none',
      emailCodeFallbackMode: 'tenant_default',
      gracePeriodDays: 0,
      transactionTtlSeconds: 1200,
      targetPolicy: { type: 'template' },
      actorId: 'admin-9',
      now: 99,
    });
    expect(next).toStrictEqual({
      ...existing,
      name: 'Renamed',
      description: 'New desc',
      status: 'paused',
      mode: 'require_passkey_after_directory',
      passkey_prompt_mode: 'none',
      email_code_fallback_mode: 'tenant_default',
      grace_period_days: 0,
      transaction_ttl_seconds: 1200,
      target_policy_json: '{"type":"template"}',
      updated_at: 99,
    });
    expect(h.execute.mock.calls[0][1]).toStrictEqual([
      'Renamed',
      'New desc',
      'paused',
      'require_passkey_after_directory',
      'none',
      'tenant_default',
      0,
      1200,
      '{"type":"template"}',
      99,
      'tenant-a',
      'damc_1',
    ]);
    const history = executeCalls(h, 'directory_auth_config_history')[0][1];
    expect(history.slice(1)).toStrictEqual([
      'tenant-a',
      'admin-9',
      'migration',
      'migration_campaign.updated',
      'directory_auth_migration_campaign',
      'damc_1',
      JSON.stringify({
        id: 'damc_1',
        status: 'active',
        mode: 'prompt_passkey',
        passkey_prompt_mode: 'optional',
        email_code_fallback_mode: 'login_method',
        grace_period_days: 14,
        transaction_ttl_seconds: 900,
        is_template: false,
      }),
      JSON.stringify({
        id: 'damc_1',
        status: 'paused',
        mode: 'require_passkey_after_directory',
        passkey_prompt_mode: 'none',
        email_code_fallback_mode: 'tenant_default',
        grace_period_days: 0,
        transaction_ttl_seconds: 1200,
        is_template: false,
      }),
      99,
    ]);
  });

  it('distinguishes description undefined, null and blank', async () => {
    const existing = campaignRow();
    const run = async (description?: string | null) => {
      const h = makeAdapter({ queryOne: () => existing });
      const next = await updateDirectoryAuthMigrationCampaign(h.adapter, {
        tenantId: 'tenant-a',
        campaignId: 'damc_1',
        description,
        now: 1,
      });
      return next?.description;
    };
    expect(await run(undefined)).toBe('Existing description');
    expect(await run(null)).toBeNull();
    expect(await run('   ')).toBeNull();
  });

  it('keeps the existing name for blank names and clamps ttl on update', async () => {
    const existing = campaignRow({ is_template: 1 });
    const h = makeAdapter({ queryOne: () => existing });
    const next = await updateDirectoryAuthMigrationCampaign(h.adapter, {
      tenantId: 'tenant-a',
      campaignId: 'damc_1',
      name: '   ',
      transactionTtlSeconds: 10,
      now: 1,
    });
    expect(next?.name).toBe('Existing name');
    expect(next?.transaction_ttl_seconds).toBe(300);
    const capped = await updateDirectoryAuthMigrationCampaign(
      makeAdapter({ queryOne: () => existing }).adapter,
      { tenantId: 'tenant-a', campaignId: 'damc_1', transactionTtlSeconds: 99999, now: 1 }
    );
    expect(capped?.transaction_ttl_seconds).toBe(1800);
    const history = executeCalls(h, 'directory_auth_config_history')[0][1];
    expect((JSON.parse(history[7] as string) as { is_template: boolean }).is_template).toBe(true);
    expect(history[2]).toBeNull();
  });

  it('defaults now to Date.now()', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(8080);
      const h = makeAdapter({ queryOne: () => campaignRow() });
      const next = await updateDirectoryAuthMigrationCampaign(h.adapter, {
        tenantId: 'tenant-a',
        campaignId: 'damc_1',
      });
      expect(next?.updated_at).toBe(8080);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resetDirectoryAuthMigrationUserState', () => {
  const existingState = {
    id: 'damus_1',
    state: 'blocked',
    blocked_reason: 'bad',
    recovery_reason: 'rec',
    deferred_until: 5,
    reset_count: 2,
  };

  it('returns null without writing when the state does not exist', async () => {
    const h = makeAdapter();
    expect(
      await resetDirectoryAuthMigrationUserState(h.adapter, {
        tenantId: 'tenant-a',
        stateId: 'x',
        actorId: 'a',
      })
    ).toBeNull();
    expect(h.queryOne.mock.calls[0][1]).toStrictEqual(['tenant-a', 'x']);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('resets to eligible by default and clears block/recovery/defer', async () => {
    const h = makeAdapter({ queryOne: () => existingState });
    const next = await resetDirectoryAuthMigrationUserState(h.adapter, {
      tenantId: 'tenant-a',
      stateId: 'damus_1',
      actorId: 'admin-1',
      reason: '  support ticket ',
      now: 300,
    });
    expect(next).toStrictEqual({
      ...existingState,
      state: 'eligible',
      blocked_reason: null,
      recovery_reason: null,
      deferred_until: null,
      reset_count: 3,
      last_reset_at: 300,
      last_reset_by: 'admin-1',
      last_reset_reason: 'support ticket',
      updated_at: 300,
    });
    const [sql, params] = h.execute.mock.calls[0];
    expect(sql).toContain('reset_count = reset_count + 1');
    expect(params).toStrictEqual([
      'eligible',
      300,
      'admin-1',
      'support ticket',
      300,
      'tenant-a',
      'damus_1',
    ]);
    const history = executeCalls(h, 'directory_auth_config_history')[0][1];
    expect(history.slice(1)).toStrictEqual([
      'tenant-a',
      'admin-1',
      'migration',
      'migration_state.reset',
      'directory_auth_migration_user_state',
      'damus_1',
      JSON.stringify({ state: 'blocked', blocked_reason: 'bad', recovery_reason: 'rec' }),
      JSON.stringify({ state: 'eligible', reason: 'support ticket' }),
      300,
    ]);
  });

  it('supports an explicit next state and a missing/blank reason', async () => {
    const h = makeAdapter({ queryOne: () => existingState });
    const next = await resetDirectoryAuthMigrationUserState(h.adapter, {
      tenantId: 'tenant-a',
      stateId: 'damus_1',
      actorId: 'admin-1',
      nextState: 'deferred',
      reason: '   ',
      now: 1,
    });
    expect(next?.state).toBe('deferred');
    expect(next?.last_reset_reason).toBeNull();
    expect(h.execute.mock.calls[0][1].slice(0, 4)).toStrictEqual(['deferred', 1, 'admin-1', null]);

    const h2 = makeAdapter({ queryOne: () => existingState });
    const next2 = await resetDirectoryAuthMigrationUserState(h2.adapter, {
      tenantId: 'tenant-a',
      stateId: 'damus_1',
      actorId: 'admin-1',
      now: 1,
    });
    expect(next2?.last_reset_reason).toBeNull();
  });
});
