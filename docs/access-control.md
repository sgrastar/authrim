# Access Control Architecture

Comprehensive documentation for Authrim's access control system, covering RBAC, ABAC, and ReBAC models.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [RBAC (Role-Based Access Control)](#rbac-role-based-access-control)
4. [ABAC (Attribute-Based Access Control)](#abac-attribute-based-access-control)
5. [ReBAC (Relationship-Based Access Control)](#rebac-relationship-based-access-control)
6. [Unified Check Service](#unified-check-service)
7. [Feature Flags](#feature-flags)
8. [API Reference](#api-reference)
9. [Database Schema](#database-schema)
10. [Usage Examples](#usage-examples)
11. [Best Practices](#best-practices)
12. [Comparison Matrix](#comparison-matrix)

---

## Overview

Authrim implements a **three-tier unified access control system** that combines:

| Model | Primary Use Case | Complexity | Performance |
|-------|-----------------|------------|-------------|
| **RBAC** | Team structures, administrative hierarchies | Low | O(1) role lookup |
| **ABAC** | Compliance rules, attribute-based policies | Medium | O(n) attribute scan |
| **ReBAC** | Resource hierarchies, sharing models | High | O(d) depth traversal |

All three models are evaluated through a **Unified Check Service** in priority order:

```
ID-Level → RBAC → ReBAC → ABAC/Computed
```

---

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Check API Request                          │
│  POST /api/check { subject_id, permission, resource_context? }     │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Unified Check Service                           │
│  packages/ar-lib-core/src/services/unified-check-service.ts        │
└─────────────────────────────────────────────────────────────────────┘
          │              │              │              │
          ▼              ▼              ▼              ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
    │ ID-Level │   │   RBAC   │   │  ReBAC   │   │   ABAC   │
    │  Check   │   │  Check   │   │  Check   │   │  Check   │
    └──────────┘   └──────────┘   └──────────┘   └──────────┘
          │              │              │              │
          ▼              ▼              ▼              ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
    │ resource │   │  roles   │   │relation- │   │ verified │
    │permissions│  │role_assign│  │  ships   │   │attributes│
    │  (D1)    │   │  (D1)    │   │  (D1)    │   │  (D1)    │
    └──────────┘   └──────────┘   └──────────┘   └──────────┘
```

### Key Files

| Component | Location |
|-----------|----------|
| Policy Types | `packages/ar-lib-policy/src/types.ts` |
| Policy Engine | `packages/ar-lib-policy/src/engine.ts` |
| Role Checker | `packages/ar-lib-policy/src/role-checker.ts` |
| Feature Flags | `packages/ar-lib-policy/src/feature-flags.ts` |
| ReBAC Types | `packages/ar-lib-core/src/rebac/types.ts` |
| ReBAC Service | `packages/ar-lib-core/src/rebac/rebac-service.ts` |
| Unified Check | `packages/ar-lib-core/src/services/unified-check-service.ts` |
| Check API | `packages/ar-policy/src/routes/check.ts` |

---

## RBAC (Role-Based Access Control)

### Core Concepts

RBAC provides hierarchical role-based access decisions with scoped role support.

#### Role Hierarchy (Default)

| Role | Priority | Scope | Description |
|------|----------|-------|-------------|
| `system_admin` | 1000 | Global | Full system access |
| `distributor_admin` | 900 | Global | Distributor-level access |
| `org_admin` | 800 | Org | Organization-level access |
| `end_user` | - | Varies | Standard user role |

### Type Definitions

#### PolicySubject

```typescript
interface PolicySubject {
  /** Subject identifier (user ID) */
  id: string;

  /** User type classification */
  userType?: UserType;

  /** Roles assigned to the subject */
  roles: SubjectRole[];

  /** Primary organization ID */
  orgId?: string;

  /** Organization plan (for plan-based policies) */
  plan?: PlanType;

  /** Organization type */
  orgType?: OrganizationType;

  /** Relationships where this subject is the parent/guardian */
  relationships?: SubjectRelationship[];
}
```

#### SubjectRole

```typescript
interface SubjectRole {
  /** Role name (e.g., 'system_admin', 'org_admin', 'end_user') */
  name: string;

  /** Scope of the role: 'global' | 'org' | 'resource' */
  scope: ScopeType;

  /** Scope target (e.g., 'org:org_123', 'resource:doc_456') */
  scopeTarget?: string;

  /** Expiration timestamp (UNIX milliseconds) */
  expiresAt?: number;
}
```

### Scoped Roles

Roles support three scope levels:

| Scope | Description | Example |
|-------|-------------|---------|
| `global` | Applies everywhere | System administrator |
| `org` | Limited to specific organization | `scopeTarget: "org:org_123"` |
| `resource` | Limited to specific resource | `scopeTarget: "resource:doc_456"` |

**Scope Resolution:**
- Global scope matches all scope requirements
- Org scope only matches within the same organization
- Resource scope only matches the specific resource

### RBAC Condition Types

| Condition | Description | Parameters |
|-----------|-------------|------------|
| `has_role` | Subject has specific role | `{ role, scope?, scopeTarget? }` |
| `has_any_role` | Subject has any of roles (OR) | `{ roles[], scope?, scopeTarget? }` |
| `has_all_roles` | Subject has all roles (AND) | `{ roles[], scope?, scopeTarget? }` |
| `is_resource_owner` | Subject owns the resource | `{}` |
| `same_organization` | Subject and resource in same org | `{}` |
| `has_relationship` | Subject has relationship with owner | `{ types[] }` |
| `user_type_is` | Subject's user type matches | `{ types[] }` |
| `plan_allows` | Organization plan allows action | `{ plans[] }` |

### Role Checker Utilities

Located in `packages/ar-lib-policy/src/role-checker.ts`:

```typescript
import {
  hasRole,
  hasAnyRole,
  hasAllRoles,
  isAdmin,
  isSystemAdmin,
  isOrgAdmin,
  getActiveRoles,
  subjectFromClaims
} from '@authrim/ar-lib-policy';

// Check single role
if (hasRole(subject, 'org_admin', { scope: 'org', scopeTarget: 'org:123' })) {
  // User is admin of organization 123
}

// Check any role (OR)
if (hasAnyRole(subject, ['system_admin', 'org_admin'])) {
  // User has at least one admin role
}

// Check all roles (AND)
if (hasAllRoles(subject, ['viewer', 'commenter'])) {
  // User has both roles
}

// Quick admin checks
if (isSystemAdmin(subject)) { /* ... */ }
if (isOrgAdmin(subject, 'org_123')) { /* ... */ }

// Get active roles
const activeRoles = getActiveRoles(subject, { scope: 'org', scopeTarget: 'org:123' });

// Create subject from JWT claims
const subject = subjectFromClaims({
  sub: 'user_123',
  authrim_roles: ['end_user', 'org_admin'],
  authrim_org_id: 'org_456',
  authrim_plan: 'professional'
});
```

### Default Policy Rules

The default policy engine includes these built-in rules:

```typescript
const defaultRules = [
  {
    id: 'system_admin_full_access',
    name: 'System Admin Full Access',
    priority: 1000,
    effect: 'allow',
    conditions: [{ type: 'has_role', params: { role: 'system_admin' } }]
  },
  {
    id: 'distributor_admin_access',
    name: 'Distributor Admin Access',
    priority: 900,
    effect: 'allow',
    conditions: [{ type: 'has_role', params: { role: 'distributor_admin' } }]
  },
  {
    id: 'org_admin_same_org',
    name: 'Org Admin Same Organization',
    priority: 800,
    effect: 'allow',
    conditions: [
      { type: 'has_role', params: { role: 'org_admin' } },
      { type: 'same_organization', params: {} }
    ]
  },
  {
    id: 'owner_full_access',
    name: 'Resource Owner Access',
    priority: 700,
    effect: 'allow',
    conditions: [{ type: 'is_resource_owner', params: {} }]
  },
  {
    id: 'guardian_access',
    name: 'Guardian Access',
    priority: 600,
    effect: 'allow',
    conditions: [{ type: 'has_relationship', params: { types: ['parent_of', 'guardian_of'] } }]
  }
];
```

---

## ABAC (Attribute-Based Access Control)

### Core Concepts

ABAC enables flexible attribute-based evaluation with support for Verifiable Credentials (VC) and KYC integration.

### Type Definitions

#### VerifiedAttribute

```typescript
interface VerifiedAttribute {
  /** Attribute name (e.g., 'age_over_18', 'subscription_tier') */
  name: string;

  /** Attribute value */
  value: string | null;

  /** Source of the attribute */
  source: 'manual' | 'vc' | 'jwt_sd' | 'kyc_provider';

  /** Issuer (DID or URL) for VC-sourced attributes */
  issuer?: string;

  /** Expiration timestamp (UNIX seconds) */
  expiresAt?: number;
}
```

#### PolicySubjectWithAttributes

```typescript
interface PolicySubjectWithAttributes extends PolicySubject {
  /** Verified attributes for ABAC evaluation */
  verifiedAttributes?: VerifiedAttribute[];
}
```

### Attribute Sources

| Source | Description | Use Case |
|--------|-------------|----------|
| `manual` | Manually assigned by admin | Internal policies |
| `vc` | Verifiable Credential | External identity verification |
| `jwt_sd` | SD-JWT (Selective Disclosure) | Privacy-preserving claims |
| `kyc_provider` | KYC service verification | Age/identity verification |

### ABAC Condition Types

| Condition | Description | Parameters |
|-----------|-------------|------------|
| `attribute_equals` | Attribute matches specific value | `{ name, value, checkExpiry? }` |
| `attribute_exists` | Attribute exists (any value) | `{ name, checkExpiry? }` |
| `attribute_in` | Attribute value in allowed list | `{ name, values[], checkExpiry? }` |

### ABAC Condition Examples

```typescript
// Check subscription tier
{
  type: 'attribute_equals',
  params: {
    name: 'subscription_tier',
    value: 'premium',
    checkExpiry: true  // Default: true
  }
}

// Check if medical license exists
{
  type: 'attribute_exists',
  params: {
    name: 'medical_license'
  }
}

// Check role level in allowed list
{
  type: 'attribute_in',
  params: {
    name: 'role_level',
    values: ['senior', 'lead', 'manager']
  }
}
```

### ABAC Policy Rule Example

```typescript
const premiumFeatureRule: PolicyRule = {
  id: 'premium_feature_access',
  name: 'Premium Feature Access',
  description: 'Only premium subscribers can access this feature',
  priority: 500,
  effect: 'allow',
  conditions: [
    {
      type: 'attribute_equals',
      params: { name: 'subscription_tier', value: 'premium' }
    }
  ]
};
```

### Verified Attributes Database Schema

```sql
CREATE TABLE verified_attributes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  attribute_name TEXT NOT NULL,
  attribute_value TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  issuer TEXT,
  credential_id TEXT,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, subject_id, attribute_name)
);
```

---

## ReBAC (Relationship-Based Access Control)

### Core Concepts

ReBAC provides a **Zanzibar-lite** implementation for relationship-based access control with support for:

- Direct relationships
- Union (OR) expressions
- Transitive relationships (tuple-to-userset)
- Closure table for efficient list operations

### Check Request/Response

#### CheckRequest

```typescript
interface CheckRequest {
  /** Tenant ID for multi-tenant isolation */
  tenant_id: string;

  /** Subject (user) identifier - "user:user_123" or "user_123" */
  user_id: string;

  /** Relation to check - "viewer", "editor", "owner" */
  relation: string;

  /** Object identifier - "document:doc_456" */
  object: string;

  /** Optional: Object type if not embedded in object string */
  object_type?: string;

  /** Optional: Context for conditional checks (Phase 4+) */
  context?: Record<string, unknown>;
}
```

#### CheckResponse

```typescript
interface CheckResponse {
  /** Whether the check is allowed */
  allowed: boolean;

  /** How the result was resolved */
  resolved_via?: 'direct' | 'computed' | 'cache' | 'closure';

  /** Path through relationships (for debugging) */
  path?: string[];

  /** Cached until timestamp (for debugging) */
  cached_until?: number;
}
```

### Relation DSL (Domain-Specific Language)

The Relation DSL defines how relations are computed for object types.

#### DirectRelation

Matches a specific relation tuple directly.

```typescript
interface DirectRelation {
  type: 'direct';
  relation: string;  // e.g., "viewer"
}
```

**Example:**
```json
{ "type": "direct", "relation": "viewer" }
```

#### UnionRelation

OR of multiple expressions (any must match).

```typescript
interface UnionRelation {
  type: 'union';
  children: RelationExpression[];
}
```

**Example:**
```json
{
  "type": "union",
  "children": [
    { "type": "direct", "relation": "owner" },
    { "type": "direct", "relation": "editor" },
    { "type": "direct", "relation": "viewer" }
  ]
}
```

#### TupleToUsersetRelation

Inherit permissions from related objects (transitive).

```typescript
interface TupleToUsersetRelation {
  type: 'tuple_to_userset';
  tupleset: {
    relation: string;  // Relation to traverse (e.g., "parent")
  };
  computed_userset: {
    relation: string;  // Relation to check on related object (e.g., "viewer")
  };
}
```

**Example:** Document inherits viewer permissions from parent folder.

```json
{
  "type": "tuple_to_userset",
  "tupleset": { "relation": "parent" },
  "computed_userset": { "relation": "viewer" }
}
```

#### IntersectionRelation (Phase 4+)

AND of multiple expressions (all must match).

```typescript
interface IntersectionRelation {
  type: 'intersection';
  children: RelationExpression[];
}
```

#### ExclusionRelation (Phase 4+)

NOT expression (base minus excluded).

```typescript
interface ExclusionRelation {
  type: 'exclusion';
  base: RelationExpression;
  subtract: RelationExpression;
}
```

### Complete Relation Definition Example

A document's `viewer` relation that includes direct viewers, editors, owners, and viewers of the parent folder:

```json
{
  "id": "def_doc_viewer",
  "tenant_id": "tenant_123",
  "object_type": "document",
  "relation_name": "viewer",
  "definition": {
    "type": "union",
    "children": [
      { "type": "direct", "relation": "owner" },
      { "type": "direct", "relation": "editor" },
      { "type": "direct", "relation": "viewer" },
      {
        "type": "tuple_to_userset",
        "tupleset": { "relation": "parent" },
        "computed_userset": { "relation": "viewer" }
      }
    ]
  },
  "priority": 100,
  "is_active": true
}
```

### ReBAC Service Configuration

```typescript
interface ReBACConfig {
  /** KV namespace for caching */
  cache_namespace?: KVNamespace;

  /** Cache TTL in seconds (default: 60) */
  cache_ttl?: number;

  /** Maximum recursion depth (default: 5) */
  max_depth?: number;

  /** Enable closure table for list operations */
  enable_closure_table?: boolean;

  /** Batch size for closure table updates */
  closure_batch_size?: number;
}
```

### Resolution Order

1. **Request-scoped cache** - Deduplication within single request
2. **KV cache** - TTL-based cache (default: 60s)
3. **Recursive CTE** - Database computation with cycle detection

### Safety Features

| Feature | Implementation |
|---------|----------------|
| Cycle detection | `visited` Set tracking |
| Depth limiting | `DEFAULT_MAX_DEPTH = 5` |
| Cache invalidation | TTL-based + manual invalidation |
| Multi-tenant isolation | `tenant_id` on all queries |

### List Operations

For efficient listing of objects/users, ReBAC uses a pre-computed **closure table**:

```typescript
// List objects user can access
interface ListObjectsRequest {
  tenant_id: string;
  user_id: string;
  relation: string;
  object_type: string;
  limit?: number;
  cursor?: string;
}

// List users with access to object
interface ListUsersRequest {
  tenant_id: string;
  object: string;
  object_type?: string;
  relation: string;
  limit?: number;
  cursor?: string;
}
```

### Relationship Tuple Format

Following Zanzibar conventions:

```
object#relation@user
```

**Example:** `document:doc_123#viewer@user:user_456`

```typescript
interface RelationshipTuple {
  object_type: string;     // "document"
  object_id: string;       // "doc_123"
  relation: string;        // "viewer"
  subject_type: string;    // "user"
  subject_id: string;      // "user_456"
  subject_relation?: string;  // For userset subjects
}
```

---

## Unified Check Service

### Evaluation Order

The Unified Check Service evaluates permissions in this order (first match wins):

| Priority | Check Type | Description |
|----------|------------|-------------|
| 1 | ID-Level | `resource:id:action` format (most specific) |
| 2 | RBAC | Role-based conditions |
| 3 | ReBAC | Relationship evaluation |
| 4 | ABAC/Computed | Attribute-based conditions |

### Permission Formats

```typescript
// String formats
"documents:read"           // Type-level
"documents:doc_123:read"   // ID-level

// Object format
{
  resource: "documents",
  id: "doc_123",           // Optional for type-level
  action: "read"
}
```

### Check API Request

```typescript
interface CheckApiRequest {
  /** Subject ID (user or service) */
  subject_id: string;

  /** Subject type */
  subject_type?: 'user' | 'service';

  /** Permission to check */
  permission: string | { resource: string; id?: string; action: string };

  /** Tenant ID */
  tenant_id?: string;

  /** Resource context for ABAC */
  resource_context?: {
    owner_id?: string;
    org_id?: string;
    attributes?: Record<string, unknown>;
  };

  /** ReBAC parameters */
  rebac?: {
    relation: string;
    object: string;
  };
}
```

### Check API Response

```typescript
interface CheckApiResponse {
  /** Whether access is allowed */
  allowed: boolean;

  /** How the result was resolved */
  resolved_via: ('id_level' | 'role' | 'rebac' | 'computed')[];

  /** Final decision */
  final_decision: 'allow' | 'deny';

  /** Reason for denial */
  reason?: string;

  /** Cache TTL in seconds */
  cache_ttl?: number;

  /** Debug information */
  debug?: {
    matched_rules?: string[];
    path?: string[];
    evaluation_time_ms?: number;
  };
}
```

### Batch Check

```typescript
// Request
interface BatchCheckRequest {
  checks: CheckApiRequest[];
  stop_on_deny?: boolean;  // Stop processing on first deny
}

// Response
interface BatchCheckResponse {
  results: CheckApiResponse[];
  summary: {
    total: number;
    allowed: number;
    denied: number;
    evaluation_time_ms: number;
  };
}
```

---

## Feature Flags

### Available Flags

| Flag | Default | Description |
|------|---------|-------------|
| `ENABLE_ABAC` | `false` | Enable Attribute-Based Access Control |
| `ENABLE_REBAC` | `false` | Enable Relationship-Based Access Control |
| `ENABLE_POLICY_LOGGING` | `false` | Enable detailed policy evaluation logging |
| `ENABLE_VERIFIED_ATTRIBUTES` | `false` | Enable verified attributes checking |
| `ENABLE_CUSTOM_RULES` | `true` | Enable custom policy rules |
| `ENABLE_SD_JWT` | `false` | Enable SD-JWT for ID Token issuance |
| `ENABLE_POLICY_EMBEDDING` | `false` | Enable permission embedding in tokens |

### Resolution Priority

```
KV Override > Environment Variable > Default Value
```

### Usage

```typescript
import { createFeatureFlagsManager } from '@authrim/ar-lib-policy';

const flagsManager = createFeatureFlagsManager(env, kvNamespace);

// Async flag check
const abacEnabled = await flagsManager.isAbacEnabled();
const rebacEnabled = await flagsManager.isRebacEnabled();

// Sync flag check (from cache/env only)
const flags = flagsManager.getFlagsSync();

// Set flag override in KV
await flagsManager.setFlag('ENABLE_ABAC', true);

// Clear flag override (revert to env/default)
await flagsManager.clearFlag('ENABLE_ABAC');
```

---

## API Reference

### Check Endpoints

#### POST /api/check

Single permission check.

**Request:**
```json
{
  "subject_id": "user_123",
  "permission": "documents:doc_456:read",
  "tenant_id": "tenant_abc"
}
```

**Response:**
```json
{
  "allowed": true,
  "resolved_via": ["id_level"],
  "final_decision": "allow",
  "cache_ttl": 60
}
```

#### POST /api/check/batch

Batch permission checks.

**Request:**
```json
{
  "checks": [
    { "subject_id": "user_123", "permission": "documents:read" },
    { "subject_id": "user_123", "permission": "documents:write" }
  ],
  "stop_on_deny": false
}
```

**Response:**
```json
{
  "results": [
    { "allowed": true, "resolved_via": ["role"], "final_decision": "allow" },
    { "allowed": false, "resolved_via": [], "final_decision": "deny", "reason": "no_matching_permission" }
  ],
  "summary": {
    "total": 2,
    "allowed": 1,
    "denied": 1,
    "evaluation_time_ms": 5.23
  }
}
```

### Authentication

| Method | Header Format |
|--------|---------------|
| API Key | `Authorization: Bearer chk_xxx` |
| Access Token | `Authorization: Bearer eyJhbG...` |

### Rate Limiting

Response headers:
- `X-RateLimit-Limit`: Maximum requests per window
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: Window reset timestamp

### Batch Size Limits

| Setting | Default | Max |
|---------|---------|-----|
| `CHECK_API_BATCH_SIZE_LIMIT` | 100 | 1000 |

---

## Database Schema

### Resource Permissions (ID-Level)

```sql
CREATE TABLE resource_permissions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_type TEXT NOT NULL DEFAULT 'user',
  subject_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  actions_json TEXT NOT NULL,      -- JSON array: ["read", "write"]
  condition_json TEXT,             -- Optional JSON condition
  expires_at INTEGER,
  is_active INTEGER DEFAULT 1,
  granted_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, subject_type, subject_id, resource_type, resource_id)
);
```

### Relation Definitions (ReBAC)

```sql
CREATE TABLE relation_definitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  relation_name TEXT NOT NULL,
  definition_json TEXT NOT NULL,   -- JSON RelationExpression
  description TEXT,
  priority INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, object_type, relation_name)
);
```

### Relationship Closure (ReBAC Lists)

```sql
CREATE TABLE relationship_closure (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  ancestor_type TEXT NOT NULL,
  ancestor_id TEXT NOT NULL,
  descendant_type TEXT NOT NULL,
  descendant_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  depth INTEGER NOT NULL,
  path_json TEXT,
  effective_permission TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### Verified Attributes (ABAC)

```sql
CREATE TABLE verified_attributes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  attribute_name TEXT NOT NULL,
  attribute_value TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  issuer TEXT,
  credential_id TEXT,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

---

## Usage Examples

### RBAC: Role-Based Access Check

```typescript
import { PolicyEngine, createDefaultPolicyEngine } from '@authrim/ar-lib-policy';

// Create engine with default rules
const engine = createDefaultPolicyEngine();

// Add custom rule
engine.addRule({
  id: 'project_manager_access',
  name: 'Project Manager Access',
  priority: 750,
  effect: 'allow',
  conditions: [
    { type: 'has_role', params: { role: 'project_manager' } },
    { type: 'same_organization', params: {} }
  ]
});

// Evaluate
const context: PolicyContext = {
  subject: {
    id: 'user_123',
    roles: [{ name: 'project_manager', scope: 'global' }],
    orgId: 'org_456'
  },
  resource: {
    type: 'project',
    id: 'proj_789',
    orgId: 'org_456'
  },
  action: { name: 'edit' },
  timestamp: Date.now()
};

const decision = engine.evaluate(context);
// { allowed: true, reason: 'Rule "Project Manager Access" matched', decidedBy: 'project_manager_access' }
```

### ABAC: Attribute-Based Access Check

```typescript
const engine = new PolicyEngine();

// Premium feature rule
engine.addRule({
  id: 'premium_feature',
  name: 'Premium Feature Access',
  priority: 500,
  effect: 'allow',
  conditions: [
    {
      type: 'attribute_equals',
      params: { name: 'subscription_tier', value: 'premium' }
    }
  ]
});

const context: PolicyContext = {
  subject: {
    id: 'user_123',
    roles: [],
    verifiedAttributes: [
      { name: 'subscription_tier', value: 'premium', source: 'manual' }
    ]
  } as PolicySubjectWithAttributes,
  resource: { type: 'feature', id: 'advanced_analytics' },
  action: { name: 'access' },
  timestamp: Date.now()
};

const decision = engine.evaluate(context);
```

### ReBAC: Relationship-Based Access Check

```typescript
import { createReBACService } from '@authrim/ar-lib-core';

const rebacService = createReBACService({
  db: D1_DATABASE,
  cache_namespace: KV_NAMESPACE,
  cache_ttl: 60,
  max_depth: 5
});

// Check if user can view document
const result = await rebacService.check({
  tenant_id: 'tenant_123',
  user_id: 'user_456',
  relation: 'viewer',
  object: 'document:doc_789'
});

if (result.allowed) {
  console.log('Access granted via:', result.resolved_via);
  console.log('Path:', result.path);
}
```

### Unified Check: Combined Model Check

```typescript
import { createUnifiedCheckService } from '@authrim/ar-lib-core';

const checkService = createUnifiedCheckService({
  db: D1_DATABASE,
  cache: KV_NAMESPACE,
  rebacService: rebacService,
  cacheTTL: 60,
  debugMode: true
});

// Single check
const result = await checkService.check({
  subject_id: 'user_123',
  permission: 'documents:doc_456:read',
  tenant_id: 'tenant_abc',
  rebac: {
    relation: 'viewer',
    object: 'document:doc_456'
  },
  resource_context: {
    owner_id: 'user_789',
    org_id: 'org_abc'
  }
});

// Batch check
const batchResult = await checkService.batchCheck({
  checks: [
    { subject_id: 'user_123', permission: 'documents:read' },
    { subject_id: 'user_123', permission: 'documents:write' },
    { subject_id: 'user_123', permission: 'documents:delete' }
  ],
  stop_on_deny: true
});
```

---

## Best Practices

### 1. Choose the Right Model

| Scenario | Recommended Model |
|----------|-------------------|
| Fixed organizational hierarchy | RBAC |
| Compliance/regulatory requirements | ABAC |
| Resource sharing/collaboration | ReBAC |
| Simple admin vs user distinction | RBAC |
| Age-gated content | ABAC |
| File/folder inheritance | ReBAC |

### 2. Performance Optimization

- **RBAC**: Embed roles in JWT for O(1) lookup
- **ABAC**: Use attribute caching, limit attribute count
- **ReBAC**: Use closure table for list operations, set appropriate `max_depth`

### 3. Security Recommendations

- Default to `deny` when no rules match
- Set appropriate TTLs for cached permissions
- Use `checkExpiry: true` for time-sensitive attributes
- Implement rate limiting on Check API
- Log all deny decisions for audit

### 4. Multi-Tenant Isolation

- Always include `tenant_id` in all queries
- Never allow cross-tenant permission checks
- Validate `tenant_id` matches authenticated tenant

### 5. Cache Management

- Use short TTLs (30-60s) for frequently changing permissions
- Implement cache invalidation on permission changes
- Monitor cache hit rates

---

## Comparison Matrix

### Feature Support

| Feature | RBAC | ABAC | ReBAC |
|---------|:----:|:----:|:-----:|
| Role hierarchy | ✅ | ❌ | ❌ |
| Scoped roles | ✅ | ❌ | ❌ |
| Role expiration | ✅ | ❌ | ❌ |
| Attribute matching | ❌ | ✅ | ❌ |
| Attribute expiration | ❌ | ✅ | ❌ |
| VC integration | ❌ | ✅ | ❌ |
| Direct relationships | ❌ | ❌ | ✅ |
| Transitive relationships | ❌ | ❌ | ✅ |
| Union (OR) expressions | ❌ | ❌ | ✅ |
| Intersection (AND) | ❌ | ❌ | ⏳ |
| Exclusion (NOT) | ❌ | ❌ | ⏳ |

### Condition Types

| RBAC (7) | ABAC (3) | ReBAC DSL |
|----------|----------|-----------|
| `has_role` | `attribute_equals` | `direct` |
| `has_any_role` | `attribute_exists` | `union` |
| `has_all_roles` | `attribute_in` | `tuple_to_userset` |
| `is_resource_owner` | | `intersection` ⏳ |
| `same_organization` | | `exclusion` ⏳ |
| `has_relationship` | | |
| `user_type_is` | | |
| `plan_allows` | | |

### Performance Characteristics

| Metric | RBAC | ABAC | ReBAC |
|--------|------|------|-------|
| Time Complexity | O(1) | O(n) | O(d) |
| Space Complexity | O(r) | O(a) | O(e) |
| Cache Strategy | Token embedding | Attribute cache | KV + closure |
| Batch Efficiency | High | Medium | Low |

Where:
- `r` = number of roles
- `a` = number of attributes
- `n` = attributes to evaluate
- `d` = relationship depth
- `e` = edges in relationship graph

---

## Future Roadmap

### Phase 4+ Planned Features

| Feature | Model | Status |
|---------|-------|--------|
| Intersection relations | ReBAC | Planned |
| Exclusion relations | ReBAC | Planned |
| Contextual tuples | ReBAC | Planned |
| Time-based conditions | ABAC | Under consideration |
| Numeric comparisons | ABAC | Under consideration |
| Geographic conditions | ABAC | Under consideration |

---

> **Authrim** — Edge-native OpenID Connect Provider with comprehensive access control
