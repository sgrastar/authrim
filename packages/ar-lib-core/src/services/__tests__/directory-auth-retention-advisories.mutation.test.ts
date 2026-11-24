import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, ExecuteResult } from '../../db';
import { emitLogIcebergRow } from '../log-iceberg-emitter';
import {
  createDirectoryAuthEvidenceExportJob,
  createDirectoryAuthSupportBundleRequest,
  matchDirectoryAuthReleaseAdvisories,
  updateDirectoryAuthRetentionPolicy,
  type DirectoryAuthReleaseAdvisoryRow,
} from '../directory-auth';

vi.mock('../log-iceberg-emitter', () => ({ emitLogIcebergRow: vi.fn(async () => ({})) }));

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

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

beforeEach(() => {
  vi.mocked(emitLogIcebergRow).mockClear();
});

describe('updateDirectoryAuthRetentionPolicy', () => {
  it('upserts and preserves the stored created_at in the result and history', async () => {
    const stored = [
      {
        tenant_id: 'tenant-a',
        authrim_audit_retention_days: 100,
        wordwarden_local_retention_days: null,
        artifact_delete_grace_hours: 10,
        updated_by: 'old',
        created_at: 42,
        updated_at: 43,
      },
    ];
    const h = makeAdapter({ queryOne: () => stored[0] });
    const next = await updateDirectoryAuthRetentionPolicy(h.adapter, {
      tenantId: 'tenant-a',
      authrimAuditRetentionDays: 200,
      wordwardenLocalRetentionDays: 7,
      artifactDeleteGraceHours: 24,
      actorId: 'admin-1',
      now: 1000,
    });
    expect(next).toStrictEqual({
      tenant_id: 'tenant-a',
      authrim_audit_retention_days: 200,
      wordwarden_local_retention_days: 7,
      artifact_delete_grace_hours: 24,
      updated_by: 'admin-1',
      created_at: 42,
      updated_at: 1000,
    });
    expect(h.execute.mock.calls[0][0]).toContain('ON CONFLICT(tenant_id) DO UPDATE SET');
    expect(h.execute.mock.calls[0][1]).toStrictEqual([
      'tenant-a',
      200,
      7,
      24,
      'admin-1',
      1000,
      1000,
    ]);
    const history = executeCalls(h, 'directory_auth_config_history')[0][1];
    expect(history.slice(1)).toStrictEqual([
      'tenant-a',
      'admin-1',
      'retention',
      'retention_policy.updated',
      'directory_auth_retention_policy',
      'tenant-a',
      JSON.stringify({
        authrim_audit_retention_days: 100,
        wordwarden_local_retention_days: null,
        artifact_delete_grace_hours: 10,
      }),
      JSON.stringify({
        authrim_audit_retention_days: 200,
        wordwarden_local_retention_days: 7,
        artifact_delete_grace_hours: 24,
      }),
      1000,
    ]);
  });

  it('records an empty before snapshot and falls back to now for created_at when nothing is stored', async () => {
    const h = makeAdapter();
    const next = await updateDirectoryAuthRetentionPolicy(h.adapter, {
      tenantId: 'tenant-a',
      authrimAuditRetentionDays: 30,
      wordwardenLocalRetentionDays: null,
      artifactDeleteGraceHours: 12,
      now: 1000,
    });
    expect(next.created_at).toBe(1000);
    expect(next.updated_by).toBeNull();
    const history = executeCalls(h, 'directory_auth_config_history')[0][1];
    expect(history[2]).toBeNull();
    expect(history[7]).toBe('{}');
    expect(history[8]).toBe(
      JSON.stringify({
        authrim_audit_retention_days: 30,
        wordwarden_local_retention_days: null,
        artifact_delete_grace_hours: 12,
      })
    );
  });
});

describe('evidence export and support bundle creation', () => {
  async function sha256(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  it('creates an evidence export with defaults, manifest hash and exact insert params', async () => {
    const h = makeAdapter();
    const row = await createDirectoryAuthEvidenceExportJob(h.adapter, {
      tenantId: 'tenant-a',
      requestedBy: 'admin-1',
      periodStartAt: 100,
      periodEndAt: 200,
      id: 'daex_fixed',
      now: 1000,
    });
    const manifest = JSON.stringify({
      type: 'directory_auth_evidence_export',
      version: 1,
      tenant_id: 'tenant-a',
      export_id: 'daex_fixed',
      requested_by: 'admin-1',
      period_start_at: 100,
      period_end_at: 200,
      download_after_delete: false,
      generated_at: 1000,
      sections: [
        'migration_campaigns',
        'migration_user_states',
        'migration_transactions',
        'config_history',
        'retention_policy',
        'support_bundle_metadata',
        'wordwarden_advisories',
      ],
    });
    expect(row).toStrictEqual({
      id: 'daex_fixed',
      tenant_id: 'tenant-a',
      status: 'ready',
      requested_by: 'admin-1',
      period_start_at: 100,
      period_end_at: 200,
      size_estimate_bytes: new TextEncoder().encode(manifest).byteLength,
      artifact_key: 'directory-auth/evidence/tenant-a/daex_fixed.json',
      artifact_sha256: await sha256(manifest),
      object_catalog_id: null,
      manifest_signature_key_id: null,
      manifest_signature_alg: null,
      signed_url_expires_at: null,
      retention_expires_at: 1000 + 7 * DAY,
      download_after_delete: 0,
      error_code: null,
      created_at: 1000,
      updated_at: 1000,
      completed_at: 1000,
      deleted_at: null,
    });
    const [sql, params] = h.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO directory_auth_evidence_exports');
    expect(params).toStrictEqual(Object.values(row));
  });

  it('honours explicit evidence export overrides', async () => {
    const h = makeAdapter();
    const row = await createDirectoryAuthEvidenceExportJob(h.adapter, {
      tenantId: 'tenant-a',
      requestedBy: 'admin-1',
      periodStartAt: 1,
      periodEndAt: 2,
      artifactKey: 'custom/key.json',
      artifactSha256: 'abc',
      objectCatalogId: 'obj-1',
      sizeEstimateBytes: 55,
      downloadAfterDelete: true,
      retentionDays: 3,
      now: 10,
    });
    expect(row).toMatchObject({
      artifact_key: 'custom/key.json',
      artifact_sha256: 'abc',
      object_catalog_id: 'obj-1',
      size_estimate_bytes: 55,
      download_after_delete: 1,
      retention_expires_at: 10 + 3 * DAY,
    });
    expect(row.id).toMatch(/^daex_/);
  });

  it('records the download-after-delete flag in the evidence manifest hash', async () => {
    const withFlag = await createDirectoryAuthEvidenceExportJob(makeAdapter().adapter, {
      tenantId: 'tenant-a',
      requestedBy: 'a',
      periodStartAt: 1,
      periodEndAt: 2,
      id: 'e',
      downloadAfterDelete: true,
      now: 1,
    });
    const without = await createDirectoryAuthEvidenceExportJob(makeAdapter().adapter, {
      tenantId: 'tenant-a',
      requestedBy: 'a',
      periodStartAt: 1,
      periodEndAt: 2,
      id: 'e',
      now: 1,
    });
    expect(withFlag.artifact_sha256).not.toBe(without.artifact_sha256);
    expect(withFlag.size_estimate_bytes).toBe((without.size_estimate_bytes ?? 0) - 1);
  });

  it('creates a support bundle with defaults, manifest hash and exact insert params', async () => {
    const h = makeAdapter();
    const row = await createDirectoryAuthSupportBundleRequest(h.adapter, {
      tenantId: 'tenant-a',
      requestedBy: 'admin-1',
      redactionLevel: 'standard',
      id: 'dasb_fixed',
      now: 1000,
    });
    const manifest = JSON.stringify({
      type: 'directory_auth_support_bundle',
      version: 1,
      tenant_id: 'tenant-a',
      bundle_id: 'dasb_fixed',
      requested_by: 'admin-1',
      redaction_level: 'standard',
      scope: {},
      consent_summary: {},
      generated_at: 1000,
      contents: [
        'redacted_configuration',
        'directory_auth_recent_job_metadata',
        'directory_auth_recent_advisory_metadata',
        'wordwarden_connector_health_summary',
      ],
    });
    expect(row).toStrictEqual({
      id: 'dasb_fixed',
      tenant_id: 'tenant-a',
      requested_by: 'admin-1',
      redaction_level: 'standard',
      status: 'ready',
      scope_json: '{}',
      consent_summary_json: '{}',
      artifact_key: 'directory-auth/support-bundles/tenant-a/dasb_fixed.json',
      artifact_sha256: await sha256(manifest),
      object_catalog_id: null,
      retention_expires_at: 1000 + 7 * DAY,
      created_at: 1000,
      updated_at: 1000,
      completed_at: 1000,
      deleted_at: null,
    });
    const [sql, params] = h.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO directory_auth_support_bundles');
    expect(params).toStrictEqual(Object.values(row));
  });

  it('honours explicit support bundle overrides', async () => {
    const h = makeAdapter();
    const row = await createDirectoryAuthSupportBundleRequest(h.adapter, {
      tenantId: 'tenant-a',
      requestedBy: 'admin-1',
      redactionLevel: 'detailed',
      artifactKey: 'k',
      artifactSha256: 'sha',
      objectCatalogId: 'obj',
      scope: { a: 1 },
      consentSummary: { ok: true },
      retentionDays: 2,
      now: 10,
    });
    expect(row).toMatchObject({
      redaction_level: 'detailed',
      artifact_key: 'k',
      artifact_sha256: 'sha',
      object_catalog_id: 'obj',
      scope_json: '{"a":1}',
      consent_summary_json: '{"ok":true}',
      retention_expires_at: 10 + 2 * DAY,
    });
    expect(row.id).toMatch(/^dasb_/);
  });
});

describe('release advisory matching', () => {
  function advisory(affected: string[] | string): DirectoryAuthReleaseAdvisoryRow {
    return {
      id: 'adv',
      channel: 'stable',
      severity: 'high',
      affected_versions_json: typeof affected === 'string' ? affected : JSON.stringify(affected),
      fixed_version: null,
      summary: 's',
      published_at: 1,
      updated_at: 1,
      release_url: null,
      created_at: 1,
    };
  }
  const affectedBy = (version: string, ranges: string[] | string) =>
    matchDirectoryAuthReleaseAdvisories(version, [advisory(ranges)])[0].affected;

  it('returns advisory, flag and reason for each advisory', () => {
    const a = advisory(['1.0.0']);
    const b = advisory(['2.0.0']);
    expect(matchDirectoryAuthReleaseAdvisories('1.0.0', [a, b])).toStrictEqual([
      { advisory: a, affected: true, reason: 'version_affected' },
      { advisory: b, affected: false, reason: 'version_not_affected' },
    ]);
    expect(matchDirectoryAuthReleaseAdvisories('1.0.0', [])).toStrictEqual([]);
  });

  it('matches exact versions ignoring a leading v and surrounding whitespace', () => {
    expect(affectedBy('1.2.3', ['1.2.3'])).toBe(true);
    expect(affectedBy('v1.2.3', ['1.2.3'])).toBe(true);
    expect(affectedBy('V1.2.3', ['v1.2.3'])).toBe(true);
    expect(affectedBy(' 1.2.3 ', [' v1.2.3 '])).toBe(true);
    expect(affectedBy('1.2.4', ['1.2.3'])).toBe(false);
  });

  it('matches wildcards', () => {
    expect(affectedBy('9.9.9', ['*'])).toBe(true);
    expect(affectedBy('1.2.3', ['1.2.*'])).toBe(true);
    expect(affectedBy('1.2.0', ['1.2.*'])).toBe(true);
    expect(affectedBy('1.3.0', ['1.2.*'])).toBe(false);
    expect(affectedBy('1.20.0', ['1.2.*'])).toBe(false);
    expect(affectedBy('1.2', ['1.2.*'])).toBe(false);
  });

  it('ignores empty or blank candidates and non-matching ones', () => {
    expect(affectedBy('1.0.0', [''])).toBe(false);
    expect(affectedBy('1.0.0', ['   '])).toBe(false);
    expect(affectedBy('1.0.0', ['v'])).toBe(false);
    expect(affectedBy('1.0.0', ['abc'])).toBe(false);
    expect(affectedBy('1.0.0', [])).toBe(false);
  });

  it.each([
    ['1.2.3', '<=1.2.3', true],
    ['1.2.2', '<=1.2.3', true],
    ['1.2.4', '<=1.2.3', false],
    ['1.2.3', '>=1.2.3', true],
    ['1.2.4', '>=1.2.3', true],
    ['1.2.2', '>=1.2.3', false],
    ['1.2.2', '<1.2.3', true],
    ['1.2.3', '<1.2.3', false],
    ['1.2.4', '<1.2.3', false],
    ['1.2.4', '>1.2.3', true],
    ['1.2.3', '>1.2.3', false],
    ['1.2.2', '>1.2.3', false],
    ['1.10.0', '>1.9.0', true],
    ['1.9.0', '<1.10.0', true],
    ['2', '>=1.9.9', true],
    ['1.2', '<=1.2.0', true],
    ['1.2.0', '<=1.2', true],
    ['1.2.0-rc.1', '<=1.2.0', true],
    ['1.2.0-rc.1', '<1.2.0', false],
    ['v1.0.0', '<= v1.0.0', true],
    ['1.0.0', '<=x.y.z', false],
    ['0.0.1', '>=x.y.z', true],
  ])('compares %s against %s -> %s', (version, range, expected) => {
    expect(affectedBy(version, [range])).toBe(expected);
  });

  it('evaluates multiple candidates with any-match semantics', () => {
    expect(affectedBy('1.5.0', ['<1.0.0', '>=1.5.0'])).toBe(true);
    expect(affectedBy('1.5.0', ['<1.0.0', '>=2.0.0'])).toBe(false);
  });

  it('treats malformed affected_versions_json as no affected versions', () => {
    expect(affectedBy('1.0.0', '{not json')).toBe(false);
    expect(affectedBy('1.0.0', '"1.0.0"')).toBe(false);
    expect(affectedBy('1.0.0', '{"0":"1.0.0"}')).toBe(false);
    expect(affectedBy('1.0.0', '[1, null, "1.0.0"]')).toBe(true);
    expect(affectedBy('1.0.0', '[1, null]')).toBe(false);
  });
});
