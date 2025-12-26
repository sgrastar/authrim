# Flow × UI Separation: Current Flow Analysis

**Created:** 2025-12-26
**Status:** Initial Analysis Complete
**Purpose:** Document existing authentication flows to inform Flow × UI separation architecture

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture Overview](#2-current-architecture-overview)
3. [Authentication Flows](#3-authentication-flows)
4. [Authorization Flows](#4-authorization-flows)
5. [Session Management Flows](#5-session-management-flows)
6. [UI Data Requirements by Flow](#6-ui-data-requirements-by-flow)
7. [Implicit State Transitions](#7-implicit-state-transitions)
8. [Gap Analysis](#8-gap-analysis)
9. [XState Machine Design Recommendations](#9-xstate-machine-design-recommendations)

---

## 1. Executive Summary

This document analyzes the current authentication and authorization flows in Authrim's `ar-auth` package to inform the design of the Flow × UI separation architecture. The analysis identifies:

- **6 primary authentication methods** (Email Code, Passkey, External IdP, DID, Password, Session)
- **3 authorization flow stages** (Login Challenge, Authorization, Consent)
- **4 session management flows** (Create, Refresh, Invalidate, Check)
- **Implicit state machines** embedded in handler logic that need extraction

### Key Findings

1. **State management is currently implicit** - Flow states are encoded in URL parameters, cookies, and challenge IDs rather than an explicit state machine
2. **UI data contracts exist but are informal** - Types like `ConsentScreenData` and `LoginChallengeData` already define what UI needs, but these aren't generalized
3. **Error handling is flow-specific** - Each handler has its own error response patterns
4. **Branding context is partially implemented** - Client metadata (logo, policy, ToS) flows through, but user branding is minimal

---

## 2. Current Architecture Overview

### 2.1 Package Structure

```
packages/ar-auth/src/
├── index.ts              # Hono routes, middleware composition
├── authorize.ts          # OAuth2/OIDC authorization endpoint (1000+ lines)
├── consent.ts            # Consent screen handling
├── login-challenge.ts    # Login challenge data provider
├── email-code.ts         # Email OTP authentication
├── passkey.ts            # WebAuthn/Passkey authentication
├── did-auth.ts           # DID-based authentication
├── did-link.ts           # DID linking to accounts
├── logout.ts             # RP-Initiated, Frontchannel, Backchannel logout
├── session-management.ts # OIDC Session Management
├── par.ts                # Pushed Authorization Requests
├── warmup.ts             # DO warmup
└── config.ts             # Configuration debug endpoint
```

### 2.2 Data Flow Pattern (Current)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Current Data Flow                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Client/Browser                                                     │
│        │                                                             │
│        ▼                                                             │
│   ┌─────────────────┐                                                │
│   │   ar-auth API   │ ◄─── URL Params, Cookies, Headers              │
│   │   (Hono)        │                                                │
│   └────────┬────────┘                                                │
│            │                                                         │
│            ▼                                                         │
│   ┌─────────────────┐     ┌─────────────────┐                        │
│   │  Handler Logic  │────►│  ChallengeStore │  (Durable Object)      │
│   │ (implicit FSM)  │     │    (state)      │                        │
│   └────────┬────────┘     └─────────────────┘                        │
│            │                                                         │
│            ▼                                                         │
│   ┌─────────────────┐     ┌─────────────────┐                        │
│   │   Repository    │────►│       D1        │  (Database)            │
│   │   (data access) │     │   KV, R2        │                        │
│   └────────┬────────┘     └─────────────────┘                        │
│            │                                                         │
│            ▼                                                         │
│   ┌─────────────────┐                                                │
│   │   Response      │ ───► JSON (API) or HTML (Fallback) or Redirect │
│   └─────────────────┘                                                │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.3 Route Structure (index.ts)

| Route | Method | Handler | Purpose |
|-------|--------|---------|---------|
| `/authorize` | GET/POST | `authorizeHandler` | OAuth2/OIDC authorization |
| `/flow/confirm` | GET/POST | `authorizeConfirmHandler` | Re-authentication |
| `/flow/login` | GET/POST | `authorizeLoginHandler` | Session-less login |
| `/par` | POST | `parHandler` | Pushed Authorization Request |
| `/api/auth/passkeys/*` | POST | `passkey*Handler` | WebAuthn registration/auth |
| `/api/auth/email-codes/*` | POST | `emailCode*Handler` | Email OTP |
| `/api/auth/dids/*` | POST/GET/DELETE | `did*Handler` | DID authentication/linking |
| `/api/auth/consents` | GET/POST | `consent*Handler` | Consent screen |
| `/api/auth/login-challenges` | GET | `loginChallengeGetHandler` | Login page data |
| `/api/sessions/*` | GET/POST | `session*Handler` | Session management |
| `/session/check` | GET | `checkSessionIframeHandler` | OIDC Session iframe |
| `/logout` | GET | `frontChannelLogoutHandler` | RP-Initiated logout |
| `/logout/backchannel` | POST | `backChannelLogoutHandler` | Backchannel logout |

---

## 3. Authentication Flows

### 3.1 Email Code (OTP) Flow

**Location:** `email-code.ts`
**Endpoints:** `POST /api/auth/email-codes/send`, `POST /api/auth/email-codes/verify`

#### State Transitions (Implicit)

```
┌─────────────┐   SEND_CODE   ┌────────────────┐   VERIFY_CODE   ┌─────────────┐
│   initial   │──────────────►│  code_pending  │────────────────►│ authenticated│
└─────────────┘               └────────────────┘                 └─────────────┘
                                     │                                  │
                                     │ EXPIRED/INVALID                  │
                                     ▼                                  ▼
                              ┌────────────────┐               ┌─────────────┐
                              │    error       │               │   session   │
                              └────────────────┘               └─────────────┘
```

#### State Encoding

| State | How Encoded | Storage |
|-------|-------------|---------|
| `initial` | No cookie, no challenge | - |
| `code_pending` | `authrim_otp_session` cookie + challenge in ChallengeStore | Cookie + DO |
| `authenticated` | `authrim_session` cookie | Cookie + SessionStore DO |
| `error` | JSON response with error | Response |

#### UI Data Requirements

```typescript
// Send phase - input needed
interface EmailCodeSendInput {
  email: string;
  name?: string;  // Optional for new user creation
}

// Verify phase - input needed
interface EmailCodeVerifyInput {
  email: string;
  code: string;   // 6-digit OTP
}

// Success response - UI feedback
interface EmailCodeVerifySuccess {
  success: true;
  sessionId: string;
  userId: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    email_verified: number;
  };
}
```

### 3.2 Passkey (WebAuthn) Flow

**Location:** `passkey.ts`
**Endpoints:**
- Registration: `POST /api/auth/passkeys/register/options`, `POST /api/auth/passkeys/register/verify`
- Authentication: `POST /api/auth/passkeys/login/options`, `POST /api/auth/passkeys/login/verify`

#### State Transitions (Implicit)

```
                    ┌─────────────────────────────────────────────────────┐
                    │                    REGISTRATION                      │
┌─────────────┐     │  GET_OPTIONS   ┌────────────────┐   VERIFY          │
│   initial   │─────┼───────────────►│  options_ready │───────────┐       │
└─────────────┘     │                └────────────────┘           │       │
                    │                       │                     ▼       │
                    │                       │ WEBAUTHN    ┌─────────────┐ │
                    │                       └────────────►│  registered │ │
                    │                                     └─────────────┘ │
                    └─────────────────────────────────────────────────────┘

                    ┌─────────────────────────────────────────────────────┐
                    │                   AUTHENTICATION                     │
┌─────────────┐     │  GET_OPTIONS   ┌────────────────┐   VERIFY          │
│   initial   │─────┼───────────────►│  options_ready │───────────┐       │
└─────────────┘     │                └────────────────┘           │       │
                    │                       │                     ▼       │
                    │                       │ WEBAUTHN    ┌─────────────┐ │
                    │                       └────────────►│authenticated│ │
                    │                                     └─────────────┘ │
                    └─────────────────────────────────────────────────────┘
```

#### UI Data Requirements

```typescript
// Registration options - returned to UI
interface PasskeyRegisterOptionsResponse {
  options: PublicKeyCredentialCreationOptionsJSON;  // WebAuthn options
  userId: string;
}

// Authentication options - returned to UI
interface PasskeyLoginOptionsResponse {
  options: PublicKeyCredentialRequestOptionsJSON;
  challengeId: string;
}

// Client-side interaction
// UI must call navigator.credentials.create() or navigator.credentials.get()
// and return the credential to verify endpoint
```

### 3.3 External IdP Flow

**Location:** `packages/ar-bridge/` (separate package, callback handled in ar-auth)
**Endpoints:** Via ar-bridge, callback at ar-auth

#### State Transitions

```
┌─────────────┐   REDIRECT    ┌────────────────┐   CALLBACK   ┌─────────────┐
│   initial   │──────────────►│  at_external   │─────────────►│ processing  │
└─────────────┘               │     IdP        │              └──────┬──────┘
                              └────────────────┘                     │
                                                                     ▼
                                                    ┌─────────────────────────────┐
                                                    │                             │
                                            ┌───────┴───────┐             ┌───────┴───────┐
                                            │  account_link │             │  jit_create   │
                                            │   required    │             │   or_login    │
                                            └───────────────┘             └───────┬───────┘
                                                                                  │
                                                                                  ▼
                                                                          ┌─────────────┐
                                                                          │authenticated│
                                                                          └─────────────┘
```

### 3.4 DID Authentication Flow

**Location:** `did-auth.ts`, `did-link.ts`
**Endpoints:** `POST /api/auth/dids/challenge`, `POST /api/auth/dids/verify`

#### State Transitions

```
┌─────────────┐   GET_CHALLENGE   ┌────────────────┐   SIGN & VERIFY   ┌─────────────┐
│   initial   │──────────────────►│ challenge_ready │─────────────────►│authenticated│
└─────────────┘                   └────────────────┘                   └─────────────┘
```

---

## 4. Authorization Flows

### 4.1 OAuth2/OIDC Authorization Flow

**Location:** `authorize.ts` (1000+ lines - primary complexity)
**Endpoint:** `GET/POST /authorize`

#### State Transitions (Complex)

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              AUTHORIZATION FLOW                                          │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│   ┌─────────────┐                                                                        │
│   │   request   │─────────────────────────────────────────────────────────────────┐      │
│   │  received   │                                                                 │      │
│   └──────┬──────┘                                                                 │      │
│          │                                                                        │      │
│          ▼ validate params                                                        │      │
│   ┌─────────────┐    invalid    ┌─────────────┐                                   │      │
│   │  validating │──────────────►│    error    │ (redirect with error or JSON)     │      │
│   └──────┬──────┘               └─────────────┘                                   │      │
│          │ valid                                                                  │      │
│          ▼                                                                        │      │
│   ┌─────────────┐    no session ┌─────────────┐                                   │      │
│   │check_session│──────────────►│   login     │ (redirect to login page)          │      │
│   └──────┬──────┘               │  required   │                                   │      │
│          │ has session          └──────┬──────┘                                   │      │
│          │                             │ after login                              │      │
│          │◄────────────────────────────┘                                          │      │
│          ▼                                                                        │      │
│   ┌─────────────┐    prompt=login ┌─────────────┐                                 │      │
│   │ check_prompt│────────────────►│   reauth    │ (redirect to confirm page)      │      │
│   └──────┬──────┘                 │  required   │                                 │      │
│          │ no reauth needed       └──────┬──────┘                                 │      │
│          │                               │ after reauth                           │      │
│          │◄──────────────────────────────┘                                        │      │
│          ▼                                                                        │      │
│   ┌─────────────┐    no consent  ┌─────────────┐                                  │      │
│   │check_consent│───────────────►│  consent    │ (redirect to consent page)       │      │
│   └──────┬──────┘                │  required   │                                  │      │
│          │ has consent           └──────┬──────┘                                  │      │
│          │                              │ after consent                           │      │
│          │◄─────────────────────────────┘                                         │      │
│          ▼                                                                        │      │
│   ┌─────────────┐                                                                 │      │
│   │ issue_code  │ ───────────────────────────────────────────────────────────────►│      │
│   └─────────────┘        redirect to redirect_uri with code                       │      │
│                                                                                   │      │
└───────────────────────────────────────────────────────────────────────────────────┴──────┘
```

#### Key Decision Points in authorize.ts

1. **PAR/Request Object Resolution** (lines 260-600)
   - Check for `request_uri` (PAR) or `request` (JAR)
   - Fetch and validate Request Objects

2. **Parameter Validation** (lines 600-800)
   - Validate `response_type`, `client_id`, `redirect_uri`, `scope`, etc.
   - PKCE validation for public clients

3. **Session Check** (lines 800-900)
   - Read `authrim_session` cookie
   - Validate session in SessionStore DO

4. **Prompt Handling** (lines 900-1000)
   - `prompt=login` → force re-authentication
   - `prompt=consent` → force consent screen
   - `prompt=none` → fail if interaction required
   - `max_age` → check auth_time against max_age

5. **Consent Check** (lines 1000-1100)
   - Check existing consent in `oauth_client_consents` table
   - Scope matching

6. **Code Issuance** (lines 1100-1200)
   - Generate authorization code
   - Store in AuthCodeStore DO with metadata
   - Redirect to `redirect_uri`

### 4.2 Consent Flow

**Location:** `consent.ts`
**Endpoints:** `GET/POST /api/auth/consents`

#### State Transitions

```
┌─────────────┐   GET_DATA   ┌────────────────┐   APPROVE/DENY   ┌─────────────┐
│   pending   │─────────────►│  data_loaded   │─────────────────►│  completed  │
│  (via URL)  │              │   (display)    │                  │ (redirect)  │
└─────────────┘              └────────────────┘                  └─────────────┘
```

#### UI Data Requirements (ConsentScreenData)

```typescript
interface ConsentScreenData {
  challenge_id: string;
  client: {
    client_id: string;
    client_name: string;
    logo_uri?: string;
    client_uri?: string;
    policy_uri?: string;
    tos_uri?: string;
    is_trusted?: boolean;
  };
  scopes: Array<{
    name: string;
    title: string;
    description: string;
    required: boolean;
  }>;
  user: {
    id: string;
    email: string;
    name?: string;
    picture?: string;
  };
  organizations: Array<{
    id: string;
    name: string;
    type: string;
    is_primary: boolean;
    plan?: string;
  }>;
  primary_org: { ... } | null;
  roles: string[];
  acting_as: { ... } | null;
  target_org_id: string | null;
  features: {
    org_selector_enabled: boolean;
    acting_as_enabled: boolean;
    show_roles: boolean;
  };
}
```

### 4.3 Login Challenge Flow

**Location:** `login-challenge.ts`
**Endpoint:** `GET /api/auth/login-challenges`

#### Purpose

Provides client metadata (logo, policy, ToS) to the login page during OAuth flow for OIDC Dynamic OP conformance.

#### UI Data Requirements (LoginChallengeData)

```typescript
interface LoginChallengeData {
  challenge_id: string;
  client: {
    client_id: string;
    client_name: string;
    logo_uri?: string;
    client_uri?: string;
    policy_uri?: string;
    tos_uri?: string;
  };
  scope?: string;
  login_hint?: string;
}
```

---

## 5. Session Management Flows

### 5.1 Session Lifecycle

```
┌─────────────┐   LOGIN   ┌─────────────┐   REFRESH   ┌─────────────┐
│    none     │──────────►│   active    │────────────►│   active    │
└─────────────┘           └──────┬──────┘             │  (extended) │
                                 │                    └─────────────┘
                                 │ LOGOUT/EXPIRE
                                 ▼
                          ┌─────────────┐
                          │  invalidated│
                          └─────────────┘
```

### 5.2 Logout Flow

**Location:** `logout.ts`
**Endpoints:** `GET /logout`, `POST /logout/backchannel`

#### Front-Channel Logout State Transitions

```
┌─────────────┐   VALIDATE   ┌────────────────┐   INVALIDATE   ┌─────────────┐
│   request   │─────────────►│  id_token_hint │───────────────►│  sessions   │
│  received   │              │   validated    │                │ invalidated │
└─────────────┘              └────────────────┘                └──────┬──────┘
                                                                      │
                                    ┌─────────────────────────────────┤
                                    │                                 │
                                    ▼                                 ▼
                            ┌─────────────┐                   ┌─────────────┐
                            │ frontchannel│                   │  redirect   │
                            │  iframes    │                   │ (no iframe) │
                            └──────┬──────┘                   └─────────────┘
                                   │
                                   ▼
                            ┌─────────────┐
                            │  redirect   │
                            └─────────────┘
```

---

## 6. UI Data Requirements by Flow

### 6.1 Summary Table

| Flow | Collect | Display | Actions |
|------|---------|---------|---------|
| **Email Code Send** | email, name? | - | submit |
| **Email Code Verify** | code | email (readonly) | submit, resend |
| **Passkey Login** | - | - | trigger WebAuthn |
| **Passkey Register** | email, name? | - | trigger WebAuthn |
| **Login Page** | email | client info, external IdPs | multiple auth methods |
| **Consent** | org selection? | scopes, client, user | approve, deny |
| **Reauth (confirm)** | - | session info | confirm |
| **Logout Complete** | - | success message | close/navigate |
| **Error** | - | error message, details | retry?, back |

### 6.2 Proposed Capability Mapping

| Current UI Requirement | Proposed Capability |
|------------------------|---------------------|
| Email input | `collect_identifier` (type: email) |
| Password input | `collect_secret` (type: password) |
| OTP code input | `collect_secret` (type: otp) |
| Passkey trigger | `verify_possession` (type: passkey) |
| Auth method selection | `choose_one` |
| Scope selection | `choose_many` |
| Consent approve/deny | `confirm_consent` |
| Error display | `display_info` (variant: error) |
| Redirect to IdP | `redirect` (type: external_idp) |

---

## 7. Implicit State Transitions

### 7.1 State Encoded in URL Parameters

| Parameter | Purpose | Used By |
|-----------|---------|---------|
| `challenge_id` | Links to challenge in ChallengeStore | Consent, Login Challenge |
| `_confirmed` | Indicates re-auth completed | authorize.ts |
| `_consent_confirmed` | Indicates consent completed | authorize.ts |
| `_auth_time` | Auth time for session | authorize.ts |
| `_session_user_id` | User ID from session | authorize.ts |
| `error` | Error code from previous step | Login, Logout pages |
| `email` | Pre-fill email | Email code verify |

### 7.2 State Encoded in Cookies

| Cookie | Purpose | Set By |
|--------|---------|--------|
| `authrim_session` | Session ID | All auth methods after success |
| `authrim_otp_session` | OTP session binding | Email code send |
| `authrim_browser_state` | OIDC Session Management | After session creation |

### 7.3 State Encoded in ChallengeStore

| Challenge Type | Purpose | TTL |
|----------------|---------|-----|
| `login` | OAuth login challenge | 10 min |
| `consent` | Consent challenge | 10 min |
| `email_code` | Email OTP challenge | 5 min |
| `passkey_registration` | WebAuthn registration | 5 min |
| `passkey_authentication` | WebAuthn authentication | 5 min |
| `did_auth` | DID authentication | 5 min |

---

## 8. Gap Analysis

### 8.1 What Needs to Change for Flow × UI Separation

| Current State | Target State | Gap |
|---------------|--------------|-----|
| Implicit FSM in handlers | Explicit XState machine | High - requires extraction |
| Flow-specific responses | Unified UI Contract | Medium - types exist but not unified |
| URL parameter state | Flow state in machine context | Medium |
| Handler-specific error handling | Centralized error → UI Contract | Medium |
| Cookie-based session check | Machine state for session | Low |
| Client info fetched per-request | Flow context with branding | Low |

### 8.2 Code Complexity

| File | Lines | Complexity | Refactor Priority |
|------|-------|------------|-------------------|
| `authorize.ts` | 1000+ | Very High | 1 (split into states) |
| `consent.ts` | ~600 | Medium | 2 |
| `passkey.ts` | ~800 | Medium | 3 |
| `email-code.ts` | ~500 | Low | 4 |
| `logout.ts` | ~900 | High | 2 |

### 8.3 Missing Pieces

1. **No centralized Intent definitions** - Each handler decides what UI should do
2. **No Capability abstraction** - UI logic is embedded in Svelte components
3. **No Flow API layer** - UI calls multiple endpoints directly
4. **No i18n in API responses** - Translations handled by UI only

---

## 9. XState Machine Design Recommendations

### 9.1 Proposed Machine Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                        Root Flow Machine                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌───────────────┐                                              │
│   │ Authorization │ ──► Entry point for OAuth/OIDC               │
│   │    Machine    │                                              │
│   └───────┬───────┘                                              │
│           │                                                      │
│           │ invokes                                              │
│           ▼                                                      │
│   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐     │
│   │Authentication │   │   Consent     │   │    Logout     │     │
│   │   Machine     │   │   Machine     │   │   Machine     │     │
│   └───────┬───────┘   └───────────────┘   └───────────────┘     │
│           │                                                      │
│           │ invokes                                              │
│           ▼                                                      │
│   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐     │
│   │  EmailCode    │   │   Passkey     │   │ External IdP  │     │
│   │   Machine     │   │   Machine     │   │   Machine     │     │
│   └───────────────┘   └───────────────┘   └───────────────┘     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 9.2 Authorization Machine States (Example)

```typescript
const authorizationMachine = createMachine({
  id: 'authorization',
  initial: 'validating',
  context: {
    params: {},        // OAuth params
    client: null,      // Client info
    session: null,     // Session info
    user: null,        // User info
    consent: null,     // Consent info
    error: null,       // Error info
  },
  states: {
    validating: {
      meta: {
        intent: 'validate_request',
        capabilities: [],
        actions: {},
      },
      invoke: {
        src: 'validateParams',
        onDone: 'checkingSession',
        onError: 'error',
      },
    },
    checkingSession: {
      invoke: {
        src: 'checkSession',
        onDone: [
          { guard: 'needsLogin', target: 'needsLogin' },
          { guard: 'needsReauth', target: 'needsReauth' },
          { target: 'checkingConsent' },
        ],
      },
    },
    needsLogin: {
      meta: {
        intent: 'authenticate_user',
        capabilities: [
          { type: 'collect_identifier', id: 'email' },
          { type: 'verify_possession', id: 'passkey' },
        ],
        actions: {
          primary: { type: 'LOGIN', label: 'Continue' },
        },
      },
    },
    needsReauth: {
      meta: {
        intent: 'verify_factor',
        capabilities: [
          { type: 'verify_possession', id: 'passkey' },
        ],
        actions: {
          primary: { type: 'CONFIRM', label: 'Confirm' },
          secondary: [{ type: 'CANCEL', label: 'Cancel' }],
        },
      },
    },
    checkingConsent: {
      invoke: {
        src: 'checkConsent',
        onDone: [
          { guard: 'needsConsent', target: 'needsConsent' },
          { target: 'issuingCode' },
        ],
      },
    },
    needsConsent: {
      meta: {
        intent: 'obtain_consent',
        capabilities: [
          { type: 'confirm_consent', id: 'oauth_consent' },
          { type: 'choose_one', id: 'org_selector', required: false },
        ],
        actions: {
          primary: { type: 'APPROVE', label: 'Allow' },
          secondary: [{ type: 'DENY', label: 'Deny' }],
        },
      },
    },
    issuingCode: {
      invoke: {
        src: 'issueCode',
        onDone: 'complete',
        onError: 'error',
      },
    },
    complete: {
      meta: {
        intent: 'complete_flow',
        capabilities: [
          { type: 'redirect', id: 'redirect_to_rp' },
        ],
      },
      type: 'final',
    },
    error: {
      meta: {
        intent: 'handle_error',
        capabilities: [
          { type: 'display_info', id: 'error_display', variant: 'error' },
        ],
        actions: {
          secondary: [{ type: 'RETRY', label: 'Try Again' }],
        },
      },
    },
  },
});
```

### 9.3 UI Contract Generation

The `meta` field in each state should be used to generate the UI Contract:

```typescript
function generateUIContract(machine, state, context): UIContract {
  const stateMeta = state.meta;

  return {
    version: '0.1',
    state: state.value,
    intent: stateMeta?.intent,
    capabilities: stateMeta?.capabilities || [],
    context: {
      branding: context.client ? {
        name: context.client.client_name,
        logoUri: context.client.logo_uri,
        policyUri: context.client.policy_uri,
        tosUri: context.client.tos_uri,
      } : undefined,
      user: context.user ? {
        id: context.user.id,
        email: context.user.email,
        name: context.user.name,
      } : undefined,
      error: context.error ? {
        code: context.error.code,
        message: context.error.message,
      } : undefined,
    },
    actions: stateMeta?.actions || { primary: { type: 'SUBMIT', label: 'Continue' } },
  };
}
```

---

## Next Steps

1. **Step 2: UI Contract JSON Schema v0.1** - Define formal JSON Schema
2. **Step 3: Capability v1 Specification** - Define all capabilities
3. **Step 4: Intent Specification** - Define all intents
4. **Step 5: Flow API Design** - Design `/api/flow/*` endpoints
5. **Step 6: Policy Boundary Design** - Separate Flow/Policy/PII/Token concerns
6. **Step 7: Prototype** - Implement one flow (login) as proof of concept

---

## References

- Architecture Decisions: `/private/docs/architecture-decisions.md` §7
- Consent Types: `/packages/ar-lib-core/src/types/consent.ts`
- Current Handlers: `/packages/ar-auth/src/*.ts`
- Current UI: `/packages/ar-ui/src/routes/**/*.svelte`
