/** Pure selection validation shared by the isolated SP and maintenance observations. */
import {
  normalizeAwsAuthStateConfig,
  type DynamoAuthStateConfig,
} from '../storage/auth-state-config';
import type { DynamoAuthStateRestoreReceipt } from '../import/auth-state-restore';
import type { AwsSelectedAuthStateEvidence } from '../import/selected-auth-state';

export type SyntheticAuthStateSelection = AwsSelectedAuthStateEvidence;
const TENANT = 'tenant-a';
function fail(): never {
  throw new Error('aws_synthetic_auth_state_snapshot_invalid');
}

export function selectedSyntheticDynamoState(
  selection: SyntheticAuthStateSelection | undefined
): { target: DynamoAuthStateConfig; receipt: DynamoAuthStateRestoreReceipt } | undefined {
  if (selection === undefined) return undefined;
  const config = normalizeAwsAuthStateConfig(selection.config);
  if (config.backend === 'postgresql') {
    if ('receipt' in selection && selection.receipt !== undefined) return fail();
    return undefined;
  }
  const receipt = 'receipt' in selection ? selection.receipt : undefined;
  if (
    !receipt ||
    receipt.tenantId !== TENANT ||
    receipt.source.tenantId !== TENANT ||
    receipt.authState.namespace !== config.namespace
  )
    return fail();
  return { target: config, receipt };
}
