import type {
  SupportOpsActionName,
  SupportOpsFieldDescriptor,
  SupportOpsResourceDescriptor,
  SupportOpsResourceName,
  SupportOpsRiskSummary,
  SupportOpsSelector,
  SupportOpsSelectorCondition,
  SupportOpsSelectorGroup,
  SupportOpsSelectorOperator,
} from '../types/support-ops';

export interface SupportOpsCompiledSelector {
  whereSql: string;
  params: unknown[];
  selectorHash: string;
}

export interface SupportOpsValidationResult {
  valid: boolean;
  error?: string;
}

export interface SupportOpsSqlFieldDescriptor extends SupportOpsFieldDescriptor {
  column: string;
}

export interface SupportOpsSqlResourceDescriptor extends Omit<
  SupportOpsResourceDescriptor,
  'fields'
> {
  table: string;
  idColumn: string;
  activeWhereSql: string;
  fields: Record<string, SupportOpsSqlFieldDescriptor>;
}

const DEFAULT_OPERATORS: Record<string, SupportOpsSelectorOperator[]> = {
  boolean: ['eq', 'ne', 'exists', 'not_exists'],
  datetime: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'exists', 'not_exists'],
  enum: ['eq', 'ne', 'in', 'exists', 'not_exists'],
  number: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'exists', 'not_exists'],
  string: ['eq', 'ne', 'in', 'exists', 'not_exists'],
};

const USER_RESOURCE: SupportOpsSqlResourceDescriptor = {
  resource: 'User',
  displayName: 'Users',
  minCount: 10,
  maxSnapshotCount: 10_000,
  table: 'identity_accounts',
  idColumn: 'legacy_user_id',
  activeWhereSql: "lifecycle_state = 'active' AND legacy_user_id IS NOT NULL",
  fields: {
    status: {
      column: "json_extract(metadata_json, '$.status')",
      type: 'enum',
      filterable: true,
      aggregatable: false,
      sensitive: false,
      operators: DEFAULT_OPERATORS.enum,
      values: ['active', 'suspended', 'locked'],
    },
    lifecycle_state: {
      column: 'lifecycle_state',
      type: 'enum',
      filterable: true,
      aggregatable: true,
      sensitive: false,
      operators: DEFAULT_OPERATORS.enum,
      values: [
        'invited',
        'pending_verification',
        'provisioning',
        'incomplete',
        'active',
        'dormant',
        'archived',
        'deprovisioned',
      ],
    },
    email_verified: {
      column:
        "(EXISTS (SELECT 1 FROM contact_points cp WHERE cp.tenant_id = identity_accounts.tenant_id AND cp.account_id = identity_accounts.id AND cp.contact_type = 'email' AND cp.verification_state = 'verified' AND cp.lifecycle_state = 'active'))",
      type: 'boolean',
      filterable: true,
      aggregatable: false,
      sensitive: false,
      operators: DEFAULT_OPERATORS.boolean,
    },
    pii_status: {
      column:
        "(CASE WHEN EXISTS (SELECT 1 FROM identity_sensitive_values isv WHERE isv.tenant_id = identity_accounts.tenant_id AND isv.owner_type = 'runtime_user' AND isv.owner_id = identity_accounts.legacy_user_id AND isv.lifecycle_state = 'active') THEN 'active' ELSE 'none' END)",
      type: 'enum',
      filterable: true,
      aggregatable: false,
      sensitive: false,
      operators: DEFAULT_OPERATORS.enum,
      values: ['none', 'active'],
    },
    user_type: {
      column: 'account_type',
      type: 'enum',
      filterable: true,
      aggregatable: true,
      sensitive: false,
      operators: DEFAULT_OPERATORS.enum,
      values: ['user', 'admin', 'service_account', 'anonymous'],
    },
    created_at: {
      column: 'created_at',
      type: 'datetime',
      filterable: true,
      aggregatable: false,
      sensitive: false,
      operators: DEFAULT_OPERATORS.datetime,
    },
    updated_at: {
      column: 'updated_at',
      type: 'datetime',
      filterable: true,
      aggregatable: false,
      sensitive: false,
      operators: DEFAULT_OPERATORS.datetime,
    },
    last_login_at: {
      column: 'last_login_at',
      type: 'datetime',
      filterable: true,
      aggregatable: false,
      sensitive: false,
      operators: DEFAULT_OPERATORS.datetime,
    },
    email: {
      column: '',
      type: 'string',
      filterable: false,
      aggregatable: false,
      sensitive: true,
      operators: [],
    },
  },
  actions: {
    suspend: { destructive: false, approvalRequired: true, implemented: true },
    delete: { destructive: true, approvalRequired: true, implemented: false },
    revoke_sessions: { destructive: false, approvalRequired: true, implemented: false },
    resync_profile: { destructive: false, approvalRequired: true, implemented: false },
  },
};

const RESOURCE_REGISTRY: Record<SupportOpsResourceName, SupportOpsSqlResourceDescriptor> = {
  User: USER_RESOURCE,
};

export function listSupportOpsResources(): SupportOpsResourceDescriptor[] {
  return Object.values(RESOURCE_REGISTRY).map((resource) => {
    const fields: Record<string, SupportOpsFieldDescriptor> = {};
    for (const [name, field] of Object.entries(resource.fields)) {
      fields[name] = {
        type: field.type,
        filterable: field.filterable,
        aggregatable: field.aggregatable,
        sensitive: field.sensitive,
        operators: [...field.operators],
        values: field.values ? [...field.values] : undefined,
      };
    }
    return {
      resource: resource.resource,
      displayName: resource.displayName,
      minCount: resource.minCount,
      maxSnapshotCount: resource.maxSnapshotCount,
      fields,
      actions: resource.actions,
    };
  });
}

export function getSupportOpsResource(resource: string): SupportOpsSqlResourceDescriptor | null {
  return RESOURCE_REGISTRY[resource as SupportOpsResourceName] ?? null;
}

export function validateSupportOpsAction(
  resource: SupportOpsSqlResourceDescriptor,
  action: string
): SupportOpsValidationResult {
  const descriptor = resource.actions[action as SupportOpsActionName];
  if (!descriptor) {
    return { valid: false, error: `Unsupported action for resource: ${action}` };
  }
  if (!descriptor.implemented) {
    return { valid: false, error: `Action is reserved but not implemented: ${action}` };
  }
  return { valid: true };
}

function isSelectorCondition(
  selector: SupportOpsSelector
): selector is SupportOpsSelectorCondition {
  return (
    typeof selector === 'object' && selector !== null && 'field' in selector && 'op' in selector
  );
}

function isSelectorGroup(selector: SupportOpsSelector): selector is SupportOpsSelectorGroup {
  return (
    typeof selector === 'object' && selector !== null && ('all' in selector || 'any' in selector)
  );
}

function normalizeValue(field: SupportOpsSqlFieldDescriptor, value: unknown): unknown {
  if (field.type === 'datetime') {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const parsed = new Date(value).getTime();
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (field.type === 'boolean') {
    if (typeof value === 'boolean') return value ? 1 : 0;
  }
  return value;
}

function sqlValueExpression(field: SupportOpsSqlFieldDescriptor): string {
  if (field.type !== 'datetime') {
    return field.column;
  }
  return `CASE WHEN ${field.column} > 0 AND ${field.column} < 100000000000 THEN ${field.column} * 1000 ELSE ${field.column} END`;
}

function validateConditionValue(
  field: SupportOpsSqlFieldDescriptor,
  op: SupportOpsSelectorOperator,
  value: unknown
): SupportOpsValidationResult {
  if (op === 'exists' || op === 'not_exists') {
    return { valid: true };
  }
  if (value === undefined || value === null) {
    return { valid: false, error: 'Selector condition value is required' };
  }
  if (op === 'in') {
    if (!Array.isArray(value) || value.length === 0 || value.length > 25) {
      return { valid: false, error: 'in operator requires 1-25 values' };
    }
    if (
      field.values &&
      value.some((item) => !field.values?.includes(item as string | number | boolean))
    ) {
      return { valid: false, error: `Unsupported value for field` };
    }
    return { valid: true };
  }
  if (Array.isArray(value)) {
    return { valid: false, error: `${op} operator does not accept array values` };
  }
  if (field.values && !field.values.includes(value as string | number | boolean)) {
    return { valid: false, error: `Unsupported value for field` };
  }
  return { valid: true };
}

function compileCondition(
  resource: SupportOpsSqlResourceDescriptor,
  condition: SupportOpsSelectorCondition
): SupportOpsCompiledSelector {
  const field = resource.fields[condition.field];
  if (!field || !field.filterable || field.sensitive) {
    throw new Error(`Field is not filterable: ${condition.field}`);
  }
  if (!field.operators.includes(condition.op)) {
    throw new Error(`Operator ${condition.op} is not allowed for ${condition.field}`);
  }
  const valueValidation = validateConditionValue(field, condition.op, condition.value);
  if (!valueValidation.valid) {
    throw new Error(valueValidation.error ?? 'Invalid selector condition');
  }

  const column = field.column;
  const valueExpression = sqlValueExpression(field);
  switch (condition.op) {
    case 'exists':
      return { whereSql: `${column} IS NOT NULL`, params: [], selectorHash: '' };
    case 'not_exists':
      return { whereSql: `${column} IS NULL`, params: [], selectorHash: '' };
    case 'eq':
      return {
        whereSql: `${valueExpression} = ?`,
        params: [normalizeValue(field, condition.value)],
        selectorHash: '',
      };
    case 'ne':
      return {
        whereSql: `${valueExpression} != ?`,
        params: [normalizeValue(field, condition.value)],
        selectorHash: '',
      };
    case 'lt':
      return {
        whereSql: `${valueExpression} < ?`,
        params: [normalizeValue(field, condition.value)],
        selectorHash: '',
      };
    case 'lte':
      return {
        whereSql: `${valueExpression} <= ?`,
        params: [normalizeValue(field, condition.value)],
        selectorHash: '',
      };
    case 'gt':
      return {
        whereSql: `${valueExpression} > ?`,
        params: [normalizeValue(field, condition.value)],
        selectorHash: '',
      };
    case 'gte':
      return {
        whereSql: `${valueExpression} >= ?`,
        params: [normalizeValue(field, condition.value)],
        selectorHash: '',
      };
    case 'in': {
      const values = (condition.value as Array<string | number | boolean>).map((v) =>
        normalizeValue(field, v)
      );
      return {
        whereSql: `${valueExpression} IN (${values.map(() => '?').join(', ')})`,
        params: values,
        selectorHash: '',
      };
    }
  }
}

function compileSelectorPart(
  resource: SupportOpsSqlResourceDescriptor,
  selector: SupportOpsSelector
): { whereSql: string; params: unknown[] } {
  if (isSelectorCondition(selector)) {
    const compiled = compileCondition(resource, selector);
    return { whereSql: compiled.whereSql, params: compiled.params };
  }

  if (!isSelectorGroup(selector)) {
    throw new Error('Selector must be a condition or group');
  }

  const hasAll = selector.all !== undefined;
  const hasAny = selector.any !== undefined;
  if (hasAll === hasAny) {
    throw new Error('Selector group must include exactly one of all or any');
  }

  const group = selector.all ?? selector.any;
  const joiner = selector.all ? ' AND ' : ' OR ';
  if (!Array.isArray(group) || group.length === 0 || group.length > 20) {
    throw new Error('Selector group requires 1-20 conditions');
  }

  const compiled = group.map((child) => compileSelectorPart(resource, child));
  return {
    whereSql: `(${compiled.map((item) => item.whereSql).join(joiner)})`,
    params: compiled.flatMap((item) => item.params),
  };
}

export async function hashSupportOpsSelector(input: unknown): Promise<string> {
  const canonical = JSON.stringify(input);
  const data = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

export async function compileSupportOpsSelector(
  resource: SupportOpsSqlResourceDescriptor,
  selector: SupportOpsSelector | undefined
): Promise<SupportOpsCompiledSelector> {
  if (!selector) {
    return {
      whereSql: '1 = 1',
      params: [],
      selectorHash: await hashSupportOpsSelector({}),
    };
  }
  const compiled = compileSelectorPart(resource, selector);
  return {
    ...compiled,
    selectorHash: await hashSupportOpsSelector(selector),
  };
}

export function buildSupportOpsRiskSummary(input: {
  resource: SupportOpsSqlResourceDescriptor;
  matchedCount: number;
  action?: SupportOpsActionName;
}): SupportOpsRiskSummary {
  const action = input.action ? input.resource.actions[input.action] : undefined;
  const lowCountSuppressed = input.matchedCount > 0 && input.matchedCount < input.resource.minCount;
  return {
    minCount: input.resource.minCount,
    matchedCount: input.matchedCount,
    lowCountSuppressed,
    usesSensitiveField: false,
    riskLevel: action?.destructive ? 'high' : input.matchedCount >= 1000 ? 'medium' : 'low',
    approvalRequired: action?.approvalRequired ?? false,
  };
}
