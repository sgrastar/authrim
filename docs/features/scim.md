# SCIM 2.0 User Provisioning

Authrim supports SCIM 2.0 (System for Cross-domain Identity Management) for automated user and group provisioning.

**Standards Implemented:**
- [RFC 7643: SCIM Core Schema](https://datatracker.ietf.org/doc/html/rfc7643)
- [RFC 7644: SCIM Protocol](https://datatracker.ietf.org/doc/html/rfc7644)

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Endpoints](#endpoints)
  - [Users](#users)
  - [Groups](#groups)
- [Filtering](#filtering)
- [Pagination](#pagination)
- [Resource Versioning (ETags)](#resource-versioning-etags)
- [Error Responses](#error-responses)
- [Examples](#examples)
- [Integration Guides](#integration-guides)

---

## Overview

SCIM provides a standardized REST API for managing user identities across systems. With SCIM, you can:

- **Automate user provisioning**: Create, update, and delete users automatically
- **Sync user attributes**: Keep user data consistent across systems
- **Manage group memberships**: Automatically assign users to roles/groups
- **Handle lifecycle events**: Deactivate users when they leave

### Supported Features

- ✅ User CRUD operations (Create, Read, Update, Delete)
- ✅ Group CRUD operations
- ✅ Filtering with SCIM query syntax
- ✅ Pagination with `startIndex` and `count`
- ✅ Resource versioning with ETags
- ✅ Partial updates with PATCH operations
- ✅ Enterprise User extension
- ✅ Bearer token authentication

---

## Authentication

All SCIM requests require a Bearer token for authentication.

### Creating a SCIM Token

1. Navigate to the Admin UI: **Admin → SCIM Tokens**
2. Click **Create Token**
3. Enter a description (e.g., "Okta SCIM Integration")
4. Set expiration (e.g., 365 days)
5. Copy the token immediately (it won't be shown again)

### Using the Token

Include the token in the `Authorization` header:

```http
Authorization: Bearer YOUR_TOKEN_HERE
```

**Example cURL:**

```bash
curl -H "Authorization: Bearer abc123..." \
  https://auth.example.com/scim/v2/Users
```

---

## Endpoints

### Base URL

```
https://YOUR_DOMAIN/scim/v2
```

### Users

#### List Users

```http
GET /scim/v2/Users
```

**Query Parameters:**

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `filter` | string | SCIM filter expression | `userName eq "john@example.com"` |
| `sortBy` | string | Attribute to sort by | `userName` |
| `sortOrder` | string | `ascending` or `descending` | `ascending` |
| `startIndex` | integer | 1-based pagination index | `1` |
| `count` | integer | Number of results per page (max 1000) | `100` |
| `attributes` | string | Comma-separated attributes to return | `userName,emails` |
| `excludedAttributes` | string | Comma-separated attributes to exclude | `password` |

**Response:**

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
  "totalResults": 2,
  "startIndex": 1,
  "itemsPerPage": 2,
  "Resources": [
    {
      "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
      "id": "user-123",
      "userName": "john@example.com",
      "name": {
        "givenName": "John",
        "familyName": "Doe"
      },
      "emails": [
        {
          "value": "john@example.com",
          "primary": true
        }
      ],
      "active": true,
      "meta": {
        "resourceType": "User",
        "created": "2024-01-01T00:00:00Z",
        "lastModified": "2024-01-02T00:00:00Z",
        "location": "https://auth.example.com/scim/v2/Users/user-123",
        "version": "W/\"1704153600000\""
      }
    }
  ]
}
```

#### Get User by ID

```http
GET /scim/v2/Users/{id}
```

**Response:** Single User resource (see List Users response for structure)

**Headers:**
- `ETag`: Resource version for conditional requests

#### Create User

```http
POST /scim/v2/Users
```

**Request Body:**

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "userName": "john@example.com",
  "name": {
    "givenName": "John",
    "familyName": "Doe"
  },
  "emails": [
    {
      "value": "john@example.com",
      "primary": true
    }
  ],
  "active": true,
  "password": "SecurePassword123!"
}
```

**Response:** `201 Created` with User resource

**Headers:**
- `Location`: URL of the created user

#### Replace User (PUT)

```http
PUT /scim/v2/Users/{id}
```

**Request Body:** Complete User resource

**Headers:**
- `If-Match`: ETag for conditional update (optional)

**Response:** `200 OK` with updated User resource

#### Update User (PATCH)

```http
PATCH /scim/v2/Users/{id}
```

**Request Body:**

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations": [
    {
      "op": "replace",
      "path": "name.givenName",
      "value": "Jane"
    },
    {
      "op": "add",
      "path": "phoneNumbers",
      "value": [
        {
          "value": "+1234567890",
          "type": "mobile"
        }
      ]
    },
    {
      "op": "remove",
      "path": "addresses"
    }
  ]
}
```

**Supported Operations:**
- `add`: Add new attribute
- `replace`: Replace existing attribute
- `remove`: Remove attribute

**Response:** `200 OK` with updated User resource

#### Delete User

```http
DELETE /scim/v2/Users/{id}
```

**Response:** `204 No Content`

---

### Groups

#### List Groups

```http
GET /scim/v2/Groups
```

**Query Parameters:** Same as List Users

**Response:**

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
  "totalResults": 1,
  "startIndex": 1,
  "itemsPerPage": 1,
  "Resources": [
    {
      "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      "id": "group-123",
      "displayName": "Administrators",
      "members": [
        {
          "value": "user-123",
          "$ref": "https://auth.example.com/scim/v2/Users/user-123",
          "type": "User",
          "display": "john@example.com"
        }
      ],
      "meta": {
        "resourceType": "Group",
        "created": "2024-01-01T00:00:00Z",
        "lastModified": "2024-01-02T00:00:00Z",
        "location": "https://auth.example.com/scim/v2/Groups/group-123"
      }
    }
  ]
}
```

#### Get Group by ID

```http
GET /scim/v2/Groups/{id}
```

#### Create Group

```http
POST /scim/v2/Groups
```

**Request Body:**

```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"],
  "displayName": "Engineering",
  "members": [
    {
      "value": "user-123",
      "type": "User"
    }
  ]
}
```

#### Replace Group (PUT)

```http
PUT /scim/v2/Groups/{id}
```

#### Update Group (PATCH)

```http
PATCH /scim/v2/Groups/{id}
```

#### Delete Group

```http
DELETE /scim/v2/Groups/{id}
```

---

## Filtering

SCIM supports complex filtering using a standardized query syntax.

### Filter Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `eq` | Equal | `userName eq "john@example.com"` |
| `ne` | Not equal | `active ne false` |
| `co` | Contains | `userName co "john"` |
| `sw` | Starts with | `userName sw "john"` |
| `ew` | Ends with | `userName ew "example.com"` |
| `pr` | Present (has value) | `phoneNumber pr` |
| `gt` | Greater than | `meta.created gt "2024-01-01"` |
| `ge` | Greater than or equal | `meta.created ge "2024-01-01"` |
| `lt` | Less than | `meta.created lt "2024-12-31"` |
| `le` | Less than or equal | `meta.created le "2024-12-31"` |

### Logical Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `and` | Logical AND | `userName eq "john" and active eq true` |
| `or` | Logical OR | `userName eq "john" or userName eq "jane"` |
| `not` | Logical NOT | `not (active eq false)` |

### Grouping

Use parentheses for precedence:

```
(userName eq "john" or userName eq "jane") and active eq true
```

### Examples

```bash
# Find user by email
GET /scim/v2/Users?filter=userName eq "john@example.com"

# Find active users
GET /scim/v2/Users?filter=active eq true

# Find users with phone numbers
GET /scim/v2/Users?filter=phoneNumber pr

# Find users by domain
GET /scim/v2/Users?filter=userName ew "example.com"

# Complex filter
GET /scim/v2/Users?filter=(userName co "john" or userName co "jane") and active eq true

# Find groups by name
GET /scim/v2/Groups?filter=displayName eq "Administrators"
```

---

## Pagination

SCIM uses 1-based pagination with `startIndex` and `count` parameters.

### Parameters

- **startIndex**: Starting position (default: 1)
- **count**: Number of results per page (default: 100, max: 1000)

### Example

```bash
# First page (items 1-100)
GET /scim/v2/Users?startIndex=1&count=100

# Second page (items 101-200)
GET /scim/v2/Users?startIndex=101&count=100

# Third page (items 201-300)
GET /scim/v2/Users?startIndex=201&count=100
```

### Response

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
  "totalResults": 250,
  "startIndex": 1,
  "itemsPerPage": 100,
  "Resources": [...]
}
```

---

## Resource Versioning (ETags)

SCIM supports ETags for optimistic concurrency control.

### How ETags Work

1. Server returns `ETag` header with resource version
2. Client includes `If-Match` header in update requests
3. Server validates version and rejects stale updates

### Example

**Get user:**

```http
GET /scim/v2/Users/user-123

Response:
ETag: W/"1704153600000"
```

**Update with ETag:**

```http
PUT /scim/v2/Users/user-123
If-Match: W/"1704153600000"

Success: 200 OK (version matches)
Failure: 412 Precondition Failed (version mismatch)
```

### Conditional GET

Use `If-None-Match` to avoid fetching unchanged resources:

```http
GET /scim/v2/Users/user-123
If-None-Match: W/"1704153600000"

Response:
304 Not Modified (resource unchanged)
OR
200 OK (resource changed, new version returned)
```

---

## Error Responses

SCIM uses standardized error responses.

### Error Format

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
  "status": "400",
  "scimType": "invalidValue",
  "detail": "userName is required"
}
```

### Error Types

| scimType | HTTP Status | Description |
|----------|-------------|-------------|
| `invalidFilter` | 400 | Invalid filter syntax |
| `invalidValue` | 400 | Invalid attribute value |
| `uniqueness` | 409 | Resource already exists |
| `mutability` | 400 | Attempt to modify read-only attribute |
| `invalidSyntax` | 400 | Malformed request |
| `noTarget` | 404 | Resource not found |
| `invalidVers` | 412 | ETag mismatch |

---

## Examples

### Complete User Lifecycle

#### 1. Create User

```bash
curl -X POST https://auth.example.com/scim/v2/Users \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
    "userName": "john@example.com",
    "name": {
      "givenName": "John",
      "familyName": "Doe"
    },
    "emails": [{
      "value": "john@example.com",
      "primary": true
    }],
    "active": true
  }'
```

#### 2. Get User

```bash
curl https://auth.example.com/scim/v2/Users/user-123 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

#### 3. Update User

```bash
curl -X PATCH https://auth.example.com/scim/v2/Users/user-123 \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    "Operations": [{
      "op": "replace",
      "path": "active",
      "value": false
    }]
  }'
```

#### 4. Delete User

```bash
curl -X DELETE https://auth.example.com/scim/v2/Users/user-123 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Integration Guides

### Okta

1. **Generate SCIM token** in Authrim Admin UI
2. **Configure Okta app:**
   - SCIM Base URL: `https://YOUR_DOMAIN/scim/v2`
   - Authentication: HTTP Header
   - Authorization: Bearer `YOUR_TOKEN`
3. **Enable provisioning:**
   - Create Users ✓
   - Update User Attributes ✓
   - Deactivate Users ✓
   - Group Push (optional) ✓

### Azure AD (Entra ID)

1. **Add Enterprise Application** → Non-gallery application
2. **Configure Provisioning:**
   - Provisioning Mode: Automatic
   - Tenant URL: `https://YOUR_DOMAIN/scim/v2`
   - Secret Token: `YOUR_TOKEN`
3. **Test Connection**
4. **Configure Attribute Mappings:**
   - userName → email
   - givenName → given_name
   - familyName → family_name
   - active → active

### OneLogin

1. **Applications** → Add App → SCIM Provisioner
2. **Configuration:**
   - SCIM Base URL: `https://YOUR_DOMAIN/scim/v2`
   - SCIM Bearer Token: `YOUR_TOKEN`
   - API Connection: SCIM 2.0
3. **Enable Provisioning:**
   - Provision → Create user
   - Update → Update user
   - Delete → Deactivate user

### Google Workspace

1. **Admin Console** → Apps → SAML apps
2. **Configure User Provisioning:**
   - Provisioning URL: `https://YOUR_DOMAIN/scim/v2/Users`
   - Authorization: Bearer Token
   - Token: `YOUR_TOKEN`
3. **Attribute Mapping:**
   - Primary Email → userName
   - First Name → name.givenName
   - Last Name → name.familyName

---

## Attribute Mapping

### User Attributes

| SCIM Attribute | Authrim Field | Type | Notes |
|----------------|---------------|------|-------|
| `id` | `id` | string | Read-only |
| `externalId` | `external_id` | string | External system ID |
| `userName` | `preferred_username` | string | Required |
| `name.givenName` | `given_name` | string | |
| `name.familyName` | `family_name` | string | |
| `name.formatted` | `name` | string | |
| `displayName` | `name` | string | |
| `emails[primary].value` | `email` | string | Required |
| `phoneNumbers[primary].value` | `phone_number` | string | |
| `active` | `active` | boolean | |
| `locale` | `locale` | string | |
| `timezone` | `zoneinfo` | string | |
| `password` | `password_hash` | string | Write-only |

### Enterprise Extension

| SCIM Attribute | Authrim Field | Type |
|----------------|---------------|------|
| `employeeNumber` | `custom_attributes.employeeNumber` | string |
| `costCenter` | `custom_attributes.costCenter` | string |
| `organization` | `custom_attributes.organization` | string |
| `division` | `custom_attributes.division` | string |
| `department` | `custom_attributes.department` | string |
| `manager.value` | `custom_attributes.manager` | string |

### Group Attributes

| SCIM Attribute | Authrim Field | Type |
|----------------|---------------|------|
| `id` | `id` | string |
| `displayName` | `name` | string |
| `members` | `user_roles` | array |

---

## Best Practices

### Security

- **Rotate tokens regularly** (e.g., every 90 days)
- **Use separate tokens** for each integration
- **Monitor token usage** in audit logs
- **Revoke unused tokens** immediately
- **Use HTTPS** for all SCIM requests

### Performance

- **Use filtering** to reduce response sizes
- **Implement pagination** for large datasets
- **Use ETags** to avoid unnecessary updates
- **Batch operations** when creating multiple users

### Error Handling

- **Implement retry logic** with exponential backoff
- **Handle 429 (rate limit)** responses
- **Log all errors** for troubleshooting
- **Validate data** before sending to SCIM

### Monitoring

- **Track provisioning metrics:**
  - User creation rate
  - Update frequency
  - Error rates
- **Set up alerts** for:
  - Authentication failures
  - High error rates
  - Token expiration
- **Review audit logs** regularly

---

## Troubleshooting

### Common Issues

#### 401 Unauthorized

**Cause:** Invalid or expired token

**Solution:**
- Verify token is correct
- Check token hasn't expired
- Ensure token is included in `Authorization` header

#### 409 Conflict (uniqueness error)

**Cause:** User with same email already exists

**Solution:**
- Check if user exists before creating
- Use PATCH to update existing user
- Handle duplicate errors gracefully

#### 412 Precondition Failed (ETag mismatch)

**Cause:** Resource was modified by another client

**Solution:**
- Fetch latest version of resource
- Reapply changes
- Consider using PATCH instead of PUT

#### 400 Invalid Filter

**Cause:** Malformed filter syntax

**Solution:**
- Check filter syntax
- Validate operator usage
- Ensure proper quoting of strings

---

## API Reference

### Rate Limits

- **100 requests per minute** per token
- **429 Too Many Requests** response when exceeded
- `Retry-After` header indicates wait time

### SCIM Compliance

Authrim implements SCIM 2.0 with the following conformance:

- ✅ Core Schema (RFC 7643)
- ✅ Protocol (RFC 7644)
- ✅ Enterprise User Extension
- ✅ Filtering
- ✅ Pagination
- ✅ ETags
- ✅ PATCH operations
- ⚠️ Bulk operations (not yet supported)
- ⚠️ Complex attributes filtering (partial support)

---

## Support

For issues or questions:

- **Documentation:** https://docs.authrim.com
- **GitHub Issues:** https://github.com/your-org/authrim/issues
- **Email:** support@authrim.com

---

## Changelog

### Version 1.0 (2024-01)

- ✅ Initial SCIM 2.0 implementation
- ✅ User and Group resources
- ✅ Filtering and pagination
- ✅ ETag support
- ✅ Enterprise User extension
- ✅ Admin UI for token management
