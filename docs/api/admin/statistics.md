# Admin Statistics API

## Overview

The Admin Statistics API provides aggregated metrics and analytics for administrators to monitor the health and usage of the Authrim OIDC Provider.

**Key Features:**
- Real-time statistics (active users, total users, clients)
- Daily metrics (new users today, logins today)
- Recent activity feed
- User growth trends (Phase 6)
- Authentication method breakdown (Phase 6)
- Client usage statistics (Phase 6)

**Authentication:**
- Requires admin privileges (Phase 6)
- Bearer token authentication (Phase 6)
- RBAC permissions: `stats:read` (Phase 6)

## Base URL

```
https://your-domain.com/admin/stats
```

## Endpoints

### 1. Get Statistics Overview

Retrieve a comprehensive overview of system statistics.

**Endpoint:** `GET /admin/stats`

**Response (200 OK):**
```json
{
  "stats": {
    "activeUsers": 342,
    "totalUsers": 1548,
    "registeredClients": 23,
    "newUsersToday": 12,
    "loginsToday": 284
  },
  "recentActivity": [
    {
      "type": "user_registration",
      "userId": "user_123",
      "email": "newuser@example.com",
      "name": "New User",
      "timestamp": 1699564800000
    },
    {
      "type": "user_registration",
      "userId": "user_456",
      "email": "another@example.com",
      "name": "Another User",
      "timestamp": 1699564200000
    }
  ]
}
```

**Response Fields:**

#### stats Object

| Field | Type | Description |
|-------|------|-------------|
| `activeUsers` | number | Users logged in within last 30 days |
| `totalUsers` | number | Total registered users |
| `registeredClients` | number | Total OAuth clients |
| `newUsersToday` | number | Users created today (since midnight) |
| `loginsToday` | number | Unique logins today (since midnight) |

#### recentActivity Array

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Activity type ("user_registration") |
| `userId` | string | User ID |
| `email` | string | User email |
| `name` | string | User name |
| `timestamp` | number | Unix timestamp (milliseconds) |

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 401 | `unauthorized` | Missing or invalid authentication token |
| 403 | `forbidden` | Insufficient permissions |
| 500 | `server_error` | Failed to retrieve statistics |

**Example:**
```bash
curl "https://your-domain.com/admin/stats" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**JavaScript Usage:**
```typescript
async function getStatistics() {
  const response = await fetch('/admin/stats', {
    headers: {
      'Authorization': `Bearer ${getAdminToken()}`
    }
  });

  if (!response.ok) {
    throw new Error('Failed to get statistics');
  }

  return await response.json();
}

// Display in dashboard
const data = await getStatistics();
console.log('Active Users:', data.stats.activeUsers);
console.log('Total Users:', data.stats.totalUsers);
console.log('New Users Today:', data.stats.newUsersToday);
```

---

## Statistics Definitions

### Active Users

**Definition:** Users who have logged in within the last 30 days.

**SQL Query:**
```sql
SELECT COUNT(*) as count
FROM users
WHERE last_login_at > ?
```

**Calculation:**
```typescript
const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
```

### Total Users

**Definition:** All registered user accounts.

**SQL Query:**
```sql
SELECT COUNT(*) as count
FROM users
```

### Registered Clients

**Definition:** All registered OAuth clients (applications).

**SQL Query:**
```sql
SELECT COUNT(*) as count
FROM oauth_clients
```

### New Users Today

**Definition:** Users created today (since midnight local time).

**SQL Query:**
```sql
SELECT COUNT(*) as count
FROM users
WHERE created_at >= ?
```

**Calculation:**
```typescript
const todayStart = new Date().setHours(0, 0, 0, 0);
```

### Logins Today

**Definition:** Unique users who logged in today (since midnight local time).

**SQL Query:**
```sql
SELECT COUNT(*) as count
FROM users
WHERE last_login_at >= ?
```

**Note:** This counts unique users, not total login attempts.

---

## Recent Activity

### Activity Types

Currently supported:
- `user_registration` - New user account created

**Future Activity Types (Phase 6):**
- `user_login` - User logged in
- `client_registration` - New OAuth client registered
- `token_issued` - Access token issued
- `token_revoked` - Token revoked
- `consent_granted` - User granted consent
- `consent_denied` - User denied consent

### Activity Limit

The API returns the **last 10 activity entries**.

**SQL Query:**
```sql
SELECT id, email, name, created_at
FROM users
ORDER BY created_at DESC
LIMIT 10
```

---

## Dashboard UI Example

### Statistics Cards

```typescript
interface StatCard {
  title: string;
  value: number;
  change?: string;  // "+12.5%" or "-3.2%"
  icon: string;
}

const statCards: StatCard[] = [
  {
    title: 'Active Users',
    value: stats.activeUsers,
    icon: '👥'
  },
  {
    title: 'Total Users',
    value: stats.totalUsers,
    icon: '👤'
  },
  {
    title: 'OAuth Clients',
    value: stats.registeredClients,
    icon: '🔑'
  },
  {
    title: 'New Users Today',
    value: stats.newUsersToday,
    icon: '✨'
  },
  {
    title: 'Logins Today',
    value: stats.loginsToday,
    icon: '🔐'
  }
];
```

### Activity Feed

```tsx
function ActivityFeed({ activities }: { activities: Activity[] }) {
  return (
    <div className="activity-feed">
      <h3>Recent Activity</h3>
      <ul>
        {activities.map(activity => (
          <li key={activity.userId}>
            <div className="activity-icon">👤</div>
            <div className="activity-content">
              <strong>{activity.name}</strong> ({activity.email})
              <br />
              <small>Registered {formatTimestamp(activity.timestamp)}</small>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

---

## Performance Considerations

### Query Optimization

All statistics queries are optimized with indexes:

```sql
-- Index for last_login_at (active users, logins today)
CREATE INDEX idx_users_last_login_at ON users(last_login_at);

-- Index for created_at (new users today, recent activity)
CREATE INDEX idx_users_created_at ON users(created_at);
```

### Caching (Phase 6)

Statistics can be cached to reduce database load:

```typescript
// Cache statistics for 5 minutes
const CACHE_TTL = 300; // seconds

async function getCachedStatistics() {
  const cached = await KV_CACHE.get('admin_stats', 'json');
  if (cached) return cached;

  const stats = await computeStatistics();
  await KV_CACHE.put('admin_stats', JSON.stringify(stats), {
    expirationTtl: CACHE_TTL
  });

  return stats;
}
```

### Estimated Query Performance

| Query | Average Time | Notes |
|-------|--------------|-------|
| Active Users | < 50ms | Indexed query |
| Total Users | < 10ms | Simple COUNT(*) |
| Registered Clients | < 10ms | Simple COUNT(*) |
| New Users Today | < 30ms | Indexed query |
| Logins Today | < 30ms | Indexed query |
| Recent Activity | < 20ms | LIMIT 10 with index |

**Total API Response Time:** < 150ms (without caching)

---

## Future Enhancements (Phase 6+)

### Phase 6: Advanced Statistics

**User Growth Trends:**
```json
{
  "userGrowth": {
    "daily": [
      { "date": "2025-11-01", "count": 15 },
      { "date": "2025-11-02", "count": 22 },
      { "date": "2025-11-03", "count": 18 }
    ],
    "weekly": [
      { "week": "2025-W44", "count": 105 },
      { "week": "2025-W45", "count": 127 }
    ],
    "monthly": [
      { "month": "2025-10", "count": 458 },
      { "month": "2025-11", "count": 523 }
    ]
  }
}
```

**Authentication Method Breakdown:**
```json
{
  "authMethods": {
    "passkey": 245,
    "magic_link": 312,
    "oauth": 89
  }
}
```

**Client Usage Statistics:**
```json
{
  "topClients": [
    {
      "client_id": "client_abc123",
      "client_name": "My Application",
      "active_users": 156,
      "total_logins": 1243,
      "last_used": 1699564800000
    }
  ]
}
```

### Phase 7: Real-time Analytics

- **Real-time active sessions** (WebSocket updates)
- **Geographic distribution** of users
- **Device type breakdown** (mobile, desktop, etc.)
- **Error rate monitoring**
- **API response time metrics**
- **Token usage statistics**

---

## Security Considerations

### Authentication (Phase 6)

Statistics endpoints should require admin authentication:

```http
Authorization: Bearer admin_key_abc123...
```

### Data Privacy

- **No PII in logs:** Statistics should not expose sensitive user data
- **Aggregated data only:** Return counts, not individual user details
- **Activity feed anonymization:** Consider masking email addresses (Phase 7)

### RBAC Permissions (Phase 6)

```typescript
interface AdminPermissions {
  'stats:read': boolean;        // View statistics
  'stats:export': boolean;      // Export statistics data
  'stats:detailed': boolean;    // View detailed breakdowns
}
```

---

## Rate Limiting

Recommended rate limits for statistics endpoint:

| Endpoint | Limit | Period | Unit |
|----------|-------|--------|------|
| `GET /admin/stats` | 60 | 1 min | admin token |

Statistics queries are relatively expensive, so rate limiting prevents abuse.

---

## Testing

**Unit Tests:** `/packages/op-management/src/__tests__/admin.test.ts`

**Manual Testing:**
```bash
# Get statistics
curl "http://localhost:8787/admin/stats"

# Expected response:
# {
#   "stats": {
#     "activeUsers": 0,
#     "totalUsers": 5,
#     "registeredClients": 2,
#     "newUsersToday": 1,
#     "loginsToday": 2
#   },
#   "recentActivity": [...]
# }
```

**Load Testing:**
```bash
# Test query performance
ab -n 1000 -c 10 \
  -H "Authorization: Bearer TEST_TOKEN" \
  http://localhost:8787/admin/stats
```

---

## Monitoring and Alerts

### Key Metrics to Monitor

**Health Indicators:**
- Active user rate (active / total)
- Daily signup rate
- Login success rate (Phase 6)
- Client registration rate

**Alert Thresholds:**
- Active users < 10% of total users (engagement issue)
- New users today = 0 (signup flow broken)
- Logins today = 0 (authentication issue)

**Example Monitoring:**
```typescript
async function checkHealth() {
  const stats = await getStatistics();

  // Alert if engagement is low
  const engagementRate = stats.activeUsers / stats.totalUsers;
  if (engagementRate < 0.1) {
    sendAlert('Low user engagement', `Only ${(engagementRate * 100).toFixed(1)}% of users are active`);
  }

  // Alert if no signups today
  if (stats.newUsersToday === 0 && new Date().getHours() > 12) {
    sendAlert('No new signups', 'No new users registered today');
  }
}
```

---

## Export Statistics (Phase 7)

Future endpoint for exporting statistics data:

**Endpoint:** `GET /admin/stats/export`

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `format` | string | Export format: "csv", "json", "xlsx" |
| `start_date` | string | Start date (ISO 8601) |
| `end_date` | string | End date (ISO 8601) |
| `metrics` | string | Comma-separated metrics to include |

**Example:**
```bash
curl "https://your-domain.com/admin/stats/export?format=csv&start_date=2025-11-01&end_date=2025-11-30" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -o stats-november.csv
```

---

## Integration with Admin Dashboard

### Dashboard Layout

```
+-------------------+-------------------+-------------------+
|  Active Users     |  Total Users      |  OAuth Clients    |
|     342           |     1,548         |       23          |
+-------------------+-------------------+-------------------+
|  New Users Today  |  Logins Today     |                   |
|      12           |      284          |                   |
+-------------------+-------------------+-------------------+
|                                                           |
|  Recent Activity                                          |
|  - New User (user@example.com) - 2 mins ago               |
|  - New User (another@example.com) - 15 mins ago           |
|  - ...                                                    |
|                                                           |
+-----------------------------------------------------------+
```

### Auto-refresh

```typescript
// Refresh statistics every 30 seconds
useEffect(() => {
  const fetchStats = async () => {
    const data = await getStatistics();
    setStats(data);
  };

  fetchStats();
  const interval = setInterval(fetchStats, 30000);

  return () => clearInterval(interval);
}, []);
```

---

## Related Documentation

- [Admin User Management API](./users.md)
- [Admin Client Management API](./clients.md)
- [Database Schema](../../architecture/database-schema.md)

---

## Change History

- **2025-11-13**: Initial implementation (Phase 5, Stage 2)
  - Basic statistics (active users, total users, clients)
  - Daily metrics (new users, logins)
  - Recent activity feed (last 10 registrations)
