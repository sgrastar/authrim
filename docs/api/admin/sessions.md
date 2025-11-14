# Admin Session Management API

## Overview

The Admin Session Management API provides comprehensive session management capabilities for administrators. It enables listing, monitoring, and revoking user sessions across the entire system, supporting security operations and compliance requirements.

**Key Features:**
- List sessions with pagination and filtering
- View detailed session information
- Revoke individual sessions (force logout)
- Revoke all sessions for a specific user
- Monitor active vs. expired sessions
- Session source tracking (memory/database)

**Authentication:**
- Requires admin privileges (Phase 6)
- Bearer token authentication (Phase 6)
- RBAC permissions: `sessions:read`, `sessions:write` (Phase 6)

**Use Cases:**
- Security incident response
- Compliance auditing
- User support (force logout)
- Session analytics
- Suspicious activity investigation

## Base URL

```
https://your-domain.com/admin/sessions
```

## Endpoints

### 1. List Sessions

Get a paginated list of sessions with optional filtering.

**Endpoint:** `GET /admin/sessions`

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `page` | number | No | 1 | Page number (1-indexed) |
| `limit` | number | No | 20 | Items per page (max 100) |
| `user_id` | string | No | - | Filter by user ID |
| `status` | string | No | - | Filter by status: `active` or `expired` |

**Response (200 OK):**
```json
{
  "sessions": [
    {
      "id": "session_abc123",
      "userId": "user_123",
      "userEmail": "john@example.com",
      "userName": "John Doe",
      "expiresAt": 1699651200000,
      "createdAt": 1699564800000,
      "isActive": true
    },
    {
      "id": "session_xyz789",
      "userId": "user_456",
      "userEmail": "jane@example.com",
      "userName": "Jane Smith",
      "expiresAt": 1699550000000,
      "createdAt": 1699547800000,
      "isActive": false
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8,
    "hasNext": true,
    "hasPrev": false
  }
}
```

**Response Fields:**

Session Object:
| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Session ID |
| `userId` | string | User ID |
| `userEmail` | string | User's email address |
| `userName` | string | User's display name |
| `expiresAt` | number | Expiration timestamp (Unix milliseconds) |
| `createdAt` | number | Creation timestamp (Unix milliseconds) |
| `isActive` | boolean | Session active status |

Pagination Object:
| Field | Type | Description |
|-------|------|-------------|
| `page` | number | Current page number |
| `limit` | number | Items per page |
| `total` | number | Total number of sessions |
| `totalPages` | number | Total number of pages |
| `hasNext` | boolean | Whether there's a next page |
| `hasPrev` | boolean | Whether there's a previous page |

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 401 | `unauthorized` | Missing or invalid authentication token |
| 403 | `forbidden` | Insufficient permissions |
| 500 | `server_error` | Failed to retrieve sessions |

**Example:**
```bash
# List all sessions (first page)
curl "https://your-domain.com/admin/sessions" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"

# Filter by user ID
curl "https://your-domain.com/admin/sessions?user_id=user_123" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"

# Filter active sessions
curl "https://your-domain.com/admin/sessions?status=active&page=1&limit=50" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"

# Filter expired sessions
curl "https://your-domain.com/admin/sessions?status=expired" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**JavaScript Usage:**
```javascript
async function listSessions(options = {}) {
  const {
    page = 1,
    limit = 20,
    userId = null,
    status = null
  } = options;

  const params = new URLSearchParams({ page, limit });
  if (userId) params.append('user_id', userId);
  if (status) params.append('status', status);

  const response = await fetch(
    `https://your-domain.com/admin/sessions?${params}`,
    {
      headers: {
        'Authorization': `Bearer ${adminToken}`
      }
    }
  );

  const data = await response.json();
  return data;
}

// Usage examples
const allSessions = await listSessions();
const userSessions = await listSessions({ userId: 'user_123' });
const activeSessions = await listSessions({ status: 'active', limit: 50 });
```

---

### 2. Get Session Details

Get detailed information about a specific session.

**Endpoint:** `GET /admin/sessions/:id`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Session ID |

**Response (200 OK):**
```json
{
  "session": {
    "id": "session_abc123",
    "userId": "user_123",
    "userEmail": "john@example.com",
    "userName": "John Doe",
    "expiresAt": 1699651200000,
    "createdAt": 1699564800000,
    "isActive": true,
    "source": "memory"
  }
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Session ID |
| `userId` | string | User ID |
| `userEmail` | string | User's email address |
| `userName` | string | User's display name |
| `expiresAt` | number | Expiration timestamp (Unix milliseconds) |
| `createdAt` | number | Creation timestamp (Unix milliseconds) |
| `isActive` | boolean | Session active status |
| `source` | string | Data source: `memory` (SessionStore DO) or `database` (D1) |

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 401 | `unauthorized` | Missing or invalid authentication token |
| 403 | `forbidden` | Insufficient permissions |
| 404 | `not_found` | Session not found |
| 500 | `server_error` | Failed to retrieve session |

**Example:**
```bash
curl "https://your-domain.com/admin/sessions/session_abc123" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**JavaScript Usage:**
```javascript
async function getSessionDetails(sessionId) {
  const response = await fetch(
    `https://your-domain.com/admin/sessions/${sessionId}`,
    {
      headers: {
        'Authorization': `Bearer ${adminToken}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to get session: ${response.status}`);
  }

  const data = await response.json();
  return data.session;
}

// Usage
const session = await getSessionDetails('session_abc123');
console.log('User:', session.userName);
console.log('Active:', session.isActive);
console.log('Source:', session.source);
```

---

### 3. Revoke Session

Force logout a specific session (immediate termination).

**Endpoint:** `POST /admin/sessions/:id/revoke`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Session ID to revoke |

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Session revoked successfully",
  "sessionId": "session_abc123"
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Always `true` on success |
| `message` | string | Success message |
| `sessionId` | string | Revoked session ID |

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 401 | `unauthorized` | Missing or invalid authentication token |
| 403 | `forbidden` | Insufficient permissions |
| 404 | `not_found` | Session not found |
| 500 | `server_error` | Failed to revoke session |

**Example:**
```bash
curl -X POST "https://your-domain.com/admin/sessions/session_abc123/revoke" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**JavaScript Usage:**
```javascript
async function revokeSession(sessionId) {
  const response = await fetch(
    `https://your-domain.com/admin/sessions/${sessionId}/revoke`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to revoke session: ${response.status}`);
  }

  const data = await response.json();
  console.log(data.message);
  return data;
}

// Usage
await revokeSession('session_abc123');
```

**Behavior:**

1. **Validation**: Checks if session exists in D1 database
2. **Memory Invalidation**: Deletes from SessionStore Durable Object (hot storage)
3. **Database Deletion**: Deletes from D1 database (persistent storage)
4. **Audit Logging**: Logs revocation event (Phase 6)
5. **Immediate Effect**: User is logged out immediately (no grace period)

---

### 4. Revoke All User Sessions

Revoke all sessions for a specific user (force logout from all devices).

**Endpoint:** `POST /admin/users/:id/revoke-all-sessions`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | User ID |

**Response (200 OK):**
```json
{
  "success": true,
  "message": "All user sessions revoked successfully",
  "userId": "user_123",
  "revokedCount": 5
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Always `true` on success |
| `message` | string | Success message |
| `userId` | string | User ID |
| `revokedCount` | number | Number of sessions revoked |

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 401 | `unauthorized` | Missing or invalid authentication token |
| 403 | `forbidden` | Insufficient permissions |
| 404 | `not_found` | User not found |
| 500 | `server_error` | Failed to revoke user sessions |

**Example:**
```bash
curl -X POST "https://your-domain.com/admin/users/user_123/revoke-all-sessions" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**JavaScript Usage:**
```javascript
async function revokeAllUserSessions(userId) {
  const response = await fetch(
    `https://your-domain.com/admin/users/${userId}/revoke-all-sessions`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to revoke sessions: ${response.status}`);
  }

  const data = await response.json();
  console.log(`Revoked ${data.revokedCount} sessions for user ${userId}`);
  return data;
}

// Usage
const result = await revokeAllUserSessions('user_123');
console.log('Revoked sessions:', result.revokedCount);
```

**Behavior:**

1. **User Validation**: Checks if user exists
2. **Session Discovery**: Retrieves all sessions from SessionStore DO
3. **Batch Invalidation**: Deletes all sessions from SessionStore (parallel)
4. **Database Cleanup**: Deletes all sessions from D1 database
5. **Audit Logging**: Logs bulk revocation event (Phase 6)
6. **Count Reconciliation**: Returns max count from both sources

**Use Cases:**
- Account compromise response
- Password reset enforcement
- User account suspension
- Security policy enforcement
- Troubleshooting login issues

---

## Session Status Lifecycle

```
┌──────────────┐
│   Created    │
│  (isActive:  │
│    true)     │
└──────┬───────┘
       │
       │ User activity
       │ (session refresh)
       │
       ▼
┌──────────────┐
│   Active     │
│  (expires_at │
│   extended)  │
└──────┬───────┘
       │
       │ No activity
       │ OR TTL expires
       │
       ▼
┌──────────────┐       Admin revokes
│   Expired    │◄──────────────────────┐
│  (isActive:  │                       │
│    false)    │       User logs out   │
└──────┬───────┘◄──────────────────────┘
       │
       │ Cleanup
       │ (background job)
       │
       ▼
┌──────────────┐
│   Deleted    │
│  (removed    │
│   from DB)   │
└──────────────┘
```

---

## Filtering Examples

### 1. Find All Active Sessions
```bash
curl "https://your-domain.com/admin/sessions?status=active" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### 2. Find All Sessions for a User
```bash
curl "https://your-domain.com/admin/sessions?user_id=user_123" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### 3. Find Active Sessions for a User
```bash
curl "https://your-domain.com/admin/sessions?user_id=user_123&status=active" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### 4. Paginate Through All Sessions
```bash
# Page 1
curl "https://your-domain.com/admin/sessions?page=1&limit=50" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"

# Page 2
curl "https://your-domain.com/admin/sessions?page=2&limit=50" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

---

## Admin Dashboard Integration

### Example: Session Monitor Component

```javascript
class SessionMonitor {
  constructor(adminToken) {
    this.adminToken = adminToken;
    this.baseUrl = 'https://your-domain.com/admin/sessions';
  }

  async getActiveSessions() {
    const response = await fetch(
      `${this.baseUrl}?status=active&limit=100`,
      {
        headers: { 'Authorization': `Bearer ${this.adminToken}` }
      }
    );
    return response.json();
  }

  async getUserSessions(userId) {
    const response = await fetch(
      `${this.baseUrl}?user_id=${userId}`,
      {
        headers: { 'Authorization': `Bearer ${this.adminToken}` }
      }
    );
    return response.json();
  }

  async revokeSession(sessionId) {
    const response = await fetch(
      `${this.baseUrl}/${sessionId}/revoke`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.adminToken}` }
      }
    );
    return response.json();
  }

  async forceLogoutUser(userId) {
    const response = await fetch(
      `https://your-domain.com/admin/users/${userId}/revoke-all-sessions`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.adminToken}` }
      }
    );
    return response.json();
  }

  // Monitor active sessions in real-time
  async monitorActiveSessions(callback, interval = 30000) {
    const check = async () => {
      const data = await this.getActiveSessions();
      callback(data.sessions);
    };

    // Initial check
    await check();

    // Periodic checks
    setInterval(check, interval);
  }
}

// Usage
const monitor = new SessionMonitor(adminToken);

// Display active sessions
monitor.monitorActiveSessions((sessions) => {
  console.log(`Active sessions: ${sessions.length}`);
  sessions.forEach(session => {
    console.log(`- ${session.userName} (${session.userEmail})`);
  });
}, 30000); // Check every 30 seconds

// Force logout a user
await monitor.forceLogoutUser('user_123');
```

---

## Security Considerations

### 1. Session Revocation
- **Instant Effect**: SessionStore Durable Object ensures immediate invalidation
- **Multi-Source Cleanup**: Removes from both memory and database
- **No Grace Period**: Session is terminated immediately
- **Audit Trail**: All revocations are logged (Phase 6)

### 2. Admin Authentication
- **Bearer Token**: Admin token required for all operations (Phase 6)
- **RBAC**: Role-based access control enforces permissions (Phase 6)
- **Audit Logging**: All admin actions are logged (Phase 6)

### 3. Data Privacy
- **User Information**: Email and name included for admin convenience
- **Session Data**: No sensitive session data exposed
- **Filtering**: User-specific queries require user ID (prevents enumeration)

---

## Performance Considerations

### 1. Hot/Cold Storage
- **Hot (Memory)**: SessionStore DO provides sub-millisecond access
- **Cold (Database)**: D1 database fallback with 100ms timeout
- **Source Tracking**: `source` field indicates data origin

### 2. Pagination
- **Default Limit**: 20 items per page
- **Max Limit**: 100 items per page (prevents large queries)
- **Efficient Queries**: Database indexes on `user_id` and `expires_at`

### 3. Filtering
- **Status Filter**: Uses database index on `expires_at`
- **User Filter**: Uses database index on `user_id`
- **Combined Filters**: Efficient query plans with compound conditions

---

## Error Handling

### Common Error Scenarios

**1. Session Not Found**
```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": "not_found",
  "error_description": "Session not found"
}
```

**2. User Not Found**
```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": "not_found",
  "error_description": "User not found"
}
```

**3. Insufficient Permissions**
```http
HTTP/1.1 403 Forbidden
Content-Type: application/json

{
  "error": "forbidden",
  "error_description": "Insufficient permissions"
}
```

---

## Best Practices

### 1. Bulk Operations
```javascript
// GOOD: Revoke all user sessions in one call
await revokeAllUserSessions('user_123');

// BAD: Revoke sessions one by one
const sessions = await getUserSessions('user_123');
for (const session of sessions) {
  await revokeSession(session.id); // Multiple API calls!
}
```

### 2. Session Monitoring
```javascript
// GOOD: Monitor with appropriate interval
monitor.monitorActiveSessions(updateUI, 30000); // Every 30 seconds

// BAD: Polling too frequently
monitor.monitorActiveSessions(updateUI, 1000); // Every second - too much!
```

### 3. Error Handling
```javascript
// GOOD: Handle errors gracefully
async function safeRevokeSession(sessionId) {
  try {
    await revokeSession(sessionId);
    showSuccess('Session revoked successfully');
  } catch (error) {
    if (error.status === 404) {
      showWarning('Session already expired or not found');
    } else {
      showError('Failed to revoke session. Please try again.');
    }
  }
}
```

---

## Related Documentation

- [Session Management API](../auth/session-management.md)
- [Logout API](../auth/logout.md)
- [Admin User Management](./users.md)
- [SessionStore Durable Object](../durable-objects/SessionStore.md)
- [Admin Statistics API](./statistics.md)
