import type { BackupBoundaryParticipant } from './boundary-receipts';
import type { TenantMutationBoundary, TenantBackupMutationAdmission } from './mutation-admission';
import type { TenantBackupBoundaryReceipts } from './boundary-receipts';

type Identity = {
  tenantId: string;
  operationId: string;
  boundaryId: string;
  inventoryDigest: string;
};
/** Environment, caller and clock come exclusively from authenticated Control context. */
export type TenantBackupBoundaryRequest = Identity &
  (
    | { action: 'begin' | 'hold' | 'release' | 'abort' | 'assertHeld' }
    | { action: 'plan' | 'readReleased'; participants: BackupBoundaryParticipant[] }
    | { action: 'acknowledge'; participant: BackupBoundaryParticipant }
  );
export interface TenantBackupBoundaryResponse {
  environmentId: string;
  boundary: TenantMutationBoundary | null;
  accepted: boolean;
}

export type TenantBackupBoundaryAdmissionPort = Pick<
  TenantBackupMutationAdmission,
  'begin' | 'hold'
>;
export type TenantBackupBoundaryReceiptsPort = Pick<
  TenantBackupBoundaryReceipts,
  'plan' | 'acknowledge' | 'assertHeld' | 'readReleased' | 'release' | 'abort'
>;
