/** Service memberships only. No authorization or token claims are granted by these contracts. */
export type Truth = true | false | 'unknown';
export type Scalar = string | number | boolean;
export type FieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'number[]' | 'boolean[]';
export interface Field {
  type: FieldType;
  normalize?: 'domain' | 'email' | 'country';
  schemaId?: string;
  schemaVersion?: number;
  pii?: boolean;
}
export type Expression =
  | { op: 'all' | 'any'; args: Expression[] }
  | { op: 'not'; arg: Expression }
  | { op: 'member'; groupId: string }
  | {
      op: 'attribute';
      field: string;
      compare: 'eq' | 'in' | 'contains' | 'lt' | 'lte' | 'gt' | 'gte';
      value: Scalar | Scalar[];
    };
export interface ServiceGroup {
  id: string;
  tenantId: string;
  key: string;
  displayName: string;
  description: string;
  enabled: boolean;
  condition: Expression | null;
  scimRoleId?: string;
}
export interface CompiledNode {
  expression:
    | Exclude<Expression, { op: 'all' | 'any' } | { op: 'not' }>
    | { op: 'all' | 'any' | 'not' };
  children: string[];
}
export interface GroupPlan {
  tenantId: string;
  groups: ServiceGroup[];
  fields: Record<string, Field>;
  nodes: Record<string, CompiledNode>;
  order: string[];
  roots: Record<string, string | null>;
  attributes: Record<string, string[]>;
  dependents: Record<string, string[]>;
  dependencies: Record<string, string[]>;
}
export interface EvaluationInput {
  attributes: Record<string, unknown>;
  sources: Record<string, { manual: boolean; scim: Truth }>;
}
export interface Evaluation {
  nodes: Record<string, Truth>;
  groups: Record<string, { member: Truth; dynamic: Truth; sources: string[] }>;
  evaluatedNodes: number;
}
export const GROUP_LIMITS = {
  groups: 256,
  nodes: 128,
  depth: 12,
  chain: 16,
  references: 32,
  fields: 128,
  bytes: 65536,
};
export const BUILTIN_GROUP_FIELDS: Record<string, Field> = {
  email: { type: 'string', normalize: 'email', pii: true },
  email_domain: { type: 'string', normalize: 'domain', pii: true },
  email_verified: { type: 'boolean' },
  country: { type: 'string', normalize: 'country', pii: true },
  registration_state: { type: 'string' },
};
