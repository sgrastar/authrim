# Phase 8: Unified Policy Integration

**Timeline:** 2026-Q2
**Status:** 🔜 Planned

---

## Overview

Phase 8 integrates the authentication (AuthN) layer from Phase 7 with the authorization (AuthZ) engine from Phase 6 into a unified flow. This creates a seamless experience where users authenticate through various identity sources and immediately receive properly scoped tokens with embedded permissions.

---

## Architecture Vision

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Identity Hub (Phase 7)                               │
│   Social Login → Identity Linking → Unified User                        │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ User Context
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Policy Engine (Phase 6)                              │
│   RBAC │ ABAC │ ReBAC │ Feature Flags                                   │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │ Evaluation Result
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Token Issuance Layer                                 │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │ ID Token:  sub, name, email, auth_time, ...                     │   │
│   │ Access Token: scope, permissions, roles, feature_flags, ...    │   │
│   └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
        ┌─────────────────────────────┴─────────────────────────────┐
        ▼                                                           ▼
┌───────────────────────┐                               ┌───────────────────────┐
│   Token Validation    │                               │   Real-time Check     │
│   (Embedded Claims)   │                               │   (/policy/check)     │
│   • Fast              │                               │   • Dynamic           │
│   • Offline capable   │                               │   • Always current    │
└───────────────────────┘                               └───────────────────────┘
```

---

## 8.1 Policy ↔ Identity Integration

Connect upstream identity attributes to policy evaluation:

### Attribute Injection 🔜

Inject upstream provider attributes into policy context:

- [ ] Design attribute injection pipeline

  ```typescript
  interface PolicyContext {
    // User identity
    user_id: string;
    email: string;
    email_verified: boolean;

    // Upstream provider attributes (Phase 7)
    provider: string; // 'google', 'github', 'saml'
    provider_groups: string[]; // Groups from upstream IdP
    provider_roles: string[]; // Roles from upstream IdP

    // Authrim attributes
    authrim_roles: string[];
    authrim_permissions: string[];
    organization_id?: string;

    // Verified attributes (Phase 6)
    verified_attributes: VerifiedAttribute[];
  }
  ```

- [ ] Map upstream claims to policy attributes
- [ ] Handle missing/optional attributes
- [ ] Add attribute caching (KV)
- [ ] Unit tests

### Dynamic Role Assignment 🔜

Automatically assign Authrim roles based on upstream attributes:

- [ ] Design role assignment rules

  ```typescript
  interface RoleAssignmentRule {
    name: string;
    condition: {
      provider?: string;
      provider_group?: string;
      email_domain?: string;
      attribute?: { key: string; value: any };
    };
    assign_roles: string[];
    scope: 'global' | 'organization';
  }

  // Example: Assign 'admin' role to users in 'admins' Google group
  const rule: RoleAssignmentRule = {
    name: 'google_admins',
    condition: { provider: 'google', provider_group: 'admins@company.com' },
    assign_roles: ['admin'],
    scope: 'global',
  };
  ```

- [ ] Implement rule evaluation on login
- [ ] Support organization-scoped assignments
- [ ] Create role assignment rules UI
- [ ] Log role assignments for audit
- [ ] Unit tests

### Just-in-Time Provisioning 🔜

Provision users and permissions on first login:

- [ ] Design JIT provisioning workflow
  ```
  1. User authenticates via upstream provider
  2. Check if user exists in Authrim
  3. If new: Create user, apply default roles
  4. Apply role assignment rules
  5. Evaluate policy, issue tokens
  ```
- [ ] Implement user creation from upstream claims
- [ ] Apply default roles per provider
- [ ] Handle organization auto-join (email domain matching)
- [ ] Integration tests

---

## 8.2 Token Embedding Model

Embed authorization decisions directly into tokens:

### Permissions in Token 🔜

Include evaluated permissions in access tokens:

- [ ] Design token permission structure

  ```typescript
  interface AccessTokenClaims {
    // Standard OAuth
    iss: string;
    sub: string;
    aud: string | string[];
    exp: number;
    iat: number;
    scope: string;

    // Authrim extensions
    permissions: string[]; // ['read:users', 'write:posts']
    roles: string[]; // ['admin', 'editor']
    feature_flags: Record<string, boolean>; // { dark_mode: true }
    organization_id?: string;
    tenant_id?: string;
  }
  ```

- [ ] Implement inline policy evaluation during token issuance
- [ ] Configure which permissions to embed
- [ ] Handle token size limits (JWT ~8KB max recommended)
- [ ] Unit tests

### Roles in Token 🔜

Embed user roles in ID and access tokens:

- [ ] Add `roles` claim to ID Token
- [ ] Add `roles` claim to Access Token
- [ ] Support role filtering by resource/scope
- [ ] Handle role expiration
- [ ] Unit tests

### Resource Permissions 🔜

Per-resource permission embedding:

- [ ] Design resource permission structure

  ```typescript
  interface ResourcePermissions {
    resource_type: string; // 'document', 'project'
    resource_id: string;
    permissions: string[]; // ['read', 'write', 'delete']
  }

  // In token:
  {
    resource_permissions: [
      { resource_type: 'project', resource_id: 'proj-123', permissions: ['read', 'write'] },
    ];
  }
  ```

- [ ] Implement resource-scoped token issuance
- [ ] Add resource parameter to token endpoint
- [ ] Limit embedded resources (performance)
- [ ] Unit tests

### Custom Claims Builder UI 🔜

Admin interface for configuring token claims:

- [ ] Design claims builder interface
- [ ] Allow custom claim mapping
- [ ] Preview token structure
- [ ] Validate claim names (avoid conflicts)
- [ ] Export/import claim configurations

---

## 8.3 Real-time Check API Model

For dynamic authorization decisions (not embedded in tokens):

### `/api/policy/check` Endpoint 🔜

Single permission check API:

- [ ] Design check API request/response

  ```typescript
  // Request
  POST /api/policy/check
  {
    subject: 'user:123',
    permission: 'read',
    resource: 'document:456',
    context?: {
      ip_address: '192.168.1.1',
      device_type: 'mobile'
    }
  }

  // Response
  {
    allowed: true,
    decision_reason: 'Role "editor" grants read permission',
    evaluated_at: '2026-03-01T12:00:00Z',
    cache_ttl: 60
  }
  ```

- [ ] Implement authorization check logic
- [ ] Add request validation
- [ ] Implement response caching (KV)
- [ ] Add rate limiting
- [ ] Unit tests

### Batch Check API 🔜

Check multiple permissions in single request:

- [ ] Design batch request format
  ```typescript
  POST /api/policy/batch-check
  {
    subject: 'user:123',
    checks: [
      { permission: 'read', resource: 'document:456' },
      { permission: 'write', resource: 'document:456' },
      { permission: 'delete', resource: 'document:789' }
    ]
  }
  ```
- [ ] Implement batch processing
- [ ] Optimize for parallel evaluation
- [ ] Limit batch size (max 100)
- [ ] Unit tests

### WebSocket Push 🔜

Real-time permission change notifications:

- [ ] Design WebSocket protocol

  ```typescript
  // Client subscribes
  { type: 'subscribe', resources: ['document:456', 'project:789'] }

  // Server pushes on permission change
  { type: 'permission_changed', resource: 'document:456', invalidate: true }
  ```

- [ ] Implement Durable Object for WebSocket connections
- [ ] Handle connection lifecycle
- [ ] Broadcast permission changes
- [ ] Integration tests

### SDK Integration 🔜

Client libraries for Check API:

- [ ] Design SDK interface

  ```typescript
  const authrim = new AuthrimClient({ ... });

  // Check permission
  const allowed = await authrim.checkPermission('read', 'document:456');

  // Batch check
  const results = await authrim.batchCheck([
    { permission: 'read', resource: 'document:456' },
    { permission: 'write', resource: 'document:789' }
  ]);

  // Subscribe to changes
  authrim.onPermissionChange('document:456', () => {
    // Refresh permissions
  });
  ```

- [ ] Implement TypeScript SDK
- [ ] Add caching layer
- [ ] Handle reconnection (WebSocket)
- [ ] Unit tests

---

## 8.4 Policy Admin Console

Visual administration for unified policy:

### Role Editor (Visual RBAC) 🔜

- [ ] List all roles with permission counts
- [ ] Create new role
- [ ] Edit role permissions (checkbox matrix)
- [ ] Role hierarchy visualization
- [ ] Assign roles to users (search/select)
- [ ] Bulk role assignment
- [ ] Role templates (copy from existing)
- [ ] Delete role (with impact analysis)

### Policy Editor (ABAC Builder) 🔜

- [ ] Visual rule builder
  - [ ] Condition blocks (drag & drop)
  - [ ] AND/OR combinators
  - [ ] Attribute selection
  - [ ] Comparison operators
- [ ] Policy testing with sample data
- [ ] Policy simulation (what-if analysis)
- [ ] Import/export policies (JSON)
- [ ] Policy versioning

### Relationship Viewer (ReBAC Graph) 🔜

- [ ] Interactive relationship graph
- [ ] Filter by namespace/relation type
- [ ] Search for specific user/resource
- [ ] Expand/collapse relationship chains
- [ ] Highlight permission paths
- [ ] Export graph as image/PDF

### Audit Log Viewer 🔜

- [ ] List all policy decisions
- [ ] Filter by user, resource, action
- [ ] Filter by date range
- [ ] Filter by decision (allow/deny)
- [ ] Export audit logs (CSV, JSON)
- [ ] Real-time log streaming
- [ ] Alert configuration for denied access patterns

---

## Database Migrations

### Migration 022: Policy Integration

- [ ] Create `role_assignment_rules` table
- [ ] Create `token_claim_configs` table
- [ ] Add `provider_attributes` column to users
- [ ] Create indexes for policy evaluation

### Migration 023: Check API Audit

- [ ] Create `policy_check_audit` table
- [ ] Create partitioned tables for high volume
- [ ] Set up retention policy (90 days default)

---

## Testing Requirements

### Unit Tests

- [ ] Attribute injection tests (20+ tests)
- [ ] Role assignment tests (20+ tests)
- [ ] Token embedding tests (30+ tests)
- [ ] Check API tests (25+ tests)

### Integration Tests

- [ ] Full flow: Login → Policy Eval → Token issuance
- [ ] JIT provisioning flow
- [ ] Real-time check with caching
- [ ] WebSocket subscription flow

### Performance Tests

- [ ] Token issuance with policy eval (<100ms)
- [ ] Check API response time (<20ms)
- [ ] Batch check performance (100 checks <200ms)
- [ ] WebSocket connection capacity (1000+ concurrent)

---

## Success Metrics

| Metric                 | Target | Current |
| ---------------------- | ------ | ------- |
| Token issuance latency | <100ms | -       |
| Check API latency      | <20ms  | -       |
| Policy eval tests      | 100+   | -       |
| Admin UI pages         | 5+     | -       |
| SDK methods            | 10+    | -       |

---

## Dependencies

- Phase 6: Policy Engine ✅
- Phase 7: Identity Hub Foundation
- D1 Database ✅
- KV Storage ✅
- Durable Objects ✅

---

## Related Documents

- [ROADMAP](../ROADMAP.md) - Overall product direction
- [Policy Service API](../api/policy/README.md) - Existing policy API
- [TASKS_Phase7.md](./TASKS_Phase7.md) - Previous phase (Identity Hub)
- [TASKS_Phase9.md](./TASKS_Phase9.md) - Next phase (Advanced Identity)

---

> **Last Update**: 2025-12-03 (Phase 8 definition for Unified Policy Integration)
