import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, ExecuteResult } from '../../db';
import {
  resolveDirectoryAuthEffectiveEmailCodeFallbackMode,
  resolveDirectoryAuthEmailFallbackRecoveryCampaign,
  resolveDirectoryAuthMigrationDecision,
  type DirectoryAuthMigrationCampaignRow,
  type DirectoryAuthMigrationUserStateRow,
} from '../directory-auth';

vi.mock('../log-iceberg-emitter', () => ({ emitLogIcebergRow: vi.fn(async () => ({})) }));

const DAY = 24 * 60 * 60 * 1000;

interface Handlers {
  query?: (sql: string, params: unknown[]) => unknown[];
  queryOne?: (sql: string, params: unknown[]) => unknown;
  execute?: (sql: string, params: unknown[]) => ExecuteResult;
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

function campaign(
  overrides: Partial<DirectoryAuthMigrationCampaignRow> = {}
): DirectoryAuthMigrationCampaignRow {
  return {
    id: 'damc_1',
    tenant_id: 'tenant-a',
    name: 'c',
    description: null,
    status: 'active',
    mode: 'prompt_passkey',
    passkey_prompt_mode: 'campaign_only',
    email_code_fallback_mode: 'tenant_default',
    grace_period_days: 30,
    transaction_ttl_seconds: 600,
    enforcement_start_mode: 'first_directory_login',
    target_policy_json: JSON.stringify({ type: 'all' }),
    is_template: 0,
    created_by: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function userState(
  overrides: Partial<DirectoryAuthMigrationUserStateRow> = {}
): DirectoryAuthMigrationUserStateRow {
  return {
    id: 'damus_1',
    tenant_id: 'tenant-a',
    campaign_id: 'damc_1',
    user_id: 'user-1',
    connector_id: 'conn-1',
    directory_subject: 'sub-1',
    cohort_key: null,
    state: 'eligible',
    first_directory_login_at: 1000,
    prompted_at: null,
    deferred_until: null,
    passkey_required_at: null,
    enrolled_at: null,
    blocked_reason: null,
    recovery_reason: null,
    reset_count: 0,
    last_reset_at: null,
    last_reset_by: null,
    last_reset_reason: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

const baseInput = {
  tenantId: 'tenant-a',
  userId: 'user-1',
  connectorId: 'conn-1',
  directorySubject: 'sub-1',
  now: 5000,
};

function resolveWith(
  campaigns: DirectoryAuthMigrationCampaignRow[],
  existing: DirectoryAuthMigrationUserStateRow | null,
  input: Partial<Parameters<typeof resolveDirectoryAuthMigrationDecision>[1]> = {}
) {
  const h = makeAdapter({ query: () => campaigns, queryOne: () => existing });
  return {
    ...h,
    run: () => resolveDirectoryAuthMigrationDecision(h.adapter, { ...baseInput, ...input }),
  };
}

describe('resolveDirectoryAuthMigrationDecision: actions', () => {
  it('returns blocked with the stored reason and does not write', async () => {
    const c = campaign({ mode: 'require_passkey_after_directory' });
    const state = userState({ state: 'blocked', blocked_reason: 'admin_block' });
    const h = resolveWith([c], state);
    const decision = await h.run();
    expect(decision).toStrictEqual({
      action: 'blocked',
      campaign: c,
      userState: state,
      reason: 'admin_block',
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('looks up the existing state by tenant, campaign, user, connector and subject', async () => {
    const h = resolveWith([campaign()], userState({ state: 'blocked' }));
    await h.run();
    expect(h.queryOne.mock.calls[0][1]).toStrictEqual([
      'tenant-a',
      'damc_1',
      'user-1',
      'conn-1',
      'sub-1',
    ]);
  });

  it('creates an eligible user state for a first login and requires passkey immediately', async () => {
    const c = campaign({ mode: 'require_passkey_after_directory' });
    const h = resolveWith([c], null);
    const decision = await h.run();
    if (decision.action !== 'require_passkey') throw new Error('expected require_passkey');
    expect(decision.reason).toBe('immediate');
    expect(decision.passkeyRequiredAt).toBe(5000);
    expect(decision.userState).toMatchObject({
      tenant_id: 'tenant-a',
      campaign_id: 'damc_1',
      user_id: 'user-1',
      connector_id: 'conn-1',
      directory_subject: 'sub-1',
      state: 'passkey_required',
      first_directory_login_at: 5000,
      passkey_required_at: 5000,
      prompted_at: null,
      reset_count: 0,
      created_at: 5000,
      updated_at: 5000,
    });
    expect(decision.userState.id).toMatch(/^damus_/);
    expect(h.execute).toHaveBeenCalledTimes(2);
    const [insertSql, insertParams] = h.execute.mock.calls[0];
    expect(insertSql).toContain('INSERT INTO directory_auth_migration_user_states');
    expect(insertParams).toStrictEqual([
      decision.userState.id,
      'tenant-a',
      'damc_1',
      'user-1',
      'conn-1',
      'sub-1',
      null,
      'eligible',
      5000,
      null,
      null,
      null,
      null,
      null,
      null,
      0,
      null,
      null,
      null,
      5000,
      5000,
    ]);
    const [updateSql, updateParams] = h.execute.mock.calls[1];
    expect(updateSql).toContain('UPDATE directory_auth_migration_user_states');
    expect(updateParams).toStrictEqual([
      'passkey_required',
      null,
      5000,
      5000,
      'tenant-a',
      decision.userState.id,
    ]);
  });

  it('keeps an existing passkey_required_at and skips the write when nothing changes', async () => {
    const c = campaign({ mode: 'require_passkey_after_directory' });
    const state = userState({ state: 'passkey_required', passkey_required_at: 700 });
    const h = resolveWith([c], state);
    const decision = await h.run();
    expect(decision).toMatchObject({
      action: 'require_passkey',
      reason: 'immediate',
      passkeyRequiredAt: 700,
    });
    expect(h.execute).not.toHaveBeenCalled();
    if (decision.action === 'require_passkey') {
      expect(decision.userState.updated_at).toBe(5000);
    }
  });

  it('writes when only the state differs or only passkey_required_at differs', async () => {
    const c = campaign({ mode: 'require_passkey_after_directory' });
    const h1 = resolveWith([c], userState({ state: 'prompted', passkey_required_at: 700 }));
    await h1.run();
    expect(h1.execute).toHaveBeenCalledTimes(1);
    const h2 = resolveWith(
      [c],
      userState({ state: 'passkey_required', passkey_required_at: null })
    );
    await h2.run();
    expect(h2.execute).toHaveBeenCalledTimes(1);
  });

  it('backfills first_directory_login_at on an existing state without one', async () => {
    const c = campaign({ mode: 'prompt_passkey' });
    const state = userState({ first_directory_login_at: null, cohort_key: null });
    const h = resolveWith([c], state, {
      directoryFacts: { groups: ['Staff'] },
    });
    const c2 = campaign({
      mode: 'prompt_passkey',
      target_policy_json: JSON.stringify({ directory_groups: ['Staff'] }),
    });
    const h2 = resolveWith([c2], state, { directoryFacts: { groups: ['Staff'] } });
    const decision = await h2.run();
    void h;
    const [sql, params] = h2.execute.mock.calls[0];
    expect(sql).toContain('first_directory_login_at = ?');
    expect(sql).toContain('COALESCE(cohort_key, ?)');
    expect(params).toStrictEqual([5000, 'directory_group:Staff', 5000, 'tenant-a', 'damus_1']);
    expect(decision.userState).toMatchObject({
      first_directory_login_at: 5000,
      cohort_key: 'directory_group:Staff',
      updated_at: 5000,
    });
  });

  it('keeps the existing cohort key when backfilling and passes null when none', async () => {
    const withKey = userState({ first_directory_login_at: null, cohort_key: 'old' });
    const h = resolveWith(
      [campaign({ target_policy_json: JSON.stringify({ directory_groups: ['Staff'] }) })],
      withKey,
      { directoryFacts: { groups: ['Staff'] } }
    );
    const decision = await h.run();
    expect(decision.userState?.cohort_key).toBe('old');

    const h2 = resolveWith([campaign()], userState({ first_directory_login_at: null }));
    const decision2 = await h2.run();
    expect(h2.execute.mock.calls[0][1]).toStrictEqual([5000, null, 5000, 'tenant-a', 'damus_1']);
    expect(decision2.userState?.cohort_key).toBeNull();
  });

  it('does not rewrite first_directory_login_at when already set', async () => {
    const h = resolveWith(
      [campaign()],
      userState({ first_directory_login_at: 1000, state: 'prompted', prompted_at: 900 })
    );
    const decision = await h.run();
    expect(h.execute).not.toHaveBeenCalled();
    expect(decision.userState).toMatchObject({ first_directory_login_at: 1000, prompted_at: 900 });
  });

  it('prompt_passkey mode marks eligible users as prompted at now', async () => {
    const h = resolveWith([campaign()], userState());
    const decision = await h.run();
    expect(decision.action).toBe('prompt_passkey');
    if (decision.action !== 'prompt_passkey') return;
    expect(decision.passkeyRequiredAt).toBeNull();
    expect(decision.userState).toMatchObject({
      state: 'prompted',
      prompted_at: 5000,
      passkey_required_at: null,
      updated_at: 5000,
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0][1]).toStrictEqual([
      'prompted',
      5000,
      null,
      5000,
      'tenant-a',
      'damus_1',
    ]);
  });

  it('prompt_passkey mode keeps non-eligible states and an earlier prompted_at', async () => {
    const state = userState({ state: 'deferred', prompted_at: 900 });
    const h = resolveWith([campaign()], state);
    const decision = await h.run();
    expect(decision.userState).toMatchObject({ state: 'deferred', prompted_at: 900 });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('grace mode prompts before the grace period elapses', async () => {
    const c = campaign({ mode: 'grace_then_require_passkey', grace_period_days: 2 });
    const h = resolveWith([c], userState({ first_directory_login_at: 1000 }), {
      now: 1000 + 2 * DAY - 1,
    });
    const decision = await h.run();
    expect(decision.action).toBe('prompt_passkey');
    if (decision.action !== 'prompt_passkey') return;
    expect(decision.passkeyRequiredAt).toBe(1000 + 2 * DAY);
    expect(decision.userState).toMatchObject({
      state: 'prompted',
      prompted_at: 1000 + 2 * DAY - 1,
      passkey_required_at: 1000 + 2 * DAY,
    });
    expect(h.execute.mock.calls[0][1]).toStrictEqual([
      'prompted',
      1000 + 2 * DAY - 1,
      1000 + 2 * DAY,
      1000 + 2 * DAY - 1,
      'tenant-a',
      'damus_1',
    ]);
  });

  it('grace mode requires the passkey exactly at the grace boundary', async () => {
    const c = campaign({ mode: 'grace_then_require_passkey', grace_period_days: 2 });
    const h = resolveWith(
      [c],
      userState({ first_directory_login_at: 1000, state: 'prompted', prompted_at: 900 }),
      {
        now: 1000 + 2 * DAY,
      }
    );
    const decision = await h.run();
    expect(decision).toMatchObject({
      action: 'require_passkey',
      reason: 'grace_period_elapsed',
      passkeyRequiredAt: 1000 + 2 * DAY,
    });
    if (decision.action !== 'require_passkey') return;
    expect(decision.userState).toMatchObject({
      state: 'passkey_required',
      passkey_required_at: 1000 + 2 * DAY,
      prompted_at: 900,
    });
    expect(h.execute.mock.calls[0][1]).toStrictEqual([
      'passkey_required',
      900,
      1000 + 2 * DAY,
      1000 + 2 * DAY,
      'tenant-a',
      'damus_1',
    ]);
  });

  it('grace mode requires the passkey after the boundary', async () => {
    const c = campaign({ mode: 'grace_then_require_passkey', grace_period_days: 1 });
    const decision = await resolveWith([c], userState({ first_directory_login_at: 0 }), {
      now: DAY + 1,
    }).run();
    expect(decision).toMatchObject({ action: 'require_passkey', reason: 'grace_period_elapsed' });
  });

  it('grace mode for a first login starts the grace period at now', async () => {
    const c = campaign({ mode: 'grace_then_require_passkey', grace_period_days: 3 });
    const decision = await resolveWith([c], null, { now: 10_000 }).run();
    expect(decision.action).toBe('prompt_passkey');
    if (decision.action !== 'prompt_passkey') return;
    expect(decision.passkeyRequiredAt).toBe(10_000 + 3 * DAY);
    expect(decision.userState.first_directory_login_at).toBe(10_000);
  });

  it('grace mode keeps the existing prompted_at and non-eligible state', async () => {
    const c = campaign({ mode: 'grace_then_require_passkey', grace_period_days: 30 });
    const state = userState({
      state: 'deferred',
      prompted_at: 900,
      passkey_required_at: 1000 + 30 * DAY,
    });
    const h = resolveWith([c], state, { now: 2000 });
    const decision = await h.run();
    expect(decision.userState).toMatchObject({ state: 'deferred', prompted_at: 900 });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('grace mode with zero grace days requires immediately for a returning user', async () => {
    const c = campaign({ mode: 'grace_then_require_passkey', grace_period_days: 0 });
    const decision = await resolveWith([c], userState({ first_directory_login_at: 5000 })).run();
    expect(decision).toMatchObject({ action: 'require_passkey', passkeyRequiredAt: 5000 });
  });

  it('defaults now to Date.now()', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(123_456);
      const h = makeAdapter({ query: () => [campaign()], queryOne: () => null });
      const decision = await resolveDirectoryAuthMigrationDecision(h.adapter, {
        tenantId: 'tenant-a',
        userId: 'user-1',
        connectorId: 'conn-1',
        directorySubject: 'sub-1',
      });
      expect(decision.userState).toMatchObject({
        first_directory_login_at: 123_456,
        prompted_at: 123_456,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('email code fallback helpers', () => {
  function tenantPolicy(mode: string) {
    return {
      tenant_id: 'tenant-a',
      email_code_fallback_mode: mode,
      updated_by: null,
      created_at: 1,
      updated_at: 1,
    };
  }

  it('effective mode returns the explicit campaign mode without reading the tenant policy', async () => {
    const h = makeAdapter();
    const mode = await resolveDirectoryAuthEffectiveEmailCodeFallbackMode(
      h.adapter,
      'tenant-a',
      campaign({ email_code_fallback_mode: 'login_method' }),
      1000
    );
    expect(mode).toBe('login_method');
    expect(h.queryOne).not.toHaveBeenCalled();
  });

  it('effective mode resolves tenant_default from the tenant policy', async () => {
    const h = makeAdapter({ queryOne: () => tenantPolicy('admin_invitation_only') });
    const mode = await resolveDirectoryAuthEffectiveEmailCodeFallbackMode(
      h.adapter,
      'tenant-a',
      campaign({ email_code_fallback_mode: 'tenant_default' }),
      1000
    );
    expect(mode).toBe('admin_invitation_only');
    expect(h.queryOne.mock.calls[0][1]).toStrictEqual(['tenant-a']);
  });

  it('effective mode seeds the default tenant policy when absent', async () => {
    const h = makeAdapter();
    const mode = await resolveDirectoryAuthEffectiveEmailCodeFallbackMode(
      h.adapter,
      'tenant-a',
      campaign({ email_code_fallback_mode: 'tenant_default' }),
      1000
    );
    expect(mode).toBe('migration_recovery');
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0][1]).toStrictEqual([
      'tenant-a',
      'migration_recovery',
      null,
      1000,
      1000,
    ]);
  });

  const recoveryInput = {
    tenantId: 'tenant-a',
    userId: 'user-1',
    connectorId: 'conn-1',
    mode: 'directory_unavailable_recovery' as const,
    now: 1000,
  };

  it('finds the first active campaign whose effective mode and target match', async () => {
    const explicit = campaign({
      id: 'explicit',
      email_code_fallback_mode: 'directory_unavailable_recovery',
    });
    const h = makeAdapter({
      query: () => [explicit],
      queryOne: () => tenantPolicy('migration_recovery'),
    });
    const found = await resolveDirectoryAuthEmailFallbackRecoveryCampaign(h.adapter, recoveryInput);
    expect(found?.id).toBe('explicit');
    const [sql, params] = h.query.mock.calls[0];
    expect(sql).toContain("email_code_fallback_mode IN (?, 'tenant_default')");
    expect(params).toStrictEqual(['tenant-a', 'directory_unavailable_recovery']);
  });

  it('uses the tenant policy for tenant_default campaigns', async () => {
    const c = campaign({ id: 'td', email_code_fallback_mode: 'tenant_default' });
    const match = makeAdapter({
      query: () => [c],
      queryOne: () => tenantPolicy('directory_unavailable_recovery'),
    });
    expect(
      (await resolveDirectoryAuthEmailFallbackRecoveryCampaign(match.adapter, recoveryInput))?.id
    ).toBe('td');
    const noMatch = makeAdapter({ query: () => [c], queryOne: () => tenantPolicy('disabled') });
    expect(
      await resolveDirectoryAuthEmailFallbackRecoveryCampaign(noMatch.adapter, recoveryInput)
    ).toBeNull();
  });

  it('skips campaigns with another effective mode or a non-matching target', async () => {
    const wrongMode = campaign({ id: 'wrong', email_code_fallback_mode: 'login_method' });
    const wrongTarget = campaign({
      id: 'target',
      email_code_fallback_mode: 'directory_unavailable_recovery',
      target_policy_json: JSON.stringify({ user_ids: ['someone-else'] }),
    });
    const good = campaign({
      id: 'good',
      email_code_fallback_mode: 'directory_unavailable_recovery',
      target_policy_json: JSON.stringify({ user_ids: ['user-1'] }),
    });
    const h = makeAdapter({
      query: () => [wrongMode, wrongTarget, good],
      queryOne: () => tenantPolicy('migration_recovery'),
    });
    expect(
      (await resolveDirectoryAuthEmailFallbackRecoveryCampaign(h.adapter, recoveryInput))?.id
    ).toBe('good');

    const h2 = makeAdapter({
      query: () => [wrongMode, wrongTarget],
      queryOne: () => tenantPolicy('migration_recovery'),
    });
    expect(
      await resolveDirectoryAuthEmailFallbackRecoveryCampaign(h2.adapter, recoveryInput)
    ).toBeNull();
  });

  it('does not match directory_subjects policies because the subject is unknown', async () => {
    const c = campaign({
      email_code_fallback_mode: 'directory_unavailable_recovery',
      target_policy_json: JSON.stringify({ directory_subjects: ['sub-1'] }),
    });
    const h = makeAdapter({ query: () => [c], queryOne: () => tenantPolicy('migration_recovery') });
    expect(
      await resolveDirectoryAuthEmailFallbackRecoveryCampaign(h.adapter, recoveryInput)
    ).toBeNull();
  });
});
