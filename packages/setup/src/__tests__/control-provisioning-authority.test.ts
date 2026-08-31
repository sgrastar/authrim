import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type {
  ControlTokenBootstrapPreparedResult,
  ControlTokenBootstrapResult,
} from '../core/cloudflare-control-token-bootstrap.js';
import {
  isTokenlessPendingControlProvisioningAuthority,
  readControlProvisioningAuthority,
  writeControlProvisioningAuthority,
} from '../core/control-provisioning-authority.js';
import { completeControlTokenBootstrap } from '../core/control-token-bootstrap-orchestrator.js';
import type { PendingControlBootstrapArtifact } from '../core/pending-control-bootstrap.js';

const ROOT_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const CHILD_TOKENS = [
  {
    resourceClass: 'd1' as const,
    tokenId: '1'.repeat(32),
    tokenName: 'authrim-test-control-d1',
    secretName: 'CLOUDFLARE_D1_API_TOKEN',
    tokenFingerprint: 'a'.repeat(64),
  },
  {
    resourceClass: 'workers' as const,
    tokenId: '2'.repeat(32),
    tokenName: 'authrim-test-control-workers',
    secretName: 'CLOUDFLARE_WORKERS_API_TOKEN',
    tokenFingerprint: 'b'.repeat(64),
  },
] as const;
const SECRET_GENERATION = {
  deploymentId: 'deployment:test-123',
  versionId: 'version:test-456',
} as const;
const CONTROL_MIGRATIONS = [
  '001_pre_1_0_control_baseline.sql',
  '002_lookup_predictive_scale_out.sql',
  '003_worker_binding_patch_intent_recovery.sql',
  '004_worker_binding_reconciler_lease.sql',
  '005_account_predictive_scale_out.sql',
  '006_account_spare_assignment_threshold.sql',
  '007_control_token_bootstrap_cutover.sql',
  '008_control_provisioning_secret_generation.sql',
] as const;

function applyControlMigrations(database: DatabaseSync, count: number): void {
  for (const filename of CONTROL_MIGRATIONS.slice(0, count)) {
    database.exec(readFileSync(resolve(ROOT_DIR, 'migrations/control', filename), 'utf8'));
  }
}

describe('Control provisioning authority setup projection', () => {
  it('allows pending cancellation only before any child-token ownership is recorded', () => {
    const base = {
      environmentId: 'test',
      capabilityCheckedAt: null,
      tokenManagement: 'none' as const,
      bootstrapPhase: 'none' as const,
      bootstrapTokenOwnership: 'none' as const,
      bootstrapTokenId: null,
      bootstrapTokenFingerprint: null,
      childTokens: [],
      secretGeneration: null,
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
      {
        ...base,
        automaticProvisioningEnabled: true,
        tokenOwnership: 'none' as const,
        tokenManagement: 'setup' as const,
        capabilityState: 'pending' as const,
      },
      {
        ...base,
        automaticProvisioningEnabled: true,
        tokenOwnership: 'none' as const,
        capabilityState: 'pending' as const,
        tokenManagement: 'setup' as const,
        bootstrapPhase: 'pending_revocation' as const,
        bootstrapTokenOwnership: 'account' as const,
        bootstrapTokenId: '1'.repeat(32),
        bootstrapTokenFingerprint: '2'.repeat(64),
        childTokens: [],
      },
    ]) {
      expect(isTokenlessPendingControlProvisioningAuthority(authority)).toBe(false);
    }
  });

  it('writes and reflects ready ownership evidence without raw token material', async () => {
    const execute = vi.fn(async () => ({ success: true, stdout: '' }));
    const query = vi.fn(async () => [
      {
        environment_id: 'test',
        automatic_provisioning_enabled: 1,
        provisioning_token_ownership: 'account' as const,
        provisioning_token_management: 'setup' as const,
        provisioning_capability_state: 'ready' as const,
        provisioning_capability_checked_at: 123,
        provisioning_bootstrap_phase: 'none' as const,
        provisioning_bootstrap_token_ownership: 'none' as const,
        provisioning_bootstrap_token_id: null,
        provisioning_bootstrap_token_fingerprint: null,
        provisioning_child_tokens_json: JSON.stringify(CHILD_TOKENS),
        provisioning_secret_generation_deployment_id: SECRET_GENERATION.deploymentId,
        provisioning_secret_generation_version_id: SECRET_GENERATION.versionId,
        updated_at: 123,
      },
    ]);
    await expect(
      writeControlProvisioningAuthority({
        controlDatabaseName: 'test-authrim-control-db',
        environmentId: 'test',
        automaticProvisioningEnabled: true,
        tokenOwnership: 'account',
        tokenManagement: 'setup',
        capabilityState: 'ready',
        childTokens: CHILD_TOKENS,
        secretGeneration: SECRET_GENERATION,
        now: 123,
        execute,
        query,
      })
    ).resolves.toMatchObject({
      capabilityState: 'ready',
      tokenOwnership: 'account',
      tokenManagement: 'setup',
      childTokens: CHILD_TOKENS,
      secretGeneration: SECRET_GENERATION,
    });
    const sql = execute.mock.calls[0]?.[1] ?? '';
    expect(sql).toContain('UPDATE control_environments');
    expect(sql).not.toContain('control_environment_provisioning_authority');
    expect(sql).not.toMatch(/token[_ ]?value|bearer|private[_ ]?key/iu);
  });

  it('rejects child-token labels or secret bindings that do not match their resource class', async () => {
    const base = {
      controlDatabaseName: 'test-authrim-control-db',
      environmentId: 'test',
      automaticProvisioningEnabled: true,
      tokenOwnership: 'account' as const,
      tokenManagement: 'setup' as const,
      capabilityState: 'ready' as const,
      secretGeneration: SECRET_GENERATION,
    };
    await expect(
      writeControlProvisioningAuthority({
        ...base,
        childTokens: [
          { ...CHILD_TOKENS[0], secretName: 'CLOUDFLARE_WORKERS_API_TOKEN' },
          CHILD_TOKENS[1],
        ],
      })
    ).rejects.toThrow('control_provisioning_authority_bootstrap_metadata_invalid');
    await expect(
      writeControlProvisioningAuthority({
        ...base,
        childTokens: [{ ...CHILD_TOKENS[0], tokenName: 'invalid name' }, CHILD_TOKENS[1]],
      })
    ).rejects.toThrow('control_provisioning_authority_bootstrap_metadata_invalid');
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

  it('reads the legacy authority projection before the cutover migration is applied', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('no such column: provisioning_bootstrap_phase'))
      .mockRejectedValueOnce(new Error('no such column: provisioning_bootstrap_phase'))
      .mockResolvedValueOnce([
        {
          environment_id: 'test',
          automatic_provisioning_enabled: 1,
          provisioning_token_ownership: 'account',
          provisioning_capability_state: 'ready',
          provisioning_capability_checked_at: 100,
          updated_at: 100,
        },
      ]);
    await expect(
      readControlProvisioningAuthority({
        controlDatabaseName: 'test-authrim-control-db',
        environmentId: 'test',
        query,
      })
    ).resolves.toMatchObject({
      capabilityState: 'ready',
      bootstrapPhase: 'none',
      bootstrapTokenOwnership: 'none',
      childTokens: [],
      secretGeneration: null,
    });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('falls back from 008 to 007 without losing an in-progress bootstrap phase', async () => {
    const legacyChildTokens = CHILD_TOKENS.map(
      ({ tokenFingerprint: _fingerprint, ...token }) => token
    );
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('no such column: provisioning_token_management'))
      .mockResolvedValueOnce([
        {
          environment_id: 'test',
          automatic_provisioning_enabled: 1,
          provisioning_token_ownership: 'none',
          provisioning_capability_state: 'pending',
          provisioning_capability_checked_at: null,
          provisioning_bootstrap_phase: 'pending_revocation',
          provisioning_bootstrap_token_ownership: 'account',
          provisioning_bootstrap_token_id: 'f'.repeat(32),
          provisioning_bootstrap_token_fingerprint: 'e'.repeat(64),
          provisioning_child_tokens_json: JSON.stringify(legacyChildTokens),
          updated_at: 100,
        },
      ]);

    await expect(
      readControlProvisioningAuthority({
        controlDatabaseName: 'test-authrim-control-db',
        environmentId: 'test',
        query,
      })
    ).resolves.toMatchObject({
      capabilityState: 'pending',
      bootstrapPhase: 'pending_revocation',
      bootstrapTokenOwnership: 'account',
      childTokens: legacyChildTokens.map((token) => ({ ...token, tokenFingerprint: null })),
      secretGeneration: null,
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('normalizes 007 authority states that lack exact generation evidence for safe re-bootstrap', async () => {
    const database = new DatabaseSync(':memory:');
    const legacyChildTokens = CHILD_TOKENS.map(
      ({ tokenFingerprint: _fingerprint, ...token }) => token
    );
    const legacyChildTokensSql = JSON.stringify(legacyChildTokens).replaceAll("'", "''");
    try {
      applyControlMigrations(database, 7);
      for (const environmentId of [
        'disabled',
        'fresh-pending',
        'ready',
        'blocked',
        'pending-revocation',
        'cutover-verified',
      ]) {
        database.exec(`
          INSERT INTO control_environments (
            environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
          ) VALUES (
            '${environmentId}', '${environmentId}', 'urn:authrim:control:${environmentId}',
            'active', 1, 1
          )
        `);
      }
      database.exec(`
        UPDATE control_environments
           SET automatic_provisioning_enabled = 1,
               provisioning_capability_state = 'pending'
         WHERE environment_id = 'fresh-pending';
        UPDATE control_environments
           SET automatic_provisioning_enabled = 1,
               provisioning_token_ownership = 'account',
               provisioning_capability_state = 'ready'
         WHERE environment_id = 'ready';
        UPDATE control_environments
           SET automatic_provisioning_enabled = 1,
               provisioning_token_ownership = 'user',
               provisioning_capability_state = 'blocked'
         WHERE environment_id = 'blocked';
        UPDATE control_environments
           SET automatic_provisioning_enabled = 1,
               provisioning_capability_state = 'pending',
               provisioning_bootstrap_phase = 'pending_revocation',
               provisioning_bootstrap_token_ownership = 'account',
               provisioning_bootstrap_token_id = '${'f'.repeat(32)}',
               provisioning_bootstrap_token_fingerprint = '${'e'.repeat(64)}',
               provisioning_child_tokens_json = '${legacyChildTokensSql}'
         WHERE environment_id = 'pending-revocation';
        UPDATE control_environments
           SET automatic_provisioning_enabled = 1,
               provisioning_capability_state = 'pending',
               provisioning_bootstrap_phase = 'cutover_verified',
               provisioning_bootstrap_token_ownership = 'user',
               provisioning_bootstrap_token_id = '${'d'.repeat(32)}',
               provisioning_bootstrap_token_fingerprint = '${'c'.repeat(64)}',
               provisioning_child_tokens_json = '${legacyChildTokensSql}'
         WHERE environment_id = 'cutover-verified';
      `);

      database.exec(
        readFileSync(
          resolve(ROOT_DIR, 'migrations/control/008_control_provisioning_secret_generation.sql'),
          'utf8'
        )
      );

      const states = database
        .prepare(
          `SELECT environment_id, automatic_provisioning_enabled,
                  provisioning_token_ownership, provisioning_capability_state,
                  provisioning_bootstrap_phase, provisioning_bootstrap_token_ownership,
                  provisioning_bootstrap_token_id, provisioning_bootstrap_token_fingerprint,
                  provisioning_child_tokens_json, provisioning_token_management,
                  provisioning_secret_generation_deployment_id,
                  provisioning_secret_generation_version_id
             FROM control_environments
         ORDER BY environment_id`
        )
        .all();
      expect(states).toHaveLength(6);
      expect(
        states.every(
          (row) =>
            row.provisioning_token_management === 'none' &&
            row.provisioning_secret_generation_deployment_id === null &&
            row.provisioning_secret_generation_version_id === null
        )
      ).toBe(true);
      for (const environmentId of ['ready', 'blocked', 'pending-revocation', 'cutover-verified']) {
        expect(states.find((row) => row.environment_id === environmentId)).toMatchObject({
          automatic_provisioning_enabled: 1,
          provisioning_token_ownership: 'none',
          provisioning_capability_state: 'pending',
          provisioning_bootstrap_phase: 'none',
          provisioning_bootstrap_token_ownership: 'none',
          provisioning_bootstrap_token_id: null,
          provisioning_bootstrap_token_fingerprint: null,
          provisioning_child_tokens_json: null,
          provisioning_token_management: 'none',
          provisioning_secret_generation_deployment_id: null,
          provisioning_secret_generation_version_id: null,
        });
      }
      expect(states.find((row) => row.environment_id === 'fresh-pending')).toMatchObject({
        automatic_provisioning_enabled: 1,
        provisioning_token_ownership: 'none',
        provisioning_capability_state: 'pending',
        provisioning_bootstrap_phase: 'none',
      });
      expect(states.find((row) => row.environment_id === 'disabled')).toMatchObject({
        automatic_provisioning_enabled: 0,
        provisioning_token_ownership: 'none',
        provisioning_capability_state: 'disabled',
        provisioning_bootstrap_phase: 'none',
      });

      const query = async <T extends Record<string, unknown>>(_databaseName: string, sql: string) =>
        database.prepare(sql).all() as T[];
      await expect(
        readControlProvisioningAuthority({
          controlDatabaseName: 'control-db',
          environmentId: 'pending-revocation',
          query,
        })
      ).resolves.toMatchObject({
        capabilityState: 'pending',
        bootstrapPhase: 'none',
        tokenManagement: 'none',
        childTokens: [],
        secretGeneration: null,
      });

      expect(() =>
        database.exec(
          "UPDATE control_environments SET provisioning_token_ownership = 'account' WHERE environment_id = 'ready'"
        )
      ).toThrow('control_automatic_provisioning_authority_invalid');
      expect(() =>
        database.exec(`
          UPDATE control_environments
             SET provisioning_bootstrap_phase = 'pending_revocation',
                 provisioning_bootstrap_token_ownership = 'account',
                 provisioning_bootstrap_token_id = '${'f'.repeat(32)}',
                 provisioning_bootstrap_token_fingerprint = '${'e'.repeat(64)}',
                 provisioning_child_tokens_json = '${legacyChildTokensSql}'
           WHERE environment_id = 'fresh-pending'
        `)
      ).toThrow('control_automatic_provisioning_authority_invalid');
      expect(() =>
        database.exec(
          "UPDATE control_environments SET provisioning_secret_generation_deployment_id = '!invalid' WHERE environment_id = 'disabled'"
        )
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it('re-bootstraps a normalized 007 authority through the complete cutover without touching disabled environments', async () => {
    const database = new DatabaseSync(':memory:');
    const environmentId = 'legacy';
    const accountId = '0'.repeat(32);
    const bootstrapToken = 'legacy-authority-bootstrap-token';
    const legacyChildTokens = CHILD_TOKENS.map(
      ({ tokenFingerprint: _fingerprint, ...token }) => token
    );
    const newChildTokens = [
      {
        resourceClass: 'd1' as const,
        tokenId: '3'.repeat(32),
        tokenName: 'authrim-legacy-control-d1',
        secretName: 'CLOUDFLARE_D1_API_TOKEN',
        tokenFingerprint: '3'.repeat(64),
      },
      {
        resourceClass: 'workers' as const,
        tokenId: '4'.repeat(32),
        tokenName: 'authrim-legacy-control-workers',
        secretName: 'CLOUDFLARE_WORKERS_API_TOKEN',
        tokenFingerprint: '4'.repeat(64),
      },
    ] as const;
    const secretGeneration = {
      deploymentId: 'deployment:post-008',
      versionId: 'version:post-008',
    } as const;
    let pendingArtifact: PendingControlBootstrapArtifact | null = null;
    const artifactEvents: string[] = [];

    const query = async <T extends Record<string, unknown>>(
      _databaseName: string,
      sql: string
    ): Promise<T[]> => database.prepare(sql).all() as T[];
    const execute = async (_databaseName: string, sql: string) => {
      database.exec(sql);
      return { success: true, stdout: '' };
    };
    const readAuthority = vi.fn(
      async (input: { environmentId: string; controlDatabaseName: string }) =>
        readControlProvisioningAuthority({ ...input, query })
    );
    const writeAuthority = vi.fn(
      async (input: Parameters<typeof writeControlProvisioningAuthority>[0]) =>
        writeControlProvisioningAuthority({ ...input, now: 200, execute, query })
    );
    const stagePending = vi.fn(async (input: { artifact: PendingControlBootstrapArtifact }) => {
      artifactEvents.push('stage');
      pendingArtifact = structuredClone(input.artifact);
    });
    const loadPending = vi.fn(async () =>
      pendingArtifact === null ? null : structuredClone(pendingArtifact)
    );
    const markRevocationConfirmed = vi.fn(async () => {
      if (pendingArtifact === null) throw new Error('pending_control_bootstrap_missing');
      artifactEvents.push('mark');
      pendingArtifact = { ...pendingArtifact, revocationConfirmed: true };
      return structuredClone(pendingArtifact);
    });
    const clearPending = vi.fn(async () => {
      artifactEvents.push('clear');
      pendingArtifact = null;
    });
    const readActiveGeneration = vi.fn(async () => secretGeneration);
    const bootstrap = vi.fn(async (input: Record<string, unknown>) => {
      const prepared: ControlTokenBootstrapPreparedResult = {
        ownership: 'account',
        bootstrapTokenId: 'f'.repeat(32),
        bootstrapRevoked: false,
        childTokens: newChildTokens,
        secretGeneration,
      };
      const verifyControlSecretCutover = input.verifyControlSecretCutover as (
        result: ControlTokenBootstrapPreparedResult
      ) => Promise<boolean>;
      const beforeBootstrapRevocation = input.beforeBootstrapRevocation as (
        result: ControlTokenBootstrapPreparedResult
      ) => Promise<void>;
      const afterBootstrapRevocation = input.afterBootstrapRevocation as (
        result: ControlTokenBootstrapResult
      ) => Promise<void>;

      await expect(verifyControlSecretCutover(prepared)).resolves.toBe(true);
      await beforeBootstrapRevocation(prepared);
      expect(pendingArtifact).toMatchObject({
        environment: environmentId,
        childTokens: newChildTokens,
        secretGeneration,
        revocationConfirmed: false,
      });
      const result: ControlTokenBootstrapResult = {
        ...prepared,
        bootstrapRevoked: true,
      };
      await afterBootstrapRevocation(result);
      expect(pendingArtifact).toMatchObject({ revocationConfirmed: true });
      return result;
    });

    try {
      applyControlMigrations(database, 7);
      for (const id of [environmentId, 'disabled']) {
        database.exec(`
          INSERT INTO control_environments (
            environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
          ) VALUES (
            '${id}', '${id}', 'urn:authrim:control:${id}', 'active', 1, 1
          )
        `);
      }
      const legacyChildTokensSql = JSON.stringify(legacyChildTokens).replaceAll("'", "''");
      database.exec(`
        UPDATE control_environments
           SET automatic_provisioning_enabled = 1,
               provisioning_capability_state = 'pending',
               provisioning_bootstrap_phase = 'pending_revocation',
               provisioning_bootstrap_token_ownership = 'account',
               provisioning_bootstrap_token_id = '${'e'.repeat(32)}',
               provisioning_bootstrap_token_fingerprint = '${'d'.repeat(64)}',
               provisioning_child_tokens_json = '${legacyChildTokensSql}'
         WHERE environment_id = '${environmentId}'
      `);

      database.exec(
        readFileSync(
          resolve(ROOT_DIR, 'migrations/control/008_control_provisioning_secret_generation.sql'),
          'utf8'
        )
      );

      await expect(
        readControlProvisioningAuthority({
          controlDatabaseName: 'control-db',
          environmentId,
          query,
        })
      ).resolves.toMatchObject({
        automaticProvisioningEnabled: true,
        tokenOwnership: 'none',
        tokenManagement: 'none',
        capabilityState: 'pending',
        bootstrapPhase: 'none',
        childTokens: [],
        secretGeneration: null,
      });
      const disabledBeforeBootstrap = await readControlProvisioningAuthority({
        controlDatabaseName: 'control-db',
        environmentId: 'disabled',
        query,
      });

      await expect(
        completeControlTokenBootstrap({
          accountId,
          environment: environmentId,
          rootDir: '/tmp/authrim-test',
          controlDatabaseName: 'control-db',
          bootstrapToken,
          ownership: 'account',
          resourceClasses: ['d1', 'workers'],
          dependencies: {
            authority: {} as never,
            secretSink: {
              putGeneration: vi.fn(async () => secretGeneration),
              listNames: vi.fn(async () => [
                'CLOUDFLARE_D1_API_TOKEN',
                'CLOUDFLARE_WORKERS_API_TOKEN',
              ]),
              has: vi.fn(async () => true),
              delete: vi.fn(async () => undefined),
              readActiveGeneration,
            },
            bootstrap: bootstrap as never,
            readAuthority: readAuthority as never,
            writeAuthority: writeAuthority as never,
            stagePending: stagePending as never,
            loadPending: loadPending as never,
            markRevocationConfirmed: markRevocationConfirmed as never,
            clearPending: clearPending as never,
          },
        })
      ).resolves.toBeUndefined();

      const ready = await readControlProvisioningAuthority({
        controlDatabaseName: 'control-db',
        environmentId,
        query,
      });
      expect(ready).toMatchObject({
        automaticProvisioningEnabled: true,
        tokenOwnership: 'account',
        tokenManagement: 'setup',
        capabilityState: 'ready',
        capabilityCheckedAt: 200,
        bootstrapPhase: 'none',
        bootstrapTokenOwnership: 'none',
        bootstrapTokenId: null,
        bootstrapTokenFingerprint: null,
        childTokens: newChildTokens,
        secretGeneration,
        updatedAt: 200,
      });
      expect(ready?.childTokens.map((token) => token.tokenId)).toEqual([
        '3'.repeat(32),
        '4'.repeat(32),
      ]);
      expect(ready?.childTokens.map((token) => token.tokenId)).not.toEqual(
        legacyChildTokens.map((token) => token.tokenId)
      );
      expect(readActiveGeneration).toHaveBeenCalled();
      expect(artifactEvents).toEqual(['stage', 'mark', 'clear']);
      expect(pendingArtifact).toBeNull();
      expect(clearPending).toHaveBeenCalledOnce();
      expect(bootstrap).toHaveBeenCalledOnce();
      expect(bootstrap.mock.calls[0]?.[0]).toMatchObject({ environment: environmentId });
      expect(bootstrap.mock.calls.some(([input]) => input.environment === 'disabled')).toBe(false);
      await expect(
        readControlProvisioningAuthority({
          controlDatabaseName: 'control-db',
          environmentId: 'disabled',
          query,
        })
      ).resolves.toEqual(disabledBeforeBootstrap);
    } finally {
      database.close();
    }
  });

  it('rejects reflected receipt or child-fingerprint drift', async () => {
    const execute = vi.fn(async () => ({ success: true, stdout: '' }));
    const reflectedRow = {
      environment_id: 'test',
      automatic_provisioning_enabled: 1,
      provisioning_token_ownership: 'account' as const,
      provisioning_token_management: 'setup' as const,
      provisioning_capability_state: 'ready' as const,
      provisioning_capability_checked_at: 123,
      provisioning_bootstrap_phase: 'none' as const,
      provisioning_bootstrap_token_ownership: 'none' as const,
      provisioning_bootstrap_token_id: null,
      provisioning_bootstrap_token_fingerprint: null,
      provisioning_child_tokens_json: JSON.stringify(CHILD_TOKENS),
      provisioning_secret_generation_deployment_id: SECRET_GENERATION.deploymentId,
      provisioning_secret_generation_version_id: SECRET_GENERATION.versionId,
      updated_at: 123,
    };
    for (const query of [
      vi.fn(async () => [
        {
          ...reflectedRow,
          provisioning_secret_generation_version_id: 'version:other',
        },
      ]),
      vi.fn(async () => [
        {
          ...reflectedRow,
          provisioning_child_tokens_json: JSON.stringify([
            { ...CHILD_TOKENS[0], tokenFingerprint: '9'.repeat(64) },
            CHILD_TOKENS[1],
          ]),
        },
      ]),
      vi.fn(async () => [
        {
          ...reflectedRow,
          provisioning_token_management: 'operator',
        },
      ]),
    ]) {
      await expect(
        writeControlProvisioningAuthority({
          controlDatabaseName: 'control-db',
          environmentId: 'test',
          automaticProvisioningEnabled: true,
          tokenOwnership: 'account',
          tokenManagement: 'setup',
          capabilityState: 'ready',
          childTokens: CHILD_TOKENS,
          secretGeneration: SECRET_GENERATION,
          now: 123,
          execute,
          query,
        })
      ).rejects.toThrow('control_provisioning_authority_reflection_failed');
    }
  });

  it('rejects every missing required child-token field on insert and update in cutover and ready states', () => {
    const database = new DatabaseSync(':memory:');
    const requiredFields = [
      'resourceClass',
      'tokenId',
      'tokenName',
      'secretName',
      'tokenFingerprint',
    ] as const;
    const childTokensJson = JSON.stringify(CHILD_TOKENS);
    const childTokensSql = `'${childTokensJson.replaceAll("'", "''")}'`;
    const insertAuthority = (
      environmentId: string,
      state: 'pending-cutover' | 'ready',
      childrenExpression: string
    ): void => {
      const authorityValues =
        state === 'ready'
          ? `1, 'account', 'setup', 'ready', 'none', 'none', NULL, NULL`
          : `1, 'none', 'setup', 'pending', 'pending_revocation', 'account',
             '${'f'.repeat(32)}', '${'e'.repeat(64)}'`;
      database.exec(`
        INSERT INTO control_environments (
          environment_id, environment_name, issuer, lifecycle_state,
          automatic_provisioning_enabled, provisioning_token_ownership,
          provisioning_token_management, provisioning_capability_state,
          provisioning_bootstrap_phase, provisioning_bootstrap_token_ownership,
          provisioning_bootstrap_token_id, provisioning_bootstrap_token_fingerprint,
          provisioning_child_tokens_json, provisioning_secret_generation_deployment_id,
          provisioning_secret_generation_version_id, created_at, updated_at
        ) VALUES (
          '${environmentId}', '${environmentId}', 'urn:authrim:control:${environmentId}', 'active',
          ${authorityValues}, ${childrenExpression}, '${SECRET_GENERATION.deploymentId}',
          '${SECRET_GENERATION.versionId}', 1, 1
        )
      `);
    };

    try {
      applyControlMigrations(database, 8);

      for (const state of ['pending-cutover', 'ready'] as const) {
        requiredFields.forEach((field, index) => {
          const malformedChildren = `json_remove(${childTokensSql}, '$[0].${field}')`;
          expect(() =>
            insertAuthority(
              `insert-${state === 'ready' ? 'r' : 'p'}-${index}`,
              state,
              malformedChildren
            )
          ).toThrow('control_automatic_provisioning_authority_invalid');
        });
      }

      insertAuthority('update-pending', 'pending-cutover', childTokensSql);
      insertAuthority('update-ready', 'ready', childTokensSql);
      for (const environmentId of ['update-pending', 'update-ready']) {
        for (const field of requiredFields) {
          expect(() =>
            database.exec(`
              UPDATE control_environments
                 SET provisioning_child_tokens_json =
                       json_remove(provisioning_child_tokens_json, '$[0].${field}')
               WHERE environment_id = '${environmentId}'
            `)
          ).toThrow('control_automatic_provisioning_authority_invalid');
        }
      }

      expect(
        database
          .prepare(
            `SELECT environment_id, provisioning_child_tokens_json
               FROM control_environments
              WHERE environment_id IN ('update-pending', 'update-ready')
           ORDER BY environment_id`
          )
          .all()
      ).toEqual([
        {
          environment_id: 'update-pending',
          provisioning_child_tokens_json: childTokensJson,
        },
        {
          environment_id: 'update-ready',
          provisioning_child_tokens_json: childTokensJson,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('reads and updates the authoritative control_environments schema', async () => {
    const database = new DatabaseSync(':memory:');
    try {
      applyControlMigrations(database, 8);
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
          tokenManagement: 'setup',
          capabilityState: 'ready',
          now: 101,
          execute,
          query,
        })
      ).rejects.toThrow('control_provisioning_authority_state_invalid');
      await expect(
        readControlProvisioningAuthority({
          controlDatabaseName: 'control-db',
          environmentId: 'test',
          query,
        })
      ).resolves.toMatchObject({ automaticProvisioningEnabled: true });
      await expect(
        writeControlProvisioningAuthority({
          controlDatabaseName: 'control-db',
          environmentId: 'test',
          automaticProvisioningEnabled: true,
          tokenOwnership: 'none',
          tokenManagement: 'operator',
          capabilityState: 'pending',
          bootstrapPhase: 'pending_revocation',
          bootstrapTokenOwnership: 'account',
          bootstrapTokenId: 'f'.repeat(32),
          bootstrapTokenFingerprint: 'e'.repeat(64),
          childTokens: CHILD_TOKENS,
          secretGeneration: SECRET_GENERATION,
          now: 102,
          execute,
          query,
        })
      ).rejects.toThrow('control_provisioning_authority_state_invalid');
      await expect(
        writeControlProvisioningAuthority({
          controlDatabaseName: 'control-db',
          environmentId: 'test',
          automaticProvisioningEnabled: true,
          tokenOwnership: 'none',
          capabilityState: 'pending',
          tokenManagement: 'setup',
          bootstrapPhase: 'pending_revocation',
          bootstrapTokenOwnership: 'account',
          bootstrapTokenId: 'f'.repeat(32),
          bootstrapTokenFingerprint: 'e'.repeat(64),
          childTokens: CHILD_TOKENS,
          secretGeneration: SECRET_GENERATION,
          now: 102,
          execute,
          query,
        })
      ).resolves.toMatchObject({
        capabilityState: 'pending',
        bootstrapPhase: 'pending_revocation',
        bootstrapTokenOwnership: 'account',
        childTokens: CHILD_TOKENS,
        secretGeneration: SECRET_GENERATION,
      });
      await expect(
        writeControlProvisioningAuthority({
          controlDatabaseName: 'control-db',
          environmentId: 'test',
          automaticProvisioningEnabled: true,
          tokenOwnership: 'none',
          capabilityState: 'pending',
          tokenManagement: 'setup',
          bootstrapPhase: 'cutover_verified',
          bootstrapTokenOwnership: 'account',
          bootstrapTokenId: 'f'.repeat(32),
          bootstrapTokenFingerprint: 'e'.repeat(64),
          childTokens: CHILD_TOKENS,
          secretGeneration: SECRET_GENERATION,
          now: 103,
          execute,
          query,
        })
      ).resolves.toMatchObject({
        capabilityState: 'pending',
        bootstrapPhase: 'cutover_verified',
        childTokens: CHILD_TOKENS,
        secretGeneration: SECRET_GENERATION,
      });
      await expect(
        writeControlProvisioningAuthority({
          controlDatabaseName: 'control-db',
          environmentId: 'test',
          automaticProvisioningEnabled: true,
          tokenOwnership: 'account',
          tokenManagement: 'setup',
          capabilityState: 'ready',
          childTokens: CHILD_TOKENS,
          secretGeneration: SECRET_GENERATION,
          now: 104,
          execute,
          query,
        })
      ).resolves.toMatchObject({
        capabilityState: 'ready',
        bootstrapPhase: 'none',
        bootstrapTokenId: null,
        bootstrapTokenFingerprint: null,
        tokenManagement: 'setup',
        childTokens: CHILD_TOKENS,
        secretGeneration: SECRET_GENERATION,
      });
      await expect(
        writeControlProvisioningAuthority({
          controlDatabaseName: 'control-db',
          environmentId: 'test',
          automaticProvisioningEnabled: true,
          tokenOwnership: 'account',
          tokenManagement: 'operator',
          capabilityState: 'ready',
          childTokens: CHILD_TOKENS,
          secretGeneration: SECRET_GENERATION,
          now: 105,
          execute,
          query,
        })
      ).resolves.toMatchObject({ capabilityState: 'ready', tokenManagement: 'operator' });
      expect(() =>
        database.exec(
          "UPDATE control_environments SET provisioning_bootstrap_phase = 'pending_revocation' WHERE environment_id = 'test'"
        )
      ).toThrow('control_automatic_provisioning_authority_invalid');
      expect(() =>
        database.exec(
          "UPDATE control_environments SET provisioning_secret_generation_deployment_id = 'a' || char(0) || 'suffix' WHERE environment_id = 'test'"
        )
      ).toThrow();
      expect(() =>
        database.exec(
          "UPDATE control_environments SET provisioning_child_tokens_json = json_set(provisioning_child_tokens_json, '$[0].secretName', 'CLOUDFLARE_WORKERS_API_TOKEN') WHERE environment_id = 'test'"
        )
      ).toThrow('control_automatic_provisioning_authority_invalid');
      expect(() =>
        database.exec(
          "UPDATE control_environments SET provisioning_child_tokens_json = json_set(provisioning_child_tokens_json, '$[0].tokenName', 'invalid name') WHERE environment_id = 'test'"
        )
      ).toThrow('control_automatic_provisioning_authority_invalid');
    } finally {
      database.close();
    }
  });
});
