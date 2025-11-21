# Dynamic Client Registration (DCR)

## Overview

**OpenID Connect Dynamic Client Registration 1.0**

Authrim implements Dynamic Client Registration (DCR), allowing OAuth 2.0 and OpenID Connect clients to register dynamically with the authorization server without requiring manual pre-registration or administrator intervention.

## Specification

- **Specification**: [OpenID Connect Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)
- **Status**: ✅ Implemented
- **Endpoint**: `POST /register`

---

## Why Use Dynamic Client Registration?

### Benefits

1. **🚀 Automated Onboarding**
   - No manual administrator intervention required
   - Instant client provisioning
   - Self-service client registration
   - Reduced time-to-market for new applications

2. **🔄 Scalability**
   - Supports thousands of clients without bottlenecks
   - API-driven client management
   - Automated testing and CI/CD integration
   - Multi-environment deployments (dev, staging, prod)

3. **🏗️ Microservices Architecture**
   - Each service can register its own client
   - Dynamic service discovery
   - Ephemeral client support (containers, serverless)
   - Cloud-native friendly

4. **🔐 Security**
   - Cryptographically secure client credentials
   - Unique client ID per registration (~135 characters)
   - Strong client secret (32 bytes, base64url-encoded)
   - Automatic credential rotation support

### Use Cases

- **Developer Self-Service**: Developers register clients without waiting for admin approval
- **SaaS Platforms**: Multi-tenant applications with per-tenant clients
- **Microservices**: Each service automatically registers on startup
- **Mobile Apps**: Dynamic client registration for app instances
- **Testing & CI/CD**: Automated test client creation and cleanup
- **IoT Devices**: Large-scale device provisioning

---

## How Dynamic Client Registration Works

### Flow Diagram

```
┌──────────┐                                    ┌────────────────┐
│  Client  │                                    │ Authorization  │
│          │                                    │     Server     │
└─────┬────┘                                    └───────┬────────┘
      │                                                 │
      │ 1. POST /register                              │
      │    {                                            │
      │      "redirect_uris": [...],                   │
      │      "client_name": "...",                     │
      │      "grant_types": [...],                     │
      │      ...                                        │
      │    }                                            │
      ├────────────────────────────────────────────────>│
      │                                                 │
      │                                                 │ 2. Validate
      │                                                 │    Metadata
      │                                                 │
      │                                                 │ 3. Generate
      │                                                 │    Credentials
      │                                                 │    (client_id,
      │                                                 │     client_secret)
      │                                                 │
      │                                                 │ 4. Store
      │                                                 │    in KV
      │                                                 │
      │ 5. 201 Created                                 │
      │    {                                            │
      │      "client_id": "...",                        │
      │      "client_secret": "...",                    │
      │      "client_id_issued_at": 1234567890,        │
      │      ...                                        │
      │    }                                            │
      │<────────────────────────────────────────────────┤
      │                                                 │
      │ 6. Client can now use OAuth/OIDC flows         │
      │    with the registered credentials             │
      │                                                 │
```

### Step-by-Step Process

1. **Client submits registration request**: Client sends metadata to registration endpoint
2. **Server validates metadata**: Validates redirect URIs, grant types, and other parameters
3. **Server generates credentials**: Creates unique client ID and secret
4. **Server stores metadata**: Saves client configuration to KV storage
5. **Server returns credentials**: Responds with client ID, secret, and metadata
6. **Client uses credentials**: Client can immediately use OAuth/OIDC flows

---

## API Reference

### Registration Endpoint

**POST /register**

#### Request Format

**Headers**:
```http
Content-Type: application/json
```

**Body Parameters**:

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `redirect_uris` | ✅ Yes | string[] | Array of registered redirect URIs (must be HTTPS, except `http://localhost` for dev) |
| `client_name` | ❌ No | string | Human-readable client name |
| `client_uri` | ❌ No | string | URL of client's homepage |
| `logo_uri` | ❌ No | string | URL of client's logo image |
| `contacts` | ❌ No | string[] | Array of contact email addresses |
| `tos_uri` | ❌ No | string | URL of client's terms of service |
| `policy_uri` | ❌ No | string | URL of client's privacy policy |
| `jwks_uri` | ❌ No | string | URL of client's JSON Web Key Set |
| `software_id` | ❌ No | string | Unique software identifier |
| `software_version` | ❌ No | string | Software version string |
| `token_endpoint_auth_method` | ❌ No | string | Token endpoint authentication method: `client_secret_basic` (default), `client_secret_post`, `none` |
| `grant_types` | ❌ No | string[] | OAuth grant types: `authorization_code` (default), `refresh_token`, `implicit` |
| `response_types` | ❌ No | string[] | OAuth response types: `code` (default), `id_token`, `token` |
| `application_type` | ❌ No | string | Application type: `web` (default), `native` |
| `scope` | ❌ No | string | Space-separated list of scope values |
| `subject_type` | ❌ No | string | Subject identifier type: `public` (default), `pairwise` |
| `sector_identifier_uri` | ❌ No | string | HTTPS URI for pairwise subject type (required for pairwise with multiple redirect URIs from different hosts) |

#### Success Response

**Status**: `201 Created`

```json
{
  "client_id": "client_AbCdEfGh...",
  "client_secret": "XyZ123...",
  "client_id_issued_at": 1699876543,
  "client_secret_expires_at": 0,
  "redirect_uris": ["https://myapp.example.com/callback"],
  "token_endpoint_auth_method": "client_secret_basic",
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "application_type": "web",
  "subject_type": "public"
}
```

**Response Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `client_id` | string | Unique client identifier (~135 characters) |
| `client_secret` | string | Client secret for authentication |
| `client_id_issued_at` | number | Unix timestamp when client ID was issued |
| `client_secret_expires_at` | number | Unix timestamp when secret expires (0 = never) |
| `redirect_uris` | string[] | Registered redirect URIs |
| `token_endpoint_auth_method` | string | Token endpoint authentication method |
| `grant_types` | string[] | Allowed OAuth grant types |
| `response_types` | string[] | Allowed OAuth response types |
| `application_type` | string | Application type (web or native) |
| `subject_type` | string | Subject identifier type |

Plus any optional fields that were provided in the request.

#### Error Responses

**400 Bad Request**:

```json
{
  "error": "invalid_redirect_uri",
  "error_description": "redirect_uris is required and must be a non-empty array"
}
```

**Common Error Codes**:

| Error Code | Description |
|------------|-------------|
| `invalid_request` | Request body is not valid JSON |
| `invalid_redirect_uri` | Missing, invalid, or insecure redirect URI |
| `invalid_client_metadata` | Invalid client metadata field |

**500 Internal Server Error**:

```json
{
  "error": "server_error",
  "error_description": "An unexpected error occurred during registration"
}
```

---

## Usage Examples

### Example 1: Minimal Registration

#### Request

```bash
curl -X POST https://authrim.sgrastar.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{
    "redirect_uris": ["https://myapp.example.com/callback"]
  }'
```

#### Response

```json
{
  "client_id": "client_AbCdEfGhIjKlMnOpQrStUvWxYz...",
  "client_secret": "XyZ123AbC456DeF789GhI...",
  "client_id_issued_at": 1699876543,
  "client_secret_expires_at": 0,
  "redirect_uris": ["https://myapp.example.com/callback"],
  "token_endpoint_auth_method": "client_secret_basic",
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "application_type": "web",
  "subject_type": "public"
}
```

---

### Example 2: Full Registration with Optional Fields

```bash
curl -X POST https://authrim.sgrastar.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{
    "redirect_uris": [
      "https://myapp.example.com/callback",
      "https://myapp.example.com/callback2"
    ],
    "client_name": "My Awesome App",
    "client_uri": "https://myapp.example.com",
    "logo_uri": "https://myapp.example.com/logo.png",
    "contacts": ["admin@example.com", "support@example.com"],
    "tos_uri": "https://myapp.example.com/tos",
    "policy_uri": "https://myapp.example.com/privacy",
    "token_endpoint_auth_method": "client_secret_post",
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "application_type": "web",
    "scope": "openid profile email"
  }'
```

---

### Example 3: Native Mobile App Registration

```bash
curl -X POST https://authrim.sgrastar.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{
    "redirect_uris": ["myapp://callback"],
    "client_name": "My Mobile App",
    "application_type": "native",
    "token_endpoint_auth_method": "none",
    "grant_types": ["authorization_code", "refresh_token"]
  }'
```

**Note**: Native apps typically use `token_endpoint_auth_method: "none"` (public client) and rely on PKCE for security.

---

### Example 4: Development with localhost

```bash
curl -X POST https://authrim.sgrastar.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{
    "redirect_uris": ["http://localhost:3000/callback"],
    "client_name": "Local Development App"
  }'
```

**Note**: `http://localhost` is allowed for development purposes. In production, always use HTTPS.

---

### Example 5: Pairwise Subject Type

```bash
curl -X POST https://authrim.sgrastar.workers.dev/register \
  -H "Content-Type: application/json" \
  -d '{
    "redirect_uris": ["https://myapp.example.com/callback"],
    "client_name": "Privacy-Focused App",
    "subject_type": "pairwise"
  }'
```

**Note**: Pairwise subject identifiers provide user privacy by issuing different `sub` (subject) values for the same user across different clients.

---

## Implementation Details

### Client ID Generation

Authrim generates cryptographically secure client IDs:

```typescript
function generateClientId(): string {
  // 96 bytes → ~128 characters in base64url
  return `client_${generateSecureRandomString(96)}`;
}
```

**Format**: `client_[128 random characters]`

**Total Length**: ~135 characters

**Example**: `client_AbCdEfGhIjKlMnOpQrStUvWxYz123456789...`

### Client Secret Generation

```typescript
function generateClientSecret(): string {
  // 32 bytes of cryptographically secure random data
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);

  // Convert to base64url
  const base64 = btoa(String.fromCharCode(...array));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
```

**Length**: ~43 characters (32 bytes base64url-encoded)

**Example**: `XyZ123AbC456DeF789GhI012JkL345MnO678PqR901`

### Storage

**KV Namespace**: `CLIENTS`

**Key Format**: `{client_id}`

**Value**: JSON object containing client metadata

**Example Stored Data**:
```json
{
  "client_id": "client_AbCdEfGh...",
  "client_secret": "XyZ123...",
  "client_id_issued_at": 1699876543,
  "client_secret_expires_at": 0,
  "redirect_uris": ["https://myapp.example.com/callback"],
  "token_endpoint_auth_method": "client_secret_basic",
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "application_type": "web",
  "subject_type": "public",
  "created_at": 1699876543,
  "updated_at": 1699876543
}
```

**TTL**: No expiration (clients persist indefinitely)

---

## Security Considerations

### 1. Redirect URI Validation

Authrim enforces strict redirect URI validation:

- ✅ **HTTPS Required**: All redirect URIs must use HTTPS (except `http://localhost` for development)
- ✅ **No Fragments**: Fragment identifiers (`#`) are not allowed in redirect URIs
- ✅ **URL Format**: All URIs must be valid, well-formed URLs
- ✅ **Exact Matching**: During authorization, redirect URIs are matched exactly (no wildcards)

```typescript
// HTTPS validation
if (parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')) {
  return error('invalid_redirect_uri',
    'redirect_uris must use HTTPS (except http://localhost for development)');
}

// Fragment validation
if (parsed.hash) {
  return error('invalid_redirect_uri',
    'redirect_uris must not contain fragment identifiers');
}
```

### 2. Credential Security

- ✅ **Long Client IDs**: ~135 characters to prevent enumeration attacks
- ✅ **Strong Secrets**: 32 bytes of cryptographically secure random data
- ✅ **Base64url Encoding**: URL-safe encoding for credentials
- ✅ **No Secret Expiration**: Client secrets never expire by default (configurable in future)

### 3. Metadata Validation

All client metadata fields are strictly validated:

- ✅ **Type Checking**: Ensures correct data types (string, array, etc.)
- ✅ **Enum Validation**: Validates allowed values for enums (grant_types, response_types, etc.)
- ✅ **URI Validation**: All URI fields are validated as proper URLs
- ✅ **Array Validation**: Ensures arrays contain valid elements

### 4. Pairwise Subject Type

For pairwise subject types:

- ✅ **Sector Identifier Validation**: Required when multiple redirect URIs have different hosts
- ✅ **HTTPS Only**: sector_identifier_uri must use HTTPS
- ✅ **Privacy Protection**: Different `sub` values for same user across clients

---

## Configuration

### Supported Authentication Methods

| Method | Description | Security |
|--------|-------------|----------|
| `client_secret_basic` | HTTP Basic authentication (default) | High |
| `client_secret_post` | Secret in POST body | Medium |
| `none` | No authentication (public client) | Low (use PKCE!) |

### Supported Grant Types

| Grant Type | Description | Use Case |
|------------|-------------|----------|
| `authorization_code` | Standard OAuth flow (default) | Web apps, mobile apps |
| `refresh_token` | Token refresh | Long-lived sessions |
| `implicit` | Direct token issuance | Legacy SPAs (not recommended) |

### Supported Response Types

| Response Type | Description | Use Case |
|---------------|-------------|----------|
| `code` | Authorization code (default) | Standard OAuth flow |
| `id_token` | ID token only | OIDC implicit flow |
| `token` | Access token only | OAuth implicit flow |

### Supported Application Types

| Application Type | Description |
|------------------|-------------|
| `web` | Server-side web applications (default) |
| `native` | Native mobile/desktop applications |

---

## Discovery Metadata

DCR endpoints are advertised in the OpenID Provider metadata:

```json
{
  "registration_endpoint": "https://authrim.sgrastar.workers.dev/register",
  "token_endpoint_auth_methods_supported": [
    "client_secret_basic",
    "client_secret_post",
    "none"
  ],
  "grant_types_supported": [
    "authorization_code",
    "refresh_token",
    "implicit"
  ],
  "response_types_supported": [
    "code",
    "id_token",
    "token"
  ],
  "subject_types_supported": [
    "public",
    "pairwise"
  ]
}
```

---

## Testing

### Test Coverage

Authrim includes comprehensive tests for Dynamic Client Registration:

**Test File**: `test/handlers/register.test.ts`

**Test Scenarios**:
- ✅ Minimal registration (required fields only)
- ✅ Full registration (all optional fields)
- ✅ Client ID generation and format validation
- ✅ Client secret generation and encoding
- ✅ Metadata storage in KV
- ✅ HTTP localhost redirect URI (development)
- ✅ Redirect URI validation (missing, empty, invalid)
- ✅ HTTPS enforcement (except localhost)
- ✅ Fragment identifier rejection
- ✅ Metadata field validation (contacts, URIs, grant_types, etc.)
- ✅ Token endpoint authentication method validation
- ✅ Grant type validation
- ✅ Response type validation
- ✅ Application type validation
- ✅ Subject type validation (public, pairwise)
- ✅ Sector identifier URI validation
- ✅ Pairwise configuration validation
- ✅ Cache-Control headers (no-store, no-cache)

**Total**: 56+ test cases

### Running Tests

```bash
npm test -- register.test.ts
```

---

## Client Libraries

### JavaScript/TypeScript

```typescript
async function registerClient(config: {
  redirectUris: string[];
  clientName?: string;
  grantTypes?: string[];
  scope?: string;
}) {
  const response = await fetch('https://authrim.sgrastar.workers.dev/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      redirect_uris: config.redirectUris,
      client_name: config.clientName,
      grant_types: config.grantTypes || ['authorization_code'],
      scope: config.scope || 'openid profile email',
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Registration failed: ${error.error_description}`);
  }

  const client = await response.json();

  // Store credentials securely
  // DO NOT expose client_secret to frontend!
  return {
    clientId: client.client_id,
    clientSecret: client.client_secret,
  };
}

// Usage
const client = await registerClient({
  redirectUris: ['https://myapp.example.com/callback'],
  clientName: 'My Application',
  scope: 'openid profile email',
});

console.log('Client ID:', client.clientId);
// Store client.clientSecret securely (e.g., environment variable)
```

### Python

```python
import requests
import json

def register_client(
    redirect_uris: list[str],
    client_name: str = None,
    grant_types: list[str] = None,
    scope: str = None
):
    """Register a new OAuth/OIDC client"""

    data = {
        'redirect_uris': redirect_uris,
    }

    if client_name:
        data['client_name'] = client_name
    if grant_types:
        data['grant_types'] = grant_types
    else:
        data['grant_types'] = ['authorization_code']
    if scope:
        data['scope'] = scope
    else:
        data['scope'] = 'openid profile email'

    response = requests.post(
        'https://authrim.sgrastar.workers.dev/register',
        json=data,
        headers={'Content-Type': 'application/json'}
    )

    if response.status_code != 201:
        error = response.json()
        raise Exception(f"Registration failed: {error['error_description']}")

    client = response.json()

    return {
        'client_id': client['client_id'],
        'client_secret': client['client_secret'],
    }

# Usage
client = register_client(
    redirect_uris=['https://myapp.example.com/callback'],
    client_name='My Python App',
    scope='openid profile email'
)

print(f"Client ID: {client['client_id']}")
# Store client['client_secret'] securely (e.g., environment variable)
```

### Node.js (with axios)

```javascript
const axios = require('axios');

async function registerClient({ redirectUris, clientName, grantTypes, scope }) {
  try {
    const response = await axios.post(
      'https://authrim.sgrastar.workers.dev/register',
      {
        redirect_uris: redirectUris,
        client_name: clientName,
        grant_types: grantTypes || ['authorization_code'],
        scope: scope || 'openid profile email',
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    return {
      clientId: response.data.client_id,
      clientSecret: response.data.client_secret,
    };
  } catch (error) {
    if (error.response) {
      throw new Error(`Registration failed: ${error.response.data.error_description}`);
    }
    throw error;
  }
}

// Usage
(async () => {
  const client = await registerClient({
    redirectUris: ['https://myapp.example.com/callback'],
    clientName: 'My Node.js App',
    scope: 'openid profile email',
  });

  console.log('Client ID:', client.clientId);
  // Store client.clientSecret securely
})();
```

---

## Troubleshooting

### Common Issues

#### "redirect_uris is required and must be a non-empty array"

**Cause**: Missing or empty `redirect_uris` field

**Solution**:
```json
{
  "redirect_uris": ["https://myapp.example.com/callback"]
}
```

#### "redirect_uris must use HTTPS"

**Cause**: Using HTTP for redirect URIs (except localhost)

**Solution**:
- Use HTTPS in production: `https://myapp.example.com/callback`
- For development, use localhost: `http://localhost:3000/callback`

#### "redirect_uris must not contain fragment identifiers"

**Cause**: Redirect URI contains a fragment (`#`)

**Solution**:
```
❌ https://myapp.example.com/callback#section
✅ https://myapp.example.com/callback
```

#### "token_endpoint_auth_method must be one of: ..."

**Cause**: Invalid authentication method specified

**Solution**: Use one of the supported methods:
- `client_secret_basic` (recommended for confidential clients)
- `client_secret_post`
- `none` (for public clients with PKCE)

#### "Unsupported grant_type: ..."

**Cause**: Invalid or unsupported grant type

**Solution**: Use only supported grant types:
- `authorization_code`
- `refresh_token`
- `implicit` (not recommended)

#### "sector_identifier_uri is required when using pairwise subject type..."

**Cause**: Using pairwise with multiple redirect URIs from different hosts

**Solution**: Provide a `sector_identifier_uri`:
```json
{
  "redirect_uris": [
    "https://app1.example.com/callback",
    "https://app2.example.com/callback"
  ],
  "subject_type": "pairwise",
  "sector_identifier_uri": "https://example.com/.well-known/sector-uris.json"
}
```

---

## Best Practices

### For Clients

1. **Store Credentials Securely**
   - Never expose client secrets in frontend code
   - Use environment variables or secure key management
   - Rotate credentials regularly

2. **Use HTTPS**
   - Always use HTTPS redirect URIs in production
   - Only use HTTP localhost for local development

3. **Specify Minimal Scopes**
   - Request only the scopes you need
   - Follow principle of least privilege

4. **Use Public Clients Wisely**
   - For public clients (mobile, SPA), use `token_endpoint_auth_method: "none"`
   - Always use PKCE with public clients

5. **Provide Metadata**
   - Include `client_name` for better UX in consent screens
   - Provide `logo_uri` for visual identification
   - Include `tos_uri` and `policy_uri` for transparency

### For Security

1. **Validate Redirect URIs Strictly**
   - Register exact redirect URIs (no wildcards)
   - Use HTTPS for all production URIs
   - Avoid dynamic redirect URIs

2. **Rotate Credentials**
   - Implement client credential rotation policy
   - Monitor for compromised credentials

3. **Monitor Registrations**
   - Log all client registrations for auditing
   - Implement rate limiting on registration endpoint
   - Alert on suspicious registration patterns

4. **Use Pairwise for Privacy**
   - Use pairwise subject type for privacy-sensitive applications
   - Comply with GDPR and other privacy regulations

---

## Future Enhancements

### Planned Features (Phase 5+)

- [ ] **Client Configuration Management**: `GET /register/{client_id}` (RFC 7592)
- [ ] **Client Update**: `PUT /register/{client_id}` (RFC 7592)
- [ ] **Client Deletion**: `DELETE /register/{client_id}` (RFC 7592)
- [ ] **Initial Access Tokens**: Require authentication for registration
- [ ] **Client Secret Rotation**: Automatic credential rotation
- [ ] **Software Statement**: JWT-based client metadata (RFC 7591 Section 2.3)
- [ ] **Rate Limiting**: Prevent registration abuse
- [ ] **Admin Dashboard**: Web UI for client management
- [ ] **Client Analytics**: Usage statistics per client

---

## References

- [OpenID Connect Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)
- [RFC 7591 - OAuth 2.0 Dynamic Client Registration Protocol](https://tools.ietf.org/html/rfc7591)
- [RFC 7592 - OAuth 2.0 Dynamic Client Registration Management Protocol](https://tools.ietf.org/html/rfc7592)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics)

---

**Last Updated**: 2025-11-12
**Status**: ✅ Implemented and Tested
**Tests**: 56+ passing tests
**Implementation**: `src/handlers/register.ts`
**Discovery**: `src/handlers/discovery.ts` (line 10)
