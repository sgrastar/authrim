import { expect } from 'vitest';
import type { PostgresFamilyRestoreReceipt } from '../postgres-restore';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../postgres-restore-table-contract';
import { POSTGRES_RESTORE_EXTENSION_CONTRACTS } from '../postgres-restore-extension-contract';

export function expectPostgresRestoreReceiptTables(
  receipt: PostgresFamilyRestoreReceipt,
  sourceDatasetIds: readonly string[]
): void {
  const source = new Set(sourceDatasetIds);
  // These schema contracts describe source authority that must be rebuilt/rebound,
  // rather than imported into a fresh target, even when present in the backup.
  const sourceAuthority = new Set([
    'core.statement_consent_guards',
    'core.statement_consent_admissions',
  ]);
  const expected = [
    ...POSTGRES_RESTORE_TABLE_CONTRACTS.filter((spec) => spec.family === receipt.family),
    ...POSTGRES_RESTORE_EXTENSION_CONTRACTS.filter(
      (spec) =>
        spec.family === receipt.family &&
        source.has(spec.datasetId) &&
        !sourceAuthority.has(spec.datasetId)
    ),
  ].map((spec) => spec.datasetId);
  expect(receipt.tables.map((table) => table.datasetId)).toEqual(expected);
}
