# CIBA (Client Initiated Backchannel Authentication)

OpenID Connect CIBA Flow Core 1.0 implementation for Authrim.

## Overview

CIBA (Client Initiated Backchannel Authentication) is an authentication flow where the client (Relying Party) can initiate an authentication request for a user without the user being present at the client device. The authentication happens on a separate device (e.g., mobile phone) via a backchannel.

### Use Cases

- **IoT Devices**: Authenticate users on devices without input capabilities
- **Call Centers**: Agent initiates authentication for customer on their mobile device
- **Banking**: Transaction approval via mobile app while using web application
- **Smart TVs**: User authenticates on their phone instead of typing on TV remote

## Architecture

### Components

1. **CIBARequestStore** - Durable Object for storing authentication requests
2. **POST /bc-authorize** - Backchannel authentication endpoint
3. **Token Endpoint** - Enhanced with CIBA grant type support
4. **User Approval UI** - Interface for users to approve/deny requests

### Token Delivery Modes

Authrim supports all three CIBA delivery modes:

#### 1. Poll Mode (Default)
- Client polls the token endpoint with `auth_req_id`
- Server returns `authorization_pending` until user approves
- Most compatible, works with any client

#### 2. Ping Mode
- Client provides `client_notification_endpoint`
- Server sends HTTP POST notification when user approves
- Client then fetches tokens from token endpoint
- Reduces polling overhead

#### 3. Push Mode
- Client provides `client_notification_endpoint`
- Server sends tokens directly in the notification
- Lowest latency, but requires secure callback endpoint

## Flow Diagram

```
┌─────────┐                                  ┌──────────┐
│         │                                  │          │
│  Client │                                  │ Authrim  │
│         │                                  │   OP     │
└─────────┘                                  └──────────┘
     │                                            │
     │  1. POST /bc-authorize                    │
     │     (scope, login_hint, etc.)             │
     ├──────────────────────────────────────────>│
     │                                            │
     │  2. auth_req_id, expires_in, interval     │
     │<──────────────────────────────────────────┤
     │                                            │
     │                                            │  3. User notification
     │                                            │     (push, SMS, email)
     │                                            ├────────────┐
     │                                            │            │
     │                                            │<───────────┘
     │                                            │
     │                                            │  4. User approves
     │                                            │     on mobile/web
     │                                            ├────────────┐
     │                                            │            │
     │                                            │<───────────┘
     │  5. POST /token                            │
     │     (grant_type=ciba, auth_req_id)        │
     ├──────────────────────────────────────────>│
     │                                            │
     │  6. access_token, id_token, refresh_token │
     │<──────────────────────────────────────────┤
     │                                            │
```

## Implementation Guide

### 1. Client Registration

Register a client with CIBA support:

```bash
POST /register
Content-Type: application/json

{
  "client_name": "My CIBA App",
  "redirect_uris": ["https://app.example.com/callback"],
  "grant_types": ["urn:openid:params:grant-type:ciba"],
  "backchannel_token_delivery_mode": "poll",
  "backchannel_client_notification_endpoint": "https://app.example.com/ciba/notify",
  "backchannel_user_code_parameter": true
}
```

### 2. Initiate CIBA Request

```bash
POST /bc-authorize
Content-Type: application/x-www-form-urlencoded

scope=openid%20profile%20email
&client_id=your_client_id
&client_secret=your_client_secret
&login_hint=user@example.com
&binding_message=Transaction%20ID:%2012345
```

#### Request Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `scope` | Yes | OAuth scopes (must include `openid`) |
| `client_id` | Yes | Client identifier |
| `login_hint` | One of | User identifier (email, phone, username) |
| `login_hint_token` | One of | JWT containing login hint |
| `id_token_hint` | One of | Previously issued ID token |
| `binding_message` | No | Human-readable message (max 140 chars) |
| `user_code` | No | User verification code |
| `acr_values` | No | Requested authentication context |
| `requested_expiry` | No | Request expiry in seconds |
| `client_notification_token` | Conditional | Required for ping/push modes |

#### Response

```json
{
  "auth_req_id": "1c266114-a1be-4252-8ad1-04986c5b9ac1",
  "expires_in": 300,
  "interval": 5
}
```

### 3. Poll for Tokens (Poll Mode)

```bash
POST /token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:openid:params:grant-type:ciba
&client_id=your_client_id
&client_secret=your_client_secret
&auth_req_id=1c266114-a1be-4252-8ad1-04986c5b9ac1
```

#### Response States

**Pending** (HTTP 400):
```json
{
  "error": "authorization_pending",
  "error_description": "User has not yet authorized the authentication request"
}
```

**Slow Down** (HTTP 400):
```json
{
  "error": "slow_down",
  "error_description": "You are polling too frequently. Please slow down."
}
```

**Denied** (HTTP 403):
```json
{
  "error": "access_denied",
  "error_description": "User denied the authentication request"
}
```

**Success** (HTTP 200):
```json
{
  "access_token": "eyJhbGc...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "id_token": "eyJhbGc...",
  "refresh_token": "eyJhbGc...",
  "scope": "openid profile email"
}
```

## Login Hint Formats

The `login_hint` parameter supports multiple formats:

### Email
```
login_hint=user@example.com
```

### Phone (E.164)
```
login_hint=+14155552671
login_hint=tel:+14155552671
```

### Subject Identifier
```
login_hint=sub:user123
```

### Username
```
login_hint=johndoe
```

## Binding Message

The `binding_message` is displayed to the user during approval to provide context:

```
binding_message=Sign in to Banking App
binding_message=Transaction ID: 12345
binding_message=Approve payment of $100.00
```

**Constraints:**
- Maximum 140 characters
- Unicode letters, numbers, punctuation, and spaces allowed
- Displayed prominently in user approval UI

## User Code (Optional)

For additional security, you can provide a `user_code` that the user must verify:

```
POST /bc-authorize
...
&user_code=ABCD-1234
```

The user will be shown this code and must confirm it matches what they see on the requesting device.

## Security Considerations

### 1. Login Hint Validation
- Validate login hints are properly formatted
- Verify user exists before initiating notification
- Consider rate limiting per login hint to prevent spam

### 2. Binding Message Injection
- Sanitize binding messages to prevent phishing
- Display raw text only, no HTML or scripts
- Limit length to prevent UI issues

### 3. Replay Protection
- `auth_req_id` is single-use only
- Requests expire after configured timeout (default 5 minutes)
- Token issuance is atomic and tracked

### 4. Notification Security
- Use authenticated channels for notifications
- Include request details in notification for user verification
- Implement rate limiting on notification delivery

### 5. Client Authentication
- Always require client authentication for CIBA
- Use client_secret or mutual TLS
- Validate client is authorized for CIBA grant type

## Rate Limiting

CIBA endpoints are rate-limited to prevent abuse:

- **bc-authorize**: 10 requests per minute per client
- **Token endpoint (polling)**: Respects `interval` parameter
- **Notification delivery**: 5 notifications per minute per user

## Database Schema

### ciba_requests Table

```sql
CREATE TABLE ciba_requests (
  auth_req_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  login_hint TEXT,
  login_hint_token TEXT,
  id_token_hint TEXT,
  binding_message TEXT,
  user_code TEXT,
  status TEXT CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  delivery_mode TEXT CHECK (delivery_mode IN ('poll', 'ping', 'push')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  interval INTEGER NOT NULL DEFAULT 5,
  user_id TEXT,
  sub TEXT,
  token_issued INTEGER DEFAULT 0,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

## Configuration

### Client Metadata

Add to client registration:

```typescript
{
  backchannel_token_delivery_mode: 'poll' | 'ping' | 'push',
  backchannel_client_notification_endpoint: 'https://...',
  backchannel_authentication_request_signing_alg: 'RS256',
  backchannel_user_code_parameter: true
}
```

### Discovery Metadata

Authrim advertises CIBA support in discovery document:

```json
{
  "backchannel_authentication_endpoint": "https://auth.example.com/bc-authorize",
  "backchannel_token_delivery_modes_supported": ["poll", "ping", "push"],
  "backchannel_authentication_request_signing_alg_values_supported": ["RS256", "ES256"],
  "backchannel_user_code_parameter_supported": true,
  "grant_types_supported": [
    "authorization_code",
    "refresh_token",
    "urn:openid:params:grant-type:ciba"
  ]
}
```

## User Approval UI

### API Endpoints

**List Pending Requests:**
```bash
GET /api/ciba/pending?user_id=user123
```

**Approve Request:**
```bash
POST /api/ciba/approve
Content-Type: application/json

{
  "auth_req_id": "1c266114-a1be-4252-8ad1-04986c5b9ac1",
  "user_id": "user123"
}
```

**Deny Request:**
```bash
POST /api/ciba/deny
Content-Type: application/json

{
  "auth_req_id": "1c266114-a1be-4252-8ad1-04986c5b9ac1"
}
```

### UI Components

The user approval UI should display:

1. **Client Information**: Name, logo, trusted status
2. **Binding Message**: Prominently displayed
3. **User Code**: If provided, for verification
4. **Requested Scopes**: What data will be shared
5. **Expiration**: Time remaining to approve
6. **Approve/Deny**: Clear action buttons

## Testing

### Example CIBA Flow Test

```javascript
// 1. Initiate CIBA request
const cibaResponse = await fetch('https://auth.example.com/bc-authorize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    scope: 'openid profile email',
    client_id: 'test_client',
    client_secret: 'test_secret',
    login_hint: 'user@example.com',
    binding_message: 'Test authentication',
  }),
});

const { auth_req_id, interval } = await cibaResponse.json();

// 2. Simulate user approval (in production, user does this via UI)
await fetch('https://auth.example.com/api/ciba/approve', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    auth_req_id,
    user_id: 'user123',
  }),
});

// 3. Poll for tokens
let tokens;
while (!tokens) {
  await new Promise(resolve => setTimeout(resolve, interval * 1000));

  const tokenResponse = await fetch('https://auth.example.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:openid:params:grant-type:ciba',
      client_id: 'test_client',
      client_secret: 'test_secret',
      auth_req_id,
    }),
  });

  if (tokenResponse.ok) {
    tokens = await tokenResponse.json();
  }
}

console.log('Tokens:', tokens);
```

## Notification System (Future Enhancement)

### Push Notifications

For mobile apps, integrate with push notification services:

- **iOS**: APNs (Apple Push Notification service)
- **Android**: FCM (Firebase Cloud Messaging)
- **Web**: Web Push API

### SMS Notifications

For phone-based login hints:

- Integrate with SMS gateway (Twilio, AWS SNS, etc.)
- Send deep link to approval page
- Include binding message in SMS

### Email Notifications

For email-based login hints:

- Send approval link via email
- Include binding message and client info
- Time-limited link matching request expiry

## Troubleshooting

### Common Errors

**invalid_request**
- Missing required parameter
- Invalid login hint format
- Binding message too long

**unauthorized_client**
- Client not registered for CIBA
- Client not authorized for requested scope

**expired_token**
- Auth request expired before approval
- User took too long to respond

**slow_down**
- Client polling too frequently
- Respect interval parameter

## References

- [OpenID Connect CIBA Flow Core 1.0](https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0.html)
- [FAPI CIBA Profile](https://openid.net/specs/openid-financial-api-ciba-ID1.html)
- [OAuth 2.0 Device Authorization Grant (RFC 8628)](https://datatracker.ietf.org/doc/html/rfc8628) - Similar async pattern

## License

Part of the Authrim OpenID Provider implementation.
