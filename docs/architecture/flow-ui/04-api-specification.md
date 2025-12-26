# Flow View API Specification

**Version:** 0.1 (Draft)
**Created:** 2025-12-26
**Status:** Experimental

---

## Table of Contents

1. [Overview](#1-overview)
2. [API Endpoints](#2-api-endpoints)
3. [Error Handling](#3-error-handling)
4. [Integration with Existing Endpoints](#4-integration-with-existing-endpoints)
5. [Flow Design API (Admin)](#5-flow-design-api-admin)
6. [Security Considerations](#6-security-considerations)
7. [Internationalization (i18n)](#7-internationalization-i18n)
8. [TypeScript Types](#8-typescript-types)
9. [Version History](#9-version-history)

---

## 1. Overview

The Flow View API is the public SDK interface for the Flow × UI separation architecture. It enables both external UIs and built-in UIs to interact with authentication flows through a unified contract-based interface.

### Design Goals

1. **SDK-First**: API designed for SDK consumption (React, Vue, vanilla JS)
2. **Contract-Based**: All UI rendering driven by `UIContract` responses
3. **Node-Flow Compatible**: Designed for visual flow designer integration (React Flow / Svelte Flow)
4. **Backward Compatible**: Existing `/api/auth/*` endpoints remain functional

### Base Path

```
/api/flow/*
```

### Authentication

Flow View API endpoints use challenge-based authentication:
- A `challenge_id` is issued by `/authorize` and passed to the UI via redirect
- All Flow API calls require this `challenge_id`
- Challenge IDs are single-use and expire after 10 minutes (configurable via KV)

---

## 2. API Endpoints

### 2.1 GET `/api/flow/contracts`

Retrieves the current UI Contract for a flow challenge.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `challenge_id` | string | Yes | Challenge ID from `/authorize` redirect |
| `locale` | string | No | Preferred locale (`en`, `ja`). Default: `en` |

**Response: `200 OK`**

```json
{
  "version": "0.1",
  "state": "needsLogin",
  "intent": "authenticate_user",
  "stability": "stable",
  "features": {
    "policy": { "rbac": "simple", "abac": false, "rebac": false },
    "targets": { "human": true, "iot": false, "ai_agent": false, "ai_mcp": false, "service": false },
    "authMethods": { "passkey": true, "email_code": true, "password": false, "external_idp": false }
  },
  "capabilities": [
    {
      "type": "collect_identifier",
      "id": "email",
      "required": true,
      "hints": {
        "inputType": "email",
        "label": "flow.login.email.label",
        "placeholder": "flow.login.email.placeholder",
        "autoComplete": "username webauthn",
        "autoFocus": true
      },
      "validation": [
        { "type": "required", "message": "flow.validation.required" },
        { "type": "email", "message": "flow.validation.email" }
      ]
    },
    {
      "type": "verify_possession",
      "id": "passkey",
      "required": false,
      "hints": {
        "webauthn": { "mode": "authenticate", "discoverable": true }
      }
    }
  ],
  "context": {
    "branding": {
      "name": "Example App",
      "logoUri": "https://example.com/logo.png"
    },
    "client": {
      "clientId": "client_abc123",
      "clientName": "Example Application",
      "scopes": [
        { "name": "openid", "title": "scope.openid.title", "description": "scope.openid.desc", "required": true },
        { "name": "profile", "title": "scope.profile.title", "description": "scope.profile.desc", "required": false }
      ]
    }
  },
  "actions": {
    "primary": { "type": "SUBMIT", "label": "flow.action.continue", "variant": "primary" },
    "secondary": [
      { "type": "USE_PASSKEY", "label": "flow.action.use_passkey", "variant": "secondary" }
    ]
  }
}
```

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `missing_challenge_id` | `challenge_id` query parameter not provided |
| 404 | `challenge_not_found` | Challenge does not exist |
| 410 | `challenge_expired` | Challenge has expired |
| 410 | `challenge_consumed` | Challenge has already been used |

---

### 2.2 POST `/api/flow/events`

Sends a user event to progress the authentication flow.

**Request Body:**

```typescript
interface FlowEventRequest {
  challenge_id: string;
  event: FlowEventType;
  data?: Record<string, CapabilityValue>;
  client_metadata?: {
    user_agent?: string;
    language?: string;
  };
}
```

**Event Types:**

| Event | Description | Typical Data |
|-------|-------------|--------------|
| `SUBMIT` | Submit form data | `{ email: { value: "user@example.com" } }` |
| `USE_PASSKEY` | Initiate passkey authentication | - |
| `USE_EMAIL_CODE` | Switch to email code flow | - |
| `USE_EXTERNAL_IDP` | Initiate external IdP flow | `{ provider: { value: "google" } }` |
| `APPROVE` | Approve consent | - |
| `DENY` | Deny consent | - |
| `CONFIRM` | Confirm re-authentication | - |
| `CANCEL` | Cancel the flow | - |
| `BACK` | Go back to previous step | - |
| `SWITCH_ORG` | Switch organization context | `{ org_id: { value: "org_123" } }` |
| `RESEND_CODE` | Resend OTP code | - |

**Response Types:**

The response is a discriminated union based on the `type` field:

```typescript
type FlowEventResponse =
  | { type: 'contract'; contract: UIContract }
  | { type: 'redirect'; redirect_url: string }
  | { type: 'pending'; next_action: PendingAction; capability_id: string }
  | { type: 'error'; error: FlowError };

type PendingAction = 'webauthn' | 'device_binding' | 'external_idp';
```

**Response: `200 OK` (contract)**

```json
{
  "type": "contract",
  "contract": {
    "version": "0.1",
    "state": "verifyCode",
    "intent": "verify_factor",
    "capabilities": [
      {
        "type": "collect_secret",
        "id": "otp",
        "hints": { "inputType": "otp", "length": 6 }
      }
    ],
    "actions": {
      "primary": { "type": "SUBMIT", "label": "flow.action.verify" },
      "secondary": [{ "type": "RESEND_CODE", "label": "flow.action.resend" }]
    }
  }
}
```

**Response: `200 OK` (redirect)**

```json
{
  "type": "redirect",
  "redirect_url": "https://app.example.com/callback?code=abc123&state=xyz"
}
```

**Response: `200 OK` (pending)**

```json
{
  "type": "pending",
  "next_action": "webauthn",
  "capability_id": "passkey"
}
```

When the client receives a `pending` response with `next_action: "webauthn"`, it should:
1. Call `GET /api/flow/webauthn/options` to get WebAuthn options
2. Execute the WebAuthn ceremony using the browser API
3. Submit the result to `POST /api/flow/capabilities/passkey/submit`

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | `invalid_event` | Unknown event type |
| 400 | `invalid_transition` | Event not allowed in current state |
| 422 | `validation_failed` | Capability data validation failed |

---

### 2.3 GET `/api/flow/webauthn/options`

Retrieves WebAuthn options for passkey authentication.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `challenge_id` | string | Yes | Challenge ID |
| `capability_id` | string | Yes | Capability ID (e.g., `passkey`) |
| `mode` | string | No | `authenticate` or `register`. Default: `authenticate` |

**Response: `200 OK`**

```json
{
  "publicKey": {
    "challenge": "base64url-encoded-challenge",
    "timeout": 60000,
    "rpId": "example.com",
    "allowCredentials": [
      {
        "type": "public-key",
        "id": "base64url-credential-id",
        "transports": ["internal", "hybrid"]
      }
    ],
    "userVerification": "preferred"
  }
}
```

---

### 2.4 POST `/api/flow/capabilities/:id/submit`

Submits capability-specific data (e.g., WebAuthn credential).

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Capability ID (e.g., `passkey`) |

**Request Body (Passkey):**

```json
{
  "challenge_id": "ch_abc123",
  "credential": {
    "id": "base64url-credential-id",
    "rawId": "base64url-raw-id",
    "type": "public-key",
    "response": {
      "authenticatorData": "base64url-auth-data",
      "clientDataJSON": "base64url-client-data",
      "signature": "base64url-signature",
      "userHandle": "base64url-user-handle"
    }
  }
}
```

**Response:**

Returns `FlowEventResponse` (same as POST `/api/flow/events`).

---

## 3. Error Handling

### 3.1 Error Response Format (RFC 9457 Problem Details)

All errors follow the RFC 9457 Problem Details specification:

```json
{
  "type": "https://authrim.io/problems/flow/challenge-expired",
  "title": "Challenge Expired",
  "status": 410,
  "detail": "The authentication challenge has expired. Please start again.",
  "error": "challenge_expired",
  "error_code": "AR120003",
  "error_id": "trace-abc123-xyz"
}
```

### 3.2 Error Code Registry

| Code | HTTP | Error | Description |
|------|------|-------|-------------|
| AR120001 | 400 | `missing_challenge_id` | `challenge_id` not provided |
| AR120002 | 404 | `challenge_not_found` | Challenge does not exist |
| AR120003 | 410 | `challenge_expired` | Challenge has expired |
| AR120004 | 410 | `challenge_consumed` | Challenge already used |
| AR120005 | 400 | `invalid_event` | Unknown event type |
| AR120006 | 400 | `invalid_transition` | Event not allowed in current state |
| AR120007 | 422 | `validation_failed` | Capability data validation failed |
| AR120008 | 400 | `webauthn_failed` | WebAuthn credential verification failed |
| AR120009 | 400 | `external_idp_failed` | External IdP authentication failed |
| AR120010 | 404 | `capability_not_found` | Capability not found |

### 3.3 FlowError Structure

For validation and business logic errors returned in the response body:

```typescript
interface FlowError {
  code: string;           // Error code (e.g., "validation_failed")
  message: string;        // i18n key (e.g., "flow.error.validation_failed")
  retryable: boolean;     // Whether the operation can be retried
  user_action?: UserAction;
  field_errors?: FieldError[];
}

type UserAction = 'retry' | 'login' | 'contact_admin' | 'none';

interface FieldError {
  field: string;          // Capability field ID (e.g., "email")
  code: string;           // Validation error code
  message: string;        // i18n key
}
```

---

## 4. Integration with Existing Endpoints

### 4.1 Challenge Lifecycle

```
/authorize
    │
    ├─► ChallengeStore DO creates challenge
    │   (type: 'login' or 'consent')
    │
    ▼
UI redirect (with challenge_id)
    │
    ▼
GET /api/flow/contracts?challenge_id=xxx
    │
    ├─► Generate UIContract from challenge metadata
    │
    ▼
POST /api/flow/events
    │
    ├─► Delegate to existing handlers internally:
    │   - SUBMIT (email) → email-codes/send
    │   - USE_PASSKEY → passkeys/login/options
    │   - APPROVE/DENY → consent processing
    │
    ▼
Flow complete → redirect_url response
```

### 4.2 Endpoint Mapping

| Legacy Endpoint | Flow Event | Processing |
|-----------------|------------|------------|
| `/api/auth/email-codes/send` | `SUBMIT` (with email) | Internal delegation |
| `/api/auth/email-codes/verify` | `SUBMIT` (with OTP) | Internal delegation |
| `/api/auth/passkeys/login/options` | `USE_PASSKEY` | Internal delegation |
| `/api/auth/passkeys/login/verify` | Capability submit | Internal delegation |
| `/api/auth/consents` POST | `APPROVE` / `DENY` | Internal delegation |

### 4.3 Backward Compatibility

- Existing `/api/auth/*` endpoints remain fully functional
- Flow View API is an abstraction layer on top of existing handlers
- SDKs can migrate incrementally

---

## 5. Flow Design API (Admin)

### 5.1 Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/flows` | GET | List all flows |
| `/api/admin/flows` | POST | Create new flow |
| `/api/admin/flows/:id` | GET | Get flow details |
| `/api/admin/flows/:id` | PATCH | Update flow |
| `/api/admin/flows/:id` | DELETE | Delete flow |
| `/api/admin/flows/:id/validate` | POST | Validate flow graph |
| `/api/admin/flows/:id/activate` | POST | Activate flow |
| `/api/admin/flows/nodes` | GET | Get available node types |

### 5.2 Flow Design Types

```typescript
interface AuthenticationFlow {
  id: string;
  name: string;
  description?: string;
  profile: ProfileId;
  securityTier?: SecurityTier;
  version: string;
  nodes: FlowDesignNode[];
  edges: FlowDesignEdge[];
  entry: string;           // Entry node ID
  errorHandler?: string;   // Error handler node ID
  metadata: {
    createdAt: string;
    updatedAt: string;
    createdBy: string;
  };
}

interface FlowDesignNode {
  id: string;
  type: CapabilityType | Intent | `plugin.${string}`;
  label: string;
  position: { x: number; y: number };
  config?: Record<string, unknown>;
  capabilities: CapabilityType[];
  actions: ActionDefinition[];
  meta?: {
    icon?: string;
    color?: string;
    description?: string;
  };
}

interface FlowDesignEdge {
  id: string;
  from: string;
  to: string;
  guard?: TransitionGuard;
  label?: string;
  meta?: {
    errorHandler?: string;
    timeout?: number;
    retryCount?: number;
  };
}
```

### 5.3 Transition Guards

```typescript
interface TransitionGuard {
  type: 'always' | 'preset' | 'custom';
  preset?: PresetGuard;
  custom?: {
    expression: string;      // JavaScript expression
    schema?: z.ZodSchema;    // Type validation
  };
}

type PresetGuard =
  | { name: 'prompt_equals'; value: 'login' | 'consent' | 'none' }
  | { name: 'auth_age_exceeded'; maxAge: number }
  | { name: 'consent_missing' }
  | { name: 'mfa_required' }
  | { name: 'org_selection_required' };
```

### 5.4 Flow Validation

**POST `/api/admin/flows/:id/validate`**

```json
{
  "valid": true,
  "errors": [],
  "warnings": [
    {
      "type": "unreachable_node",
      "nodeId": "node_xyz",
      "message": "Node is not reachable from entry point"
    }
  ]
}
```

**Validation Error Types:**

| Type | Description |
|------|-------------|
| `missing_entry` | No entry node defined |
| `orphan_node` | Node has no incoming edges (except entry) |
| `invalid_guard` | Guard expression is invalid |
| `profile_mismatch` | Node capability not available in profile |
| `cycle_detected` | Infinite loop detected |

### 5.5 Available Nodes

**GET `/api/admin/flows/nodes?profile=human-org`**

```json
{
  "capabilities": [
    { "type": "collect_identifier", "label": "Collect Email/Phone", "category": "core", "stability": "core" },
    { "type": "verify_possession", "label": "Passkey/WebAuthn", "category": "auth", "stability": "stable" },
    { "type": "choose_organization", "label": "Organization Selector", "category": "policy", "stability": "stable" }
  ],
  "customNodes": [
    { "type": "plugin.totp", "label": "TOTP Verification", "pluginId": "authenticator-totp" }
  ]
}
```

---

## 6. Security Considerations

### 6.1 Challenge Security

- **Single-Use**: Challenge is consumed upon flow completion
- **TTL Enforcement**: Default 10 minutes, configurable via KV
- **Unpredictable IDs**: `crypto.randomUUID()` for challenge IDs
- **Encrypted Metadata**: Challenge data encrypted in ChallengeStore DO

### 6.2 Rate Limiting

```typescript
// Applied to all Flow API endpoints
app.use('/api/flow/*', async (c, next) => {
  const profile = await getRateLimitProfileAsync(c.env, 'moderate');
  return rateLimitMiddleware({
    ...profile,
    endpoints: ['/api/flow/contracts', '/api/flow/events']
  })(c, next);
});
```

### 6.3 Input Validation

- Event types validated against allowlist
- Capability data validated against UIContract schema
- All user input sanitized before processing
- Guard expressions executed in sandboxed environment

### 6.4 CORS Policy

```typescript
const corsOptions = {
  origin: (origin, callback) => {
    // Allow configured origins from tenant settings
    const allowedOrigins = getTenantAllowedOrigins(tenantId);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
};
```

---

## 7. Internationalization (i18n)

### 7.1 Design Decision

**API returns i18n keys only; translation happens on the client side.**

Rationale:
- Keeps API responses lightweight and cacheable
- Client SDKs can use any i18n library
- UI-specific translations belong in the UI layer
- Admin UI and Login UI need full i18n, API messages do not

### 7.2 i18n Key Conventions

| Category | Key Pattern | Example |
|----------|-------------|---------|
| Labels | `flow.{step}.{field}.label` | `flow.login.email.label` |
| Placeholders | `flow.{step}.{field}.placeholder` | `flow.login.email.placeholder` |
| Validation | `flow.validation.{rule}` | `flow.validation.required` |
| Actions | `flow.action.{type}` | `flow.action.continue` |
| Errors | `flow.error.{code}` | `flow.error.challenge_expired` |
| Scopes | `scope.{name}.{title\|desc}` | `scope.openid.title` |

### 7.3 Client-Side Translation

```typescript
// SDK example
const contract = await flowApi.getContract(challengeId);

// Translate capability labels
const translatedCapabilities = contract.capabilities.map(cap => ({
  ...cap,
  hints: {
    ...cap.hints,
    label: t(cap.hints.label),
    placeholder: cap.hints.placeholder ? t(cap.hints.placeholder) : undefined,
  }
}));
```

---

## 8. TypeScript Types

### 8.1 Package Structure

```
packages/ar-lib-core/src/schemas/
├── flow-ui/           # Existing UI Contract types
│   ├── index.ts
│   └── *.schema.json
├── flow-api/          # Flow View API types (NEW)
│   └── index.ts
└── flow-design/       # Flow Designer types (NEW)
    └── index.ts
```

### 8.2 Flow API Types

```typescript
// packages/ar-lib-core/src/schemas/flow-api/index.ts

import type { UIContract } from '../flow-ui';

// Request types
export interface FlowContractRequest {
  challenge_id: string;
  locale?: string;
}

export interface FlowEventRequest {
  challenge_id: string;
  event: FlowEventType;
  data?: Record<string, CapabilityValue>;
  client_metadata?: ClientMetadata;
}

export interface FlowCapabilitySubmitRequest {
  challenge_id: string;
  credential?: WebAuthnCredential;
  data?: Record<string, unknown>;
}

// Event types
export type FlowEventType =
  | 'SUBMIT'
  | 'USE_PASSKEY'
  | 'USE_EMAIL_CODE'
  | 'USE_DID'
  | 'USE_EXTERNAL_IDP'
  | 'APPROVE'
  | 'DENY'
  | 'CONFIRM'
  | 'CANCEL'
  | 'BACK'
  | 'SWITCH_ORG'
  | 'RESEND_CODE';

// Response types
export type FlowEventResponse =
  | FlowContractResponse
  | FlowRedirectResponse
  | FlowPendingResponse
  | FlowErrorResponse;

export interface FlowContractResponse {
  type: 'contract';
  contract: UIContract;
}

export interface FlowRedirectResponse {
  type: 'redirect';
  redirect_url: string;
}

export interface FlowPendingResponse {
  type: 'pending';
  next_action: PendingAction;
  capability_id: string;
}

export interface FlowErrorResponse {
  type: 'error';
  error: FlowError;
}

export type PendingAction = 'webauthn' | 'device_binding' | 'external_idp';

// Error types
export interface FlowError {
  code: string;
  message: string;
  retryable: boolean;
  user_action?: UserAction;
  field_errors?: FieldError[];
}

export type UserAction = 'retry' | 'login' | 'contact_admin' | 'none';

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

// Supporting types
export interface CapabilityValue {
  value: string | boolean | string[];
  raw?: unknown;
}

export interface ClientMetadata {
  user_agent?: string;
  language?: string;
}

export interface WebAuthnCredential {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
    userHandle?: string;
  };
}

export interface WebAuthnOptions {
  publicKey: PublicKeyCredentialRequestOptions;
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
- [03-schema-specification.md](./03-schema-specification.md) - Schema specification
- [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) - Problem Details for HTTP APIs
- [WebAuthn Spec](https://www.w3.org/TR/webauthn-2/) - Web Authentication API
