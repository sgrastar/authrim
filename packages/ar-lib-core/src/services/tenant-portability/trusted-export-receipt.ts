import type { TenantPortableDataset } from './module-contract';
import type { TenantBackupSelection, TenantPortableSourceIdentity } from './selection-contract';

/** Obtained from the authenticated export control plane, independently of downloaded ciphertext. */
export interface TrustedTenantBackupExportReceiptV2 {
  source: TenantPortableSourceIdentity;
  bundleId: string;
  snapshotId: string;
  inventoryDigestSha256: string;
  /** Exact download order and byte boundaries in the concatenated download; ciphertext digests. */
  parts: readonly { size: number; sha256: string }[];
}

/** Published metadata contains no content keys, object addresses, or exported data rows. */
export interface TenantBackupExportPublicationReceiptV1 {
  formatVersion: 1;
  operationId: string;
  expiresAt: number;
  byteCount: number;
  boundaryUnixMs: number;
  receipt: TrustedTenantBackupExportReceiptV2;
  selection: TenantBackupSelection;
  /** The source export's pinned installed dataset inventory, not an artifact-supplied inventory. */
  datasets: readonly TenantPortableDataset[];
}
