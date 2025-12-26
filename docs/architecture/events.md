# Event Catalog

A document defining the event system for Authrim.
Used as a design guideline for Webhooks, Auth Flow Designer, and custom script execution infrastructure.

> **Note**: This document was created by reviewing the actual code.
> Authrim uses passwordless authentication and does not have password-related features.

## Overview

### Authrim Authentication Methods

| Method                | Description                                                    |
| --------------------- | -------------------------------------------------------------- |
| **Passkey** (WebAuthn)| Passwordless authentication using Discoverable Credentials     |
| **Email Code** (OTP)  | One-time code sent to email address                            |
| **External IdP**      | Google, GitHub, Microsoft, Apple, Facebook, LinkedIn, Twitter, etc. |

### Authrim Main Features

| Feature              | Description                              |
| -------------------- | ---------------------------------------- |
| **OAuth 2.0 / OIDC** | Authorization Code, PAR, PKCE            |
| **CIBA**             | Client Initiated Backchannel Authentication |
| **Device Code**      | Device Authorization Grant (for TV/IoT)  |
| **SAML**             | Operates as both IdP and SP              |
| **SCIM**             | User/Group provisioning                  |
| **ReBAC**            | Relationship-Based Access Control        |
| **VC/DID**           | Verifiable Credentials (Phase 9)         |

---

## Event Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         Event Source                            │
│  (Authentication flows, Admin operations, System events)        │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Event Dispatcher                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ Pre-hooks   │  │ Core Logic  │  │ Post-hooks              │ │
│  │ (Sync)      │  │             │  │ (Sync/Async)            │ │
│  │             │  │             │  │                         │ │
│  │ - Validation│  │ - Execute   │  │ - Audit log             │ │
│  │ - Transform │  │   process   │  │ - Webhook send          │ │
│  │ - Can abort │  │             │  │ - Custom scripts        │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Event Naming Convention

### Format

```
{domain}.{resource}.{action}[.{modifier}]
```

### Examples

| Event Name                      | Description                     |
| ------------------------------- | ------------------------------- |
| `auth.passkey.login.succeeded`  | Passkey login succeeded         |
| `auth.email_code.verified`      | Email code verification succeeded |
| `oauth.consent.granted`         | OAuth consent granted           |
| `admin.client.created`          | Client created by admin         |

---

## Event Categories

### 1. Authentication Events (`auth.*`)

Events related to authentication flows. Hookable in Auth Flow Designer.

#### 1.1 Passkey (WebAuthn) Authentication

| Event                                  | Phase | PII | Hookable | Webhook | Description                           |
| -------------------------------------- | ----- | --- | -------- | ------- | ------------------------------------- |
| `auth.passkey.login.started`           | Pre   | No  | Yes      | No      | Passkey login started                 |
| `auth.passkey.login.challenge_created` | Pre   | No  | No       | No      | WebAuthn challenge created            |
| `auth.passkey.login.succeeded`         | Post  | No  | Yes      | Yes     | Passkey login succeeded               |
| `auth.passkey.login.failed`            | Post  | No  | No       | Yes     | Passkey login failed                  |
| `auth.passkey.register.started`        | Pre   | Yes | Yes      | No      | Passkey registration started (email+name input) |
| `auth.passkey.register.succeeded`      | Post  | Yes | Yes      | Yes     | Passkey registration succeeded        |
| `auth.passkey.register.failed`         | Post  | Yes | No       | Yes     | Passkey registration failed           |

#### 1.2 Email Code (OTP) Authentication

| Event                       | Phase | PII | Hookable | Webhook | Description                                      |
| --------------------------- | ----- | --- | -------- | ------- | ------------------------------------------------ |
| `auth.email_code.requested` | Pre   | Yes | Yes      | No      | Email code send requested                        |
| `auth.email_code.sent`      | Post  | Yes | No       | No      | Email code send completed                        |
| `auth.email_code.verified`  | Post  | Yes | Yes      | Yes     | Email code verification succeeded (login/signup complete) |
| `auth.email_code.failed`    | Post  | Yes | No       | Yes     | Email code verification failed                   |
| `auth.email_code.expired`   | Post  | Yes | No       | No      | Email code expired                               |

#### 1.3 External IdP Authentication

| Event                                 | Phase | PII | Hookable | Webhook | Description                               |
| ------------------------------------- | ----- | --- | -------- | ------- | ----------------------------------------- |
| `auth.external_idp.started`           | Pre   | No  | Yes      | No      | External IdP auth started (before redirect) |
| `auth.external_idp.callback_received` | Pre   | Yes | No       | No      | Callback received                         |
| `auth.external_idp.succeeded`         | Post  | Yes | Yes      | Yes     | External IdP auth succeeded               |
| `auth.external_idp.failed`            | Post  | No  | No       | Yes     | External IdP auth failed                  |
| `auth.external_idp.linked`            | Post  | Yes | Yes      | Yes     | Account linked                            |
| `auth.external_idp.unlinked`          | Post  | No  | No       | Yes     | Account unlinked                          |
| `auth.external_idp.jit_provisioned`   | Post  | Yes | Yes      | Yes     | JIT provisioning (new user created)       |

#### 1.4 Login/Logout (Common)

| Event                               | Phase | PII | Hookable | Webhook | Description                        |
| ----------------------------------- | ----- | --- | -------- | ------- | ---------------------------------- |
| `auth.login.succeeded`              | Post  | Yes | Yes      | Yes     | Login succeeded (all auth methods) |
| `auth.login.failed`                 | Post  | Yes | Yes      | Yes     | Login failed (all auth methods)    |
| `auth.logout.initiated`             | Pre   | No  | Yes      | No      | Logout started (RP-Initiated)      |
| `auth.logout.succeeded`             | Post  | No  | No       | Yes     | Logout completed                   |
| `auth.logout.backchannel_sent`      | Post  | No  | No       | Yes     | Back-Channel Logout sent           |
| `auth.logout.frontchannel_rendered` | Post  | No  | No       | No      | Front-Channel Logout iframe rendered |

#### 1.5 Re-authentication (Step-up Auth)

| Event                   | Phase | PII | Hookable | Webhook | Description                        |
| ----------------------- | ----- | --- | -------- | ------- | ---------------------------------- |
| `auth.reauth.required`  | Pre   | No  | Yes      | No      | Re-auth required (max_age exceeded, etc.) |
| `auth.reauth.succeeded` | Post  | No  | No       | No      | Re-auth succeeded                  |
| `auth.reauth.failed`    | Post  | No  | No       | Yes     | Re-auth failed                     |

---

### 2. OAuth/OIDC Events (`oauth.*`)

Events related to OAuth 2.0 / OpenID Connect flows.

#### 2.1 Authorization

| Event                         | Phase | PII | Hookable | Webhook | Description                  |
| ----------------------------- | ----- | --- | -------- | ------- | ---------------------------- |
| `oauth.authorize.started`     | Pre   | No  | No       | No      | Authorization request received |
| `oauth.authorize.validated`   | Pre   | No  | No       | No      | Parameters validated         |
| `oauth.authorize.code_issued` | Post  | No  | No       | No      | Authorization code issued    |
| `oauth.authorize.failed`      | Post  | No  | No       | No      | Authorization failed         |

#### 2.2 PAR (Pushed Authorization Request)

| Event                | Phase | PII | Hookable | Webhook | Description          |
| -------------------- | ----- | --- | -------- | ------- | -------------------- |
| `oauth.par.created`  | Post  | No  | No       | No      | PAR request created  |
| `oauth.par.consumed` | Post  | No  | No       | No      | PAR request consumed |
| `oauth.par.expired`  | Post  | No  | No       | No      | PAR request expired  |

#### 2.3 Consent

| Event                   | Phase | PII | Hookable | Webhook | Description      |
| ----------------------- | ----- | --- | -------- | ------- | ---------------- |
| `oauth.consent.shown`   | Pre   | No  | Yes      | No      | Consent screen shown |
| `oauth.consent.granted` | Post  | No  | Yes      | Yes     | Consent granted  |
| `oauth.consent.denied`  | Post  | No  | No       | No      | Consent denied   |
| `oauth.consent.revoked` | Post  | No  | No       | Yes     | Consent revoked  |

---

### 3. CIBA Events (`ciba.*`)

Events related to Client Initiated Backchannel Authentication.

| Event                 | Phase | PII | Hookable | Webhook | Description               |
| --------------------- | ----- | --- | -------- | ------- | ------------------------- |
| `ciba.auth.requested` | Pre   | Yes | No       | No      | CIBA auth request received |
| `ciba.auth.pending`   | Post  | No  | No       | No      | Waiting for user approval |
| `ciba.auth.approved`  | Post  | Yes | No       | Yes     | User approved             |
| `ciba.auth.denied`    | Post  | Yes | No       | Yes     | User denied               |
| `ciba.auth.expired`   | Post  | No  | No       | No      | Timeout                   |
| `ciba.ping.sent`      | Post  | No  | No       | No      | Ping notification sent    |
| `ciba.push.sent`      | Post  | No  | No       | No      | Push notification sent    |

---

### 4. Device Code Events (`device.*`)

Events related to Device Authorization Grant.

| Event                  | Phase | PII | Hookable | Webhook | Description            |
| ---------------------- | ----- | --- | -------- | ------- | ---------------------- |
| `device.code.created`  | Post  | No  | No       | No      | Device code issued     |
| `device.code.verified` | Post  | Yes | No       | No      | User code entered      |
| `device.auth.approved` | Post  | Yes | No       | Yes     | User approved          |
| `device.auth.denied`   | Post  | Yes | No       | Yes     | User denied            |
| `device.code.expired`  | Post  | No  | No       | No      | Device code expired    |
| `device.token.issued`  | Post  | No  | No       | No      | Token issued           |

---

### 5. Session Events (`session.*`)

Events related to session lifecycle.

| Event                      | Phase | PII | Hookable | Webhook | Description                       |
| -------------------------- | ----- | --- | -------- | ------- | --------------------------------- |
| `session.created`          | Post  | No  | No       | No      | Session created                   |
| `session.extended`         | Post  | No  | No       | No      | Session extended                  |
| `session.expired`          | Post  | No  | No       | No      | Session expired (automatic)       |
| `session.revoked`          | Post  | No  | No       | Yes     | Session revoked (manual)          |
| `session.revoked.logout`   | Post  | No  | No       | Yes     | Revoked by logout                 |
| `session.revoked.admin`    | Post  | No  | No       | Yes     | Revoked by admin                  |
| `session.revoked.security` | Post  | No  | No       | Yes     | Revoked for security reasons      |

---

### 6. Token Events (`token.*`)

Events related to token issuance and revocation.

| Event                   | Phase | PII | Hookable | Webhook | Description                   |
| ----------------------- | ----- | --- | -------- | ------- | ----------------------------- |
| `token.access.issued`   | Post  | No  | No       | No      | Access Token issued           |
| `token.refresh.issued`  | Post  | No  | No       | No      | Refresh Token issued          |
| `token.refresh.rotated` | Post  | No  | No       | No      | Refresh Token rotated         |
| `token.revoked`         | Post  | No  | No       | Yes     | Token revoked                 |
| `token.introspected`    | Post  | No  | No       | No      | Token introspected            |

---

### 7. User Events (`user.*`)

Events related to user lifecycle and profile.

> **Note**: Due to passwordless authentication, there are no password-related events.

| Event                     | Phase | PII | Hookable | Webhook | Description                             |
| ------------------------- | ----- | --- | -------- | ------- | --------------------------------------- |
| `user.created`            | Post  | Yes | Yes      | Yes     | User created                            |
| `user.updated`            | Post  | Yes | No       | Yes     | User info updated                       |
| `user.deleted`            | Post  | No  | No       | Yes     | User deleted (PII deleted, UUID remains) |
| `user.suspended`          | Post  | No  | No       | Yes     | User suspended                          |
| `user.reactivated`        | Post  | No  | No       | Yes     | User reactivated                        |
| `user.email.changed`      | Post  | Yes | Yes      | Yes     | Email address changed                   |
| `user.email.verified`     | Post  | Yes | No       | Yes     | Email verified                          |
| `user.passkey.registered` | Post  | No  | No       | Yes     | Passkey registered                      |
| `user.passkey.removed`    | Post  | No  | No       | Yes     | Passkey removed                         |
| `user.passkey.renamed`    | Post  | No  | No       | No      | Passkey renamed                         |

---

### 8. Permission Events (`permission.*`)

Events related to authorization and permissions (ReBAC).

| Event                | Phase | PII | Hookable | Webhook | Description                    |
| -------------------- | ----- | --- | -------- | ------- | ------------------------------ |
| `permission.granted` | Post  | No  | No       | Yes     | Permission granted             |
| `permission.revoked` | Post  | No  | No       | Yes     | Permission revoked             |
| `permission.checked` | Post  | No  | No       | No      | Permission check executed      |
| `permission.changed` | Post  | No  | No       | Yes     | Permission change notification (realtime) |
| `role.assigned`      | Post  | No  | No       | Yes     | Role assigned                  |
| `role.removed`       | Post  | No  | No       | Yes     | Role removed                   |

---

### 9. SAML Events (`saml.*`)

Events related to SAML IdP/SP.

#### 9.1 SAML IdP (Authrim operates as IdP)

| Event                              | Phase | PII | Hookable | Webhook | Description          |
| ---------------------------------- | ----- | --- | -------- | ------- | -------------------- |
| `saml.idp.authn_request_received`  | Pre   | No  | No       | No      | AuthnRequest received |
| `saml.idp.response_sent`           | Post  | Yes | No       | No      | SAML Response sent   |
| `saml.idp.logout_request_received` | Pre   | No  | No       | No      | SLO Request received |
| `saml.idp.logout_response_sent`    | Post  | No  | No       | No      | SLO Response sent    |

#### 9.2 SAML SP (Authrim operates as SP)

| Event                         | Phase | PII | Hookable | Webhook | Description                 |
| ----------------------------- | ----- | --- | -------- | ------- | --------------------------- |
| `saml.sp.authn_request_sent`  | Pre   | No  | No       | No      | AuthnRequest sent           |
| `saml.sp.response_received`   | Post  | Yes | Yes      | Yes     | SAML Response received/verified |
| `saml.sp.assertion_validated` | Post  | Yes | No       | No      | Assertion validation succeeded |
| `saml.sp.login_succeeded`     | Post  | Yes | Yes      | Yes     | SAML login succeeded        |
| `saml.sp.login_failed`        | Post  | No  | No       | Yes     | SAML login failed           |

---

### 10. SCIM Events (`scim.*`)

Events related to SCIM provisioning.

| Event                 | Phase | PII | Hookable | Webhook | Description            |
| --------------------- | ----- | --- | -------- | ------- | ---------------------- |
| `scim.user.created`   | Post  | Yes | No       | Yes     | SCIM user created      |
| `scim.user.updated`   | Post  | Yes | No       | Yes     | SCIM user updated      |
| `scim.user.deleted`   | Post  | No  | No       | Yes     | SCIM user deleted      |
| `scim.group.created`  | Post  | No  | No       | Yes     | SCIM group created     |
| `scim.group.updated`  | Post  | No  | No       | Yes     | SCIM group updated     |
| `scim.group.deleted`  | Post  | No  | No       | Yes     | SCIM group deleted     |
| `scim.bulk.completed` | Post  | No  | No       | Yes     | SCIM bulk operation completed |

---

### 11. Admin Events (`admin.*`)

Events related to admin operations (subject to audit logging).

#### 11.1 Client Management

| Event                         | Phase | PII | Hookable | Webhook | Description         |
| ----------------------------- | ----- | --- | -------- | ------- | ------------------- |
| `admin.client.created`        | Post  | No  | No       | Yes     | Client created      |
| `admin.client.updated`        | Post  | No  | No       | Yes     | Client updated      |
| `admin.client.deleted`        | Post  | No  | No       | Yes     | Client deleted      |
| `admin.client.secret_rotated` | Post  | No  | No       | Yes     | Secret rotated      |

#### 11.2 User Management

| Event                   | Phase | PII | Hookable | Webhook | Description                |
| ----------------------- | ----- | --- | -------- | ------- | -------------------------- |
| `admin.user.created`    | Post  | Yes | No       | Yes     | User created by admin      |
| `admin.user.updated`    | Post  | Yes | No       | Yes     | User updated by admin      |
| `admin.user.deleted`    | Post  | No  | No       | Yes     | User deleted by admin      |
| `admin.user.suspended`  | Post  | No  | No       | Yes     | User suspended by admin    |
| `admin.session.revoked` | Post  | No  | No       | Yes     | Session revoked by admin   |

#### 11.3 Key Management

| Event                                 | Phase | PII | Hookable | Webhook | Description               |
| ------------------------------------- | ----- | --- | -------- | ------- | ------------------------- |
| `admin.signing_key.rotated`           | Post  | No  | No       | Yes     | Signing key rotated       |
| `admin.signing_key.rotated.emergency` | Post  | No  | No       | Yes     | Emergency key rotation    |
| `admin.encryption_key.rotated`        | Post  | No  | No       | Yes     | Encryption key rotated    |

#### 11.4 Settings Changes

| Event                    | Phase | PII | Hookable | Webhook | Description           |
| ------------------------ | ----- | --- | -------- | ------- | --------------------- |
| `admin.settings.updated` | Post  | No  | No       | Yes     | System settings changed |
| `admin.idp.created`      | Post  | No  | No       | Yes     | External IdP config added |
| `admin.idp.updated`      | Post  | No  | No       | Yes     | External IdP config updated |
| `admin.idp.deleted`      | Post  | No  | No       | Yes     | External IdP config deleted |

---

### 12. Security Events (`security.*`)

Security-related events (subject to SIEM integration).

| Event                             | Phase | PII | Hookable | Webhook | Description              |
| --------------------------------- | ----- | --- | -------- | ------- | ------------------------ |
| `security.brute_force.detected`   | Post  | Yes | No       | Yes     | Brute force detected     |
| `security.account.locked`         | Post  | Yes | No       | Yes     | Account locked           |
| `security.account.unlocked`       | Post  | No  | No       | Yes     | Account unlocked         |
| `security.suspicious_login`       | Post  | Yes | No       | Yes     | Suspicious login detected |
| `security.rate_limit.exceeded`    | Post  | Yes | No       | Yes     | Rate limit exceeded      |
| `security.replay_attack.detected` | Post  | No  | No       | Yes     | Replay attack detected   |
| `security.token.replay_detected`  | Post  | No  | No       | Yes     | Auth code reuse detected |

---

### 13. VC/DID Events (`vc.*`) - Phase 9

Events related to Verifiable Credentials (in development).

#### 13.1 Credential Issuance

| Event                     | Phase | PII | Hookable | Webhook | Description             |
| ------------------------- | ----- | --- | -------- | ------- | ----------------------- |
| `vc.credential.requested` | Pre   | Yes | No       | No      | Credential issuance requested |
| `vc.credential.issued`    | Post  | Yes | No       | Yes     | Credential issued       |
| `vc.credential.revoked`   | Post  | No  | No       | Yes     | Credential revoked      |

#### 13.2 Presentation

| Event                       | Phase | PII | Hookable | Webhook | Description                |
| --------------------------- | ----- | --- | -------- | ------- | -------------------------- |
| `vc.presentation.requested` | Pre   | No  | No       | No      | Presentation requested     |
| `vc.presentation.verified`  | Post  | Yes | No       | Yes     | Presentation verification succeeded |
| `vc.presentation.failed`    | Post  | No  | No       | Yes     | Presentation verification failed |

---

### 14. System Events (`system.*`)

System events (internal use).

| Event                      | Phase | PII | Hookable | Webhook | Description               |
| -------------------------- | ----- | --- | -------- | ------- | ------------------------- |
| `system.startup`           | Post  | No  | No       | No      | System startup            |
| `system.config.reloaded`   | Post  | No  | No       | No      | Config reloaded           |
| `system.key.rotated`       | Post  | No  | No       | No      | Internal key auto-rotation |
| `system.cleanup.completed` | Post  | No  | No       | No      | Cleanup completed         |
| `system.do.evicted`        | Post  | No  | No       | No      | Durable Object eviction   |

---

## Event Payload Structure

### Base Payload

```typescript
interface BaseEventPayload {
  // Metadata
  eventId: string; // UUID v4
  eventName: string; // e.g., "auth.passkey.login.succeeded"
  timestamp: number; // Unix timestamp (ms)
  tenantId: string; // Tenant ID

  // Context
  context: {
    requestId?: string; // Request ID
    sessionId?: string; // Session ID (if available)
    clientId?: string; // OAuth client ID (if available)
    ipAddress?: string; // IP address
    userAgent?: string; // User-Agent
    geoLocation?: {
      // Geo info (if available)
      country?: string;
      region?: string;
      city?: string;
    };
  };

  // Actor (who)
  actor?: {
    type: 'user' | 'admin' | 'system' | 'client' | 'scim';
    id: string; // UUID
    // PII not included (reference PII DB if needed)
  };

  // Target (what)
  target?: {
    type: string; // e.g., "user", "session", "client"
    id: string; // UUID
  };

  // Event-specific data
  data: Record<string, unknown>;
}
```

### Example: auth.passkey.login.succeeded

```json
{
  "eventId": "evt_abc123",
  "eventName": "auth.passkey.login.succeeded",
  "timestamp": 1703119856000,
  "tenantId": "default",
  "context": {
    "requestId": "req_xyz789",
    "sessionId": "ses_def456",
    "clientId": "my-app",
    "ipAddress": "203.0.113.1",
    "userAgent": "Mozilla/5.0...",
    "geoLocation": {
      "country": "JP",
      "region": "Tokyo"
    }
  },
  "actor": {
    "type": "user",
    "id": "usr_abc123"
  },
  "data": {
    "credentialId": "cred_xyz",
    "deviceName": "MacBook Pro",
    "isDiscoverableCredential": true
  }
}
```

---

## Audit Log vs Event Log

### Differences

| Aspect            | Audit Log                      | Event Log              |
| ----------------- | ------------------------------ | ---------------------- |
| **Purpose**       | Compliance / Legal evidence    | System integration / Automation |
| **Retention**     | Long-term (90 days to permanent) | Short to medium term |
| **PII**           | Minimal (UUID only)            | May include (encrypted) |
| **Mutability**    | Immutable (Append-only)        | Deletable              |
| **Destination**   | D1 (Core DB)                   | Webhook, Queue         |

### PII Separation Principle

```
On user deletion:

1. Delete personal info from PII DB
   - users_pii.email → Delete
   - users_pii.name → Delete

2. Tombstone user record in Core DB
   - users.id → Maintain
   - users.status → 'deleted'
   - users.deleted_at → Deletion timestamp

3. Retain audit logs (no PII)
   - audit_log.action → 'user.deleted'
   - audit_log.target_id → UUID (retain)
   - audit_log.metadata → PII removed
```

---

## Implementation Status

| Category              | Events Defined | Audit Log | Webhook            | Hooks |
| --------------------- | -------------- | --------- | ------------------ | ----- |
| `auth.passkey.*`      | Yes            | No        | No                 | No    |
| `auth.email_code.*`   | Yes            | No        | No                 | No    |
| `auth.external_idp.*` | Yes            | Partial   | No                 | No    |
| `auth.logout.*`       | Yes            | No        | Yes (Back-Channel) | No    |
| `oauth.*`             | Yes            | No        | No                 | No    |
| `ciba.*`              | Yes            | No        | No                 | No    |
| `device.*`            | Yes            | No        | No                 | No    |
| `session.*`           | Yes            | Partial   | Yes (Back-Channel) | No    |
| `token.*`             | Yes            | No        | No                 | No    |
| `user.*`              | Yes            | Partial   | No                 | No    |
| `permission.*`        | Yes            | No        | No (Notifier exists) | No  |
| `saml.*`              | Yes            | No        | No                 | No    |
| `scim.*`              | Yes            | No        | No                 | No    |
| `admin.*`             | Yes            | Yes       | No                 | No    |
| `security.*`          | Yes            | Partial   | No                 | No    |
| `vc.*`                | Yes            | No        | No                 | No    |
| `system.*`            | Yes            | No        | No                 | No    |

---

## References

- [CloudEvents Specification](https://cloudevents.io/)
- [OpenID RISC (Risk and Incident Sharing)](https://openid.net/specs/openid-risc-profile-specification-1_0.html)
- [OIDC Back-Channel Logout](https://openid.net/specs/openid-connect-backchannel-1_0.html)
- [SCIM 2.0](https://datatracker.ietf.org/doc/html/rfc7644)

---

**Last Updated**: 2025-12-20
**Status**: Draft - Event catalog defined based on actual codebase analysis
