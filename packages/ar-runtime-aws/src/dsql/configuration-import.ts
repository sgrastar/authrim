import type { TransactionContext } from '@authrim/ar-lib-core/db/adapter';
import {
  assertDsqlConfigurationSchemaName,
  createDsqlConfigurationSchemaPlan,
  dsqlConfigurationTableName,
} from './configuration-schema';
import {
  createDsqlSubsetImporter,
  type DsqlSubsetImportDatabase,
  type DsqlSubsetImportInput,
  type DsqlSubsetImportProgress,
  type DsqlSubsetReceipt,
} from './subset-import';

export const DSQL_CONFIGURATION_IMPORT_JOURNAL_TABLES = [
  'authrim_configuration_import_operation',
  'authrim_configuration_import_chunks',
] as const;

export class DsqlConfigurationImportValidationError extends Error {
  constructor() {
    super('aurora_dsql_configuration_import_invalid');
    this.name = 'DsqlConfigurationImportValidationError';
  }
}

export class DsqlConfigurationVerificationMismatch extends Error {
  constructor() {
    super('aurora_dsql_configuration_verification_mismatch');
    this.name = 'DsqlConfigurationVerificationMismatch';
  }
}

export type DsqlConfigurationImportDatabase = DsqlSubsetImportDatabase;
export type DsqlConfigurationImportInput = DsqlSubsetImportInput;
export type DsqlConfigurationImportProgress = DsqlSubsetImportProgress;
export type DsqlConfigurationSubsetReceipt =
  DsqlSubsetReceipt<'four-table-saml-configuration-evaluation'>;

/**
 * Post-import checks supplement, rather than replace, native FK/unique/check constraints.
 * This slice does not verify OIDC or credential-profile target inventories. Reject such
 * links explicitly instead of issuing a reference-verified receipt for absent datasets.
 * It verifies storage/relationships, not arbitrary Flow execution or SAML signing material.
 */
export async function verifyDsqlConfigurationReferences(
  db: Pick<TransactionContext, 'queryOne'>,
  schema: string,
  tenantId: string
): Promise<void> {
  if (!tenantId) throw new DsqlConfigurationImportValidationError();
  const flows = dsqlConfigurationTableName(schema, 'flows');
  const versions = dsqlConfigurationTableName(schema, 'flow_versions');
  const assignments = dsqlConfigurationTableName(schema, 'flow_assignments');
  const providers = dsqlConfigurationTableName(schema, 'identity_providers');
  const checks = [
    `SELECT 1 FROM ${versions} v LEFT JOIN ${flows} f ON f.id=v.flow_id AND f.tenant_id=v.tenant_id WHERE v.tenant_id<>$1 OR f.id IS NULL LIMIT 1`,
    `SELECT 1 FROM ${assignments} a LEFT JOIN ${flows} f ON f.id=a.flow_id AND f.tenant_id=a.tenant_id WHERE a.tenant_id<>$1 OR f.id IS NULL LIMIT 1`,
    `SELECT 1 FROM ${flows} f LEFT JOIN ${versions} v ON v.id=f.published_version_id AND v.flow_id=f.id AND v.tenant_id=f.tenant_id WHERE f.tenant_id<>$1 OR (f.published_version_id IS NOT NULL AND v.id IS NULL) OR (f.status='published' AND f.published_version_id IS NULL) LIMIT 1`,
    `SELECT 1 FROM ${flows} WHERE client_id IS NOT NULL OR profile_id IS NOT NULL LIMIT 1`,
    `SELECT 1 FROM ${assignments} WHERE target_type NOT IN ('tenant','saml_sp') OR (target_type='tenant' AND target_id IS NOT NULL) OR (target_type='saml_sp' AND target_id IS NULL) LIMIT 1`,
    `SELECT 1 FROM ${providers} WHERE tenant_id<>$1 OR enabled NOT IN (0,1) OR (provider_type IN ('saml_idp','saml_sp') AND CASE WHEN config_json IS JSON THEN jsonb_typeof(config_json::jsonb) IS DISTINCT FROM 'object' OR jsonb_typeof(config_json::jsonb->'entityId') IS DISTINCT FROM 'string' OR length(config_json::jsonb->>'entityId')=0 ELSE TRUE END) LIMIT 1`,
    `SELECT 1 FROM ${assignments} a LEFT JOIN ${providers} p ON p.tenant_id=a.tenant_id AND p.provider_type='saml_sp' AND (CASE WHEN p.config_json IS JSON THEN p.config_json::jsonb->>'entityId' END)=a.target_id WHERE a.target_type='saml_sp' AND p.id IS NULL LIMIT 1`,
    `SELECT 1 FROM ${versions} WHERE NOT (runtime_snapshot_json IS JSON) OR NOT (validation_result_json IS JSON) OR (editor_snapshot_json IS NOT NULL AND NOT (editor_snapshot_json IS JSON)) LIMIT 1`,
    `SELECT 1 FROM ${flows} WHERE deleted_at IS NULL AND slug IS NOT NULL GROUP BY tenant_id,slug HAVING COUNT(*)>1 LIMIT 1`,
    `SELECT 1 FROM ${versions} GROUP BY tenant_id,flow_id,version_number HAVING COUNT(*)>1 LIMIT 1`,
    `SELECT 1 FROM ${assignments} WHERE target_id IS NOT NULL GROUP BY tenant_id,target_type,target_id,flow_kind HAVING COUNT(*)>1 LIMIT 1`,
    `SELECT 1 FROM ${assignments} WHERE target_type='tenant' AND target_id IS NULL GROUP BY tenant_id,flow_kind HAVING COUNT(*)>1 LIMIT 1`,
    `SELECT 1 FROM ${providers} WHERE provider_type IN ('saml_idp','saml_sp') GROUP BY tenant_id,provider_type,(CASE WHEN config_json IS JSON THEN config_json::jsonb->>'entityId' END) HAVING COUNT(*)>1 LIMIT 1`,
  ];
  for (const sql of checks) {
    if (await db.queryOne(sql, sql.includes('$1') ? [tenantId] : [])) {
      throw new DsqlConfigurationVerificationMismatch();
    }
  }
}

const importer = createDsqlSubsetImporter({
  scope: 'four-table-saml-configuration-evaluation',
  operationId: 'configuration-v1',
  journalTables: DSQL_CONFIGURATION_IMPORT_JOURNAL_TABLES,
  assertSchemaName: assertDsqlConfigurationSchemaName,
  schemaPlan: createDsqlConfigurationSchemaPlan,
  ValidationError: DsqlConfigurationImportValidationError,
  VerificationMismatch: DsqlConfigurationVerificationMismatch,
  verifyReferences: verifyDsqlConfigurationReferences,
});

export const createDsqlConfigurationImportJournal = importer.createJournal;
export const restoreDsqlConfigurationSlice = importer.restoreSlice;
export const verifyDsqlConfigurationSubset = importer.verifySubset;
