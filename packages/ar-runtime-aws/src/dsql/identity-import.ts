import {
  createDsqlIdentitySchemaPlan,
  assertDsqlIdentitySchemaName,
  dsqlIdentityTableName,
} from './identity-schema';
import {
  createDsqlSubsetImporter,
  type DsqlSubsetImportDatabase,
  type DsqlSubsetImportInput,
  type DsqlSubsetImportProgress,
  type DsqlSubsetReceipt,
} from './subset-import';

export const DSQL_IDENTITY_IMPORT_JOURNAL_TABLES = [
  'authrim_identity_import_operation',
  'authrim_identity_import_chunks',
] as const;

export class DsqlIdentityImportValidationError extends Error {
  constructor() {
    super('aurora_dsql_identity_import_invalid');
    this.name = 'DsqlIdentityImportValidationError';
  }
}

/** Readback mismatches are distinct from transport failures, without exposing private rows. */
export class DsqlIdentityVerificationMismatch extends Error {
  constructor() {
    super('aurora_dsql_identity_verification_mismatch');
    this.name = 'DsqlIdentityVerificationMismatch';
  }
}

export type DsqlIdentityImportDatabase = DsqlSubsetImportDatabase;
export type DsqlIdentityImportInput = DsqlSubsetImportInput;
export type DsqlIdentityImportProgress = DsqlSubsetImportProgress;
export type DsqlIdentitySubsetReceipt = DsqlSubsetReceipt<'three-table-identity-evaluation'>;

const importer = createDsqlSubsetImporter({
  scope: 'three-table-identity-evaluation',
  operationId: 'identity-v1',
  journalTables: DSQL_IDENTITY_IMPORT_JOURNAL_TABLES,
  assertSchemaName: assertDsqlIdentitySchemaName,
  schemaPlan: createDsqlIdentitySchemaPlan,
  ValidationError: DsqlIdentityImportValidationError,
  VerificationMismatch: DsqlIdentityVerificationMismatch,
  async verifyReferences(db, schema) {
    // Cross-family ownership is explicit; this evaluation requires a PII row for every user.
    for (const [child, owner, parent] of [
      ['users_pii', 'id', 'users_core'],
      ['passkeys', 'user_id', 'users_core'],
      ['users_core', 'id', 'users_pii'],
    ] as const) {
      const orphan = await db.queryOne(
        `SELECT 1 FROM ${dsqlIdentityTableName(schema, child)} child LEFT JOIN ${dsqlIdentityTableName(schema, parent)} parent ON parent.id=child."${owner}" AND parent.tenant_id=child.tenant_id WHERE parent.id IS NULL LIMIT 1`
      );
      if (orphan) throw new DsqlIdentityVerificationMismatch();
    }
  },
});

export const createDsqlIdentityImportJournal = importer.createJournal;
export const restoreDsqlIdentitySlice = importer.restoreSlice;
export const verifyDsqlIdentitySubset = importer.verifySubset;
