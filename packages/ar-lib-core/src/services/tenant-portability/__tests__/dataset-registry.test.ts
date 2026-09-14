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

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));

describe('tenant backup dataset registry coverage', () => {
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

  it('keeps current revocation, deletion, and undelivered state outside optional history', () => {
    for (const [family, table] of [
      ['pii', 'users_pii_tombstone'],
      ['core', 'account_legal_hold_states'],
      ['core', 'user_token_families'],
      ['core', 'webhook_deliveries'],
      ['core', 'account_webhook_outbox'],
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
      TENANT_DATASET_POLICIES.find((entry) => entry.family === 'core' && entry.table === 'sessions')
        ?.kind
    ).toBe('ephemeral');
  });

  it('distinguishes deployment profiles, delivery state, and sensitive identifier history', () => {
    expect(
      TENANT_DATASET_POLICIES.find(
        (entry) => entry.family === 'core' && entry.table === 'profile_registry'
      )?.kind
    ).toBe('settings');
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
  });

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
