import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, ExecuteResult } from '../../db';
import { emitLogIcebergRow } from '../log-iceberg-emitter';
import {
  ensureDirectoryAuthDefaults,
  ensureDirectoryAuthRetentionPolicy,
  ensureDirectoryAuthTemplateCampaign,
  getDirectoryAuthEvidenceExport,
  getDirectoryAuthSupportBundle,
  listDirectoryAuthConfigHistory,
  listDirectoryAuthEvidenceExports,
  listDirectoryAuthEvidenceExportsReadyForHardDelete,
  listDirectoryAuthMigrationCampaigns,
  listDirectoryAuthMigrationUserStates,
  listDirectoryAuthReleaseAdvisories,
  listDirectoryAuthSupportBundles,
  listDirectoryAuthSupportBundlesReadyForHardDelete,
  recordDirectoryAuthConfigHistory,
  type DirectoryAuthMigrationCampaignRow,
} from '../directory-auth';

vi.mock('../log-iceberg-emitter', () => ({ emitLogIcebergRow: vi.fn(async () => ({})) }));

const HOUR = 60 * 60 * 1000;

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

describe('config history', () => {
  it('records defaults for optional fields', async () => {
    const h = makeAdapter();
    await recordDirectoryAuthConfigHistory(h.adapter, {
      tenantId: 'tenant-a',
      category: 'cat',
      action: 'act',
      resourceType: 'res',
      now: 77,
    });
    const [sql, params] = h.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO directory_auth_config_history');
    expect(params[0]).toMatch(/^dach_/);
    expect(params.slice(1)).toStrictEqual([
      'tenant-a',
      null,
      'cat',
      'act',
      'res',
      null,
      '{}',
      '{}',
      77,
    ]);
  });

  it('serializes before/after and truncates oversized snapshots at exactly 32 KiB', async () => {
    const exact = { a: 'x'.repeat(32 * 1024 - 8) };
    expect(JSON.stringify(exact)).toHaveLength(32 * 1024);
    const over = { a: 'x'.repeat(32 * 1024 - 7) };
    const h = makeAdapter();
    await recordDirectoryAuthConfigHistory(h.adapter, {
      tenantId: 't',
      actorId: 'actor',
      category: 'c',
      action: 'a',
      resourceType: 'r',
      resourceId: 'rid',
      before: exact,
      after: over,
      now: 1,
    });
    const params = h.execute.mock.calls[0][1];
    expect(params[2]).toBe('actor');
    expect(params[6]).toBe('rid');
    expect(params[7]).toBe(JSON.stringify(exact));
    expect(params[8]).toBe('{"truncated":true}');
  });

  it('counts bytes rather than characters when bounding JSON', async () => {
    // 3-byte characters: 10923 chars = 32769 bytes, over the limit although < 32768 chars + 8
    const multi = { a: 'あ'.repeat(10_923) };
    const h = makeAdapter();
    await recordDirectoryAuthConfigHistory(h.adapter, {
      tenantId: 't',
      category: 'c',
      action: 'a',
      resourceType: 'r',
      before: multi,
      now: 1,
    });
    expect(h.execute.mock.calls[0][1][7]).toBe('{"truncated":true}');
  });

  it('lists config history with clamped limit and optional category', async () => {
    const rows = [{ id: 'h1' }];
    const h = makeAdapter({ query: () => rows });
    expect(await listDirectoryAuthConfigHistory(h.adapter, 'tenant-a')).toBe(rows);
    expect(h.query.mock.calls[0][0]).toContain('WHERE tenant_id = ?');
    expect(h.query.mock.calls[0][0]).not.toContain('category');
    expect(h.query.mock.calls[0][0]).toContain('ORDER BY created_at DESC');
    expect(h.query.mock.calls[0][1]).toStrictEqual(['tenant-a', 50]);

    await listDirectoryAuthConfigHistory(h.adapter, 'tenant-a', { category: ' policy ', limit: 7 });
    expect(h.query.mock.calls[1][0]).toContain('WHERE tenant_id = ? AND category = ?');
    expect(h.query.mock.calls[1][1]).toStrictEqual(['tenant-a', 'policy', 7]);

    await listDirectoryAuthConfigHistory(h.adapter, 'tenant-a', { category: '   ' });
    expect(h.query.mock.calls[2][0]).not.toContain('category');
    expect(h.query.mock.calls[2][1]).toStrictEqual(['tenant-a', 50]);
  });
});

describe('list limit clamping', () => {
  it.each([
    [undefined, 50],
    [0, 50],
    [Number.NaN, 50],
    [Number.POSITIVE_INFINITY, 50],
    [1, 1],
    [2.9, 2],
    [-5, 1],
    [100, 100],
    [101, 100],
    [100000, 100],
  ])('limit %s becomes %s', async (input, expected) => {
    const h = makeAdapter();
    await listDirectoryAuthEvidenceExports(h.adapter, 'tenant-a', input);
    expect(h.query.mock.calls[0][1]).toStrictEqual(['tenant-a', expected]);
  });
});

describe('list queries', () => {
  it('lists migration campaigns for a tenant, templates first', async () => {
    const rows = [campaignRow()];
    const h = makeAdapter({ query: () => rows });
    expect(await listDirectoryAuthMigrationCampaigns(h.adapter, 'tenant-a')).toBe(rows);
    expect(h.query.mock.calls[0][0]).toContain('ORDER BY is_template DESC, updated_at DESC');
    expect(h.query.mock.calls[0][1]).toStrictEqual(['tenant-a']);
  });

  it('lists user states with each optional filter', async () => {
    const rows = [{ id: 's1' }];
    const h = makeAdapter({ query: () => rows });
    expect(await listDirectoryAuthMigrationUserStates(h.adapter, 'tenant-a')).toBe(rows);
    expect(h.query.mock.calls[0][0]).toContain('WHERE tenant_id = ?\n');
    expect(h.query.mock.calls[0][0]).toContain('ORDER BY updated_at DESC');
    expect(h.query.mock.calls[0][1]).toStrictEqual(['tenant-a', 50]);

    await listDirectoryAuthMigrationUserStates(h.adapter, 'tenant-a', { state: 'blocked' });
    expect(h.query.mock.calls[1][0]).toContain('WHERE tenant_id = ? AND state = ?');
    expect(h.query.mock.calls[1][1]).toStrictEqual(['tenant-a', 'blocked', 50]);

    await listDirectoryAuthMigrationUserStates(h.adapter, 'tenant-a', { campaignId: 'c1' });
    expect(h.query.mock.calls[2][0]).toContain('WHERE tenant_id = ? AND campaign_id = ?');
    expect(h.query.mock.calls[2][1]).toStrictEqual(['tenant-a', 'c1', 50]);

    await listDirectoryAuthMigrationUserStates(h.adapter, 'tenant-a', { userId: 'u1' });
    expect(h.query.mock.calls[3][0]).toContain('WHERE tenant_id = ? AND user_id = ?');
    expect(h.query.mock.calls[3][1]).toStrictEqual(['tenant-a', 'u1', 50]);

    await listDirectoryAuthMigrationUserStates(h.adapter, 'tenant-a', {
      state: 'enrolled',
      campaignId: 'c1',
      userId: 'u1',
      limit: 5,
    });
    expect(h.query.mock.calls[4][0]).toContain(
      'WHERE tenant_id = ? AND state = ? AND campaign_id = ? AND user_id = ?'
    );
    expect(h.query.mock.calls[4][1]).toStrictEqual(['tenant-a', 'enrolled', 'c1', 'u1', 5]);
  });

  it('treats empty string filters as absent', async () => {
    const h = makeAdapter();
    await listDirectoryAuthMigrationUserStates(h.adapter, 'tenant-a', {
      campaignId: '',
      userId: '',
    });
    expect(h.query.mock.calls[0][1]).toStrictEqual(['tenant-a', 50]);
  });

  it('lists and gets evidence exports and support bundles scoped to the tenant', async () => {
    const h = makeAdapter({ query: () => [{ id: 'x' }], queryOne: () => ({ id: 'one' }) });
    expect(await listDirectoryAuthEvidenceExports(h.adapter, 'tenant-a', 3)).toStrictEqual([
      { id: 'x' },
    ]);
    expect(h.query.mock.calls[0][0]).toContain('FROM directory_auth_evidence_exports');
    expect(h.query.mock.calls[0][0]).toContain('ORDER BY created_at DESC');
    expect(h.query.mock.calls[0][1]).toStrictEqual(['tenant-a', 3]);

    expect(await getDirectoryAuthEvidenceExport(h.adapter, 'tenant-a', 'e1')).toStrictEqual({
      id: 'one',
    });
    expect(h.queryOne.mock.calls[0][0]).toContain('FROM directory_auth_evidence_exports');
    expect(h.queryOne.mock.calls[0][1]).toStrictEqual(['tenant-a', 'e1']);

    expect(await listDirectoryAuthSupportBundles(h.adapter, 'tenant-a')).toStrictEqual([
      { id: 'x' },
    ]);
    expect(h.query.mock.calls[1][0]).toContain('FROM directory_auth_support_bundles');
    expect(h.query.mock.calls[1][1]).toStrictEqual(['tenant-a', 50]);

    expect(await getDirectoryAuthSupportBundle(h.adapter, 'tenant-a', 'b1')).toStrictEqual({
      id: 'one',
    });
    expect(h.queryOne.mock.calls[1][0]).toContain('FROM directory_auth_support_bundles');
    expect(h.queryOne.mock.calls[1][1]).toStrictEqual(['tenant-a', 'b1']);
  });

  it('lists release advisories for a channel (default stable)', async () => {
    const h = makeAdapter({ query: () => [{ id: 'a' }] });
    expect(await listDirectoryAuthReleaseAdvisories(h.adapter)).toStrictEqual([{ id: 'a' }]);
    expect(h.query.mock.calls[0][0]).toContain('FROM directory_auth_release_advisories');
    expect(h.query.mock.calls[0][0]).toContain('ORDER BY updated_at DESC');
    expect(h.query.mock.calls[0][1]).toStrictEqual(['stable', 50]);
    await listDirectoryAuthReleaseAdvisories(h.adapter, 'beta', 9);
    expect(h.query.mock.calls[1][1]).toStrictEqual(['beta', 9]);
  });

  it('lists artifacts ready for hard delete past the grace window', async () => {
    const h = makeAdapter({ query: () => [{ id: 'old' }] });
    expect(
      await listDirectoryAuthEvidenceExportsReadyForHardDelete(h.adapter, 'tenant-a', {
        now: 1_000_000_000,
        graceHours: 2,
        limit: 4,
      })
    ).toStrictEqual([{ id: 'old' }]);
    expect(h.query.mock.calls[0][0]).toContain('directory_auth_evidence_exports');
    expect(h.query.mock.calls[0][0]).toContain("status = 'expired'");
    expect(h.query.mock.calls[0][0]).toContain('object_catalog_id IS NOT NULL');
    expect(h.query.mock.calls[0][1]).toStrictEqual(['tenant-a', 1_000_000_000 - 2 * HOUR, 4]);

    await listDirectoryAuthEvidenceExportsReadyForHardDelete(h.adapter, 'tenant-a', {
      now: 1_000_000_000,
    });
    expect(h.query.mock.calls[1][1]).toStrictEqual(['tenant-a', 1_000_000_000 - 72 * HOUR, 50]);

    await listDirectoryAuthSupportBundlesReadyForHardDelete(h.adapter, 'tenant-a', {
      now: 1_000_000_000,
      graceHours: 0,
      limit: 1000,
    });
    expect(h.query.mock.calls[2][0]).toContain('directory_auth_support_bundles');
    expect(h.query.mock.calls[2][1]).toStrictEqual(['tenant-a', 1_000_000_000, 100]);

    await listDirectoryAuthSupportBundlesReadyForHardDelete(h.adapter, 'tenant-a', {
      now: 1_000_000_000,
    });
    expect(h.query.mock.calls[3][1]).toStrictEqual(['tenant-a', 1_000_000_000 - 72 * HOUR, 50]);
  });

  it('defaults hard-delete listing time to Date.now()', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(500 * HOUR);
      const h = makeAdapter();
      await listDirectoryAuthEvidenceExportsReadyForHardDelete(h.adapter, 'tenant-a');
      await listDirectoryAuthSupportBundlesReadyForHardDelete(h.adapter, 'tenant-a');
      expect(h.query.mock.calls[0][1]).toStrictEqual(['tenant-a', 428 * HOUR, 50]);
      expect(h.query.mock.calls[1][1]).toStrictEqual(['tenant-a', 428 * HOUR, 50]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('defaults and template campaign', () => {
  it('ensureDirectoryAuthRetentionPolicy returns the existing policy without writing', async () => {
    const existing = { tenant_id: 'tenant-a', authrim_audit_retention_days: 1 };
    const h = makeAdapter({ queryOne: () => existing });
    expect(await ensureDirectoryAuthRetentionPolicy(h.adapter, 'tenant-a', 'a', 1)).toBe(existing);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('ensureDirectoryAuthRetentionPolicy seeds documented defaults', async () => {
    const h = makeAdapter();
    const row = await ensureDirectoryAuthRetentionPolicy(h.adapter, 'tenant-a', 'admin-1', 1000);
    expect(row).toStrictEqual({
      tenant_id: 'tenant-a',
      authrim_audit_retention_days: 365,
      wordwarden_local_retention_days: 14,
      artifact_delete_grace_hours: 72,
      updated_by: 'admin-1',
      created_at: 1000,
      updated_at: 1000,
    });
    expect(h.execute.mock.calls[0][0]).toContain('ON CONFLICT(tenant_id) DO NOTHING');
    expect(h.execute.mock.calls[0][1]).toStrictEqual([
      'tenant-a',
      365,
      14,
      72,
      'admin-1',
      1000,
      1000,
    ]);
    const noActor = await ensureDirectoryAuthRetentionPolicy(makeAdapter().adapter, 'tenant-a');
    expect(noActor.updated_by).toBeNull();
  });

  it('ensureDirectoryAuthRetentionPolicy prefers the stored row after insert (race)', async () => {
    const stored = { tenant_id: 'tenant-a', authrim_audit_retention_days: 5 };
    let calls = 0;
    const h = makeAdapter({ queryOne: () => (++calls === 1 ? null : stored) });
    expect(await ensureDirectoryAuthRetentionPolicy(h.adapter, 'tenant-a', null, 1)).toBe(stored);
  });

  it('ensureDirectoryAuthDefaults skips every insert when everything exists', async () => {
    const h = makeAdapter({ queryOne: () => ({ id: 'exists' }) });
    await ensureDirectoryAuthDefaults(h.adapter, 'tenant-a', 'admin-1', 1000);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.queryOne).toHaveBeenCalledTimes(3);
  });

  it('ensureDirectoryAuthDefaults passes a null actor and now to each seed', async () => {
    const h = makeAdapter();
    await ensureDirectoryAuthDefaults(h.adapter, 'tenant-a', undefined, 1000);
    const tenant = executeCalls(h, 'INSERT INTO directory_auth_tenant_policies')[0];
    expect(tenant[1]).toStrictEqual(['tenant-a', 'migration_recovery', null, 1000, 1000]);
    const retention = executeCalls(h, 'INSERT INTO directory_auth_retention_policies')[0];
    expect(retention[1]).toStrictEqual(['tenant-a', 365, 14, 72, null, 1000, 1000]);
    const campaign = executeCalls(h, 'INSERT INTO directory_auth_migration_campaigns')[0];
    expect(campaign[1][13]).toBeNull();
    expect(campaign[1][14]).toBe(1000);
  });

  it('returns an existing template campaign untouched', async () => {
    const existing = campaignRow({ is_template: 1 });
    const h = makeAdapter({ queryOne: () => existing });
    expect(await ensureDirectoryAuthTemplateCampaign(h.adapter, 'tenant-a', 'a', 1)).toBe(existing);
    expect(h.queryOne.mock.calls[0][0]).toContain('is_template = 1');
    expect(h.queryOne.mock.calls[0][0]).toContain('ORDER BY created_at ASC');
    expect(h.queryOne.mock.calls[0][1]).toStrictEqual(['tenant-a']);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('creates the disabled template campaign with its fixed configuration', async () => {
    const h = makeAdapter();
    const row = await ensureDirectoryAuthTemplateCampaign(h.adapter, 'tenant-a', 'admin-1', 1000);
    expect(row).toMatchObject({
      tenant_id: 'tenant-a',
      name: 'Default passwordless migration template',
      description: 'Disabled template for an explicit passwordless migration campaign.',
      status: 'disabled',
      mode: 'grace_then_require_passkey',
      passkey_prompt_mode: 'campaign_only',
      email_code_fallback_mode: 'tenant_default',
      grace_period_days: 30,
      transaction_ttl_seconds: 600,
      enforcement_start_mode: 'first_directory_login',
      target_policy_json: '{"type":"template","assignments":[]}',
      is_template: 1,
      created_by: 'admin-1',
      created_at: 1000,
      updated_at: 1000,
    });
    expect(row.id).toMatch(/^damc_/);
  });

  it('returns the concurrently created template when the insert fails', async () => {
    const winner = campaignRow({ id: 'winner', is_template: 1 });
    let selects = 0;
    const h = makeAdapter({
      queryOne: () => (++selects === 1 ? null : winner),
      execute: () => {
        throw new Error('UNIQUE constraint failed');
      },
    });
    expect(await ensureDirectoryAuthTemplateCampaign(h.adapter, 'tenant-a', null, 1)).toBe(winner);
    expect(h.queryOne.mock.calls[1][0]).toContain('is_template = 1');
    expect(h.queryOne.mock.calls[1][1]).toStrictEqual(['tenant-a']);
  });

  it('rethrows the original insert error when no template exists afterwards', async () => {
    const failure = new Error('db down');
    const h = makeAdapter({
      execute: () => {
        throw failure;
      },
    });
    await expect(ensureDirectoryAuthTemplateCampaign(h.adapter, 'tenant-a', null, 1)).rejects.toBe(
      failure
    );
  });
});
