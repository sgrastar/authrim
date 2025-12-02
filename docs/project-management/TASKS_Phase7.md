# Phase 7: VC/DID & Access Control

**Timeline:** 2026-Q3 to Q4
**Status:** ⏳ Partial (Policy Core/Service Complete)

---

## Overview

Phase 7 focuses on completing the access control system (RBAC/ABAC/ReBAC) and implementing Verifiable Credentials support. This phase builds the foundational authorization layer that other phases will depend on.

---

## Completed Features (Dec 2025)

### Policy Core (@authrim/policy-core) ✅

The core policy evaluation engine has been implemented:

- [x] `PolicyEngine` class with configurable default decision
- [x] RBAC (Role-Based Access Control) evaluation
  - [x] `has_role` condition type
  - [x] `has_any_role` condition type
  - [x] `has_all_roles` condition type
  - [x] Role scope support (global, organization, resource)
  - [x] Role expiration support
- [x] ABAC (Attribute-Based Access Control) evaluation
  - [x] `attribute_equals` condition type
  - [x] `attribute_exists` condition type
  - [x] `attribute_in` condition type
  - [x] Verified attributes with expiry checking
- [x] Ownership conditions
  - [x] `is_resource_owner` check
  - [x] `same_organization` check
- [x] Relationship conditions
  - [x] `has_relationship` check (guardian, parent, etc.)
  - [x] `user_type_is` check
  - [x] `plan_allows` check
- [x] Default rules (5 built-in rules)
  - [x] `system_admin_full_access` (priority 1000)
  - [x] `distributor_admin_access` (priority 900)
  - [x] `org_admin_same_org` (priority 800)
  - [x] `owner_full_access` (priority 700)
  - [x] `guardian_access` (priority 600)
- [x] Custom rule support via `addRule()` API
- [x] Unit tests (53 tests passing)

### Policy Service (@authrim/policy-service) ✅

REST API service for policy evaluation:

- [x] `GET /policy/health` - Health check
- [x] `POST /policy/evaluate` - Full policy evaluation
- [x] `POST /policy/check-role` - Quick role check (single/multiple)
- [x] `POST /policy/check-access` - Simplified access check
- [x] `POST /policy/is-admin` - Admin status check
- [x] Bearer token authentication
- [x] Integration tests (31 tests passing)
- [x] Cloudflare Workers deployment
- [x] Custom domain routing (`/policy/*`)

### API Documentation ✅

- [x] `/docs/api/policy/README.md` - Comprehensive usage guide
- [x] cURL examples
- [x] TypeScript integration examples
- [x] Error response documentation

---

## Recently Completed Features (Dec 2025)

### Feature Flags System ✅

Hybrid feature flag system implemented:

- [x] Create `PolicyFeatureFlags` type definition
  ```typescript
  interface PolicyFeatureFlags {
    ENABLE_ABAC: boolean;
    ENABLE_REBAC: boolean;
    ENABLE_POLICY_LOGGING: boolean;
    ENABLE_VERIFIED_ATTRIBUTES: boolean;
    ENABLE_CUSTOM_RULES: boolean;
  }
  ```
- [x] Add environment variable support for flags (defaults)
- [x] Add KV storage support for dynamic overrides
- [x] Priority chain: Cache → KV → Environment → Default
- [x] Implement flag checking in policy service
- [x] Add flag status to health endpoint (`/policy/health`)
- [x] Add flag management endpoints:
  - `GET /policy/flags` - Get all flags with sources
  - `PUT /policy/flags/:name` - Set flag override
  - `DELETE /policy/flags/:name` - Clear flag override
- [x] Add 23 unit tests for flag behavior
- [x] 60-second TTL caching for KV lookups

### ReBAC Check API (Zanzibar-style) ✅

Complete Relationship-Based Access Control implementation:

- [x] Relation tuple schema (`relationships` table)
- [x] Recursive CTE queries in `ReBACService`
- [x] KV caching for relation lookups
- [x] Feature flag gating (`ENABLE_REBAC`)
- [x] REST API endpoints:
  - `POST /api/rebac/check` - Single relationship check
  - `POST /api/rebac/batch-check` - Batch check (max 100)
  - `POST /api/rebac/list-objects` - List user's accessible objects
  - `POST /api/rebac/list-users` - List users with access to object
  - `POST /api/rebac/write` - Create relationship tuple
  - `DELETE /api/rebac/tuple` - Delete relationship tuple
  - `POST /api/rebac/invalidate` - Invalidate cache
  - `GET /api/rebac/health` - Health check with status
- [x] Namespace/relation type definitions (`relation_definitions` table)
- [x] Unit tests integrated in policy-service tests

### Database Migrations ✅

All required tables for ReBAC/ABAC support:

- [x] Migration 017: `relationship_closure` table (transitive lookups)
- [x] Migration 018: `relation_definitions` table (Zanzibar-style DSL)
- [x] Migration 019: `verified_attributes` + `subject_identifiers` tables
- [x] Added `evidence_type`, `evidence_ref` columns to `relationships`
- [x] Seed data for document/folder relation definitions
- [x] Applied to conformance environment

---

## Planned Features

### JWT-SD (Selective Disclosure) 🔜

Implement SD-JWT for privacy-preserving credentials:

- [ ] Research SD-JWT specification (draft-ietf-oauth-selective-disclosure-jwt)
- [ ] Implement SD-JWT issuing
  - [ ] Hash-based disclosure
  - [ ] Salt generation
  - [ ] Disclosure array creation
- [ ] Implement SD-JWT verification
  - [ ] Disclosure reconstruction
  - [ ] Hash verification
- [ ] Add `sd_jwt` claim support to ID Token
- [ ] Create presentation endpoint
- [ ] Add unit tests
- [ ] Document SD-JWT usage

### OpenID4VP (Verifiable Presentations) 🔜

Implement OpenID for Verifiable Presentations:

- [ ] Research OpenID4VP specification
- [ ] Implement presentation definition
- [ ] Create authorization request for VP
- [ ] Implement VP Token validation
- [ ] Add presentation submission handling
- [ ] Support multiple credential formats
  - [ ] JWT-VC
  - [ ] SD-JWT
  - [ ] JSON-LD VC (optional)
- [ ] Create verifier UI
- [ ] Add unit tests
- [ ] Document OpenID4VP flow

### OpenID4CI (Credential Issuance) 🔜

Implement OpenID for Verifiable Credential Issuance:

- [ ] Research OpenID4CI specification
- [ ] Implement credential offer endpoint
- [ ] Create credential issuer metadata
- [ ] Implement pre-authorized code flow
- [ ] Implement authorization code flow for issuance
- [ ] Add credential endpoint
- [ ] Support multiple credential formats
- [ ] Create issuer UI
- [ ] Add unit tests
- [ ] Document credential issuance

### DID Resolver 🔜

Implement Decentralized Identifier resolution:

- [ ] Research DID Core specification (W3C)
- [ ] Implement `did:web` resolver
  - [ ] Fetch `.well-known/did.json`
  - [ ] Parse DID document
  - [ ] Extract verification methods
- [ ] Implement `did:key` resolver
  - [ ] Parse multibase-encoded public key
  - [ ] Support Ed25519, P-256, secp256k1
- [ ] Create DID document generation
- [ ] Add DID authentication support
- [ ] Integrate with VP/VC verification
- [ ] Add unit tests
- [ ] Document DID support

---

## Integration with Other Components

### Consent Screen Integration

The consent screen (`/auth/consent`) currently calls RBAC functions:

- `getConsentRBACData()` - Fetches organization roles
- `getRolesInOrganization()` - Gets user's roles in org

These functions gracefully degrade when tables are empty, ensuring no impact on OIDC Conformance tests.

### Token Endpoint Integration

Access tokens can include policy-related claims:

- `authrim_roles` - User's assigned roles
- `authrim_permissions` - Derived permissions
- `authrim_org_id` - Organization context

---

## Testing Requirements

### Unit Tests

- [x] Feature flag tests (enable/disable behavior) - 23 tests
- [x] ReBAC recursive query tests - integrated in shared
- [ ] SD-JWT generation/verification tests
- [ ] DID resolver tests

### Integration Tests

- [ ] End-to-end policy evaluation
- [ ] VP presentation flow
- [ ] Credential issuance flow

### Conformance Testing

Ensure no regression in OIDC Conformance:

- [ ] Re-run Basic OP tests after each major change
- [ ] Verify consent flow still works
- [ ] Test with feature flags disabled

---

## Success Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Policy Core tests | 50+ | **76** ✅ |
| Policy Service tests | 30+ | **33** ✅ |
| Feature Flags tests | 20+ | **23** ✅ |
| ReBAC tests | 30+ | Integrated ✅ |
| SD-JWT tests | 20+ | - |
| DID resolver tests | 15+ | - |
| OpenID4VP tests | 25+ | - |

---

## Dependencies

- Policy Core/Service: **Complete** ✅
- Feature Flags System: **Complete** ✅
- ReBAC Check API: **Complete** ✅
- D1 Database migrations: **Complete** ✅ (017-019 applied)
- KV Storage: Required for caching (available)
- jose library: Already integrated

---

## Related Documents

- [Policy Service API Guide](../api/policy/README.md)
- [API Inventory](./API_INVENTORY.md)
- [Database Schema](../architecture/database-schema.md)
- [ROADMAP](../ROADMAP.md)

---

> **Last Update**: 2025-12-02 (Feature Flags + ReBAC API + DB Migrations Complete)
