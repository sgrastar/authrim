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

export const CONTROL_TOKEN_CLEANUP_CREDENTIAL_REQUIRED =
  'control_token_cleanup_token_edit_credential_required' as const;
export const CONTROL_TOKEN_CLEANUP_CREDENTIAL_UNAUTHORIZED =
  'control_token_cleanup_token_edit_credential_unauthorized' as const;
export const CONTROL_TOKEN_CLEANUP_PERMISSION_REQUIRED =
  'control_token_cleanup_token_edit_permission_required' as const;

export type ControlTokenManualCleanupReason =
  | typeof MISSING_CONTROL_TOKEN_CLEANUP_CHECKPOINT
  | typeof CONTROL_TOKEN_CLEANUP_CREDENTIAL_REQUIRED
  | typeof CONTROL_TOKEN_CLEANUP_CREDENTIAL_UNAUTHORIZED
  | typeof CONTROL_TOKEN_CLEANUP_PERMISSION_REQUIRED;

export interface ControlTokenManualCleanupIssue {
  reason: ControlTokenManualCleanupReason;
  /** Exact IDs retained from the integrity-checked cleanup checkpoint, when available. */
  targetTokenIds?: string[];
  tokenOwnership?: 'account' | 'user';
}

export interface ControlTokenManualCleanupTarget extends ControlTokenManualCleanupIssue {
  /** Informational candidates only; names are never treated as deletion ownership evidence. */
  expectedTokenNames: string[];
  accountTokensDashboardUrl: string;
  userTokensDashboardUrl: string;
}

export class ControlTokenCleanupManualActionError extends Error {
  readonly issue: ControlTokenManualCleanupIssue;

  constructor(issue: ControlTokenManualCleanupIssue, options?: ErrorOptions) {
    super(issue.reason, options);
    this.name = 'ControlTokenCleanupManualActionError';
    this.issue = issue;
  }
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
    targetTokenIds: Array.from(
      new Set(
        (input.issue.targetTokenIds ?? []).filter((tokenId) => /^[0-9a-f]{32}$/u.test(tokenId))
      )
    ).sort(),
    expectedTokenNames,
    accountTokensDashboardUrl: 'https://dash.cloudflare.com/?to=/:account/api-tokens',
    userTokensDashboardUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  };
}
