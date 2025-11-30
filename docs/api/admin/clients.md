# Admin Client Management API

## Overview

The Admin Client Management API provides OAuth 2.0 client management capabilities for administrators. It enables listing, viewing, and managing registered OAuth clients (applications) that can authenticate with the Authrim OIDC Provider.

**Key Features:**
- List OAuth clients with pagination and search
- Get detailed client information
- Create, update, and delete clients (Phase 6)
- Regenerate client secrets (Phase 6)
- View client metadata (name, logo, redirect URIs, etc.)

**Authentication:**
- Requires admin privileges (Phase 6)
- Bearer token authentication (Phase 6)
- RBAC permissions: `clients:read`, `clients:write`, `clients:delete` (Phase 6)

## Base URL

```
https://your-domain.com/admin/clients
```

## Endpoints

### 1. List Clients

Get a paginated list of registered OAuth clients with optional search.

**Endpoint:** `GET /admin/clients`

**Query Parameters:**
| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `page` | number | No | 1 | Page number (1-indexed) |
| `limit` | number | No | 20 | Items per page (max 100) |
| `search` | string | No | - | Search by client_name or client_id |

**Response (200 OK):**
```json
{
  "clients": [
    {
      "client_id": "client_abc123",
      "client_name": "My Application",
      "client_secret": "***masked***",
      "client_uri": "https://example.com",
      "logo_uri": "https://example.com/logo.png",
      "redirect_uris": "https://example.com/callback https://example.com/callback2",
      "grant_types": "authorization_code refresh_token",
      "response_types": "code",
      "scope": "openid profile email",
      "token_endpoint_auth_method": "client_secret_basic",
      "created_at": 1699561200000,
      "updated_at": 1699561200000
    },
    {
      "client_id": "client_xyz789",
      "client_name": "Another App",
      "client_secret": "***masked***",
      "client_uri": "https://another.example.com",
      "logo_uri": null,
      "redirect_uris": "https://another.example.com/auth/callback",
      "grant_types": "authorization_code",
      "response_types": "code",
      "scope": "openid email",
      "token_endpoint_auth_method": "client_secret_post",
      "created_at": 1699560000000,
      "updated_at": 1699560000000
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 45,
    "totalPages": 3,
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
| 500 | `server_error` | Failed to retrieve clients |

**Example:**
```bash
# List all clients (first page)
curl "https://your-domain.com/admin/clients" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"

# Search clients by name/ID
curl "https://your-domain.com/admin/clients?search=myapp" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"

# Pagination
curl "https://your-domain.com/admin/clients?page=2&limit=50" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**JavaScript Usage:**
```typescript
async function listClients(page = 1, search = '') {
  const params = new URLSearchParams({
    page: page.toString(),
    limit: '20',
    ...(search && { search })
  });

  const response = await fetch(`/admin/clients?${params}`, {
    headers: {
      'Authorization': `Bearer ${getAdminToken()}`
    }
  });

  const data = await response.json();
  return data;
}
```

---

### 2. Get Client Details

Retrieve detailed information about a specific OAuth client.

**Endpoint:** `GET /admin/clients/:id`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Client ID |

**Response (200 OK):**
```json
{
  "client": {
    "client_id": "client_abc123",
    "client_name": "My Application",
    "client_secret": "***masked***",
    "client_uri": "https://example.com",
    "logo_uri": "https://example.com/logo.png",
    "tos_uri": "https://example.com/terms",
    "policy_uri": "https://example.com/privacy",
    "redirect_uris": "https://example.com/callback https://example.com/callback2",
    "post_logout_redirect_uris": "https://example.com/logout",
    "grant_types": "authorization_code refresh_token",
    "response_types": "code",
    "scope": "openid profile email",
    "token_endpoint_auth_method": "client_secret_basic",
    "jwks_uri": "https://example.com/.well-known/jwks.json",
    "subject_type": "public",
    "id_token_signed_response_alg": "RS256",
    "require_auth_time": 0,
    "default_max_age": 3600,
    "require_pushed_authorization_requests": 0,
    "software_id": null,
    "software_version": null,
    "created_at": 1699561200000,
    "updated_at": 1699561200000
  }
}
```

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 401 | `unauthorized` | Missing or invalid authentication token |
| 403 | `forbidden` | Insufficient permissions |
| 404 | `not_found` | Client not found |
| 500 | `server_error` | Failed to retrieve client |

**Example:**
```bash
curl "https://your-domain.com/admin/clients/client_abc123" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**JavaScript Usage:**
```typescript
async function getClientDetails(clientId: string) {
  const response = await fetch(`/admin/clients/${clientId}`, {
    headers: {
      'Authorization': `Bearer ${getAdminToken()}`
    }
  });

  if (!response.ok) {
    throw new Error('Failed to get client details');
  }

  return await response.json();
}
```

---

### 3. Create Client

Create a new OAuth client with admin privileges.

**Endpoint:** `POST /api/admin/clients`

**Authentication:** Bearer token (ADMIN_API_SECRET)

**Request Body:**
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `client_name` | string | **Yes** | - | Application display name |
| `redirect_uris` | string[] | **Yes** | - | Allowed redirect URIs |
| `grant_types` | string[] | No | `["authorization_code"]` | Allowed grant types |
| `response_types` | string[] | No | `["code"]` | Allowed response types |
| `scope` | string | No | `"openid profile email"` | Allowed scopes |
| `logo_uri` | string | No | - | Application logo URL |
| `client_uri` | string | No | - | Application homepage URL |
| `policy_uri` | string | No | - | Privacy policy URL |
| `tos_uri` | string | No | - | Terms of service URL |
| `contacts` | string[] | No | - | Contact email addresses |
| `token_endpoint_auth_method` | string | No | `"client_secret_basic"` | Authentication method |
| `subject_type` | string | No | `"public"` | Subject identifier type |
| `sector_identifier_uri` | string | No | - | Sector identifier URI |
| `is_trusted` | boolean | No | `false` | Trust status |
| `skip_consent` | boolean | No | `false` | Skip consent screen |
| `allow_claims_without_scope` | boolean | No | `false` | Allow claims parameter without scope |

**Example Request:**
```bash
curl -X POST "https://your-domain.com/api/admin/clients" \
  -H "Authorization: Bearer YOUR_ADMIN_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "My Application",
    "redirect_uris": ["http://localhost:3000/callback"],
    "grant_types": ["authorization_code", "refresh_token"],
    "scope": "openid profile email"
  }'
```

**Response (201 Created):**
```json
{
  "client": {
    "client_id": "550e8400-e29b-41d4-a716-446655440000",
    "client_secret": "a1b2c3d4e5f6g7h8i9j0...",
    "client_name": "My Application",
    "redirect_uris": ["http://localhost:3000/callback"],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "scope": "openid profile email",
    "logo_uri": null,
    "client_uri": null,
    "policy_uri": null,
    "tos_uri": null,
    "contacts": [],
    "token_endpoint_auth_method": "client_secret_basic",
    "subject_type": "public",
    "sector_identifier_uri": null,
    "is_trusted": false,
    "skip_consent": false,
    "allow_claims_without_scope": false,
    "created_at": 1732970400000,
    "updated_at": 1732970400000
  }
}
```

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 400 | `invalid_request` | Missing required fields or invalid data |
| 401 | `unauthorized` | Missing or invalid authentication |
| 500 | `server_error` | Database error |

**JavaScript Usage:**
```typescript
async function createClient(clientData: {
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  scope?: string;
}) {
  const response = await fetch('/api/admin/clients', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.ADMIN_API_SECRET}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(clientData)
  });

  const data = await response.json();

  // IMPORTANT: Store client_secret securely - it's only shown once!
  console.log('Client ID:', data.client.client_id);
  console.log('Client Secret:', data.client.client_secret);

  return data;
}
```

**Important Notes:**
- `client_secret` is only returned once at creation time - store it securely!
- Unlike Dynamic Client Registration (DCR), this endpoint allows setting admin-only flags like `skip_consent` and `is_trusted`
- The `client_id` is a UUID generated by the server

---

### 4. Update Client

Update an existing OAuth client's metadata.

**Endpoint:** `PUT /api/admin/clients/:id`

**Authentication:** Bearer token (ADMIN_API_SECRET)

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Client ID |

**Request Body (all fields optional):**
| Field | Type | Description |
|-------|------|-------------|
| `client_name` | string | Application display name |
| `redirect_uris` | string[] | Allowed redirect URIs |
| `grant_types` | string[] | Allowed grant types |
| `scope` | string | Allowed scopes |
| `logo_uri` | string | Application logo URL |
| `client_uri` | string | Application homepage URL |
| `policy_uri` | string | Privacy policy URL |
| `tos_uri` | string | Terms of service URL |
| `is_trusted` | boolean | Trust status |
| `skip_consent` | boolean | Skip consent screen |
| `allow_claims_without_scope` | boolean | Allow claims parameter without scope |

**Example Request:**
```bash
curl -X PUT "https://your-domain.com/api/admin/clients/CLIENT_ID" \
  -H "Authorization: Bearer YOUR_ADMIN_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Updated Application Name",
    "redirect_uris": ["http://localhost:3000/callback", "http://localhost:3000/new-callback"]
  }'
```

**Response (200 OK):**
```json
{
  "client": {
    "client_id": "550e8400-e29b-41d4-a716-446655440000",
    "client_name": "Updated Application Name",
    "redirect_uris": ["http://localhost:3000/callback", "http://localhost:3000/new-callback"],
    "updated_at": 1732970400000
  }
}
```

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 400 | `invalid_request` | Invalid request body |
| 401 | `unauthorized` | Missing or invalid authentication |
| 404 | `not_found` | Client not found |
| 500 | `server_error` | Database error |

---

### 5. Regenerate Client Secret (Phase 6)

Generate a new client secret and invalidate the old one.

**Status:** Planned for Phase 6

**Endpoint:** `POST /admin/clients/:id/regenerate-secret`

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Client ID |

**Expected Response (200 OK):**
```json
{
  "client_id": "client_abc123",
  "client_secret": "new_secret_generated_abc...xyz",
  "message": "Client secret regenerated. Please store this securely - it will not be shown again."
}
```

**Security:**
- Old secret is immediately invalidated
- New secret is shown only once
- Audit log entry created

---

### 6. Delete Client

Delete an OAuth client.

**Endpoint:** `DELETE /api/admin/clients/:id`

**Authentication:** Bearer token (ADMIN_API_SECRET)

**Path Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | Client ID |

**Example Request:**
```bash
curl -X DELETE "https://your-domain.com/api/admin/clients/CLIENT_ID" \
  -H "Authorization: Bearer YOUR_ADMIN_API_SECRET"
```

**Response (200 OK):**
```json
{
  "success": true,
  "message": "Client deleted successfully"
}
```

**Error Responses:**

| Status Code | Error | Description |
|-------------|-------|-------------|
| 401 | `unauthorized` | Missing or invalid authentication |
| 404 | `not_found` | Client not found |
| 500 | `server_error` | Database error |

---

### 7. Bulk Delete Clients

Delete multiple OAuth clients at once.

**Endpoint:** `DELETE /api/admin/clients/bulk`

**Authentication:** Bearer token (ADMIN_API_SECRET)

**Request Body:**
```json
{
  "client_ids": ["client_id_1", "client_id_2", "client_id_3"]
}
```

**Example Request:**
```bash
curl -X DELETE "https://your-domain.com/api/admin/clients/bulk" \
  -H "Authorization: Bearer YOUR_ADMIN_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"client_ids": ["client_1", "client_2"]}'
```

**Response (200 OK):**
```json
{
  "success": true,
  "deleted": 2,
  "requested": 2
}
```

**Partial Success Response:**
```json
{
  "success": true,
  "deleted": 1,
  "requested": 2,
  "errors": ["Client client_2 not found"]
}
```

---

## Data Model

### Client Object

```typescript
interface OAuthClient {
  // Basic metadata
  client_id: string;                        // Unique client identifier
  client_secret: string;                    // Hashed secret (masked in responses)
  client_name: string;                      // Application name
  client_uri: string | null;                // Application homepage URL
  logo_uri: string | null;                  // Application logo URL
  tos_uri: string | null;                   // Terms of Service URL
  policy_uri: string | null;                // Privacy Policy URL

  // OAuth configuration
  redirect_uris: string;                    // Space-separated redirect URIs
  post_logout_redirect_uris: string | null; // Space-separated logout redirect URIs
  grant_types: string;                      // Space-separated grant types
  response_types: string;                   // Space-separated response types
  scope: string;                            // Space-separated scopes
  token_endpoint_auth_method: string;       // client_secret_basic, client_secret_post, etc.

  // Advanced configuration
  jwks_uri: string | null;                  // JWKS endpoint URL
  subject_type: string;                     // "public" or "pairwise"
  id_token_signed_response_alg: string;     // "RS256", "ES256", etc.
  require_auth_time: 0 | 1;                 // Require auth_time in ID token
  default_max_age: number | null;           // Default max authentication age
  require_pushed_authorization_requests: 0 | 1; // Require PAR

  // Metadata
  software_id: string | null;               // Software identifier
  software_version: string | null;          // Software version
  created_at: number;                       // Unix timestamp (milliseconds)
  updated_at: number;                       // Unix timestamp (milliseconds)
}
```

---

## Database Schema

### oauth_clients Table

```sql
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_uri TEXT,
  logo_uri TEXT,
  tos_uri TEXT,
  policy_uri TEXT,
  redirect_uris TEXT NOT NULL,
  post_logout_redirect_uris TEXT,
  grant_types TEXT NOT NULL,
  response_types TEXT NOT NULL,
  scope TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  jwks_uri TEXT,
  subject_type TEXT DEFAULT 'public',
  id_token_signed_response_alg TEXT DEFAULT 'RS256',
  require_auth_time INTEGER DEFAULT 0,
  default_max_age INTEGER,
  require_pushed_authorization_requests INTEGER DEFAULT 0,
  software_id TEXT,
  software_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

---

## Search and Filtering

### Search Implementation

The search functionality uses SQL `LIKE` queries:

```sql
SELECT * FROM oauth_clients
WHERE client_name LIKE ? OR client_id LIKE ?
ORDER BY created_at DESC
LIMIT ? OFFSET ?;
```

**Search Examples:**
- `search=myapp` - Matches "My Application", "MyApp Dashboard", client IDs containing "myapp"
- `search=client_abc` - Matches client_id "client_abc123"
- `search=test` - Matches "Test Client", "Testing App"

---

## Pagination

### Pagination Structure

```typescript
interface Pagination {
  page: number;          // Current page (1-indexed)
  limit: number;         // Items per page
  total: number;         // Total number of clients
  totalPages: number;    // Total number of pages
  hasNext: boolean;      // Whether there is a next page
  hasPrev: boolean;      // Whether there is a previous page
}
```

---

## Security Considerations

### Client Secret Masking

Client secrets are never returned in plain text:

```json
{
  "client_secret": "***masked***"
}
```

**Exception:** When regenerating secret (POST `/admin/clients/:id/regenerate-secret`), the new secret is shown once.

### Authentication (Phase 6)

- **Bearer Token:** Admin API key or OAuth access token
- **RBAC Permissions:**
  - `clients:read` - View clients
  - `clients:write` - Create/update clients
  - `clients:delete` - Delete clients

### Audit Logging (Phase 6)

All admin actions should be logged:

```typescript
interface AuditLog {
  timestamp: number;
  admin_id: string;
  action: string;          // "client_created", "client_updated", "client_deleted", "secret_regenerated"
  resource_type: string;   // "oauth_client"
  resource_id: string;     // Client ID
  changes: object;         // What changed
  ip_address: string;
  user_agent: string;
}
```

---

## Cache Invalidation

OAuth clients are cached in KV for performance. When a client is updated or deleted:

1. **Invalidate KV cache:**
   ```typescript
   await KV_CACHE.delete(`oauth_client:${client_id}`);
   ```

2. **Update D1 database:**
   ```sql
   UPDATE oauth_clients SET ... WHERE client_id = ?;
   ```

3. **Propagation delay:**
   - KV invalidation: Immediate
   - Global propagation: < 60 seconds

---

## Rate Limiting

Recommended rate limits for admin endpoints:

| Endpoint | Limit | Period | Unit |
|----------|-------|--------|------|
| `GET /admin/clients` | 100 | 1 min | admin token |
| `GET /admin/clients/:id` | 60 | 1 min | admin token |
| `POST /admin/clients` | 10 | 1 min | admin token |
| `PUT /admin/clients/:id` | 30 | 1 min | admin token |
| `POST /admin/clients/:id/regenerate-secret` | 5 | 1 min | admin token |
| `DELETE /admin/clients/:id` | 10 | 1 min | admin token |

---

## Testing

**Unit Tests:** `/packages/op-management/src/__tests__/admin.test.ts`

**Manual Testing:**
```bash
# List clients
curl "http://localhost:8787/admin/clients"

# Search clients
curl "http://localhost:8787/admin/clients?search=myapp"

# Get client details
curl "http://localhost:8787/admin/clients/CLIENT_ID"

# Create client (Phase 6)
# Update client (Phase 6)
# Regenerate secret (Phase 6)
# Delete client (Phase 6)
```

---

## Integration with Dynamic Client Registration

The Admin Client Management API complements the existing Dynamic Client Registration (DCR) endpoint:

**Comparison:**

| Feature | DCR (`POST /register`) | Admin API (`POST /admin/clients`) |
|---------|------------------------|-----------------------------------|
| **Authentication** | None (public) or Initial Access Token | Admin Bearer Token |
| **Use Case** | Client self-registration | Admin-initiated registration |
| **Validation** | Strict RFC 7591 compliance | More flexible |
| **Metadata** | Standard OIDC metadata | Can include custom fields |
| **Audit** | Limited | Full audit trail |

---

## Grant Types

Supported OAuth 2.0 grant types:

| Grant Type | Description |
|------------|-------------|
| `authorization_code` | Standard authorization code flow (REQUIRED) |
| `refresh_token` | Refresh token for long-lived access |
| `client_credentials` | Machine-to-machine authentication (Phase 7) |
| `implicit` | Implicit flow (NOT RECOMMENDED) |

**Default:** `authorization_code`

---

## Token Endpoint Auth Methods

Supported client authentication methods:

| Method | Description |
|--------|-------------|
| `client_secret_basic` | HTTP Basic authentication (default) |
| `client_secret_post` | POST body parameters |
| `client_secret_jwt` | JWT with client secret (RFC 7523) |
| `private_key_jwt` | JWT with private key (RFC 7523) |
| `none` | Public clients (PKCE required) |

**Default:** `client_secret_basic`

---

## Response Types

Supported OAuth 2.0 response types:

| Response Type | Flow | Description |
|---------------|------|-------------|
| `code` | Authorization Code | Standard flow (RECOMMENDED) |
| `token` | Implicit | Access token (NOT RECOMMENDED) |
| `id_token` | Implicit | ID token only |
| `id_token token` | Implicit | Both tokens |
| `code id_token` | Hybrid | Code + ID token |
| `code token` | Hybrid | Code + access token |
| `code id_token token` | Hybrid | All tokens |

**Default:** `code`

---

## Future Enhancements

### Phase 6
- Create client endpoint
- Update client endpoint
- Regenerate client secret
- Delete client endpoint
- Audit logging
- KV cache invalidation

### Phase 7
- Bulk operations (bulk delete)
- Client export (CSV, JSON)
- Client usage statistics (token counts, last used)
- Client health monitoring
- Client secret rotation policies
- Webhook configuration

---

## Related Documentation

- [Admin User Management API](./users.md)
- [Admin Statistics API](./statistics.md)
- [Dynamic Client Registration (DCR)](../../features/dynamic-client-registration.md)
- [Database Schema](../../architecture/database-schema.md)
- [RFC 7591 - OAuth 2.0 Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591)

---

## Change History

- **2025-11-30**: Full CRUD implementation
  - Create client endpoint (`POST /api/admin/clients`)
  - Update client endpoint (`PUT /api/admin/clients/:id`)
  - Delete client endpoint (`DELETE /api/admin/clients/:id`)
  - Bulk delete endpoint (`DELETE /api/admin/clients/bulk`)
  - Admin-only flags support (`is_trusted`, `skip_consent`, `allow_claims_without_scope`)
- **2025-11-13**: Initial implementation (Phase 5, Stage 2)
  - List clients with pagination and search
  - Get client details
