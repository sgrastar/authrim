import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inventoryBackupSchemas } from '../../../../../../scripts/tenant-backup/schema-inventory';
import {
  inspectBackupBindings,
  inventoryBackupBindings,
} from '../../../../../../scripts/tenant-backup/binding-inventory';
import {
  checkTenantBackupBindingCoverage,
  TENANT_BACKUP_BINDING_POLICIES,
} from '../binding-registry';
import { MIGRATION_STREAM_CONTRACTS } from '../../control-plane/migration-stream-contract';
import { checkTenantDatasetCoverage, TENANT_DATASET_POLICIES } from '../dataset-registry';
import { parseTenantBackupSelection, tenantDatasetSelectionRule } from '../selection-contract';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));

describe('tenant backup dataset registry coverage', () => {
  it.each(['core', 'pii', 'admin', 'control', 'lookup', 'plugin_runner'] as const)(
    'excludes the engine sentinel exactly once in %s, with no Admin business dataset',
    (family) => {
      expect(
        TENANT_DATASET_POLICIES.filter(
          (entry) => entry.family === family && entry.table === 'tenant_database_migration_state'
        )
      ).toEqual([{ family, table: 'tenant_database_migration_state', kind: 'rebuild' }]);
      expect(
        tenantDatasetSelectionRule('rebuild', {
          settings: true,
          users: true,
          admin: true,
          artifacts: true,
          logs: { audit: true, other: true, sensitive: true, period: 'all' },
        }).action
      ).toBe('rebuild');
    }
  );

  it('never exports replication grants or their credential hashes', () => {
    const policy = TENANT_DATASET_POLICIES.find(
      (entry) => entry.family === 'admin' && entry.table === 'tenant_backup_replication_grants'
    );
    expect(policy?.kind).toBe('ephemeral');
    if (!policy) throw new Error('replication_grant_policy_missing');
    expect(
      tenantDatasetSelectionRule(policy.kind, {
        settings: true,
        users: true,
        admin: true,
        artifacts: true,
        logs: { audit: true, other: true, sensitive: true, period: 'all' },
      }).action
    ).toBe('excluded');
  });
  it('selects failure aggregates only with other logs and preserves their cumulative meaning', () => {
    const policy = TENANT_DATASET_POLICIES.find(
      ({ family, table }) => family === 'admin' && table === 'identity_mapping_failures'
    );
    expect(policy?.kind).toBe('history');
    if (!policy) throw new Error('mapping_failure_policy_missing');
    for (const other of [false, true]) {
      const selection = parseTenantBackupSelection({
        settings: true,
        users: false,
        admin: false,
        artifacts: false,
        logs: { audit: true, other, sensitive: true, period: 7 },
      });
      expect(tenantDatasetSelectionRule(policy.kind, selection)).toEqual(
        other
          ? { action: 'selected', timeFilter: 'log_window' }
          : { action: 'excluded', reason: 'not_selected' }
      );
    }
  });

  it('preserves the mapping version ledger with settings even when historical logs are disabled', () => {
    const policy = TENANT_DATASET_POLICIES.find(
      ({ family, table }) => family === 'admin' && table === 'identity_mapping_level_history'
    );
    expect(policy?.kind).toBe('settings');
    const selection = parseTenantBackupSelection({
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 7 },
    });
    expect(tenantDatasetSelectionRule('settings', selection)).toEqual({
      action: 'selected',
      timeFilter: 'none',
    });
  });
  it('retains published mapping dependencies in settings-only backups with logs and Admin users off', () => {
    const selection = parseTenantBackupSelection({
      settings: true,
      users: false,
      admin: false,
      logs: { audit: false, other: false, sensitive: false, period: 7 },
      artifacts: false,
    });
    // Compilation chooses a catalog version and compatibility range, and activation
    // changes lifecycle state. Recompiling defaults does not reproduce those choices.
    for (const table of [
      'field_mapping_activations',
      'field_mapping_versions',
      'compiled_mapping_snapshots',
      'dependency_graph_snapshots',
      'field_catalog_versions',
      'destination_profiles',
      'destination_profile_versions',
      // Missing the latest trust-context hash makes an unchanged source update
      // invalidate restored metadata and delete its verified runtime entities.
      'federation_trust_context_snapshots',
      'federation_trust_sources',
      'federation_saml_runtime_entities',
    ]) {
      const policy = TENANT_DATASET_POLICIES.find(
        (entry) => entry.family === 'admin' && entry.table === table
      );
      expect(policy, table).toBeDefined();
      expect(tenantDatasetSelectionRule(policy!.kind, selection), table).toEqual({
        action: 'selected',
        timeFilter: 'none',
      });
    }
  });

  it('classifies every table in each executable D1 schema without duplicates or stale entries', () => {
    for (const stream of inventoryBackupSchemas(root).inspectedStreams) {
      const family = MIGRATION_STREAM_CONTRACTS.find(
        (contract) => contract.id === stream.id
      )!.schemaFamily;
      expect(
        checkTenantDatasetCoverage(
          family,
          stream.tables.map((table) => table.name)
        ),
        stream.id
      ).toEqual({
        unclassified: [],
        stale: [],
        duplicates: [],
      });
    }
  });

  it('makes an added or renamed table visible instead of assigning a wildcard default', () => {
    expect(
      checkTenantDatasetCoverage(
        'pii',
        ['new_pii_table'],
        [
          { family: 'pii', table: 'old_pii_table', kind: 'users' },
          { family: 'pii', table: 'old_pii_table', kind: 'users' },
          { family: 'core', table: 'new_pii_table', kind: 'settings' },
        ]
      )
    ).toEqual({
      unclassified: ['new_pii_table'],
      stale: ['old_pii_table'],
      duplicates: ['old_pii_table'],
    });
  });

  it('keeps deletion and undelivered state while excluding active refresh-token families', () => {
    for (const [family, table] of [
      ['pii', 'users_pii_tombstone'],
      ['core', 'account_legal_hold_states'],
      ['core', 'webhook_deliveries'],
      ['core', 'account_webhook_outbox'],
      // Restored with the device secrets and consents it refuses or ends.
      ['core', 'device_secrets'],
      ['core', 'oauth_client_consent_revocations'],
      // Restored with the invitations whose uses it holds.
      ['core', 'tenant_invitation_redemptions'],
    ]) {
      expect(
        TENANT_DATASET_POLICIES.find((entry) => entry.family === family && entry.table === table)
          ?.kind
      ).toBe('users');
    }
    expect(
      TENANT_DATASET_POLICIES.find(
        (entry) => entry.family === 'pii' && entry.table === 'audit_log_pii'
      )?.kind
    ).toBe('sensitive_logs');
    expect(
      TENANT_DATASET_POLICIES.find(
        (entry) => entry.family === 'core' && entry.table === 'user_token_families'
      )?.kind
    ).toBe('ephemeral');
    expect(
      TENANT_DATASET_POLICIES.find((entry) => entry.family === 'core' && entry.table === 'sessions')
        ?.kind
    ).toBe('ephemeral');
    expect(
      TENANT_DATASET_POLICIES.find(
        (entry) =>
          entry.family === 'pii' && entry.table === 'identity_identifier_replacement_challenges'
      )?.kind
    ).toBe('users');
    expect(
      TENANT_DATASET_POLICIES.find(
        (entry) => entry.family === 'control' && entry.table === 'control_audit_events'
      )?.kind
    ).toBe('external');
    expect(
      TENANT_DATASET_POLICIES.find(
        (entry) =>
          entry.family === 'control' && entry.table === 'control_account_legal_hold_projections'
      )?.kind
    ).toBe('rebuild');
  });

  it('distinguishes deployment profiles, delivery state, and sensitive identifier history', () => {
    expect(
      TENANT_DATASET_POLICIES.find(
        (entry) => entry.family === 'core' && entry.table === 'profile_registry'
      )?.kind
    ).toBe('external');
    for (const family of ['core', 'admin']) {
      for (const table of [
        'internal_notification_events',
        'internal_notification_delivery_attempts',
      ]) {
        expect(
          TENANT_DATASET_POLICIES.find((entry) => entry.family === family && entry.table === table)
            ?.kind
        ).toBe('delivery_state');
      }
    }
    expect(
      TENANT_DATASET_POLICIES.find(
        (entry) =>
          entry.family === 'pii' && entry.table === 'identity_identifier_replacement_history'
      )?.kind
    ).toBe('sensitive_logs');
  });

  it('classifies the declared production storage bindings while keeping mixed state explicit', () => {
    expect(checkTenantBackupBindingCoverage(inventoryBackupBindings(root))).toEqual({
      unclassified: [],
      stale: [],
      duplicates: [],
    });
    expect(
      TENANT_BACKUP_BINDING_POLICIES.find((entry) => entry.name === 'SESSION_REVOCATION_STORE')
        ?.disposition
    ).toBe('mixed');
    expect(
      TENANT_BACKUP_BINDING_POLICIES.find((entry) => entry.name === 'PUBLIC_ASSETS')?.disposition
    ).toBe('mixed');
    expect(
      checkTenantBackupBindingCoverage([{ name: 'NEW_DATA', kind: 'R2Bucket' }]).unclassified
    ).toEqual(['R2Bucket:NEW_DATA']);
  }, 15_000);

  it('does not discard single-use credential denials as ordinary rate counters', () => {
    // IAT metadata has no tenant ID, and consumption is claimed in RATE_LIMITER before KV
    // deletion. Treating either binding as a whole export or reset can resurrect credentials.
    for (const name of ['INITIAL_ACCESS_TOKENS', 'RATE_LIMITER']) {
      expect(TENANT_BACKUP_BINDING_POLICIES.find((entry) => entry.name === name)).toMatchObject({
        disposition: 'mixed',
      });
    }
  });

  it('finds optional, inherited, union and quoted binding declarations without executing source', () => {
    const source = `interface LoggingBindings { AUDIT_ARCHIVE?: R2Bucket; }
      type WorkerEnv = LoggingBindings & { 'CONFIG': KVNamespace | undefined; SECRET: string;
        AUTH: DurableObjectNamespace<Session>; };
      const example = 'NOT_REAL: R2Bucket';
      // FAKE: KVNamespace;
      interface Options { namespace: KVNamespace; }`;
    expect(inspectBackupBindings(source, 'env.ts').map(({ name, kind }) => [name, kind])).toEqual([
      ['AUDIT_ARCHIVE', 'R2Bucket'],
      ['CONFIG', 'KVNamespace'],
      ['AUTH', 'DurableObjectNamespace'],
    ]);
  });
});
