# Flow × UI Separation: Architecture Principles

**Created:** 2025-12-26
**Status:** Draft
**Purpose:** Define fundamental principles to prevent common failure patterns

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Core Principles](#2-core-principles)
3. [Feature Profile System](#3-feature-profile-system)
4. [Capability Governance](#4-capability-governance)
5. [Flow / Policy Boundary](#5-flow--policy-boundary)
6. [Stability Levels](#6-stability-levels)
7. [Anti-Patterns](#7-anti-patterns)
8. [Decision Records](#8-decision-records)

---

## 1. Executive Summary

This document defines the fundamental architectural principles for the Flow × UI separation architecture. These principles are designed to prevent common failure patterns that emerge in flexible authentication systems:

| Problem | Solution | Principle |
|---------|----------|-----------|
| Feature Flag Combinatorial Explosion | Feature Profiles | §3 |
| Capability Bloat | Strict Addition Criteria | §4 |
| Flow/Policy Boundary Blur | Clear Responsibility Split | §5 |
| Unstable API Surface | Stability Levels | §6 |

---

## 2. Core Principles

### Principle 1: Profile-First Configuration

> **"Profiles are the primary configuration unit. Individual feature flags are adjustments, not foundations."**

Instead of allowing arbitrary combinations of features, we define **supported profiles** that represent tested, documented, and supportable configurations.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Configuration Hierarchy                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   Level 1: Profile Selection (REQUIRED)                                     │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  human-basic │ human-org │ ai-agent │ iot-device │ (future...)     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                            │                                                 │
│                            ▼                                                 │
│   Level 2: Profile Adjustments (OPTIONAL)                                   │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  + Enable/disable specific auth methods within profile constraints  │   │
│   │  + Tenant-specific branding                                         │   │
│   │  + UI customization flags                                           │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│   ❌ NOT ALLOWED: Arbitrary feature flag combinations                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Principle 2: Capability Minimalism

> **"A Capability should only exist if it represents a distinct UI interaction pattern that is reused across multiple Intents."**

Capabilities are not features. They are **UI interaction abstractions**. Adding a Capability has significant costs:
- UI implementation complexity
- SDK surface area
- Documentation burden
- Testing matrix expansion

### Principle 3: Flow Collects, Policy Decides

> **"The Flow Engine's responsibility ends at 'present choices and collect responses'. All authorization decisions are made by the Policy Engine."**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Responsibility Boundary                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌─────────────────────────────────┐  ┌─────────────────────────────────┐  │
│   │         FLOW ENGINE             │  │        POLICY ENGINE            │  │
│   │                                 │  │                                 │  │
│   │  ✓ Present options to user     │  │  ✓ Evaluate RBAC rules          │  │
│   │  ✓ Collect user selections     │  │  ✓ Evaluate ABAC conditions     │  │
│   │  ✓ Validate input format       │  │  ✓ Evaluate ReBAC relationships │  │
│   │  ✓ Manage flow state           │  │  ✓ Make allow/deny decisions    │  │
│   │  ✓ Generate UI Contract        │  │  ✓ Compute effective permissions│  │
│   │                                 │  │                                 │  │
│   │  ✗ Check if user has role      │  │  ✗ Present UI to user           │  │
│   │  ✗ Evaluate permissions        │  │  ✗ Manage authentication state  │  │
│   │  ✗ Determine access rights     │  │  ✗ Handle user input            │  │
│   └─────────────────────────────────┘  └─────────────────────────────────┘  │
│                                                                             │
│   Interface: Flow calls Policy.evaluate() and receives { allowed, reason }  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Principle 4: Explicit Stability Contracts

> **"Every Capability and Intent must declare its stability level. SDK and UI implementations should respect these levels."**

This allows us to experiment with new features (AI, MCP, DID) without breaking existing integrations.

---

## 3. Feature Profile System

### 3.1 Profile Definitions

We define **4 initial profiles**. This number may increase or decrease based on actual usage patterns.

#### Profile: `human-basic`

**Target Use Case:** Simple web applications with individual user accounts.

```typescript
const PROFILE_HUMAN_BASIC: FeatureProfile = {
  id: 'human-basic',
  name: 'Human Basic',
  description: 'Simple authentication for individual users',

  policy: {
    rbac: 'simple',    // Admin / User only
    abac: false,
    rebac: false,
  },

  targets: {
    human: true,
    iot: false,
    ai_agent: false,
    ai_mcp: false,
    service: false,
  },

  authMethods: {
    passkey: true,
    email_code: true,
    password: { allowed: true, default: false },
    external_idp: { allowed: true, default: false },
    did: false,
  },

  capabilities: [
    'collect_identifier',
    'collect_secret',
    'verify_possession',
    'confirm_consent',
    'display_info',
    'redirect',
  ],

  intents: [
    'identify_user',
    'authenticate_user',
    'obtain_consent',
    'complete_flow',
    'handle_error',
  ],
};
```

#### Profile: `human-org`

**Target Use Case:** B2B SaaS with organization/team structures.

```typescript
const PROFILE_HUMAN_ORG: FeatureProfile = {
  id: 'human-org',
  name: 'Human Organization',
  description: 'Authentication with organization context and role management',

  policy: {
    rbac: 'full',      // Role-based within organizations
    abac: false,
    rebac: true,       // Organization relationships
  },

  targets: {
    human: true,
    iot: false,
    ai_agent: false,
    ai_mcp: false,
    service: { allowed: true, default: false },  // Service accounts
  },

  authMethods: {
    passkey: true,
    email_code: true,
    password: { allowed: true, default: false },
    external_idp: { allowed: true, default: true },  // SSO common in B2B
    did: { allowed: true, default: false },
  },

  // Extends human-basic capabilities
  capabilities: [
    ...PROFILE_HUMAN_BASIC.capabilities,
    'choose_organization',
    'choose_role',
    'delegate_access',
    'view_permissions',
  ],

  intents: [
    ...PROFILE_HUMAN_BASIC.intents,
    'select_organization',
    'select_role',
    'delegate_identity',
    'review_permissions',
  ],
};
```

#### Profile: `ai-agent`

**Target Use Case:** AI agents acting on behalf of users.

```typescript
const PROFILE_AI_AGENT: FeatureProfile = {
  id: 'ai-agent',
  name: 'AI Agent',
  description: 'Authentication for AI agents with delegated authority',

  policy: {
    rbac: 'full',
    abac: true,        // Attribute-based scope limiting
    rebac: true,
  },

  targets: {
    human: true,       // Human grants permission
    iot: false,
    ai_agent: true,
    ai_mcp: true,
    service: true,
  },

  authMethods: {
    passkey: true,     // Human approves
    email_code: false,
    password: false,
    external_idp: false,
    did: { allowed: true, default: false },
  },

  capabilities: [
    ...PROFILE_HUMAN_ORG.capabilities,
    'agent_scope_request',
    'agent_consent',
    'mcp_tool_binding',
    'mcp_resource_select',
  ],

  intents: [
    ...PROFILE_HUMAN_ORG.intents,
    'authorize_agent',
    'scope_agent',
    'bind_mcp_tools',
    'authorize_mcp',
  ],

  stability: 'experimental',
};
```

#### Profile: `iot-device`

**Target Use Case:** IoT devices with hardware attestation.

```typescript
const PROFILE_IOT_DEVICE: FeatureProfile = {
  id: 'iot-device',
  name: 'IoT Device',
  description: 'Authentication for IoT devices with hardware binding',

  policy: {
    rbac: 'simple',
    abac: true,        // Device attributes
    rebac: false,
  },

  targets: {
    human: true,       // Initial provisioning by human
    iot: true,
    ai_agent: false,
    ai_mcp: false,
    service: true,
  },

  authMethods: {
    passkey: false,
    email_code: false,
    password: false,
    external_idp: false,
    did: true,         // Device identity
  },

  capabilities: [
    'collect_identifier',
    'device_attestation',
    'device_binding',
    'display_info',
    'redirect',
  ],

  intents: [
    'identify_user',
    'attest_device',
    'bind_device',
    'complete_flow',
    'handle_error',
  ],

  stability: 'experimental',
};
```

### 3.2 Profile Selection Rules

1. **One Profile Per Tenant:** Each tenant has exactly one active profile
2. **Profile Immutable in Flight:** Profile cannot change during an active flow
3. **Upgrade Path:** Profiles can be upgraded (basic → org), not arbitrarily changed
4. **Adjustments Are Subtractive:** You can disable features from a profile, not add features from other profiles

### 3.3 KV Storage Structure

```
tenant:{tenant_id}:profile
├── id: "human-org"
├── securityTier: "enhanced"
├── complianceModules: ["sox"]
├── adjustments:
│   ├── authMethods:
│   │   └── password: false  (disabled from profile default)
│   └── ui:
│       └── consent_show_roles: true
└── activated_at: "2025-12-26T00:00:00Z"
```

### 3.4 Security Tier System

Profiles can be combined with **Security Tiers** to add security requirements without changing the base profile.

#### 3.4.1 Security Tier Definitions

```typescript
type SecurityTier = 'standard' | 'enhanced' | 'regulated';

interface TenantProfileConfig {
  profile: CoreProfileId;           // Base profile (use case)
  securityTier: SecurityTier;       // Security level (modifier)
  complianceModules?: ComplianceModule[];
}
```

| Tier | Description | Use Case |
|------|-------------|----------|
| `standard` | Default, no additional requirements | Startups, internal tools |
| `enhanced` | Security hardening | B2B SaaS, SOC 2 compliance |
| `regulated` | Regulatory compliance | Financial services, healthcare, government |

#### 3.4.2 Security Tier Feature Matrix

| Feature | standard | enhanced | regulated |
|---------|----------|----------|-----------|
| **MFA Required** | ❌ | ✅ | ✅ |
| **Audit Log Level** | Basic | Detailed | Complete |
| **Log Retention** | 30 days | 1 year | 7 years |
| **Session Timeout** | 24 hours | 8 hours | 1 hour |
| **Enterprise Attestation** | ❌ | ❌ | ✅ (※) |
| **Device-bound Passkey Only** | ❌ | ❌ | ✅ (※) |
| **IP Restriction** | ❌ | Optional | Recommended |
| **Idle Timeout** | None | 30 min | 15 min |

(※) May be relaxed via `overrides` in future versions.

#### 3.4.3 Compliance Modules

Optional regulatory compliance support:

```typescript
type ComplianceModule =
  | 'hipaa'      // Healthcare (US)
  | 'pci-dss'    // Payment Card Industry
  | 'ismap'      // Government (Japan)
  | 'gdpr'       // Data Protection (EU)
  | 'sox';       // Public Companies (US)
```

> ⚠️ **Responsibility Disclaimer**
>
> `complianceModules` provides **"control support"**, NOT **"certification"**.
>
> - Authrim assists with implementing security controls relevant to these regulations
> - Using Authrim does NOT guarantee regulatory compliance
> - Final compliance responsibility rests with the customer

#### 3.4.4 Configuration Examples

```typescript
// Example 1: Startup (minimal)
{ profile: 'human-basic', securityTier: 'standard' }

// Example 2: B2B SaaS (SOC 2)
{ profile: 'human-org', securityTier: 'enhanced' }

// Example 3: Financial AI Agent
{ profile: 'ai-agent', securityTier: 'regulated', complianceModules: ['pci-dss'] }

// Example 4: Government (minimal footprint)
{ profile: 'human-basic', securityTier: 'regulated' }
```

#### 3.4.5 Future Extensibility

The `regulated` tier defaults may be too strict for some use cases (e.g., "only need 7-year logs, not Enterprise Attestation").

**Future escape hatch** (not implemented now):

```typescript
interface TenantProfileConfig {
  profile: CoreProfileId;
  securityTier: SecurityTier;
  complianceModules?: ComplianceModule[];
  // Future: Allow selective override
  overrides?: {
    requireEnterpriseAttestation?: boolean;
    requireDeviceBoundPasskey?: boolean;
    auditLogRetentionDays?: number;
  };
}
```

---

## 4. Capability Governance

### 4.1 Capability Addition Criteria

A new Capability may only be added if ALL of the following are true:

| Criterion | Description | Verification |
|-----------|-------------|--------------|
| **Multi-Intent Reuse** | Used by 2+ distinct Intents | Code review |
| **UI Abstraction Validity** | Represents a coherent UI interaction pattern | Design review |
| **No Existing Equivalent** | Cannot be achieved with existing Capabilities | Architecture review |
| **Profile Justification** | Required by at least one supported Profile | Product review |

### 4.2 Capability Deprecation Process

1. Mark as `deprecated` in metadata
2. Emit warning in UI Contract (6 months)
3. Remove from new Profile definitions
4. Remove from codebase after migration period

### 4.3 Capability Categories

```typescript
enum CapabilityCategory {
  // Core: Always available, cannot be disabled
  CORE = 'core',

  // Auth: Authentication method specific
  AUTH = 'auth',

  // Policy: Depends on RBAC/ABAC/ReBAC configuration
  POLICY = 'policy',

  // Target: Depends on auth target (IoT, AI, etc.)
  TARGET = 'target',
}
```

### 4.4 Core Capabilities (Locked)

These Capabilities are available in ALL profiles and cannot be removed:

| Capability | Category | Description |
|------------|----------|-------------|
| `collect_identifier` | CORE | Collect email, phone, username |
| `collect_secret` | CORE | Collect password, OTP, PIN |
| `verify_possession` | CORE | Verify ownership (passkey, device) |
| `display_info` | CORE | Show messages (success, error, info) |
| `redirect` | CORE | Redirect to external URL |
| `confirm_consent` | CORE | OAuth consent approval |

---

## 5. Flow / Policy Boundary

### 5.1 The Golden Rule

> **Flow presents. Policy decides. Flow never decides.**

### 5.2 Interaction Patterns

#### Pattern A: Role Selection (RBAC)

```
┌─────────────┐                    ┌─────────────┐
│    Flow     │                    │   Policy    │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │  1. getRolesForUser(userId)      │
       │ ────────────────────────────────►│
       │                                  │
       │  2. [admin, editor, viewer]      │
       │ ◄────────────────────────────────│
       │                                  │
       │  3. Present role selector to UI  │
       │                                  │
       │  4. User selects "editor"        │
       │                                  │
       │  5. Flow continues with role     │
       │     in context                   │
       │                                  │
```

**Flow's Job:** Present the list, collect the selection
**Policy's Job:** Provide the list of valid roles

#### Pattern B: Consent with Permissions (ReBAC)

```
┌─────────────┐                    ┌─────────────┐
│    Flow     │                    │   Policy    │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │  1. getConsentData(userId, clientId, scopes)
       │ ────────────────────────────────►│
       │                                  │
       │  2. { scopes, effectivePermissions, organizations }
       │ ◄────────────────────────────────│
       │                                  │
       │  3. Present consent UI with      │
       │     permissions preview          │
       │                                  │
       │  4. User approves                │
       │                                  │
       │  5. recordConsent(...)           │
       │ ────────────────────────────────►│
       │                                  │
```

**Flow's Job:** Present consent UI, collect decision, record consent
**Policy's Job:** Compute what permissions would be granted

#### Pattern C: Acting-As (Delegation)

```
┌─────────────┐                    ┌─────────────┐
│    Flow     │                    │   Policy    │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │  1. getDelegationTargets(userId) │
       │ ────────────────────────────────►│
       │                                  │
       │  2. [{ targetUser, permissions, relationship }]
       │ ◄────────────────────────────────│
       │                                  │
       │  3. Present acting-as selector   │
       │                                  │
       │  4. User selects target          │
       │                                  │
       │  5. validateDelegation(userId, targetId, action)
       │ ────────────────────────────────►│
       │                                  │
       │  6. { allowed: true/false }      │
       │ ◄────────────────────────────────│
       │                                  │
```

**Flow's Job:** Present options, collect selection, pass to validation
**Policy's Job:** Provide valid targets, validate the delegation

### 5.3 Forbidden Patterns

| Pattern | Why It's Wrong | Correct Approach |
|---------|----------------|------------------|
| Flow checks `user.role === 'admin'` | Flow is making a policy decision | Call `Policy.hasPermission()` |
| Flow filters organizations by user attributes | Flow is evaluating ABAC rules | Call `Policy.getAccessibleOrgs()` |
| Flow embeds permission logic in state guards | Couples flow to policy implementation | Policy returns pre-computed data |

---

## 6. Stability Levels

### 6.1 Stability Definitions

```typescript
enum StabilityLevel {
  // Core: Will never change. Safe for all SDKs.
  CORE = 'core',

  // Stable: Unlikely to change. Safe for production SDKs.
  STABLE = 'stable',

  // Experimental: May change without notice. Use at own risk.
  EXPERIMENTAL = 'experimental',

  // Deprecated: Will be removed. Migration path provided.
  DEPRECATED = 'deprecated',
}
```

### 6.2 Stability by Feature Area

| Feature Area | Stability | Notes |
|--------------|-----------|-------|
| Core Capabilities | CORE | Never changes |
| Core Intents | CORE | Never changes |
| RBAC Capabilities | STABLE | human-org profile |
| ReBAC Capabilities | STABLE | human-org profile |
| AI Agent Capabilities | EXPERIMENTAL | ai-agent profile |
| AI MCP Capabilities | EXPERIMENTAL | ai-agent profile |
| IoT Capabilities | EXPERIMENTAL | iot-device profile |
| DID Auth | EXPERIMENTAL | All profiles (optional) |

### 6.3 SDK Implications

```typescript
// SDK should filter by stability
const capabilities = uiContract.capabilities.filter(c =>
  c.stability === 'core' || c.stability === 'stable'
);

// Or opt-in to experimental
const capabilities = uiContract.capabilities.filter(c =>
  c.stability !== 'deprecated' &&
  (c.stability !== 'experimental' || options.enableExperimental)
);
```

### 6.4 UI Contract Stability Indicator

```typescript
interface UIContract {
  version: '0.1';

  // Contract-level stability
  stability: StabilityLevel;

  capabilities: Array<{
    type: CapabilityType;
    // Per-capability stability
    stability: StabilityLevel;
    // ...
  }>;

  // ...
}
```

---

## 7. Anti-Patterns

### 7.1 Configuration Anti-Patterns

| Anti-Pattern | Description | Consequence |
|--------------|-------------|-------------|
| **Flag Soup** | Allowing arbitrary feature flag combinations | Untestable, unsupportable |
| **Profile Bypass** | Adding features outside profile scope | Breaks guarantees |
| **Runtime Profile Switch** | Changing profile during active flow | Undefined behavior |

### 7.2 Capability Anti-Patterns

| Anti-Pattern | Description | Consequence |
|--------------|-------------|-------------|
| **Feature-as-Capability** | Creating Capability per feature flag | Capability explosion |
| **God Capability** | Single Capability that does everything | Meaningless abstraction |
| **Duplicate Semantics** | Multiple Capabilities for same UI pattern | Confusion, inconsistency |

### 7.3 Boundary Anti-Patterns

| Anti-Pattern | Description | Consequence |
|--------------|-------------|-------------|
| **Flow Decides** | Flow contains authorization logic | Bypassing policy, security holes |
| **Policy Presents** | Policy generates UI elements | Coupling, maintenance nightmare |
| **Shared State** | Flow and Policy share mutable state | Race conditions, bugs |

---

## 8. Decision Records

### DR-001: Profile-Based Configuration

**Date:** 2025-12-26
**Status:** Accepted

**Context:**
Feature flags for policy (RBAC/ABAC/ReBAC), targets (Human/IoT/AI), and auth methods create a combinatorial explosion of possible configurations. Testing and supporting all combinations is impractical.

**Decision:**
Adopt a Profile-based configuration system where:
1. Profiles are pre-defined, tested configurations
2. Each tenant selects exactly one profile
3. Limited adjustments allowed within profile constraints
4. New profiles require full implementation and testing

**Consequences:**
- (+) Testable: Only need to test N profiles, not 2^N combinations
- (+) Supportable: "What profile are you using?" is a valid support question
- (+) Documentable: Each profile has clear capabilities
- (-) Less flexible: Some edge cases may not be supported
- (-) More profiles over time: Enterprise may need custom profiles

### DR-002: Capability Stability Levels

**Date:** 2025-12-26
**Status:** Accepted

**Context:**
We want to experiment with new features (AI, MCP, IoT) without breaking existing integrations. However, experimental features need real-world testing.

**Decision:**
Introduce stability levels (core/stable/experimental/deprecated) for all Capabilities and Intents. SDKs and UIs can filter by stability level.

**Consequences:**
- (+) Safe experimentation: Experimental features don't break production
- (+) Clear expectations: Developers know what's stable
- (+) Migration path: Deprecation is explicit
- (-) Complexity: More metadata to track
- (-) Fragmentation: Different SDKs may support different levels

### DR-003: Flow/Policy Boundary

**Date:** 2025-12-26
**Status:** Accepted

**Context:**
As we add RBAC, ABAC, and ReBAC features, there's a risk of authorization logic leaking into the Flow Engine, creating security vulnerabilities and maintenance problems.

**Decision:**
Establish a strict boundary:
- Flow Engine: "Present options, collect responses"
- Policy Engine: "Evaluate rules, make decisions"

Flow may never make authorization decisions. All permission checks, role evaluations, and access decisions are Policy Engine calls.

**Consequences:**
- (+) Clear responsibility: Easy to audit authorization logic
- (+) Testable: Policy can be tested in isolation
- (+) Secure: No bypass paths through Flow
- (-) More API calls: Flow must call Policy for data
- (-) Latency: Additional round-trips may be needed

### DR-004: Profile Migration Contract

**Date:** 2025-12-26
**Status:** Accepted

**Context:**
Tenants will need to upgrade profiles (basic → org) or downgrade (PoC → production). Without clear migration rules, this becomes a support nightmare and potential security issue.

**Decision:**
Define explicit migration paths and rules:

```
Migration Matrix:
┌─────────────┬─────────────┬───────────┬────────────┐
│ From ╲ To   │ human-basic │ human-org │ ai-agent   │
├─────────────┼─────────────┼───────────┼────────────┤
│ human-basic │      -      │    ✅     │     ✅     │
│ human-org   │    ⚠️ *1    │     -     │     ✅     │
│ ai-agent    │    ⚠️ *2    │   ⚠️ *2   │      -     │
└─────────────┴─────────────┴───────────┴────────────┘

*1: Downgrade loses ReBAC/role data (requires explicit acknowledgment)
*2: Downgrade loses AI/MCP configuration (requires explicit acknowledgment)
```

Migration Rules:
1. **Upgrade is safe**: All data preserved, new capabilities unlocked
2. **Downgrade requires acknowledgment**: User must confirm data loss
3. **No migration during active flow**: Wait for flow completion
4. **Audit log required**: All migrations logged with reason
5. **Rollback window**: 7-day grace period for upgrade reversions

**Consequences:**
- (+) Predictable: Support can explain migration impacts
- (+) Safe upgrades: No data loss on upgrade
- (+) Controlled downgrades: Explicit acknowledgment prevents accidents
- (-) Complexity: Migration logic needs implementation
- (-) Constraints: Some migrations may be blocked

### DR-005: Extensible Type System

**Date:** 2025-12-26
**Status:** Accepted

**Context:**
Fixed enums for CapabilityType and ProfileId block plugin/OSS extensibility and require breaking changes for new types.

**Decision:**
Use namespace-based extension pattern:

```typescript
// Core types (enum, protected)
type CoreCapability = 'collect_identifier' | 'collect_secret' | ...;
type CoreProfileId = 'human-basic' | 'human-org' | 'ai-agent' | 'iot-device';

// Extension types (string pattern)
type ExtensionCapability = `x-${string}` | `authrim.${string}` | `${string}.${string}`;
type CustomProfileId = `custom.${string}` | `enterprise.${string}`;

// Combined types
type CapabilityType = CoreCapability | ExtensionCapability;
type ProfileId = CoreProfileId | CustomProfileId;
```

Namespace Conventions:
- `x-*`: Experimental/private (no stability guarantee)
- `authrim.*`: Official Authrim extensions (stable after release)
- `vendor.*`: Third-party vendor extensions (vendor's responsibility)
- `custom.*`: Tenant-specific custom profiles

**Consequences:**
- (+) Extensible: Plugins can add capabilities without core changes
- (+) OSS-friendly: Forks can extend without merge conflicts
- (+) Enterprise-ready: Custom profiles for OEM/White-label
- (-) Validation complexity: Need registry for known extensions
- (-) Documentation: More types to document

### DR-006: State vs Intent Semantics

**Date:** 2025-12-26
**Status:** Accepted

**Context:**
The relationship between `state` and `intent` in UIContract is ambiguous. SDKs and UIs need clear guidance on which to use for what purpose.

**Decision:**
Define clear semantics:

| Attribute | Purpose | Stability | SDK Usage |
|-----------|---------|-----------|-----------|
| `state` | Internal flow state identifier | Unstable (implementation detail) | Diagnostics/debugging only |
| `intent` | Semantic purpose of this step | Stable (part of contract) | **Primary reference for UI logic** |

SDK Guidance:
> "Always branch on `intent`, never on `state`. Use `state` only for logging and error reports."

Example:
```typescript
// ✅ Correct: Branch on intent
if (contract.intent === 'authenticate_user') { ... }

// ❌ Wrong: Branch on state (breaks on refactor)
if (contract.state === 'needsLogin') { ... }
```

**Consequences:**
- (+) Refactor-safe: Flow internals can change without breaking UI
- (+) Clear contract: intent is the stable API surface
- (+) Better errors: state provides context for debugging
- (-) Migration: Existing code may need refactor

### DR-007: Security Tier System

**Date:** 2025-12-26
**Status:** Accepted

**Context:**
Enterprise customers require varying security levels (basic SaaS vs SOC 2 vs regulated industries). Industry-specific profiles (e.g., `fedramp-gov`, `hipaa-healthcare`) create confusion and don't reflect actual usage patterns: a small startup in healthcare may want minimal config, while a fintech AI agent may need maximum security.

**Decision:**
Implement a Security Tier system orthogonal to profiles:

```typescript
type SecurityTier = 'standard' | 'enhanced' | 'regulated';

type ComplianceModule =
  | 'hipaa'    // Healthcare (US)
  | 'pci-dss'  // Payment Card Industry
  | 'ismap'    // Government (Japan)
  | 'gdpr'     // Data Protection (EU)
  | 'sox';     // Public Companies (US)

interface TenantProfileConfig {
  profile: CoreProfileId;           // Base use case
  securityTier: SecurityTier;       // Security level (modifier)
  complianceModules?: ComplianceModule[];
}
```

Tier definitions:
- `standard`: Default, no additional requirements
- `enhanced`: MFA required, detailed audit logs, 1-year retention, 8h session timeout
- `regulated`: Enterprise Attestation (optional), device-bound passkeys, 7-year retention, 1h session

Key design principles:
1. **Tier + Profile composition**: Any profile can combine with any tier
2. **Security tier is a modifier**: Does not change the base profile's use case
3. **Compliance modules are additive**: Enable specific regulatory controls
4. **Control support, not certification**: Authrim does not guarantee compliance

**Consequences:**
- (+) Flexible: `human-basic` + `regulated` for minimal-footprint government apps
- (+) Composable: Security requirements decoupled from use case
- (+) Future-proof: New tiers/modules can be added without new profiles
- (-) Complexity: Two dimensions (profile × tier) to configure
- (-) Regulated tier may be too strict: Future `overrides` escape hatch planned

**Implementation phases:**
- Phase 1 (1.0 GA): `standard` only (current behavior)
- Phase 2 (1.1): `enhanced` tier (MFA required, detailed audit)
- Phase 3 (1.2): `regulated` tier (Enterprise Attestation, device-bound passkeys)

---

## Appendix A: Profile Comparison Matrix

| Feature | human-basic | human-org | ai-agent | iot-device |
|---------|-------------|-----------|----------|------------|
| **Policy** |
| RBAC | Simple | Full | Full | Simple |
| ABAC | ❌ | ❌ | ✅ | ✅ |
| ReBAC | ❌ | ✅ | ✅ | ❌ |
| **Targets** |
| Human | ✅ | ✅ | ✅ | ✅ |
| IoT | ❌ | ❌ | ❌ | ✅ |
| AI Agent | ❌ | ❌ | ✅ | ❌ |
| AI MCP | ❌ | ❌ | ✅ | ❌ |
| Service | ❌ | Optional | ✅ | ✅ |
| **Auth Methods** |
| Passkey | ✅ | ✅ | ✅ | ❌ |
| Email Code | ✅ | ✅ | ❌ | ❌ |
| Password | Optional | Optional | ❌ | ❌ |
| External IdP | Optional | ✅ | ❌ | ❌ |
| DID | ❌ | Optional | Optional | ✅ |
| **Stability** | CORE | STABLE | EXPERIMENTAL | EXPERIMENTAL |

---

## Appendix B: Capability Registry

| Capability | Category | Stability | Profiles |
|------------|----------|-----------|----------|
| `collect_identifier` | CORE | CORE | All |
| `collect_secret` | CORE | CORE | All |
| `verify_possession` | CORE | CORE | All |
| `display_info` | CORE | CORE | All |
| `redirect` | CORE | CORE | All |
| `confirm_consent` | CORE | CORE | All |
| `choose_organization` | POLICY | STABLE | human-org, ai-agent |
| `choose_role` | POLICY | STABLE | human-org, ai-agent |
| `delegate_access` | POLICY | STABLE | human-org, ai-agent |
| `view_permissions` | POLICY | STABLE | human-org, ai-agent |
| `agent_scope_request` | TARGET | EXPERIMENTAL | ai-agent |
| `agent_consent` | TARGET | EXPERIMENTAL | ai-agent |
| `mcp_tool_binding` | TARGET | EXPERIMENTAL | ai-agent |
| `mcp_resource_select` | TARGET | EXPERIMENTAL | ai-agent |
| `device_attestation` | TARGET | EXPERIMENTAL | iot-device |
| `device_binding` | TARGET | EXPERIMENTAL | iot-device |

---

## References

- Current Flow Analysis: `01-current-flow-analysis.md`
- Architecture Decisions: `/private/docs/architecture-decisions.md` §7
