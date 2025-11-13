# Admin User Management API

## Overview

The Admin User Management API provides comprehensive user management capabilities for administrators. It enables CRUD operations on user accounts, searching, filtering, and retrieving detailed user information including passkeys and custom fields.

**Key Features:**
- List users with pagination, search, and filtering
- Get detailed user information
- Create new users programmatically
- Update user attributes
- Delete users with cascade deletion
- View user's passkeys and custom fields

**Authentication:**
- Requires admin privileges (Phase 6)
- Bearer token authentication (Phase 6)
- RBAC permissions: `users:read`, `users:write`, `users:delete` (Phase 6)

## Base URL

```
https://your-domain.com/admin/users
```

## Endpoints

### 1. List Users

Get a paginated list of users with optional search and filtering.

**Endpoint:** `GET /admin/users`

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `page` | number | No | 1 | Page number (1-indexed) |
| `limit` | number | No | 20 | Items per page (max 100) |
| `search` | string | No | - | Search by email or name |
| `verified` | string | No | - | Filter by email verification ("true" or "false") |

**Response (200 OK):**
```json
{
  "users": [
    {
      "id": "user_123",
      "email": "user@example.com",
      "name": "John Doe",
      "email_verified": 1,
      "phone_number": null,
      "phone_number_verified": 0,
      "created_at": 1699561200000,
      "updated_at": 1699561200000,
      "last_login_at": 1699564800000,
      "custom_attributes_json": null
    },
    {
      "id": "user_456",
      "email": "jane@example.com",
      "name": "Jane Smith",
      "email_verified": 1,
      "phone_number": "+1234567890",
      "phone_number_verified": 1,
      "created_at": 1699560000000,
      "updated_at": 1699560000000,
      "last_login_at": 1699563600000,
      "custom_attributes_json": "{\"department\":\"Engineering\"}"
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

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 401 | `unauthorized` | Missing or invalid authentication token |
| 403 | `forbidden` | Insufficient permissions |
| 500 | `server_error` | Failed to retrieve users |

**Example:**
```bash
# List all users (first page)
curl "https://your-domain.com/admin/users" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"

# Search users by email/name
curl "https://your-domain.com/admin/users?search=john" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"

# Filter verified users
curl "https://your-domain.com/admin/users?verified=true" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"

# Pagination
curl "https://your-domain.com/admin/users?page=2&limit=50" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**JavaScript Usage:**
```typescript
async function listUsers(page = 1, search = '') {
  const params = new URLSearchParams({
    page: page.toString(),
    limit: '20',
    ...(search && { search })
  });

  const response = await fetch(`/admin/users?${params}`, {
    headers: {
      'Authorization': `Bearer ${getAdminToken()}`
    }
  });

  const data = await response.json();
  return data;
}
```

---

### 2. Get User Details

Retrieve detailed information about a specific user.

**Endpoint:** `GET /admin/users/:id`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | User ID |

**Response (200 OK):**
```json
{
  "user": {
    "id": "user_123",
    "email": "user@example.com",
    "name": "John Doe",
    "email_verified": 1,
    "phone_number": "+1234567890",
    "phone_number_verified": 1,
    "created_at": 1699561200000,
    "updated_at": 1699561200000,
    "last_login_at": 1699564800000,
    "custom_attributes_json": "{\"department\":\"Engineering\",\"role\":\"Developer\"}"
  },
  "passkeys": [
    {
      "id": "pk_550e8400-e29b-41d4-a716-446655440000",
      "credential_id": "Gu0hYqrVjzsN3wz...",
      "device_name": "iPhone 15 Pro",
      "created_at": 1699561200000,
      "last_used_at": 1699564800000
    }
  ],
  "customFields": [
    {
      "field_name": "department",
      "field_value": "Engineering",
      "field_type": "string"
    },
    {
      "field_name": "employee_id",
      "field_value": "EMP-12345",
      "field_type": "string"
    }
  ]
}
```

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 401 | `unauthorized` | Missing or invalid authentication token |
| 403 | `forbidden` | Insufficient permissions |
| 404 | `not_found` | User not found |
| 500 | `server_error` | Failed to retrieve user |

**Example:**
```bash
curl "https://your-domain.com/admin/users/user_123" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**JavaScript Usage:**
```typescript
async function getUserDetails(userId: string) {
  const response = await fetch(`/admin/users/${userId}`, {
    headers: {
      'Authorization': `Bearer ${getAdminToken()}`
    }
  });

  if (!response.ok) {
    throw new Error('Failed to get user details');
  }

  return await response.json();
}
```

---

### 3. Create User

Create a new user account.

**Endpoint:** `POST /admin/users`

**Request Body:**
```json
{
  "email": "newuser@example.com",
  "name": "New User",
  "email_verified": true,
  "phone_number": "+1234567890",
  "phone_number_verified": false,
  "department": "Sales",
  "employee_id": "EMP-99999"
}
```

**Request Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `email` | string | Yes | User's email address (must be unique) |
| `name` | string | No | User's display name |
| `email_verified` | boolean | No | Email verification status (default: false) |
| `phone_number` | string | No | User's phone number |
| `phone_number_verified` | boolean | No | Phone verification status (default: false) |
| `[custom]` | any | No | Additional custom attributes stored in `custom_attributes_json` |

**Response (201 Created):**
```json
{
  "user": {
    "id": "user_789",
    "email": "newuser@example.com",
    "name": "New User",
    "email_verified": 1,
    "phone_number": "+1234567890",
    "phone_number_verified": 0,
    "created_at": 1699565400000,
    "updated_at": 1699565400000,
    "last_login_at": null,
    "custom_attributes_json": "{\"department\":\"Sales\",\"employee_id\":\"EMP-99999\"}"
  }
}
```

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 400 | `invalid_request` | Email is missing or invalid |
| 401 | `unauthorized` | Missing or invalid authentication token |
| 403 | `forbidden` | Insufficient permissions |
| 409 | `conflict` | User with this email already exists |
| 500 | `server_error` | Failed to create user |

**Example:**
```bash
curl -X POST "https://your-domain.com/admin/users" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "newuser@example.com",
    "name": "New User",
    "email_verified": true,
    "department": "Sales"
  }'
```

**JavaScript Usage:**
```typescript
async function createUser(userData: {
  email: string;
  name?: string;
  email_verified?: boolean;
  [key: string]: any;
}) {
  const response = await fetch('/admin/users', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getAdminToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(userData)
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error_description || 'Failed to create user');
  }

  return await response.json();
}
```

---

### 4. Update User

Update an existing user's attributes.

**Endpoint:** `PUT /admin/users/:id`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | User ID |

**Request Body:**
```json
{
  "name": "Updated Name",
  "email_verified": true,
  "phone_number": "+9876543210",
  "phone_number_verified": true
}
```

**Request Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | No | User's display name |
| `email_verified` | boolean | No | Email verification status |
| `phone_number` | string | No | User's phone number |
| `phone_number_verified` | boolean | No | Phone verification status |

**Note:** Email address cannot be changed. Custom fields update is planned for Phase 6.

**Response (200 OK):**
```json
{
  "user": {
    "id": "user_123",
    "email": "user@example.com",
    "name": "Updated Name",
    "email_verified": 1,
    "phone_number": "+9876543210",
    "phone_number_verified": 1,
    "created_at": 1699561200000,
    "updated_at": 1699565600000,
    "last_login_at": 1699564800000,
    "custom_attributes_json": null
  }
}
```

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 400 | `invalid_request` | No fields to update |
| 401 | `unauthorized` | Missing or invalid authentication token |
| 403 | `forbidden` | Insufficient permissions |
| 404 | `not_found` | User not found |
| 500 | `server_error` | Failed to update user |

**Example:**
```bash
curl -X PUT "https://your-domain.com/admin/users/user_123" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Name",
    "email_verified": true
  }'
```

**JavaScript Usage:**
```typescript
async function updateUser(userId: string, updates: {
  name?: string;
  email_verified?: boolean;
  phone_number?: string;
  phone_number_verified?: boolean;
}) {
  const response = await fetch(`/admin/users/${userId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${getAdminToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates)
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error_description || 'Failed to update user');
  }

  return await response.json();
}
```

---

### 5. Delete User

Delete a user account. This cascades to delete related data (passkeys, custom fields, sessions).

**Endpoint:** `DELETE /admin/users/:id`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | User ID |

**Response (200 OK):**
```json
{
  "success": true,
  "message": "User deleted successfully"
}
```

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 401 | `unauthorized` | Missing or invalid authentication token |
| 403 | `forbidden` | Insufficient permissions |
| 404 | `not_found` | User not found |
| 500 | `server_error` | Failed to delete user |

**Example:**
```bash
curl -X DELETE "https://your-domain.com/admin/users/user_123" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**JavaScript Usage:**
```typescript
async function deleteUser(userId: string) {
  const confirmed = confirm('Are you sure you want to delete this user? This action cannot be undone.');
  if (!confirmed) return;

  const response = await fetch(`/admin/users/${userId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${getAdminToken()}`
    }
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error_description || 'Failed to delete user');
  }

  return await response.json();
}
```

---

## Data Model

### User Object

```typescript
interface User {
  id: string;                      // UUID
  email: string;                   // Unique email address
  name: string | null;             // Display name
  email_verified: 0 | 1;           // Email verification status
  phone_number: string | null;     // Phone number (E.164 format)
  phone_number_verified: 0 | 1;    // Phone verification status
  created_at: number;              // Unix timestamp (milliseconds)
  updated_at: number;              // Unix timestamp (milliseconds)
  last_login_at: number | null;    // Unix timestamp (milliseconds)
  custom_attributes_json: string | null; // JSON string of custom attributes
}
```

### Passkey Object

```typescript
interface Passkey {
  id: string;                      // UUID
  credential_id: string;           // WebAuthn credential ID (base64)
  device_name: string;             // Human-readable device name
  created_at: number;              // Unix timestamp (milliseconds)
  last_used_at: number;            // Unix timestamp (milliseconds)
}
```

### Custom Field Object

```typescript
interface CustomField {
  field_name: string;              // Field name
  field_value: string;             // Field value
  field_type: string;              // Field type (string, number, boolean, etc.)
}
```

---

## Database Schema

### users Table

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  email_verified INTEGER DEFAULT 0,
  phone_number TEXT,
  phone_number_verified INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER,
  custom_attributes_json TEXT
);
```

### passkeys Table

```sql
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### user_custom_fields Table

```sql
CREATE TABLE user_custom_fields (
  user_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  field_value TEXT NOT NULL,
  field_type TEXT NOT NULL,
  PRIMARY KEY (user_id, field_name),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

---

## Cascade Deletion

When a user is deleted, the following related data is automatically deleted:

1. **Passkeys** - All passkeys registered by the user
2. **Custom Fields** - All custom field entries
3. **Sessions** - All active sessions (Phase 6)
4. **Refresh Tokens** - All refresh tokens (Phase 6)
5. **Consents** - All stored consent decisions (Phase 6)

**Database Constraint:**
```sql
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
```

---

## Search and Filtering

### Search Implementation

The search functionality uses SQL `LIKE` queries:

```sql
SELECT * FROM users
WHERE (email LIKE ? OR name LIKE ?)
ORDER BY created_at DESC
LIMIT ? OFFSET ?;
```

**Search Examples:**
- `search=john` - Matches "john@example.com", "John Doe", "johnny@test.com"
- `search=@example` - Matches all emails with "@example" (e.g., "*@example.com")
- `search=doe` - Matches "John Doe", "Jane Doe"

### Filtering

**Email Verification Filter:**
```bash
# Verified users only
curl "/admin/users?verified=true"

# Unverified users only
curl "/admin/users?verified=false"

# All users (no filter)
curl "/admin/users"
```

**Combining Search and Filter:**
```bash
curl "/admin/users?search=john&verified=true"
```

---

## Pagination

### Pagination Structure

```typescript
interface Pagination {
  page: number;          // Current page (1-indexed)
  limit: number;         // Items per page
  total: number;         // Total number of items
  totalPages: number;    // Total number of pages
  hasNext: boolean;      // Whether there is a next page
  hasPrev: boolean;      // Whether there is a previous page
}
```

### Example Pagination Navigation

```typescript
async function loadPage(page: number) {
  const data = await listUsers(page);

  // Update UI
  displayUsers(data.users);

  // Update pagination controls
  document.getElementById('prev-btn').disabled = !data.pagination.hasPrev;
  document.getElementById('next-btn').disabled = !data.pagination.hasNext;
  document.getElementById('page-info').textContent =
    `Page ${data.pagination.page} of ${data.pagination.totalPages}`;
}

document.getElementById('prev-btn').onclick = () => {
  currentPage--;
  loadPage(currentPage);
};

document.getElementById('next-btn').onclick = () => {
  currentPage++;
  loadPage(currentPage);
};
```

---

## Security Considerations

### Authentication (Phase 6)

Currently, admin endpoints do not enforce authentication. In Phase 6:

- **Bearer Token:** Admin API key or OAuth access token
- **RBAC Permissions:** Role-based access control
  - `users:read` - View users
  - `users:write` - Create/update users
  - `users:delete` - Delete users

### Authorization Header

```http
Authorization: Bearer admin_key_abc123...
```

### Audit Logging (Phase 6)

All admin actions should be logged:

```typescript
interface AuditLog {
  timestamp: number;
  admin_id: string;
  action: string;          // "user_created", "user_updated", "user_deleted"
  resource_type: string;   // "user"
  resource_id: string;     // User ID
  changes: object;         // What changed
  ip_address: string;
  user_agent: string;
}
```

---

## Rate Limiting

Recommended rate limits for admin endpoints:

| Endpoint | Limit | Period | Unit |
|----------|-------|--------|------|
| `GET /admin/users` | 100 | 1 min | admin token |
| `GET /admin/users/:id` | 60 | 1 min | admin token |
| `POST /admin/users` | 10 | 1 min | admin token |
| `PUT /admin/users/:id` | 30 | 1 min | admin token |
| `DELETE /admin/users/:id` | 10 | 1 min | admin token |

---

## Testing

**Unit Tests:** `/packages/op-management/src/__tests__/admin.test.ts`

**Manual Testing:**
```bash
# List users
curl "http://localhost:8787/admin/users"

# Create user
curl -X POST "http://localhost:8787/admin/users" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","name":"Test User"}'

# Get user
curl "http://localhost:8787/admin/users/USER_ID"

# Update user
curl -X PUT "http://localhost:8787/admin/users/USER_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"Updated Name","email_verified":true}'

# Delete user
curl -X DELETE "http://localhost:8787/admin/users/USER_ID"
```

---

## Future Enhancements (Phase 6+)

### Phase 6
- Admin authentication and authorization
- RBAC permissions
- Audit logging
- Custom field updates
- Session invalidation on user delete

### Phase 7
- Bulk operations (bulk delete, bulk update)
- User export (CSV, JSON)
- Advanced filtering (by date range, custom fields)
- User impersonation (for support)
- Password management (if password auth added)

---

## Related Documentation

- [Admin Client Management API](./clients.md)
- [Admin Statistics API](./statistics.md)
- [Database Schema](../../architecture/database-schema.md)
- [Passkey API](../auth/passkey.md)

---

## Change History

- **2025-11-13**: Initial implementation (Phase 5, Stage 2)
  - List users with pagination and search
  - Get user details with passkeys and custom fields
  - Create, update, and delete users
  - Cascade deletion support
