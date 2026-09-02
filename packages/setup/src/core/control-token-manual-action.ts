import {
  buildCloudflareBootstrapTokenName,
  buildCloudflareChildTokenName,
  type ControlTokenResourceClass,
} from './cloudflare-control-token-bootstrap.js';

const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const CONTROL_TOKEN_RESOURCE_CLASSES: readonly ControlTokenResourceClass[] = [
  'd1',
  'workers',
  'kv',
  'r2',
];

export const MISSING_CONTROL_TOKEN_CLEANUP_CHECKPOINT =
  'control_token_cleanup_checkpoint_required_for_missing_control_database_manual_recovery_required' as const;

export interface ControlTokenManualCleanupIssue {
  reason: typeof MISSING_CONTROL_TOKEN_CLEANUP_CHECKPOINT;
}

export interface ControlTokenManualCleanupTarget extends ControlTokenManualCleanupIssue {
  /** Informational candidates only; names are never treated as deletion ownership evidence. */
  expectedTokenNames: string[];
  accountTokensDashboardUrl: string;
  userTokensDashboardUrl: string;
}

export function buildControlTokenManualCleanupTarget(input: {
  issue: ControlTokenManualCleanupIssue;
  accountId: string | null | undefined;
  environment: string;
}): ControlTokenManualCleanupTarget {
  const expectedTokenNames = ACCOUNT_ID.test(input.accountId ?? '')
    ? [
        buildCloudflareBootstrapTokenName({
          accountId: input.accountId!,
          environment: input.environment,
        }),
        ...CONTROL_TOKEN_RESOURCE_CLASSES.map((resourceClass) =>
          buildCloudflareChildTokenName({
            accountId: input.accountId!,
            environment: input.environment,
            resourceClass,
          })
        ),
      ]
    : [];

  return {
    ...input.issue,
    expectedTokenNames,
    accountTokensDashboardUrl: 'https://dash.cloudflare.com/?to=/:account/api-tokens',
    userTokensDashboardUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  };
}
