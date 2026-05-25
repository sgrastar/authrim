export type SupportOpsResourceName = 'User';

export type SupportOpsFieldType = 'boolean' | 'datetime' | 'enum' | 'number' | 'string';

export type SupportOpsSelectorOperator =
  | 'eq'
  | 'ne'
  | 'in'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'exists'
  | 'not_exists';

export type SupportOpsActionName = 'suspend' | 'delete' | 'revoke_sessions' | 'resync_profile';

export interface SupportOpsFieldDescriptor {
  type: SupportOpsFieldType;
  filterable: boolean;
  aggregatable: boolean;
  sensitive: boolean;
  operators: SupportOpsSelectorOperator[];
  values?: Array<string | number | boolean>;
}

export interface SupportOpsActionDescriptor {
  destructive: boolean;
  approvalRequired: boolean;
  implemented: boolean;
}

export interface SupportOpsResourceDescriptor {
  resource: SupportOpsResourceName;
  displayName: string;
  minCount: number;
  maxSnapshotCount: number;
  fields: Record<string, SupportOpsFieldDescriptor>;
  actions: Record<SupportOpsActionName, SupportOpsActionDescriptor>;
}

export interface SupportOpsSelectorCondition {
  field: string;
  op: SupportOpsSelectorOperator;
  value?: string | number | boolean | Array<string | number | boolean>;
}

export interface SupportOpsSelectorGroup {
  all?: SupportOpsSelector[];
  any?: SupportOpsSelector[];
}

export type SupportOpsSelector = SupportOpsSelectorCondition | SupportOpsSelectorGroup;

export interface SupportOpsRiskSummary {
  minCount: number;
  matchedCount: number;
  lowCountSuppressed: boolean;
  usesSensitiveField: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  approvalRequired: boolean;
}

export interface SupportOpsCohortSummary {
  cohortId: string;
  resource: SupportOpsResourceName;
  matchedCount: number;
  actionableCount: number;
  blockedCount: number;
  blockedReasons: string[];
  expiresAt: number;
  selectorHash: string;
  risk: SupportOpsRiskSummary;
}

export interface SupportOpsActionSummary {
  actionId: string;
  cohortId: string;
  resource: SupportOpsResourceName;
  action: SupportOpsActionName;
  status: 'approval_required' | 'approved' | 'running' | 'completed' | 'failed' | 'cancelled';
  reason: string;
  supportCaseId?: string | null;
  matchedCount: number;
  actionableCount: number;
  blockedCount: number;
  succeededCount?: number;
  failedCount?: number;
  requestedBy: string;
  approvedBy?: string | null;
  createdAt: number;
  updatedAt: number;
}
