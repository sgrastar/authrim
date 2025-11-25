# CIBA Implementation Status & TODO

## 📊 Current Implementation Status

### ✅ Completed (Core Implementation)

#### 1. Database Schema
- ✅ `ciba_requests` table with full schema
- ✅ Client metadata extensions for CIBA
- ✅ Indexes for efficient queries
- ✅ Migration script: `migrations/007_add_ciba_requests_table.sql`

#### 2. Durable Objects
- ✅ **CIBARequestStore** - Complete implementation
  - Status tracking (pending → approved/denied/expired)
  - Polling rate limiting
  - One-time token issuance enforcement
  - Automatic expiration cleanup
  - In-memory cache + D1 persistence
  - File: `packages/shared/src/durable-objects/CIBARequestStore.ts`

#### 3. API Endpoints
- ✅ **POST /bc-authorize** - Backchannel authentication request
  - Request validation
  - Login hint parsing (email, phone, sub, username)
  - Binding message support (max 140 chars)
  - Optional user code generation
  - Delivery mode determination (poll/ping/push)
  - File: `packages/op-async/src/ciba-authorization.ts`

- ✅ **POST /token** - CIBA grant type support
  - `grant_type=urn:openid:params:grant-type:ciba`
  - Authorization pending/slow_down/access_denied errors
  - One-time token issuance
  - Full OAuth token response
  - File: `packages/op-token/src/token.ts` (lines 1564-1927)

#### 4. Discovery & Configuration
- ✅ Discovery metadata updates
  - `backchannel_authentication_endpoint`
  - `backchannel_token_delivery_modes_supported: ['poll', 'ping', 'push']`
  - `backchannel_authentication_request_signing_alg_values_supported`
  - `grant_types_supported` includes CIBA grant type
  - File: `packages/op-discovery/src/discovery.ts`

#### 5. Type Definitions
- ✅ `CIBARequestMetadata` - Full request metadata
- ✅ `CIBAAuthenticationRequest` - Request parameters
- ✅ `CIBAAuthenticationResponse` - Response format
- ✅ Client metadata CIBA fields
- ✅ Provider metadata CIBA fields
- File: `packages/shared/src/types/oidc.ts`

#### 6. Utilities
- ✅ `generateAuthReqId()` - UUID v4 generation
- ✅ `generateCIBAUserCode()` - User code generation
- ✅ `isCIBARequestExpired()` - Expiration check
- ✅ `isPollingTooFast()` - Rate limiting
- ✅ `parseLoginHint()` - Multi-format support
- ✅ `validateBindingMessage()` - Message validation
- ✅ `validateCIBARequest()` - Request validation
- ✅ `determineDeliveryMode()` - Mode selection
- ✅ `calculatePollingInterval()` - Dynamic interval
- File: `packages/shared/src/utils/ciba.ts`

#### 7. Routing
- ✅ Router integration for `/bc-authorize`
- ✅ Router integration for `/api/ciba/*`
- ✅ OP-Async worker routing
- Files: `packages/router/src/index.ts`, `packages/op-async/src/index.ts`

#### 8. Documentation
- ✅ Comprehensive CIBA guide
- ✅ Flow diagrams
- ✅ API reference
- ✅ Security considerations
- File: `docs/CIBA.md`

---

## ⏳ Not Implemented (TODO)

### 🔴 Priority 1: CIBA Approval API (CRITICAL)

**Status**: Not implemented
**Blocks**: Complete CIBA flow testing
**Estimated effort**: 2-3 hours

#### Required Endpoints

**1. List Pending Requests**
```typescript
// GET /api/ciba/pending
// Query params: ?login_hint=user@example.com or ?user_id=user123
{
  "requests": [
    {
      "auth_req_id": "1c266114-a1be-4252-8ad1-04986c5b9ac1",
      "client_id": "client123",
      "client_name": "Banking App",
      "scope": "openid profile email",
      "binding_message": "Sign in to Banking App",
      "user_code": "ABCD-1234",
      "created_at": 1234567890,
      "expires_at": 1234568190,
      "status": "pending"
    }
  ]
}
```

**2. Get Request Details**
```typescript
// GET /api/ciba/request/:auth_req_id
{
  "auth_req_id": "1c266114-a1be-4252-8ad1-04986c5b9ac1",
  "client": {
    "client_id": "client123",
    "client_name": "Banking App",
    "logo_uri": "https://...",
    "is_trusted": false
  },
  "scope": "openid profile email",
  "binding_message": "Sign in to Banking App",
  "user_code": "ABCD-1234",
  "created_at": 1234567890,
  "expires_at": 1234568190,
  "time_remaining": 290
}
```

**3. Approve Request**
```typescript
// POST /api/ciba/approve
// Body:
{
  "auth_req_id": "1c266114-a1be-4252-8ad1-04986c5b9ac1",
  "user_id": "user123"
}

// Response:
{
  "success": true,
  "message": "Authentication request approved"
}
```

**4. Deny Request**
```typescript
// POST /api/ciba/deny
// Body:
{
  "auth_req_id": "1c266114-a1be-4252-8ad1-04986c5b9ac1",
  "reason": "User rejected" // Optional
}

// Response:
{
  "success": true,
  "message": "Authentication request denied"
}
```

#### Implementation Requirements
- Session/authentication check (user must be logged in)
- Verify user owns the login_hint
- Client metadata enrichment (name, logo, trust status)
- Scope description/translation
- Security: CSRF protection, rate limiting

#### Files to Create
- `packages/op-async/src/ciba-pending.ts` - List pending requests
- `packages/op-async/src/ciba-details.ts` - Get request details
- `packages/op-async/src/ciba-approve.ts` - Approve request
- `packages/op-async/src/ciba-deny.ts` - Deny request

#### Route Integration
```typescript
// packages/op-async/src/index.ts
app.get('/api/ciba/pending', cibaPendingHandler);
app.get('/api/ciba/request/:auth_req_id', cibaDetailsHandler);
app.post('/api/ciba/approve', cibaApproveHandler);
app.post('/api/ciba/deny', cibaDenyHandler);
```

---

### 🟡 Priority 2: User Notification System

**Status**: Not implemented
**Blocks**: Real-world CIBA usage
**Estimated effort**: 5-8 hours

#### 1. Push Notifications (Mobile/Web)

**iOS (APNs)**
```typescript
// packages/shared/src/notifications/apns.ts
interface APNsNotification {
  deviceToken: string;
  payload: {
    aps: {
      alert: {
        title: string;
        body: string;
      };
      badge?: number;
      sound?: string;
    };
    auth_req_id: string;
    binding_message?: string;
  };
}

async function sendAPNs(notification: APNsNotification): Promise<void> {
  // Implementation using APNs HTTP/2 API
}
```

**Android (FCM)**
```typescript
// packages/shared/src/notifications/fcm.ts
interface FCMNotification {
  token: string;
  notification: {
    title: string;
    body: string;
  };
  data: {
    auth_req_id: string;
    binding_message?: string;
  };
}

async function sendFCM(notification: FCMNotification): Promise<void> {
  // Implementation using FCM HTTP v1 API
}
```

**Web Push**
```typescript
// packages/shared/src/notifications/web-push.ts
interface WebPushNotification {
  subscription: {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  };
  payload: {
    title: string;
    body: string;
    data: {
      auth_req_id: string;
    };
  };
}

async function sendWebPush(notification: WebPushNotification): Promise<void> {
  // Implementation using web-push library
}
```

#### 2. SMS Notifications

```typescript
// packages/shared/src/notifications/sms.ts
interface SMSNotification {
  phoneNumber: string; // E.164 format
  message: string;
  approvalUrl: string; // Deep link
}

async function sendSMS(notification: SMSNotification): Promise<void> {
  // Implementation using Twilio/AWS SNS/etc.
  // Example message:
  // "Banking App is requesting authentication.
  //  Binding message: Transaction ID: 12345
  //  Approve: https://auth.example.com/ciba/approve?token=..."
}
```

#### 3. Email Notifications

```typescript
// packages/shared/src/notifications/email.ts
interface EmailNotification {
  to: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  approvalUrl: string;
}

async function sendEmail(notification: EmailNotification): Promise<void> {
  // Implementation using Resend/SendGrid/etc.
}
```

#### Device Token Management

```sql
-- Add to users table or create new table
CREATE TABLE user_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_type TEXT NOT NULL CHECK (device_type IN ('ios', 'android', 'web')),
  push_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_devices_user_id ON user_devices(user_id);
```

#### Integration Point

```typescript
// In ciba-authorization.ts, after storing request:
if (login_hint) {
  const parsed = parseLoginHint(login_hint);

  if (parsed.type === 'email') {
    await sendEmailNotification(parsed.value, authReqId, binding_message);
  } else if (parsed.type === 'phone') {
    await sendSMSNotification(parsed.value, authReqId, binding_message);
  }

  // Also send push notifications if device tokens exist
  const devices = await getUserDevices(userId);
  for (const device of devices) {
    await sendPushNotification(device, authReqId, binding_message);
  }
}
```

---

### 🟡 Priority 3: Ping/Push Mode Complete Implementation

**Status**: Structure exists, callbacks not implemented
**Blocks**: Ping/Push mode functionality
**Estimated effort**: 3-4 hours

#### Ping Mode Implementation

```typescript
// packages/shared/src/notifications/ciba-ping.ts
async function sendPingNotification(
  clientNotificationEndpoint: string,
  clientNotificationToken: string,
  authReqId: string
): Promise<void> {
  // Send HTTP POST to client notification endpoint
  const response = await fetch(clientNotificationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${clientNotificationToken}`,
    },
    body: JSON.stringify({
      auth_req_id: authReqId,
    }),
  });

  if (!response.ok) {
    console.error('Ping notification failed:', await response.text());
  }
}
```

#### Push Mode Implementation

```typescript
// packages/shared/src/notifications/ciba-push.ts
async function sendPushModeTokens(
  clientNotificationEndpoint: string,
  clientNotificationToken: string,
  authReqId: string,
  accessToken: string,
  idToken: string,
  refreshToken: string
): Promise<void> {
  // Send tokens directly to client
  const response = await fetch(clientNotificationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${clientNotificationToken}`,
    },
    body: JSON.stringify({
      auth_req_id: authReqId,
      access_token: accessToken,
      token_type: 'Bearer',
      id_token: idToken,
      refresh_token: refreshToken,
      expires_in: 3600,
    }),
  });

  if (!response.ok) {
    console.error('Push mode token delivery failed:', await response.text());
  }
}
```

#### Integration Points

**1. In ciba-approve handler:**
```typescript
// After user approves, check delivery mode
if (metadata.delivery_mode === 'ping') {
  await sendPingNotification(
    metadata.client_notification_endpoint!,
    metadata.client_notification_token!,
    metadata.auth_req_id
  );
}
```

**2. In handleCIBAGrant (token.ts):**
```typescript
// After issuing tokens, if push mode:
if (metadata.delivery_mode === 'push') {
  await sendPushModeTokens(
    metadata.client_notification_endpoint!,
    metadata.client_notification_token!,
    authReqId,
    accessToken,
    idToken,
    refreshToken
  );

  // Return immediate success to client (tokens already sent)
  return c.json({ success: true }, 200);
}
```

---

### 🟢 Priority 4: User Approval UI

**Status**: Not implemented
**Blocks**: User-facing functionality
**Estimated effort**: 4-6 hours

#### Web UI Components (SvelteKit)

**1. Pending Requests Page**
```svelte
<!-- src/routes/ciba/+page.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';

  let pendingRequests = [];

  onMount(async () => {
    const response = await fetch('/api/ciba/pending');
    pendingRequests = (await response.json()).requests;
  });
</script>

<div class="ciba-requests">
  <h1>Authentication Requests</h1>
  {#each pendingRequests as request}
    <div class="request-card">
      <div class="client-info">
        <img src={request.client.logo_uri} alt={request.client.client_name} />
        <h2>{request.client.client_name}</h2>
      </div>

      {#if request.binding_message}
        <div class="binding-message">
          <strong>Message:</strong> {request.binding_message}
        </div>
      {/if}

      {#if request.user_code}
        <div class="user-code">
          <strong>Verification Code:</strong>
          <span class="code">{request.user_code}</span>
        </div>
      {/if}

      <div class="scopes">
        <strong>Requested Access:</strong>
        <ul>
          {#each request.scope.split(' ') as scope}
            <li>{scope}</li>
          {/each}
        </ul>
      </div>

      <div class="actions">
        <button on:click={() => approve(request.auth_req_id)}>
          Approve
        </button>
        <button on:click={() => deny(request.auth_req_id)}>
          Deny
        </button>
      </div>

      <div class="expiry">
        Expires in {timeRemaining(request.expires_at)}
      </div>
    </div>
  {/each}
</div>
```

**2. Quick Approval (Deep Link)**
```svelte
<!-- src/routes/ciba/approve/[auth_req_id]/+page.svelte -->
<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';

  const authReqId = $page.params.auth_req_id;
  let request = null;

  onMount(async () => {
    const response = await fetch(`/api/ciba/request/${authReqId}`);
    request = await response.json();
  });

  async function handleApprove() {
    await fetch('/api/ciba/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_req_id: authReqId }),
    });

    // Show success and redirect
  }
</script>

{#if request}
  <div class="quick-approve">
    <h1>Approve Authentication?</h1>
    <!-- Same UI as above -->
  </div>
{/if}
```

#### Mobile Deep Links

**iOS (Universal Links)**
```json
// .well-known/apple-app-site-association
{
  "applinks": {
    "apps": [],
    "details": [
      {
        "appID": "TEAMID.com.example.app",
        "paths": ["/ciba/approve/*"]
      }
    ]
  }
}
```

**Android (App Links)**
```xml
<!-- AndroidManifest.xml -->
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="https"
        android:host="auth.example.com"
        android:pathPrefix="/ciba/approve" />
</intent-filter>
```

---

### 🔵 Priority 5: Testing

**Status**: Not implemented
**Blocks**: Production readiness
**Estimated effort**: 6-8 hours

#### Unit Tests

**1. CIBARequestStore Tests**
```typescript
// packages/shared/src/durable-objects/__tests__/CIBARequestStore.test.ts
describe('CIBARequestStore', () => {
  test('stores and retrieves CIBA request', async () => {});
  test('marks request as approved', async () => {});
  test('marks request as denied', async () => {});
  test('detects polling too fast', async () => {});
  test('enforces one-time token issuance', async () => {});
  test('cleans up expired requests', async () => {});
});
```

**2. CIBA Utilities Tests**
```typescript
// packages/shared/src/utils/__tests__/ciba.test.ts
describe('CIBA Utilities', () => {
  test('generateAuthReqId generates UUID v4', async () => {});
  test('parseLoginHint handles email format', async () => {});
  test('parseLoginHint handles phone format', async () => {});
  test('validateBindingMessage rejects too long', async () => {});
  test('validateCIBARequest requires login hint', async () => {});
  test('determineDeliveryMode selects poll', async () => {});
});
```

**3. Authorization Handler Tests**
```typescript
// packages/op-async/src/__tests__/ciba-authorization.test.ts
describe('CIBA Authorization Handler', () => {
  test('returns auth_req_id on valid request', async () => {});
  test('rejects missing client_id', async () => {});
  test('rejects missing login hints', async () => {});
  test('rejects invalid binding message', async () => {});
  test('respects client CIBA configuration', async () => {});
});
```

#### Integration Tests

**1. Complete CIBA Flow**
```typescript
// tests/integration/ciba-flow.test.ts
describe('CIBA Flow Integration', () => {
  test('complete poll mode flow', async () => {
    // 1. Initiate CIBA request
    const cibaResponse = await POST('/bc-authorize', {
      scope: 'openid profile',
      client_id: 'test_client',
      login_hint: 'user@example.com',
    });

    expect(cibaResponse.auth_req_id).toBeDefined();

    // 2. Simulate user approval
    await POST('/api/ciba/approve', {
      auth_req_id: cibaResponse.auth_req_id,
      user_id: 'user123',
    });

    // 3. Poll for tokens
    const tokenResponse = await POST('/token', {
      grant_type: 'urn:openid:params:grant-type:ciba',
      auth_req_id: cibaResponse.auth_req_id,
    });

    expect(tokenResponse.access_token).toBeDefined();
    expect(tokenResponse.id_token).toBeDefined();
  });

  test('handles user denial', async () => {});
  test('handles expiration', async () => {});
  test('enforces rate limiting', async () => {});
  test('prevents replay attacks', async () => {});
});
```

**2. Security Tests**
```typescript
// tests/integration/ciba-security.test.ts
describe('CIBA Security', () => {
  test('prevents auth_req_id reuse', async () => {});
  test('validates client authorization', async () => {});
  test('enforces polling interval', async () => {});
  test('validates binding message format', async () => {});
  test('prevents CSRF on approval', async () => {});
});
```

---

## 📋 Implementation Checklist

### Phase 1: Core Approval API (Week 1)
- [ ] Create `ciba-pending.ts` handler
- [ ] Create `ciba-details.ts` handler
- [ ] Create `ciba-approve.ts` handler
- [ ] Create `ciba-deny.ts` handler
- [ ] Add routes to op-async worker
- [ ] Add session/auth middleware
- [ ] Test with curl/Postman

### Phase 2: Basic Testing (Week 1-2)
- [ ] Unit tests for CIBARequestStore
- [ ] Unit tests for CIBA utilities
- [ ] Integration test for complete flow
- [ ] Security tests

### Phase 3: User UI (Week 2-3)
- [ ] SvelteKit pending requests page
- [ ] SvelteKit approval page
- [ ] Mobile deep link support
- [ ] UI styling and UX polish

### Phase 4: Notifications (Week 3-4)
- [ ] Device token management
- [ ] Push notifications (APNs/FCM/Web)
- [ ] SMS notifications (Twilio)
- [ ] Email notifications (Resend)
- [ ] Notification templates

### Phase 5: Advanced Features (Week 4-5)
- [ ] Ping mode implementation
- [ ] Push mode implementation
- [ ] Rate limiting enhancements
- [ ] Analytics and logging
- [ ] Admin dashboard for CIBA

---

## 🎯 Minimal Viable Implementation

To get CIBA working end-to-end, **implement in this order**:

1. **CIBA Approval API** (2-3 hours) - Critical path
2. **Basic integration test** (1 hour) - Verify it works
3. **Simple web UI** (2 hours) - Make it usable
4. **Unit tests** (2 hours) - Ensure quality

**Total: ~7-8 hours for MVP**

After MVP is working, add notifications and advanced features incrementally.

---

## 📚 Reference Implementation

For guidance, see existing similar implementations:
- **Device Flow**: `packages/op-async/src/device-*.ts` (similar async pattern)
- **Device Approval UI**: Check how device flow approval is handled
- **Push Notifications**: If email already implemented, follow that pattern

---

## 🔗 Related Documentation

- Main CIBA guide: `docs/CIBA.md`
- Device Flow (reference): RFC 8628
- OIDC CIBA spec: https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html
- FAPI CIBA profile: https://openid.net/specs/openid-financial-api-ciba-ID1.html
