import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  ADMIN_PERMISSIONS,
  adminAuthMiddleware,
  type AdminAuthContext,
} from '@authrim/ar-lib-core';
import {
  agentBaselinesRouter,
  agentTemplatesRouter,
} from '../routes/admin-management/agent-baselines';

const adapter = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  batch: vi.fn(),
  transaction: vi.fn(),
};

const reader = vi.hoisted(() => ({ readCurrent: vi.fn() }));
const settings = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@authrim/ar-agent-access/platform/cloudflare/tenant-configuration-reader', () => ({
  CloudflareTenantConfigurationReader: class {
    readCurrent = reader.readCurrent;
  },
}));

vi.mock('@authrim/ar-agent-access/platform/cloudflare/tenant-settings', () => ({
  CloudflareAgentSettingsProvider: class {
    get = settings.get;
  },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    adminAuthMiddleware:
      () =>
      async (c: { set: (name: string, value: unknown) => void }, next: () => Promise<void>) => {
        c.set('adminAuth', authContext);
        await next();
      },
    requireDedicatedAdminDatabaseAdapter: () => adapter,
  };
});

let authContext: AdminAuthContext;

function app() {
  const result = new Hono();
  result.route('/api/admin/agent-templates', agentTemplatesRouter as never);
  result.route('/api/admin/agent-baselines', agentBaselinesRouter as never);
  return result;
}

function request(path: string, method = 'GET', value?: unknown) {
  return app().request(
    path,
    {
      method,
      headers: value ? { 'content-type': 'application/json' } : undefined,
      body: value ? JSON.stringify(value) : undefined,
    },
    {
      DEFAULT_TENANT_ID: 'control',
      ENABLE_AGENT_MCP: 'true',
    } as never
  );
}

function configurationProfile() {
  return {
    schemaVersion: 'authrim-agent-plan-v1',
    goal: 'Apply an approved Authrim configuration change',
    steps: [
      {
        id: 'client-metadata',
        operation: 'admin.write.clients.metadata',
        toolContractVersion: '1',
        input: {
          client_id: 'client-1',
          client_name: 'Configured client',
        },
        resourcePrecondition: 'per-tenant-validation',
      },
    ],
  };
}

describe('Agent template and baseline control plane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authContext = {
      userId: 'platform-admin',
      authMethod: 'session',
      roles: [],
      tenantId: 'control',
      tenantScope: ['*'],
      permissions: [
        ADMIN_PERMISSIONS.AGENT_TEMPLATES_PUBLISH,
        ADMIN_PERMISSIONS.AGENT_BASELINES_READ,
        ADMIN_PERMISSIONS.AGENT_BASELINES_WRITE,
        ADMIN_PERMISSIONS.AGENT_BASELINES_APPLY,
        ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
      ],
      hierarchyLevel: 100,
      mfaVerified: true,
      authenticationTimeMs: Date.now(),
    };
    adapter.query.mockResolvedValue([]);
    adapter.queryOne.mockResolvedValue(null);
    adapter.batch.mockResolvedValue([{ rowsAffected: 1 }, { rowsAffected: 1 }]);
    reader.readCurrent.mockResolvedValue({ client_name: 'Changed client' });
    settings.get.mockResolvedValue({ bulkCanaryProtected: false });
  });

  it('creates a managed report-only baseline with an atomic audit batch', async () => {
    const response = await request('/api/admin/agent-baselines', 'POST', {
      name: 'OIDC baseline',
      mode: 'managed',
      enforcement: 'report_only',
      definition: {
        schemaVersion: 'authrim-agent-baseline-v1',
        taskSet: { id: 'task-set', version: 1, digest: 'x'.repeat(32) },
        configurationProfile: configurationProfile(),
      },
    });
    expect(response.status).toBe(201);
    expect(adapter.batch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ sql: expect.stringContaining('INSERT INTO agent_baselines') }),
        expect.objectContaining({ sql: expect.stringContaining('INSERT INTO admin_audit_log') }),
      ])
    );
  });

  it('rejects a one-time baseline that requests auto-remediation', async () => {
    const response = await request('/api/admin/agent-baselines', 'POST', {
      name: 'Unsafe baseline',
      mode: 'one_time',
      enforcement: 'standard_auto_remediation',
      definition: {
        schemaVersion: 'authrim-agent-baseline-v1',
        taskSet: { id: 'task-set', version: 1, digest: 'x'.repeat(32) },
        configurationProfile: configurationProfile(),
      },
    });
    expect(response.status).toBe(400);
    expect(adapter.batch).not.toHaveBeenCalled();
  });

  it('requires fresh MFA to opt in to managed standard auto-remediation', async () => {
    authContext = { ...authContext, mfaVerified: false };
    const response = await request('/api/admin/agent-baselines', 'POST', {
      name: 'Managed baseline',
      mode: 'managed',
      enforcement: 'standard_auto_remediation',
      definition: {
        schemaVersion: 'authrim-agent-baseline-v1',
        taskSet: { id: 'task-set', version: 1, digest: 'x'.repeat(32) },
        configurationProfile: configurationProfile(),
      },
    });
    expect(response.status).toBe(403);
    expect(adapter.batch).not.toHaveBeenCalled();
  });

  it('requires fresh MFA before approving a managed exception', async () => {
    authContext = { ...authContext, mfaVerified: false };
    const response = await request(
      '/api/admin/agent-baselines/assignments/assignment-1/exceptions',
      'POST',
      {
        fields: ['client.redirect_uris'],
        reason: 'Temporary exception',
        expires_at: Date.now() + 60_000,
      }
    );
    expect(response.status).toBe(403);
    expect(adapter.batch).not.toHaveBeenCalled();
  });

  it('rejects a managed exception outside the administrator tenant scope', async () => {
    authContext = { ...authContext, tenantScope: ['tenant-allowed'] };
    adapter.queryOne.mockResolvedValue({
      assignment_id: 'assignment-1',
      baseline_id: 'baseline-1',
      baseline_version: 1,
      tenant_id: 'tenant-other',
      source_bulk_plan_id: 'bulk-1',
      source_bulk_plan_version: 1,
      assigned_by: 'platform-admin',
      assigned_at: 1,
      last_evaluated_at: null,
      drift_status: 'drifted',
      drift_digest: 'drift-1',
      control_tenant_id: 'control',
      baseline_name: 'Client baseline',
      baseline_mode: 'managed',
      baseline_enforcement: 'report_only',
      definition_json: JSON.stringify({
        schemaVersion: 'authrim-agent-baseline-v1',
        taskSet: { id: 'task-set', version: 1, digest: 'x'.repeat(32) },
        configurationProfile: configurationProfile(),
      }),
      definition_digest: 'baseline-definition-digest',
      baseline_status: 'active',
      baseline_created_by: 'platform-admin',
      baseline_created_at: 1,
    });
    const response = await request(
      '/api/admin/agent-baselines/assignments/assignment-1/exceptions',
      'POST',
      {
        fields: ['client-metadata.client_name'],
        reason: 'Temporary exception',
        expires_at: Date.now() + 60_000,
      }
    );
    expect(response.status).toBe(403);
    expect(adapter.batch).not.toHaveBeenCalled();
  });

  it('does not treat a platform role name as template publish authorization', async () => {
    authContext = { ...authContext, roles: ['platform_admin'], permissions: [] };
    const response = await request('/api/admin/agent-templates');
    expect(response.status).toBe(403);
  });

  it('evaluates drift from a trusted platform read and ignores a caller digest', async () => {
    adapter.queryOne.mockResolvedValue({
      assignment_id: 'assignment-1',
      baseline_id: 'baseline-1',
      baseline_version: 1,
      tenant_id: 'tenant-1',
      source_bulk_plan_id: 'bulk-1',
      source_bulk_plan_version: 1,
      assigned_by: 'platform-admin',
      assigned_at: 1,
      last_evaluated_at: null,
      drift_status: 'unknown',
      drift_digest: null,
      control_tenant_id: 'control',
      baseline_name: 'Client baseline',
      baseline_mode: 'managed',
      baseline_enforcement: 'report_only',
      definition_json: JSON.stringify({
        schemaVersion: 'authrim-agent-baseline-v1',
        taskSet: { id: 'task-set', version: 1, digest: 'x'.repeat(32) },
        configurationProfile: configurationProfile(),
      }),
      definition_digest: 'baseline-definition-digest',
      baseline_status: 'active',
      baseline_created_by: 'platform-admin',
      baseline_created_at: 1,
    });
    const response = await request(
      '/api/admin/agent-baselines/assignments/assignment-1/evaluate',
      'POST',
      { current_digest: 'attacker-controlled' }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      drift_status: 'drifted',
      drift_fields: ['client-metadata.client_name'],
    });
    expect(reader.readCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1' })
    );
    expect(JSON.stringify(adapter.batch.mock.calls)).not.toContain('attacker-controlled');
  });

  it('queues one remediation Bulk Plan for an opted-in managed drift digest', async () => {
    adapter.queryOne.mockResolvedValue({
      assignment_id: 'assignment-1',
      baseline_id: 'baseline-1',
      baseline_version: 1,
      tenant_id: 'tenant-1',
      source_bulk_plan_id: 'bulk-1',
      source_bulk_plan_version: 1,
      assigned_by: 'platform-admin',
      assigned_at: 1,
      last_evaluated_at: null,
      drift_status: 'unknown',
      drift_digest: null,
      remediation_bulk_plan_id: null,
      remediation_bulk_plan_version: null,
      remediation_drift_digest: null,
      remediation_requested_at: null,
      control_tenant_id: 'control',
      baseline_name: 'Client baseline',
      baseline_mode: 'managed',
      baseline_enforcement: 'standard_auto_remediation',
      definition_json: JSON.stringify({
        schemaVersion: 'authrim-agent-baseline-v1',
        taskSet: { id: 'task-set', version: 1, digest: 'x'.repeat(32) },
        configurationProfile: configurationProfile(),
      }),
      definition_digest: 'baseline-definition-digest',
      baseline_status: 'active',
      baseline_created_by: 'platform-admin',
      baseline_created_at: 1,
    });
    const response = await request(
      '/api/admin/agent-baselines/assignments/assignment-1/evaluate',
      'POST'
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      drift_status: 'drifted',
      remediation: {
        status: 'queued',
        bulk_plan_id: expect.stringMatching(/^abp_baseline_/u),
      },
    });
    expect(JSON.stringify(adapter.batch.mock.calls)).toContain(
      'agent.baseline.remediation_requested'
    );
  });
});
