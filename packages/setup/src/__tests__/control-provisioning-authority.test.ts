import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  isTokenlessPendingControlProvisioningAuthority,
  readControlProvisioningAuthority,
  writeControlProvisioningAuthority,
} from '../core/control-provisioning-authority.js';

const ROOT_DIR = fileURLToPath(new URL('../../../../', import.meta.url));

describe('Control provisioning authority setup projection', () => {
  it('allows pending cancellation only before any child-token ownership is recorded', () => {
    const base = {
      environmentId: 'test',
      capabilityCheckedAt: null,
      updatedAt: 123,
    };
    expect(
      isTokenlessPendingControlProvisioningAuthority({
        ...base,
        automaticProvisioningEnabled: true,
        tokenOwnership: 'none',
        capabilityState: 'pending',
      })
    ).toBe(true);
    for (const authority of [
      null,
      {
        ...base,
        automaticProvisioningEnabled: false,
        tokenOwnership: 'none' as const,
        capabilityState: 'disabled' as const,
      },
      {
        ...base,
        automaticProvisioningEnabled: true,
        tokenOwnership: 'user' as const,
        capabilityState: 'ready' as const,
      },
      {
        ...base,
        automaticProvisioningEnabled: true,
        tokenOwnership: 'account' as const,
        capabilityState: 'blocked' as const,
      },
    ]) {
      expect(isTokenlessPendingControlProvisioningAuthority(authority)).toBe(false);
    }
  });

  it('writes and reflects Automatic provisioning ready state without token material', async () => {
    const execute = vi.fn(async () => ({ success: true, stdout: '' }));
    const query = vi.fn(async () => [
      {
        environment_id: 'test',
        automatic_provisioning_enabled: 1,
        provisioning_token_ownership: 'account' as const,
        provisioning_capability_state: 'ready' as const,
        provisioning_capability_checked_at: 123,
        updated_at: 123,
      },
    ]);
    await expect(
      writeControlProvisioningAuthority({
        controlDatabaseName: 'test-authrim-control-db',
        environmentId: 'test',
        automaticProvisioningEnabled: true,
        tokenOwnership: 'account',
        capabilityState: 'ready',
        now: 123,
        execute,
        query,
      })
    ).resolves.toMatchObject({ capabilityState: 'ready', tokenOwnership: 'account' });
    const sql = execute.mock.calls[0]?.[1] ?? '';
    expect(sql).toContain('UPDATE control_environments');
    expect(sql).not.toContain('control_environment_provisioning_authority');
    expect(sql).not.toMatch(/token[_ ]?value|bearer|secret/iu);
  });

  it('records OFF only as disabled with no token ownership', async () => {
    const execute = vi.fn(async () => ({ success: true, stdout: '' }));
    const query = vi.fn(async () => [
      {
        environment_id: 'test',
        automatic_provisioning_enabled: 0,
        provisioning_token_ownership: 'none' as const,
        provisioning_capability_state: 'disabled' as const,
        provisioning_capability_checked_at: 123,
        updated_at: 123,
      },
    ]);
    await expect(
      writeControlProvisioningAuthority({
        controlDatabaseName: 'test-authrim-control-db',
        environmentId: 'test',
        automaticProvisioningEnabled: false,
        tokenOwnership: 'none',
        capabilityState: 'disabled',
        now: 123,
        execute,
        query,
      })
    ).resolves.toMatchObject({ automaticProvisioningEnabled: false });
    await expect(
      writeControlProvisioningAuthority({
        controlDatabaseName: 'test-authrim-control-db',
        environmentId: 'test',
        automaticProvisioningEnabled: false,
        tokenOwnership: 'user',
        capabilityState: 'disabled',
        execute,
        query,
      })
    ).rejects.toThrow('control_provisioning_authority_state_invalid');
  });

  it('keeps pending authority tokenless until child secrets are registered', async () => {
    const execute = vi.fn(async () => ({ success: true, stdout: '' }));
    const query = vi.fn(async () => [
      {
        environment_id: 'test',
        automatic_provisioning_enabled: 1,
        provisioning_token_ownership: 'none' as const,
        provisioning_capability_state: 'pending' as const,
        provisioning_capability_checked_at: null,
        updated_at: 123,
      },
    ]);
    await expect(
      writeControlProvisioningAuthority({
        controlDatabaseName: 'test-authrim-control-db',
        environmentId: 'test',
        automaticProvisioningEnabled: true,
        tokenOwnership: 'none',
        capabilityState: 'pending',
        now: 123,
        execute,
        query,
      })
    ).resolves.toMatchObject({ tokenOwnership: 'none', capabilityState: 'pending' });
    await expect(
      writeControlProvisioningAuthority({
        controlDatabaseName: 'test-authrim-control-db',
        environmentId: 'test',
        automaticProvisioningEnabled: true,
        tokenOwnership: 'user',
        capabilityState: 'pending',
        execute,
        query,
      })
    ).rejects.toThrow('control_provisioning_authority_state_invalid');
  });

  it('returns null when no environment authority exists', async () => {
    await expect(
      readControlProvisioningAuthority({
        controlDatabaseName: 'test-authrim-control-db',
        environmentId: 'test',
        query: vi.fn(async () => []),
      })
    ).resolves.toBeNull();
  });

  it('reads and updates the authoritative control_environments schema', async () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(
        readFileSync(
          resolve(ROOT_DIR, 'migrations/control/001_pre_1_0_control_baseline.sql'),
          'utf8'
        )
      );
      database.exec(`
        INSERT INTO control_environments (
          environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
        ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1)
      `);
      const execute = async (_databaseName: string, sql: string) => {
        database.exec(sql);
        return { success: true, stdout: '' };
      };
      const query = async <T extends Record<string, unknown>>(_databaseName: string, sql: string) =>
        database.prepare(sql).all() as T[];

      await expect(
        writeControlProvisioningAuthority({
          controlDatabaseName: 'control-db',
          environmentId: 'test',
          automaticProvisioningEnabled: true,
          tokenOwnership: 'none',
          capabilityState: 'pending',
          now: 100,
          execute,
          query,
        })
      ).resolves.toMatchObject({ capabilityState: 'pending', tokenOwnership: 'none' });
      await expect(
        writeControlProvisioningAuthority({
          controlDatabaseName: 'control-db',
          environmentId: 'test',
          automaticProvisioningEnabled: true,
          tokenOwnership: 'account',
          capabilityState: 'ready',
          now: 101,
          execute,
          query,
        })
      ).resolves.toMatchObject({
        capabilityState: 'ready',
        tokenOwnership: 'account',
        capabilityCheckedAt: 101,
      });
      await expect(
        readControlProvisioningAuthority({
          controlDatabaseName: 'control-db',
          environmentId: 'test',
          query,
        })
      ).resolves.toMatchObject({ automaticProvisioningEnabled: true });
    } finally {
      database.close();
    }
  });
});
