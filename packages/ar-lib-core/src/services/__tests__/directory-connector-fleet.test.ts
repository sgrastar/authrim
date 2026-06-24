import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, ExecuteResult, HealthStatus, TransactionContext } from '../../db';
import {
  acknowledgeDirectoryConnectorEpisode,
  listDirectoryConnectorEpisodes,
  listDirectoryConnectorInstances,
  markDirectoryConnectorInstanceStatus,
  reactivateDirectoryConnectorInstance,
  recordDirectoryConnectorHeartbeat,
} from '../directory-connector-fleet';

function executeResult(rowsAffected = 1): ExecuteResult {
  return { rowsAffected, success: true };
}

function createAdapter(): DatabaseAdapter {
  return {
    query: vi.fn(async () => []),
    queryOne: vi.fn(async () => null),
    execute: vi.fn(async () => executeResult()),
    transaction: vi.fn(async (fn: (tx: TransactionContext) => Promise<unknown>) =>
      fn({
        query: vi.fn(async () => []),
        queryOne: vi.fn(async () => null),
        execute: vi.fn(async () => executeResult()),
      })
    ),
    batch: vi.fn(async () => []),
    isHealthy: vi.fn(async (): Promise<HealthStatus> => ({
      healthy: true,
      latencyMs: 1,
      type: 'mock',
    })),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(async () => undefined),
  };
}

describe('directory connector fleet service', () => {
  it('records a heartbeat and creates an open status episode', async () => {
    const adapter = createAdapter();

    const result = await recordDirectoryConnectorHeartbeat(adapter, {
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      instanceId: 'wwi_1234567890123456789012',
      transport: 'relay',
      version: '0.13.0',
      startedAt: '2026-06-24T00:00:00.000Z',
      healthStatus: 'healthy',
      healthSummary: { ldap: 'ok' },
      configFingerprint: 'sha256:abc',
      configCategories: ['ldap', 'profile'],
      now: 1000,
    });

    expect(result).toEqual({ accepted: true, status: 'connected' });
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_connector_instances'),
      expect.arrayContaining([
        'tenant-a',
        'wwcon_8K4M2Q9F7D3H6P1X',
        'wwi_1234567890123456789012',
        null,
        'relay',
        '0.13.0',
      ])
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_connector_status_episodes'),
      expect.arrayContaining(['tenant-a', 'wwcon_8K4M2Q9F7D3H6P1X', 'wwi_1234567890123456789012', 'connected'])
    );
  });

  it('rejects heartbeat from a deactivated instance without updating inventory', async () => {
    const adapter = createAdapter();
    vi.mocked(adapter.queryOne).mockResolvedValueOnce({
      id: 'dcinst_1',
      tenant_id: 'tenant-a',
      connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
      instance_id: 'wwi_1234567890123456789012',
      display_name: null,
      transport: 'relay',
      version: '0.13.0',
      started_at: '2026-06-24T00:00:00.000Z',
      first_seen_at: 1,
      last_seen_at: 1,
      status: 'deactivated',
      health_status: 'healthy',
      health_summary_json: '{}',
      config_fingerprint: 'sha256:abc',
      config_categories_json: '[]',
      drift_severity: 'none',
      deactivated_at: 900,
      deactivated_by: 'admin-1',
      deactivation_reason: 'security',
      updated_at: 900,
    });

    const result = await recordDirectoryConnectorHeartbeat(adapter, {
      tenantId: 'tenant-a',
      connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
      instanceId: 'wwi_1234567890123456789012',
      transport: 'relay',
      version: '0.13.0',
      startedAt: '2026-06-24T00:00:00.000Z',
      healthStatus: 'healthy',
      configFingerprint: 'sha256:abc',
      now: 1000,
    });

    expect(result).toEqual({
      accepted: false,
      status: 'deactivated',
      reason: 'instance_deactivated',
    });
    expect(adapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO directory_connector_instances'),
      expect.anything()
    );
  });

  it('updates administrative fleet state with rowsAffected guards', async () => {
    const adapter = createAdapter();

    await expect(
      markDirectoryConnectorInstanceStatus(adapter, {
        tenantId: 'tenant-a',
        connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
        instanceId: 'wwi_1234567890123456789012',
        status: 'deactivated',
        actorId: 'admin-1',
        reason: 'security',
        now: 1000,
      })
    ).resolves.toBe(true);

    vi.mocked(adapter.execute).mockResolvedValueOnce(executeResult(0));
    await expect(
      reactivateDirectoryConnectorInstance(adapter, {
        tenantId: 'tenant-a',
        connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
        instanceId: 'missing',
        actorId: 'admin-1',
        now: 1000,
      })
    ).resolves.toBe(false);

    vi.mocked(adapter.execute).mockResolvedValueOnce(executeResult(1));
    await expect(
      acknowledgeDirectoryConnectorEpisode(adapter, {
        tenantId: 'tenant-a',
        connectorId: 'wwcon_8K4M2Q9F7D3H6P1X',
        instanceId: 'wwi_1234567890123456789012',
        actorId: 'admin-1',
        now: 1000,
      })
    ).resolves.toBe(true);
  });

  it('lists fleet inventory and episodes with tenant scoped filters', async () => {
    const adapter = createAdapter();
    await listDirectoryConnectorInstances(adapter, 'tenant-a', 'wwcon_8K4M2Q9F7D3H6P1X');
    await listDirectoryConnectorEpisodes(adapter, 'tenant-a', 'wwcon_8K4M2Q9F7D3H6P1X', {
      limit: 14,
      retentionDays: 7,
      now: 8 * 24 * 60 * 60 * 1000,
    });

    expect(adapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM directory_connector_instances'),
      ['tenant-a', 'wwcon_8K4M2Q9F7D3H6P1X']
    );
    expect(adapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM directory_connector_status_episodes'),
      ['tenant-a', 'wwcon_8K4M2Q9F7D3H6P1X', 24 * 60 * 60 * 1000, 14]
    );
  });
});
