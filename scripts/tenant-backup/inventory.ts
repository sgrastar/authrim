import { fileURLToPath } from 'node:url';
import { inventoryBackupBindings } from './binding-inventory.js';
import { inventoryBackupSchemas } from './schema-inventory.js';
import { assessSnapshotTable } from './snapshot-applicability.js';
import { inventoryBackupSettings } from './settings-inventory.js';
import {
  checkTenantSettingFieldCoverage,
  TENANT_SETTING_FIELD_POLICIES,
} from '../../packages/ar-lib-core/src/services/tenant-portability/settings-field-registry.js';
import { checkTenantDatasetCoverage } from '../../packages/ar-lib-core/src/services/tenant-portability/dataset-registry.js';
import { checkTenantBackupBindingCoverage } from '../../packages/ar-lib-core/src/services/tenant-portability/binding-registry.js';
import { MIGRATION_STREAM_CONTRACTS } from '../../packages/ar-lib-core/src/services/control-plane/migration-stream-contract.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const inventory = inventoryBackupSchemas(repositoryRoot);
const bindings = inventoryBackupBindings(repositoryRoot);
const settings = await inventoryBackupSettings();
const classificationChecks = {
  settings: checkTenantSettingFieldCoverage(settings),
  bindings: checkTenantBackupBindingCoverage(bindings),
  tables: inventory.inspectedStreams.map((stream) => {
    const contract = MIGRATION_STREAM_CONTRACTS.find((candidate) => candidate.id === stream.id);
    if (!contract) throw new Error('backup_unknown_migration_stream');
    return {
      stream: stream.id,
      ...checkTenantDatasetCoverage(
        contract.schemaFamily,
        stream.tables.map((table) => table.name)
      ),
    };
  }),
};
const failures = [
  classificationChecks.settings,
  classificationChecks.bindings,
  ...classificationChecks.tables,
].some((check) => Object.values(check).some((value) => Array.isArray(value) && value.length > 0));
process.stdout.write(
  `${JSON.stringify(
    {
      ...inventory,
      storageBindings: bindings,
      settingsFields: settings.map((field) => ({
        ...field,
        handling:
          TENANT_SETTING_FIELD_POLICIES.find((policy) => policy.key === field.key)?.handling ??
          null,
      })),
      classificationChecks,
      // A green classification report is not a claim of export/import implementation.
      completeRestoreCoverage: false,
      snapshotStructureChecks: inventory.inspectedStreams.map((stream) => ({
        stream: stream.id,
        tables: stream.tables.map((table) => ({
          table: table.name,
          concerns: assessSnapshotTable(table).concerns,
        })),
      })),
    },
    null,
    2
  )}\n`
);
if (failures) process.exitCode = 1;
