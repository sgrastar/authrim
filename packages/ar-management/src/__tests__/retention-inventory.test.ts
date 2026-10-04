import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantAuditRetentionFromEnv: vi.fn(),
  resolvePlatformSettingsWithSources: vi.fn(),
  resolveEffectiveSettings: vi.fn(),
  readTenantSessionSettingsStrict: vi.fn(),
  loadTenantProfileStrict: vi.fn(),
  getAuditHotQuerySupportForProfile: vi.fn(),
  resolveTenantRuntimeProfilesFromEnv: vi.fn(),
  getScheduledMaintenanceTaskView: vi.fn(),
  readTenantRetentionRuns: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveTenantAuditRetentionFromEnv: mocks.resolveTenantAuditRetentionFromEnv,
    resolvePlatformSettingsWithSources: mocks.resolvePlatformSettingsWithSources,
    resolveEffectiveSettings: mocks.resolveEffectiveSettings,
    readTenantSessionSettingsStrict: mocks.readTenantSessionSettingsStrict,
    loadTenantProfileStrict: mocks.loadTenantProfileStrict,
    resolveTenantRuntimeProfilesFromEnv: mocks.resolveTenantRuntimeProfilesFromEnv,
  };
});
vi.mock('../audit-hot-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audit-hot-query')>();
  return {
    ...actual,
    getAuditHotQuerySupportForProfile: mocks.getAuditHotQuerySupportForProfile,
  };
});
vi.mock('../r2-storage-maintenance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../r2-storage-maintenance')>();
  return { ...actual, getScheduledMaintenanceTaskView: mocks.getScheduledMaintenanceTaskView };
});
vi.mock('../retention-tenant-runs', () => ({
  readTenantRetentionRuns: mocks.readTenantRetentionRuns,
}));

import {
  buildRetentionInventory,
  RETENTION_CATEGORY_IDS,
  type RetentionCategory,
} from '../compliance/retention-inventory';

function adapter(rows: Record<string, unknown> = {}) {
  return {
    queryOne: vi.fn(async (sql: string, _params?: unknown[]) => {
      for (const [needle, row] of Object.entries(rows)) {
        if (sql.includes(needle)) return row;
      }
      return null;
    }),
    query: vi.fn(),
    execute: vi.fn(),
  };
}

const NOW = 1_800_000_000_000;

function byId(categories: RetentionCategory[]) {
  return Object.fromEntries(categories.map((category) => [category.id, category]));
}

describe('retention inventory', () => {
  let core: ReturnType<typeof adapter>;
  let pii: ReturnType<typeof adapter>;
  let eventLog: ReturnType<typeof adapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    core = adapter({
      'FROM lookup_retention_policies': { retention_days: 365, policy_generation: 2 },
      'FROM lookup_retention_policy_projection_outbox': { projected: 1 },
      'FROM permission_check_audit': { total: 20, expired: 4 },
      'FROM compliance_reports': { total: 3, expired: 1 },
    });
    pii = adapter({ 'FROM users_pii_tombstone': { total: 5, expired: 2 } });
    eventLog = adapter({ 'FROM event_log': { total: 100, expired: 7 } });
    mocks.resolveTenantAuditRetentionFromEnv.mockResolvedValue({
      event: { days: 180, source: 'audit_profile', variesByRoute: false, archived: false },
      pii: { days: 400, source: 'delivery_plan', variesByRoute: true, archived: false },
    });
    mocks.resolvePlatformSettingsWithSources.mockResolvedValue({
      values: { 'audit.check_api_retention_days': 60 },
      sources: {},
    });
    mocks.resolveEffectiveSettings.mockImplementation(async (_env, category: string) =>
      category === 'diagnostic-logging'
        ? { 'diagnostic-logging.retention_days': 14 }
        : {
            'oauth.refresh_token_expiry': 7776000,
            'oauth.auth_code_ttl': 60,
            'oauth.access_token_expiry': 3600,
          }
    );
    mocks.readTenantSessionSettingsStrict.mockResolvedValue({
      'session.ttl.passkey': 3 * 86400000,
    });
    mocks.resolveTenantRuntimeProfilesFromEnv.mockResolvedValue({ auditProfile: { id: 'custom' } });
    mocks.loadTenantProfileStrict.mockResolvedValue({ max_token_ttl_seconds: 86400 });
    mocks.getAuditHotQuerySupportForProfile.mockReturnValue({
      supported: true,
      context: {
        adapter: eventLog,
        mode: 'unified',
        dialect: 'sqlite',
        createdAtUnit: 'milliseconds',
        auditProfileId: 'p',
      },
    });
    mocks.getScheduledMaintenanceTaskView.mockImplementation(async (_env, id: string) => ({
      id,
      name: id,
      enabled: true,
      cron: '0 */6 * * *',
      nextRunAt: NOW + 1000,
      disabledReason: null,
      status: 'succeeded',
      lastStartedAt: NOW - 2000,
      lastCompletedAt: NOW - 1000,
      lastErrorCode: null,
      lastResult: null,
    }));
    mocks.readTenantRetentionRuns.mockResolvedValue({
      audit_retention: { at: NOW - 1000, outcome: 'cleaned' },
    });
  });

  function build(withCounts = true) {
    return buildRetentionInventory({
      env: {} as never,
      tenantId: 'tenant-a',
      coreAdapter: core as never,
      piiAdapters: [pii as never, pii as never],
      withCounts,
      now: NOW,
    });
  }

  it('reports each category from what decides it, in a fixed order', async () => {
    const categories = await build();
    expect(categories.map((category) => category.id)).toEqual(RETENTION_CATEGORY_IDS);
    const c = byId(categories);

    expect(c.audit_events).toMatchObject({
      retention: { value: 180, unit: 'days' },
      source: { kind: 'audit', from: 'audit_profile' },
      edit: { kind: 'audit_profile' },
      varies: null,
      deletion: {
        kind: 'scheduled_task',
        task: 'audit_retention',
        tenant_last_run: { outcome: 'cleaned' },
      },
    });
    // A logging destination's retention applies per route.
    expect(c.audit_pii).toMatchObject({
      retention: { value: 400, unit: 'days' },
      edit: { kind: 'audit_routing_rules' },
      varies: 'by_route',
    });
    expect(c.check_api_audit).toMatchObject({
      retention: { value: 60, unit: 'days' },
      source: { kind: 'setting', level: 'platform', key: 'audit.check_api_retention_days' },
      deletion: { task: 'check_api_audit_retention', tenant_last_run: null },
    });
    // Counted as the retention task finds them: any report whose file is still kept.
    const reportSql = String(
      core.queryOne.mock.calls.find(([sql]) => String(sql).includes('FROM compliance_reports'))?.[0]
    );
    expect(reportSql).toContain("status IN ('completed', 'generating', 'failed')");
    expect(reportSql).toContain('object_key_base IS NOT NULL');
    // Reports can be downloaded for 30 days; then the retention task deletes their file.
    expect(c.compliance_reports).toMatchObject({
      retention: { value: 30, unit: 'days' },
      source: { kind: 'default' },
      edit: { kind: 'none' },
      deletion: { kind: 'scheduled_task', task: 'compliance_report_retention' },
      counts: { total: 3, expired: 1 },
    });
    expect(c.user_tombstones).toMatchObject({
      retention: { value: 90, unit: 'days' },
      source: { kind: 'default' },
      edit: { kind: 'none' },
      varies: 'by_request',
    });
    expect(c.lookup_directory).toMatchObject({
      retention: { value: 365, unit: 'days' },
      edit: { kind: 'lookup_directory' },
      deletion: {
        kind: 'not_deleted',
        reason: 'lookup_purge_not_available',
        projection: 'current',
      },
    });
    expect(c.diagnostic_logs).toMatchObject({ retention: { value: 14, unit: 'days' } });
    // Expired families stay until rotated or revoked.
    expect(c.refresh_tokens).toMatchObject({
      retention: { value: 7776000, unit: 'seconds' },
      varies: 'by_app',
      deletion: { kind: 'not_deleted', reason: 'expired_refresh_families_kept' },
    });
    expect(c.authorization_codes).toMatchObject({ retention: { value: 60, unit: 'seconds' } });
    expect(c.access_tokens).toMatchObject({ deletion: { kind: 'not_stored' } });
    expect(c.access_tokens).not.toHaveProperty('cap');
  });

  it('reads the profile strictly once for retention and counts, and settings fresh', async () => {
    await build();
    expect(mocks.resolveTenantRuntimeProfilesFromEnv).toHaveBeenCalledTimes(1);
    expect(mocks.resolveTenantRuntimeProfilesFromEnv).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      { strict: true }
    );
    expect(mocks.resolveTenantAuditRetentionFromEnv).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-a',
      { auditProfile: { id: 'custom' } }
    );
    expect(mocks.getAuditHotQuerySupportForProfile).toHaveBeenCalledWith(expect.anything(), {
      id: 'custom',
    });
    expect(mocks.resolvePlatformSettingsWithSources).toHaveBeenCalledWith(
      expect.anything(),
      'check-api-audit',
      { fresh: true }
    );
    for (const category of ['diagnostic-logging', 'oauth']) {
      expect(mocks.resolveEffectiveSettings).toHaveBeenCalledWith(expect.anything(), category, {
        tenantId: 'tenant-a',
        fresh: true,
      });
    }

    // A caller's profile is used as given.
    mocks.resolveTenantRuntimeProfilesFromEnv.mockClear();
    await buildRetentionInventory({
      env: {} as never,
      tenantId: 'tenant-a',
      coreAdapter: core as never,
      piiAdapters: [],
      withCounts: false,
      auditProfile: { id: 'given' } as never,
      now: NOW,
    });
    expect(mocks.resolveTenantRuntimeProfilesFromEnv).not.toHaveBeenCalled();
  });

  it('shows sessions as their longest sign-in method lifetime, with each method', async () => {
    const sessions = byId(await build()).sessions!;
    // passkey is set to 3 days; the default of the longest method (30 days) still wins.
    expect(sessions.retention).toEqual({ value: 30 * 86400, unit: 'seconds' });
    expect(sessions.varies).toBe('by_sign_in_method');
    // A refresh extends a session by up to a day, up to session.max_ttl (30 days) from sign-in.
    expect(sessions.extension).toEqual({
      per_refresh_seconds: 86400,
      absolute_limit_seconds: 30 * 86400,
    });
    expect(sessions.breakdown).toEqual(
      expect.arrayContaining([
        { key: 'session.ttl.passkey', seconds: 3 * 86400 },
        // External IdP and SAML sign-in take session.default_ttl.
        { key: 'session.default_ttl', seconds: 86400 },
        // Paths whose lifetime is fixed in code are listed too.
        { key: 'session_handoff', seconds: 3600, fixed: true },
      ])
    );
    expect(sessions.source).toMatchObject({ kind: 'session_settings' });
    expect((sessions.source as { keys: string[] }).keys).not.toContain('session_handoff');
  });

  it('caps session lifetimes at session.max_ttl, and shows no extension when it is off', async () => {
    mocks.readTenantSessionSettingsStrict.mockResolvedValueOnce({
      'session.max_ttl': 2 * 86400000,
      'session.refresh_default': false,
    });
    const sessions = byId(await build()).sessions!;
    expect(sessions.retention).toEqual({ value: 2 * 86400, unit: 'seconds' });
    expect(sessions.breakdown).toEqual(
      expect.arrayContaining([{ key: 'session.ttl.passkey_registration', seconds: 2 * 86400 }])
    );
    expect(sessions.extension).toBeUndefined();
  });

  it('counts records for the tenant only, past retention by their own cutoff', async () => {
    const c = byId(await build());
    expect(c.audit_events!.counts).toEqual({ total: 100, expired: 7 });
    expect(c.check_api_audit!.counts).toEqual({ total: 20, expired: 4 });
    // Summed over every PII store.
    expect(c.user_tombstones!.counts).toEqual({ total: 10, expired: 4 });
    expect(c.sessions!.counts).toBeNull();

    expect(eventLog.queryOne).toHaveBeenCalledWith(expect.stringContaining('FROM event_log'), [
      NOW,
      'tenant-a',
    ]);
    const checkCall = core.queryOne.mock.calls.find(([sql]) =>
      String(sql).includes('permission_check_audit')
    )!;
    expect(checkCall[1]).toEqual([Math.floor(NOW / 1000) - 60 * 86400, 'tenant-a']);
    expect(pii.queryOne).toHaveBeenCalledWith(expect.stringContaining('users_pii_tombstone'), [
      NOW,
      'tenant-a',
    ]);
  });

  it('does not count audit logs it cannot query, or on request', async () => {
    mocks.getAuditHotQuerySupportForProfile.mockReturnValueOnce({
      supported: false,
      status: 'not_supported',
    });
    expect(byId(await build()).audit_events!.counts).toBeNull();

    pii.queryOne.mockClear();
    const categories = await build(false);
    expect(categories.every((category) => category.counts === null)).toBe(true);
    expect(pii.queryOne).not.toHaveBeenCalled();
  });

  it('marks a lookup policy whose generation was not projected yet', async () => {
    core = adapter({
      'FROM lookup_retention_policies': { retention_days: 400, policy_generation: 3 },
      'FROM lookup_retention_policy_projection_outbox': { projected: 0 },
    });
    const lookup = byId(await build(false)).lookup_directory!;
    expect(lookup.retention.value).toBe(400);
    expect(lookup.deletion).toEqual({
      kind: 'not_deleted',
      reason: 'lookup_purge_not_available',
      projection: 'pending',
    });
    // Judged by the current generation only.
    const outboxCall = core.queryOne.mock.calls.find(([sql]) =>
      String(sql).includes('projection_outbox')
    )!;
    expect(outboxCall[1]).toEqual(['tenant-a', 3]);

    // No policy row yet: the default, nothing to project.
    core = adapter({});
    const defaults = byId(await build(false)).lookup_directory!;
    expect(defaults.retention.value).toBe(180);
    expect(defaults.deletion).toMatchObject({ projection: 'current' });
  });

  it('marks audit retention a route sets apart from its default source', async () => {
    mocks.resolveTenantAuditRetentionFromEnv.mockResolvedValueOnce({
      event: { days: 90, source: 'audit_profile', variesByRoute: true, archived: false },
      pii: { days: 365, source: 'pii_config', variesByRoute: false, archived: false },
    });
    const c = byId(await build(false));
    expect(c.audit_events).toMatchObject({ varies: 'by_route', edit: { kind: 'audit_profile' } });
    expect(c.audit_pii).toMatchObject({ varies: null, edit: { kind: 'audit_pii_config' } });
  });

  it('shows the access token lifetime the tenant profile caps it to', async () => {
    mocks.loadTenantProfileStrict.mockResolvedValueOnce({ max_token_ttl_seconds: 1800 });
    expect(byId(await build(false)).access_tokens).toMatchObject({
      retention: { value: 1800, unit: 'seconds' },
      cap: { kind: 'tenant_profile', seconds: 1800 },
    });
  });

  it('shows the diagnostic log retention as its cleanup applies it', async () => {
    for (const [stored, shown] of [
      [1.5, 1.5],
      [4000, 3650],
      [undefined, 30],
    ] as const) {
      mocks.resolveEffectiveSettings.mockImplementation(async (_env, category: string) =>
        category === 'diagnostic-logging'
          ? { 'diagnostic-logging.retention_days': stored }
          : {
              'oauth.refresh_token_expiry': 7776000,
              'oauth.auth_code_ttl': 60,
              'oauth.access_token_expiry': 3600,
            }
      );
      expect(byId(await build(false)).diagnostic_logs!.retention.value).toBe(shown);
    }
  });

  it('throws rather than show a value nothing uses', async () => {
    mocks.loadTenantProfileStrict.mockRejectedValueOnce(new Error('tenant_contract_invalid'));
    await expect(build()).rejects.toThrow('tenant_contract_invalid');

    mocks.readTenantSessionSettingsStrict.mockRejectedValueOnce(
      new Error('session_settings_invalid')
    );
    await expect(build()).rejects.toThrow('session_settings_invalid');

    mocks.resolveTenantAuditRetentionFromEnv.mockRejectedValueOnce(new Error('kv_unavailable'));
    await expect(build()).rejects.toThrow('kv_unavailable');

    mocks.resolvePlatformSettingsWithSources.mockResolvedValueOnce({
      values: { 'audit.check_api_retention_days': 'ninety' },
      sources: {},
    });
    await expect(build()).rejects.toThrow('retention_inventory_invalid_check_api_retention_days');

    // An audit retention a write cannot use (not a number, or a fraction it would drop).
    for (const days of ['broken', 1.5]) {
      mocks.resolveTenantAuditRetentionFromEnv.mockResolvedValueOnce({
        event: { days, source: 'audit_profile', variesByRoute: false, archived: false },
        pii: { days: 365, source: 'pii_config', variesByRoute: false, archived: false },
      });
      await expect(build()).rejects.toThrow(
        'retention_inventory_invalid_audit_event_retention_days'
      );
    }

    core = adapter({ 'FROM lookup_retention_policies': { retention_days: 5 } });
    await expect(build()).rejects.toThrow('retention_inventory_invalid_lookup_policy');
  });

  it('says when audit logs are also archived, which their deletion does not cover', async () => {
    mocks.resolveTenantAuditRetentionFromEnv.mockResolvedValueOnce({
      event: { days: 90, source: 'audit_profile', variesByRoute: false, archived: true },
      pii: { days: 365, source: 'pii_config', variesByRoute: false, archived: false },
    });
    const c = byId(await build(false));
    expect(c.audit_events).toMatchObject({
      deletion: { kind: 'scheduled_task', task: 'audit_retention' },
      archive: { deletion: 'not_deleted' },
    });
    expect(c.audit_pii).not.toHaveProperty('archive');
  });
});
