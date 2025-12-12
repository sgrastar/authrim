# SessionStore Durable Object API

## Overview

The SessionStore Durable Object manages active user sessions with in-memory hot data and D1 database fallback for persistence. It provides instant session invalidation and ITP-compatible session management.

**Hot/Cold Pattern:**
1. Active sessions stored in-memory for sub-millisecond access (hot)
2. Cold sessions loaded from D1 database on demand
3. Sessions promoted to hot storage on access
4. Expired sessions cleaned up periodically

**Security Features:**
- Instant session revocation (security requirement)
- Automatic expiration handling
- Multi-device session management
- Audit trail via D1 storage

## Base URL

```
https://session-store.{namespace}.workers.dev
```

## Endpoints

### 1. Create Session

Create a new user session.

**Endpoint:** `POST /session`

**Request Body:**
```json
{
  "userId": "user_123",
  "ttl": 3600,
  "data": {
    "amr": ["pwd"],
    "acr": "aal1",
    "deviceName": "iPhone 15",
    "ipAddress": "192.168.1.1",
    "userAgent": "Mozilla/5.0..."
  }
}
```

**Request Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `userId` | string | Yes | User ID for the session |
| `ttl` | number | Yes | Time to live in seconds |
| `data` | object | No | Additional session metadata |

**Response (201 Created):**
```json
{
  "id": "session_550e8400-e29b-41d4-a716-446655440000",
  "userId": "user_123",
  "expiresAt": 1699564800000,
  "createdAt": 1699561200000
}
```

**Example:**
```bash
curl -X POST https://session-store.example.workers.dev/session \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user_123",
    "ttl": 3600,
    "data": {
      "deviceName": "iPhone 15",
      "ipAddress": "192.168.1.1"
    }
  }'
```

---

### 2. Get Session

Retrieve a session by ID. Checks in-memory storage first, then falls back to D1 with 100ms timeout.

**Endpoint:** `GET /session/:id`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Session ID |

**Response (200 OK):**
```json
{
  "id": "session_550e8400-e29b-41d4-a716-446655440000",
  "userId": "user_123",
  "expiresAt": 1699564800000,
  "createdAt": 1699561200000
}
```

**Response (404 Not Found):**
```json
{
  "error": "Session not found"
}
```

**Example:**
```bash
curl https://session-store.example.workers.dev/session/session_550e8400-e29b-41d4-a716-446655440000
```

---

### 3. Delete Session

Invalidate a session immediately (instant revocation).

**Endpoint:** `DELETE /session/:id`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Session ID to invalidate |

**Response (200 OK):**
```json
{
  "success": true,
  "deleted": "session_550e8400-e29b-41d4-a716-446655440000"
}
```

**Example:**
```bash
curl -X DELETE https://session-store.example.workers.dev/session/session_550e8400-e29b-41d4-a716-446655440000
```

---

### 4. List User Sessions

List all active sessions for a specific user (multi-device support).

**Endpoint:** `GET /sessions/user/:userId`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `userId` | string | Yes | User ID |

**Response (200 OK):**
```json
{
  "sessions": [
    {
      "id": "session_550e8400-e29b-41d4-a716-446655440000",
      "userId": "user_123",
      "expiresAt": 1699564800000,
      "createdAt": 1699561200000
    },
    {
      "id": "session_661f9511-f3ac-52e5-b827-557766551111",
      "userId": "user_123",
      "expiresAt": 1699568400000,
      "createdAt": 1699564800000
    }
  ]
}
```

**Example:**
```bash
curl https://session-store.example.workers.dev/sessions/user/user_123
```

---

### 5. Extend Session

Extend session expiration (Active TTL pattern).

**Endpoint:** `POST /session/:id/extend`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Session ID |

**Request Body:**
```json
{
  "seconds": 3600
}
```

**Request Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `seconds` | number | Yes | Seconds to add to expiration (must be > 0) |

**Response (200 OK):**
```json
{
  "id": "session_550e8400-e29b-41d4-a716-446655440000",
  "userId": "user_123",
  "expiresAt": 1699568400000,
  "createdAt": 1699561200000
}
```

**Response (404 Not Found):**
```json
{
  "error": "Session not found"
}
```

**Response (400 Bad Request):**
```json
{
  "error": "Invalid seconds value"
}
```

**Example:**
```bash
curl -X POST https://session-store.example.workers.dev/session/session_550e8400-e29b-41d4-a716-446655440000/extend \
  -H "Content-Type: application/json" \
  -d '{"seconds": 3600}'
```

---

### 6. Health Check / Status

Get health status and statistics.

**Endpoint:** `GET /status`

**Response (200 OK):**
```json
{
  "status": "ok",
  "sessions": 42,
  "timestamp": 1699561200000
}
```

**Example:**
```bash
curl https://session-store.example.workers.dev/status
```

---

## Error Responses

All endpoints may return the following error responses:

### 400 Bad Request
```json
{
  "error": "Missing required fields: userId, ttl"
}
```

### 404 Not Found
```json
{
  "error": "Session not found"
}
```

### 500 Internal Server Error
```json
{
  "error": "Internal Server Error",
  "message": "Detailed error message"
}
```

---

## Data Types

### Session Object
```typescript
interface Session {
  id: string;
  userId: string;
  expiresAt: number;  // Unix timestamp in milliseconds
  createdAt: number;  // Unix timestamp in milliseconds
}
```

### SessionData Object
```typescript
interface SessionData {
  amr?: string[];      // Authentication Methods References
  acr?: string;        // Authentication Context Class Reference
  deviceName?: string;
  ipAddress?: string;
  userAgent?: string;
  [key: string]: unknown;
}
```

---

## Implementation Notes

### Hot/Cold Storage Pattern

1. **Hot Storage (In-Memory):**
   - Active sessions kept in Durable Object memory
   - Sub-millisecond access time
   - Instant invalidation

2. **Cold Storage (D1 Database):**
   - Sessions persisted to D1 asynchronously
   - 100ms timeout for D1 queries (fail fast)
   - Automatic promotion to hot storage on access

### Session Cleanup

- Automatic cleanup runs every 5 minutes
- Expired sessions removed from memory
- D1 database maintains audit trail

### Concurrency

- Durable Objects provide strong consistency guarantees
- Single-threaded execution per session namespace
- No race conditions on session operations

---

## Security Considerations

1. **Instant Revocation:** Session invalidation is immediate in memory
2. **No Token Exposure:** Actual session data never exposed in API responses
3. **Audit Trail:** All session operations logged to D1 for security analysis
4. **Expiration Handling:** Expired sessions automatically rejected

---

## Usage Examples

### Complete Session Lifecycle

```bash
# 1. Create session
SESSION_ID=$(curl -X POST https://session-store.example.workers.dev/session \
  -H "Content-Type: application/json" \
  -d '{"userId": "user_123", "ttl": 3600}' \
  | jq -r '.id')

# 2. Get session
curl https://session-store.example.workers.dev/session/$SESSION_ID

# 3. Extend session
curl -X POST https://session-store.example.workers.dev/session/$SESSION_ID/extend \
  -H "Content-Type: application/json" \
  -d '{"seconds": 3600}'

# 4. List all user sessions
curl https://session-store.example.workers.dev/sessions/user/user_123

# 5. Delete session
curl -X DELETE https://session-store.example.workers.dev/session/$SESSION_ID
```

### Multi-Device Session Management

```bash
# User logs in from multiple devices
curl -X POST https://session-store.example.workers.dev/session \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user_123",
    "ttl": 86400,
    "data": {"deviceName": "iPhone"}
  }'

curl -X POST https://session-store.example.workers.dev/session \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user_123",
    "ttl": 86400,
    "data": {"deviceName": "MacBook"}
  }'

# List all active sessions
curl https://session-store.example.workers.dev/sessions/user/user_123
```
