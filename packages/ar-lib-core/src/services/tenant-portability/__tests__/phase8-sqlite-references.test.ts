import { describe, expect, it, vi } from 'vitest';
import type { PlannedInstalledSqliteDataset } from '../installed-sqlite-datasets.js';
import {
  PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS,
  PHASE8_SQLITE_DATASET_REGISTRATIONS,
} from '../phase8-sqlite-modules.js';
import {
  createPhase8SqliteInspectionPolicies,
  inspectPhase8SqliteReferences,
  phase8SqliteRestoreDependencies,
} from '../phase8-sqlite-references.js';

const text = (value: string) => ['text', value] as const;
const nil = ['null', null] as const;
const restoreHold = () => ({ write: vi.fn(), verify: vi.fn() });

function planned(): PlannedInstalledSqliteDataset[] {
  return PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map((registration, ordinal) => ({
    ordinal,
    firstOrdinal: 0,
    resourceId: `${registration.family}-db`,
    family: registration.family,
    table: registration.table,
    dataset: structuredClone(registration.dataset),
    ...(registration.partitions ? { partitions: [...registration.partitions] } : {}),
    capture: {
      table: registration.table,
      columns: registration.partitions ? ['id', 'tenant_id', 'resource_type'] : ['id', 'tenant_id'],
      primaryKey: ['id'],
      uniqueKeys: [],
      tenantColumn: 'tenant_id',
      ...(registration.partitions
        ? {
            rowPartition: {
              column: 'resource_type',
              values: PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.filter(
                (candidate) =>
                  candidate.family === registration.family && candidate.table === registration.table
              ).flatMap((candidate) => candidate.partitions ?? []),
            },
          }
        : {}),
    },
  }));
}

const identity = {
  module: 'users' as const,
  collection: 'core.contact_points',
  id: 'contact-a',
  tenantId: 'tenant-a',
};

describe('Phase 8 SQL references', () => {
  it('builds an exact cumulative plan and preserves the physical restore graph', () => {
    const policies = createPhase8SqliteInspectionPolicies(planned(), {
      tenantKey: 'tenant-key-a',
      validateAdminEnvelope: vi.fn(),
      validatePhase8Envelope: vi.fn(),
      resolveAdminReference: vi.fn(async (_context, source) => `target-${source}`),
      resolvePluginReference: vi.fn(async (_context, _source, plugin) => `target-${plugin}`),
      restoreHold: restoreHold(),
    });
    expect(policies).toHaveLength(PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.length);
    expect(
      policies.find(({ dataset }) => dataset.id === 'core.contact_points')?.restoreAfter
    ).toEqual(['core.identity_accounts', 'core.identity_subjects']);
    expect(
      policies.find(({ dataset }) => dataset.id === 'core.attribute_verifications')
        ?.restoreOverrides
    ).toEqual({ vp_request_id: nil });
    expect(
      policies.find(({ dataset }) => dataset.id === 'admin.admin_users')?.restoreDisposition
    ).toBe('reference_only');
    expect(
      policies.find(({ dataset }) => dataset.id === 'admin.admin_role_assignments')
        ?.restoreTransform?.id
    ).toBe('phase8-restore-v1:admin.admin_role_assignments');
    expect(
      policies.find(({ dataset }) => dataset.id === 'core.totp_credentials')?.restoreOverrides
    ).toMatchObject({
      secret_encrypted: ['text', 'backup-pending'],
      secret_key_version: ['integer', '1'],
    });
  });

  it('rejects incomplete, duplicate, or altered installed plans', () => {
    const valid = planned();
    const input = {
      tenantKey: 'tenant-key-a',
      validateAdminEnvelope: vi.fn(),
      validatePhase8Envelope: vi.fn(),
      resolveAdminReference: vi.fn(async (_context, source) => source),
      resolvePluginReference: vi.fn(async (_context, source) => source),
      restoreHold: restoreHold(),
    };
    expect(() => createPhase8SqliteInspectionPolicies(valid.slice(1), input)).toThrow(
      'backup_phase8_plan_incomplete'
    );
    expect(() =>
      createPhase8SqliteInspectionPolicies([...valid.slice(0, -1), valid[0]], input)
    ).toThrow('backup_phase8_plan_incomplete');
    const altered = structuredClone(valid);
    altered[altered.length - 1].table = 'changed';
    expect(() => createPhase8SqliteInspectionPolicies(altered, input)).toThrow(
      'backup_phase8_plan_mismatch'
    );
  });

  it('emits required references for simple and composite physical foreign keys', () => {
    expect(
      inspectPhase8SqliteReferences(
        'core.contact_points',
        { account_id: text('account-a'), subject_id: text('subject-a') },
        identity
      ).map(({ to }) => [to.collection, to.id])
    ).toEqual([
      ['core.identity_accounts', JSON.stringify([text('account-a')])],
      ['core.identity_subjects', JSON.stringify([text('subject-a')])],
    ]);
    expect(
      inspectPhase8SqliteReferences(
        'core.plugin_account_metadata_audit',
        {
          tenant_id: text('tenant-a'),
          plugin_installation_id: text('plugin-a'),
          operation_id: text('operation-a'),
        },
        { ...identity, collection: 'core.plugin_account_metadata_audit' }
      )[0]?.to.id
    ).toBe(JSON.stringify([text('tenant-a'), text('plugin-a'), text('operation-a')]));
  });

  it('maps operational Admin principals while preserving typed non-Admin subjects', async () => {
    const resolveAdminReference = vi.fn(async (_context, source: string) => `target-${source}`);
    const policies = createPhase8SqliteInspectionPolicies(planned(), {
      tenantKey: 'tenant-key-a',
      validateAdminEnvelope: vi.fn(),
      validatePhase8Envelope: vi.fn(),
      resolveAdminReference,
      resolvePluginReference: vi.fn(async (_context, source) => source),
      restoreHold: restoreHold(),
    });
    const assignment = policies.find(
      ({ dataset }) => dataset.id === 'admin.admin_role_assignments'
    );
    const transformed = await assignment?.restoreTransform?.transform(
      {} as never,
      JSON.stringify({
        id: text('assignment-a'),
        tenant_id: text('tenant-a'),
        admin_user_id: text('source-a'),
      }),
      'write'
    );
    expect(JSON.parse(transformed ?? '{}').admin_user_id).toEqual(text('target-source-a'));
    expect(resolveAdminReference).toHaveBeenCalledWith(expect.anything(), 'source-a');

    expect(
      inspectPhase8SqliteReferences(
        'admin.admin_role_assignments',
        { admin_user_id: text('source-a'), admin_role_id: text('role-a') },
        { ...identity, module: 'admin-auth', collection: 'admin.admin_role_assignments' }
      ).filter(({ to }) => to.collection === 'admin.admin_users')
    ).toHaveLength(1);

    expect(
      inspectPhase8SqliteReferences(
        'admin.approval_request_approvals',
        {
          approval_request_id: text('request-a'),
          subject_type: text('end_user'),
          subject_id: text('user-a'),
        },
        { ...identity, module: 'admin-auth', collection: 'admin.approval_request_approvals' }
      ).filter(({ to }) => to.collection === 'admin.admin_users')
    ).toEqual([]);
  });

  it('maps active plugin account state to the target environment installation identity', async () => {
    const resolvePluginReference = vi.fn(
      async (_context, _source: string, plugin: string) => `target-${plugin}`
    );
    const policies = createPhase8SqliteInspectionPolicies(planned(), {
      tenantKey: 'tenant-key-a',
      validateAdminEnvelope: vi.fn(),
      validatePhase8Envelope: vi.fn(),
      resolveAdminReference: vi.fn(async (_context, source) => source),
      resolvePluginReference,
      restoreHold: restoreHold(),
    });
    for (const datasetId of [
      'core.plugin_account_metadata',
      'core.plugin_account_metadata_mutations',
      'core.plugin_account_metadata_audit',
    ]) {
      const policy = policies.find(({ dataset }) => dataset.id === datasetId);
      const transformed = await policy?.restoreTransform?.transform(
        {} as never,
        JSON.stringify({
          tenant_id: text('tenant-a'),
          plugin_installation_id: text('source-installation'),
          plugin_id: text('example-plugin'),
        }),
        'write'
      );
      expect(JSON.parse(transformed ?? '{}').plugin_installation_id).toEqual(
        text('target-example-plugin')
      );
    }
    expect(resolvePluginReference).toHaveBeenCalledTimes(3);
  });

  it('matches SQLite nullable-FK semantics and rejects malformed typed fields', () => {
    expect(
      inspectPhase8SqliteReferences(
        'pii.identity_identifier_replacement_operations',
        { challenge_id: nil },
        { ...identity, collection: 'pii.identity_identifier_replacement_operations' }
      )
    ).toEqual([]);
    expect(() =>
      inspectPhase8SqliteReferences(
        'core.contact_points',
        { account_id: text('account-a') },
        identity
      )
    ).toThrow('backup_phase8_reference_invalid');
  });

  it('validates every sensitive Phase 8 transport row with the installed port', async () => {
    const validatePhase8Envelope = vi.fn();
    const policy = createPhase8SqliteInspectionPolicies(planned(), {
      tenantKey: 'tenant-key-a',
      validateAdminEnvelope: vi.fn(),
      validatePhase8Envelope,
      resolveAdminReference: vi.fn(async (_context, source) => source),
      resolvePluginReference: vi.fn(async (_context, source) => source),
      restoreHold: restoreHold(),
    }).find(({ dataset }) => dataset.id === 'pii.identity_identifier_replacement_challenges');
    expect(policy).toBeDefined();
    await policy!.inspectRow(
      {},
      { ...identity, collection: 'pii.identity_identifier_replacement_challenges' }
    );
    expect(validatePhase8Envelope).toHaveBeenCalledWith(
      'pii.identity_identifier_replacement_challenges',
      {}
    );
  });

  it('pins every generated dependency target to the cumulative installed registry', () => {
    const ids = new Set(
      PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.map(({ dataset }) => dataset.id)
    );
    for (const { dataset } of PHASE8_SQLITE_DATASET_REGISTRATIONS) {
      for (const dependency of phase8SqliteRestoreDependencies(dataset.id)) {
        expect(ids.has(dependency), `${dataset.id} -> ${dependency}`).toBe(true);
      }
    }
  });
});
