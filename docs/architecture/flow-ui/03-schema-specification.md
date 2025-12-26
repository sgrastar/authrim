# Flow × UI Separation: Schema Specification

**Version:** 0.1 (Draft)
**Created:** 2025-12-26
**Status:** Experimental

---

## Table of Contents

1. [Overview](#1-overview)
2. [Schema Files](#2-schema-files)
3. [UI Contract](#3-ui-contract)
4. [Capabilities](#4-capabilities)
5. [Intents](#5-intents)
6. [Feature Profiles](#6-feature-profiles)
7. [Usage Examples](#7-usage-examples)
8. [TypeScript Integration](#8-typescript-integration)
9. [Version History](#9-version-history)

---

## 1. Overview

This document specifies the JSON Schema definitions for the Flow × UI separation architecture. The schemas define the contract between the Flow Engine and UI implementations.

### Design Goals

1. **Type Safety**: All schemas have corresponding TypeScript types
2. **Extensibility**: New capabilities and intents can be added without breaking changes
3. **Profile-Based**: Configuration is driven by feature profiles, not arbitrary flags
4. **Stability-Aware**: Every element declares its stability level

### Schema Location

```
packages/ar-lib-core/src/schemas/flow-ui/
├── ui-contract.schema.json      # Main UI Contract
├── capability.schema.json       # Capability definitions
├── intent.schema.json           # Intent definitions
├── feature-profile.schema.json  # Feature Profile definitions
└── index.ts                     # TypeScript type exports
```

---

## 2. Schema Files

| File | Purpose | $id |
|------|---------|-----|
| `ui-contract.schema.json` | Main contract between Flow and UI | `https://authrim.io/schemas/flow-ui/ui-contract.schema.json` |
| `capability.schema.json` | UI interaction pattern definitions | `https://authrim.io/schemas/flow-ui/capability.schema.json` |
| `intent.schema.json` | Flow state purpose definitions | `https://authrim.io/schemas/flow-ui/intent.schema.json` |
| `feature-profile.schema.json` | Pre-defined configuration bundles | `https://authrim.io/schemas/flow-ui/feature-profile.schema.json` |

All schemas use JSON Schema Draft-07.

---

## 3. UI Contract

The `UIContract` is the primary interface between the Flow Engine and UI.

### Structure

```typescript
interface UIContract {
  version: '0.1';
  state: string;
  intent: Intent;
  stability?: StabilityLevel;
  features: FeatureFlags;
  capabilities: Capability[];
  context?: FlowContext;
  actions: ActionSet;
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | `"0.1"` | Yes | Schema version |
| `state` | `string` | Yes | Current flow state (e.g., `"needsLogin"`) |
| `intent` | `Intent` | Yes | What this state aims to achieve |
| `stability` | `StabilityLevel` | No | Contract-level stability |
| `features` | `FeatureFlags` | Yes | Enabled features from profile |
| `capabilities` | `Capability[]` | Yes | UI capabilities for this state |
| `context` | `FlowContext` | No | Contextual data for rendering |
| `actions` | `ActionSet` | Yes | Available user actions |

### Example

```json
{
  "version": "0.1",
  "state": "needsLogin",
  "intent": "authenticate_user",
  "stability": "stable",
  "features": {
    "policy": { "rbac": "simple", "abac": false, "rebac": false },
    "targets": { "human": true, "iot": false, "ai_agent": false, "ai_mcp": false, "service": false },
    "authMethods": { "passkey": true, "email_code": true, "password": false, "external_idp": false, "did": false }
  },
  "capabilities": [
    {
      "type": "collect_identifier",
      "id": "email",
      "hints": {
        "inputType": "email",
        "label": "Email address",
        "autoComplete": "email",
        "autoFocus": true
      },
      "validation": [
        { "type": "required", "message": "Email is required" },
        { "type": "email", "message": "Please enter a valid email" }
      ]
    },
    {
      "type": "verify_possession",
      "id": "passkey",
      "hints": {
        "webauthn": { "mode": "authenticate", "discoverable": true }
      }
    }
  ],
  "context": {
    "branding": {
      "name": "My App",
      "logoUri": "https://example.com/logo.png"
    }
  },
  "actions": {
    "primary": { "type": "CONTINUE", "label": "Continue", "variant": "primary" },
    "secondary": [{ "type": "CANCEL", "label": "Cancel", "variant": "link" }]
  }
}
```

---

## 4. Capabilities

Capabilities represent distinct UI interaction patterns.

### Categories

| Category | Stability | Description |
|----------|-----------|-------------|
| `core` | CORE | Always available, cannot be disabled |
| `auth` | varies | Authentication method specific |
| `policy` | STABLE | RBAC/ABAC/ReBAC features |
| `target` | EXPERIMENTAL | AI/IoT/Service specific |

### Core Capabilities

| Type | Description | Input Type |
|------|-------------|------------|
| `collect_identifier` | Collect email, phone, username | email, tel, text |
| `collect_secret` | Collect password, OTP, PIN | password, otp |
| `verify_possession` | Verify ownership (passkey, device) | button (WebAuthn) |
| `display_info` | Show messages | - |
| `redirect` | Redirect to external URL | - |
| `confirm_consent` | OAuth consent approval | checkbox, button |

### Policy Capabilities

| Type | Description | Requires |
|------|-------------|----------|
| `choose_organization` | Organization selector | ReBAC |
| `choose_role` | Role selector | RBAC (full) |
| `delegate_access` | Acting-as selector | ReBAC |
| `view_permissions` | Permission preview | RBAC/ReBAC |

### Target Capabilities

| Type | Description | Requires |
|------|-------------|----------|
| `agent_scope_request` | AI agent scope selection | ai_agent |
| `agent_consent` | AI agent authorization | ai_agent |
| `mcp_tool_binding` | MCP tool binding | ai_mcp |
| `mcp_resource_select` | MCP resource selection | ai_mcp |
| `device_attestation` | Hardware attestation | iot |
| `device_binding` | Device binding | iot |

### Capability Hints

The `hints` object provides UI rendering guidance:

```typescript
interface CapabilityHints {
  inputType?: 'text' | 'email' | 'password' | 'tel' | 'otp' | 'select' | ...;
  label?: string;
  placeholder?: string;
  helpText?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  options?: Array<{ value: string; label: string; }>;
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
  webauthn?: { mode: 'register' | 'authenticate'; discoverable?: boolean; };
}
```

---

## 5. Intents

Intents describe what a flow state aims to achieve.

### Core Intents

| Intent | Description | Typical Capabilities |
|--------|-------------|---------------------|
| `identify_user` | Collect user identifier | `collect_identifier` |
| `authenticate_user` | Verify identity | `collect_secret`, `verify_possession` |
| `verify_factor` | Additional factor (MFA) | `verify_possession` |
| `obtain_consent` | OAuth consent | `confirm_consent` |
| `complete_flow` | Flow completed | `redirect` |
| `handle_error` | Error occurred | `display_info` |

### Policy Intents

| Intent | Description | Requires |
|--------|-------------|----------|
| `select_organization` | Choose org context | ReBAC |
| `select_role` | Choose role | RBAC (full) |
| `delegate_identity` | Acting-as flow | ReBAC |
| `review_permissions` | Preview permissions | RBAC/ReBAC |

### Target Intents

| Intent | Description | Requires |
|--------|-------------|----------|
| `authorize_agent` | Authorize AI agent | ai_agent |
| `scope_agent` | Define agent scopes | ai_agent |
| `bind_mcp_tools` | Bind MCP tools | ai_mcp |
| `authorize_mcp` | Authorize MCP | ai_mcp |
| `attest_device` | Device attestation | iot |
| `bind_device` | Bind device | iot |
| `authenticate_service` | Service auth | service |

---

## 6. Feature Profiles

Profiles are pre-defined, tested configurations.

### Available Profiles

| Profile | Stability | Use Case |
|---------|-----------|----------|
| `human-basic` | CORE | Simple web apps |
| `human-org` | STABLE | B2B SaaS with organizations |
| `ai-agent` | EXPERIMENTAL | AI agents |
| `iot-device` | EXPERIMENTAL | IoT devices |

### Profile Selection Rules

1. **One Profile Per Tenant**: Each tenant has exactly one active profile
2. **Immutable in Flight**: Profile cannot change during an active flow
3. **Upgrade Path**: Profiles can be upgraded (basic → org)
4. **Subtractive Adjustments**: Can disable features, not add from other profiles

### KV Storage

```json
{
  "id": "human-org",
  "adjustments": {
    "authMethods": {
      "password": false
    },
    "ui": {
      "consent_show_roles": true
    }
  },
  "activatedAt": "2025-12-26T00:00:00Z"
}
```

---

## 7. Usage Examples

### Example 1: Login Flow (human-basic)

```json
{
  "version": "0.1",
  "state": "collectEmail",
  "intent": "identify_user",
  "features": {
    "policy": { "rbac": "simple", "abac": false, "rebac": false },
    "targets": { "human": true },
    "authMethods": { "passkey": true, "email_code": true }
  },
  "capabilities": [
    {
      "type": "collect_identifier",
      "id": "email",
      "hints": { "inputType": "email", "autoFocus": true },
      "validation": [{ "type": "required" }, { "type": "email" }]
    }
  ],
  "actions": {
    "primary": { "type": "CONTINUE", "label": "Continue" }
  }
}
```

### Example 2: Consent Flow (human-org)

```json
{
  "version": "0.1",
  "state": "needsConsent",
  "intent": "obtain_consent",
  "features": {
    "policy": { "rbac": "full", "rebac": true },
    "authMethods": { "passkey": true, "external_idp": true }
  },
  "capabilities": [
    {
      "type": "choose_organization",
      "id": "org_selector",
      "required": false,
      "hints": {
        "inputType": "select",
        "options": [
          { "value": "org1", "label": "Acme Corp" },
          { "value": "org2", "label": "Globex Inc" }
        ]
      }
    },
    {
      "type": "confirm_consent",
      "id": "oauth_consent"
    }
  ],
  "context": {
    "client": {
      "clientId": "app123",
      "clientName": "My Application",
      "scopes": [
        { "name": "openid", "title": "OpenID", "required": true },
        { "name": "profile", "title": "Profile", "required": false }
      ]
    },
    "user": { "id": "user1", "email": "user@example.com" }
  },
  "actions": {
    "primary": { "type": "APPROVE", "label": "Allow" },
    "secondary": [{ "type": "DENY", "label": "Deny" }]
  }
}
```

---

## 8. TypeScript Integration

### Importing Types

```typescript
import {
  UIContract,
  Capability,
  Intent,
  FeatureProfile,
  ProfileId,
  StabilityLevel,
} from '@authrim/ar-lib-core/schemas/flow-ui';
```

### Type-Safe Capabilities

```typescript
import type { CapabilitiesForProfile, IntentsForProfile } from '@authrim/ar-lib-core/schemas/flow-ui';

// Only core capabilities for human-basic
type BasicCapabilities = CapabilitiesForProfile<'human-basic'>;
// 'collect_identifier' | 'collect_secret' | 'verify_possession' | ...

// Core + Policy capabilities for human-org
type OrgCapabilities = CapabilitiesForProfile<'human-org'>;
// Includes 'choose_organization' | 'choose_role' | ...
```

### Filtering by Stability

```typescript
function filterStableCapabilities(contract: UIContract): Capability[] {
  return contract.capabilities.filter(
    (c) => c.stability === 'core' || c.stability === 'stable'
  );
}
```

---

## 9. Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1 | 2025-12-26 | Initial draft |

---

## References

- [01-current-flow-analysis.md](./01-current-flow-analysis.md) - Current flow analysis
- [02-architecture-principles.md](./02-architecture-principles.md) - Architecture principles
- JSON Schema files: `packages/ar-lib-core/src/schemas/flow-ui/`
