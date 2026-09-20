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
    | {
        action: 'admit' | 'plan' | 'readReleased' | 'acknowledgeAll';
        participants: BackupBoundaryParticipant[];
      }
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
> & {
  /** Production Control combines begin, plan and hold in one RPC to keep T0 admission bounded. */
  admit?(
    value: Parameters<TenantBackupMutationAdmission['begin']>[0],
    participants: readonly BackupBoundaryParticipant[]
  ): Promise<TenantMutationBoundary | null>;
};
export type TenantBackupBoundaryReceiptsPort = Pick<
  TenantBackupBoundaryReceipts,
  'plan' | 'acknowledge' | 'assertHeld' | 'readReleased' | 'release' | 'abort'
> & {
  acknowledgeAll?(
    input: Parameters<TenantBackupBoundaryReceipts['acknowledge']>[0],
    participants: readonly BackupBoundaryParticipant[],
    now: number
  ): Promise<boolean>;
};
