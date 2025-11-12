# PAR (Pushed Authorization Requests)

## Overview

**RFC 9126** - OAuth 2.0 Pushed Authorization Requests

Hibana implements Pushed Authorization Requests (PAR), an OAuth 2.0 security extension that allows clients to push authorization request parameters directly to the authorization server before redirecting the user.

## Specification

- **RFC**: [RFC 9126 - OAuth 2.0 Pushed Authorization Requests](https://datatracker.ietf.org/doc/html/rfc9126)
- **Status**: ✅ Implemented
- **Endpoint**: `POST /as/par`

---

## Why Use PAR?

### Security Benefits

1. **🔒 Parameter Tampering Prevention**
   - Authorization parameters are sent via secure backend channel
   - Parameters cannot be modified by user or intermediaries
   - Request integrity is guaranteed

2. **🛡️ Privacy Protection**
   - Sensitive parameters not exposed in browser history
   - No leakage through referrer headers
   - Prevents surveillance of authorization requests

3. **📏 URL Length Limitations**
   - Avoids browser/server URL length limits
   - Enables complex requests with many parameters
   - Supports large request objects (JAR)

4. **✅ Client Authentication**
   - PAR endpoint can require client authentication
   - Prevents unauthorized authorization requests
   - Reduces phishing risks

### Use Cases

- **Financial Services**: FAPI (Financial-grade API) compliance
- **Healthcare**: HIPAA-compliant OAuth flows
- **Enterprise**: Complex authorization with many parameters
- **Mobile Apps**: Secure authorization from native apps

---

## How PAR Works

### Flow Diagram

```
┌──────────┐                                    ┌────────────────┐
│  Client  │                                    │ Authorization  │
│          │                                    │     Server     │
└─────┬────┘                                    └───────┬────────┘
      │                                                 │
      │ 1. POST /as/par                                │
      │    (authorization parameters)                  │
      ├────────────────────────────────────────────────>│
      │                                                 │
      │                                                 │ 2. Store
      │                                                 │    parameters
      │                                                 │    (KV)
      │                                                 │
      │ 3. 201 Created                                 │
      │    {request_uri, expires_in}                   │
      │<────────────────────────────────────────────────┤
      │                                                 │
      │ 4. Redirect user to /authorize                 │
      │    ?request_uri=urn:ietf:...                   │
      │    &client_id=...                              │
      ├────────────────────────────────────────────────>│
      │                                                 │
      │                                                 │ 5. Retrieve
      │                                                 │    parameters
      │                                                 │    from KV
      │                                                 │
      │ 6. Authorization response                      │
      │<────────────────────────────────────────────────┤
      │                                                 │
```

### Step-by-Step Process

1. **Client pushes parameters**: Client sends authorization parameters to PAR endpoint
2. **Server stores parameters**: Server validates and stores parameters in KV storage
3. **Server returns request_uri**: Server responds with a unique `request_uri`
4. **Client redirects user**: Client redirects user to authorization endpoint with `request_uri`
5. **Server retrieves parameters**: Authorization endpoint retrieves parameters using `request_uri`
6. **Normal flow continues**: Authorization proceeds as normal

---

## API Reference

### PAR Endpoint

**POST /as/par**

#### Request Format

**Headers**:
```http
Content-Type: application/x-www-form-urlencoded
Authorization: Basic <base64(client_id:client_secret)>  # Optional
```

**Body Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `client_id` | ✅ Yes | The client identifier |
| `response_type` | ✅ Yes | OAuth response type (e.g., `code`) |
| `redirect_uri` | ✅ Yes | Client's registered redirect URI |
| `scope` | ✅ Yes | Requested scopes (space-separated) |
| `state` | ❌ No | Opaque value for CSRF protection |
| `nonce` | ❌ No | Nonce for ID token binding (OIDC) |
| `code_challenge` | ❌ No | PKCE code challenge |
| `code_challenge_method` | ❌ No | PKCE method (must be `S256`) |
| `response_mode` | ❌ No | Response mode (e.g., `query`, `fragment`, `form_post`) |
| `prompt` | ❌ No | OIDC prompt parameter |
| `display` | ❌ No | OIDC display parameter |
| `max_age` | ❌ No | OIDC max authentication age |
| `ui_locales` | ❌ No | Preferred UI locales |
| `id_token_hint` | ❌ No | ID token hint for re-authentication |
| `login_hint` | ❌ No | Login hint (email, username) |
| `acr_values` | ❌ No | Authentication Context Class References |
| `claims` | ❌ No | OIDC claims parameter (JSON) |

#### Success Response

**Status**: `201 Created`

```json
{
  "request_uri": "urn:ietf:params:oauth:request_uri:6esc_11ACC5bwc014ltc14eY22c",
  "expires_in": 600
}
```

| Field | Type | Description |
|-------|------|-------------|
| `request_uri` | string | Unique URN identifying the stored request |
| `expires_in` | number | Lifetime in seconds (default: 600 = 10 minutes) |

#### Error Responses

**400 Bad Request**:

```json
{
  "error": "invalid_request",
  "error_description": "client_id is required"
}
```

| Error Code | Description |
|------------|-------------|
| `invalid_request` | Missing or invalid required parameters |
| `invalid_client` | Client not found or not authorized |
| `invalid_scope` | Invalid or unauthorized scope |
| `unsupported_response_type` | Response type not supported |

**405 Method Not Allowed**:

```json
{
  "error": "invalid_request",
  "error_description": "PAR endpoint only accepts POST requests"
}
```

---

### Authorization Endpoint with PAR

**GET/POST /authorize**

When using PAR, the authorization endpoint accepts the `request_uri` parameter instead of individual authorization parameters.

#### Request Format

**Query Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `request_uri` | ✅ Yes | The request URI from PAR response |
| `client_id` | ✅ Yes | Must match client_id from PAR request |

#### Example

```http
GET /authorize?request_uri=urn:ietf:params:oauth:request_uri:6esc_11ACC5bwc014ltc14eY22c&client_id=my_client_id HTTP/1.1
Host: hibana.sgrastar.workers.dev
```

#### Validation

1. ✅ `request_uri` must start with `urn:ietf:params:oauth:request_uri:`
2. ✅ `request_uri` must exist in storage and not be expired
3. ✅ `client_id` from query must match `client_id` from PAR request
4. ✅ `request_uri` is single-use (deleted after retrieval)

---

## Usage Examples

### Example 1: Basic PAR Flow

#### Step 1: Push Authorization Request

```bash
curl -X POST https://hibana.sgrastar.workers.dev/as/par \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=my_client_id" \
  -d "response_type=code" \
  -d "redirect_uri=https://myapp.example.com/callback" \
  -d "scope=openid profile email" \
  -d "state=abc123" \
  -d "nonce=xyz789"
```

**Response**:
```json
{
  "request_uri": "urn:ietf:params:oauth:request_uri:6esc_11ACC5bwc014ltc14eY22c",
  "expires_in": 600
}
```

#### Step 2: Redirect User to Authorization Endpoint

```javascript
const authUrl = new URL('https://hibana.sgrastar.workers.dev/authorize');
authUrl.searchParams.set('request_uri', 'urn:ietf:params:oauth:request_uri:6esc_11ACC5bwc014ltc14eY22c');
authUrl.searchParams.set('client_id', 'my_client_id');

window.location.href = authUrl.toString();
```

---

### Example 2: PAR with PKCE

```bash
# Generate PKCE challenge
CODE_VERIFIER=$(openssl rand -base64 96 | tr -d '\n' | tr '/+' '_-' | tr -d '=')
CODE_CHALLENGE=$(echo -n $CODE_VERIFIER | openssl dgst -binary -sha256 | openssl base64 | tr -d '\n' | tr '/+' '_-' | tr -d '=')

# Push authorization request with PKCE
curl -X POST https://hibana.sgrastar.workers.dev/as/par \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=my_public_client" \
  -d "response_type=code" \
  -d "redirect_uri=https://myapp.example.com/callback" \
  -d "scope=openid profile" \
  -d "code_challenge=$CODE_CHALLENGE" \
  -d "code_challenge_method=S256"
```

---

### Example 3: PAR with Client Authentication

```bash
curl -X POST https://hibana.sgrastar.workers.dev/as/par \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "my_client_id:my_client_secret" \
  -d "response_type=code" \
  -d "redirect_uri=https://myapp.example.com/callback" \
  -d "scope=openid profile email"
```

---

### Example 4: PAR with Complex Claims

```bash
CLAIMS='{
  "userinfo": {
    "email": {"essential": true},
    "email_verified": {"essential": true},
    "phone_number": null,
    "address": null
  },
  "id_token": {
    "auth_time": {"essential": true},
    "acr": {"values": ["urn:mace:incommon:iap:silver"]}
  }
}'

curl -X POST https://hibana.sgrastar.workers.dev/as/par \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=my_client_id" \
  -d "response_type=code" \
  -d "redirect_uri=https://myapp.example.com/callback" \
  -d "scope=openid profile email" \
  -d "claims=$(echo $CLAIMS | jq -c .)"
```

---

## Implementation Details

### Request URI Format

- **Scheme**: `urn:ietf:params:oauth:request_uri:`
- **Identifier**: Cryptographically secure random string (~128 characters)
- **Example**: `urn:ietf:params:oauth:request_uri:6esc_11ACC5bwc014ltc14eY22c`

### Storage

**KV Namespace**: `STATE_STORE`

**Key Format**: `request_uri:{request_uri}`

**Value**: JSON object containing all authorization parameters

**Example Stored Data**:
```json
{
  "client_id": "my_client_id",
  "response_type": "code",
  "redirect_uri": "https://myapp.example.com/callback",
  "scope": "openid profile email",
  "state": "abc123",
  "nonce": "xyz789",
  "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  "code_challenge_method": "S256",
  "created_at": 1699876543210
}
```

**TTL**: 600 seconds (10 minutes)

### Single-Use Enforcement

Per RFC 9126, request URIs are **single-use only**:

```typescript
// After retrieval, immediately delete the request_uri
await c.env.STATE_STORE.delete(`request_uri:${request_uri}`);
```

This prevents:
- Replay attacks
- Parameter reuse across multiple authorization requests

---

## Security Considerations

### 1. Client Validation

Hibana validates that:
- Client exists in the client registry
- `redirect_uri` is registered for the client
- `response_type` is supported
- `scope` is valid

### 2. Request URI Security

- ✅ **Random Generation**: Uses cryptographically secure random strings
- ✅ **URN Format**: Follows `urn:ietf:params:oauth:request_uri:` scheme
- ✅ **Short Lifetime**: Default 10 minutes (configurable)
- ✅ **Single-Use**: Deleted immediately after retrieval

### 3. Client ID Matching

When using `request_uri` at the authorization endpoint:

```typescript
// RFC 9126: client_id from query MUST match client_id from PAR
if (client_id && client_id !== parsedData.client_id) {
  return error('invalid_request', 'client_id mismatch');
}
```

### 4. PKCE Support

PAR fully supports PKCE parameters:
- `code_challenge`
- `code_challenge_method`

These are stored and validated during token exchange.

---

## Configuration

### Discovery Metadata

PAR endpoints are advertised in the OpenID Provider metadata:

```json
{
  "pushed_authorization_request_endpoint": "https://hibana.sgrastar.workers.dev/as/par",
  "require_pushed_authorization_requests": false
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PAR_EXPIRY` | `600` | Request URI lifetime in seconds (10 minutes) |

**Note**: Currently hardcoded, will be configurable in future versions.

### Optional PAR Enforcement

Currently, PAR is **optional** (`require_pushed_authorization_requests: false`). Clients can use either:

1. Traditional authorization endpoint with query parameters
2. PAR flow with `request_uri`

**Future Enhancement**: Add configuration option to require PAR for all clients.

---

## Testing

### Test Coverage

Hibana includes comprehensive tests for PAR:

**Test File**: `test/par.test.ts`

**Test Scenarios**:
- ✅ Successful PAR request
- ✅ Request URI generation and format
- ✅ Parameter validation (client_id, redirect_uri, scope)
- ✅ Client authentication (optional)
- ✅ PKCE parameter handling
- ✅ Request URI expiration
- ✅ Single-use enforcement
- ✅ Authorization endpoint integration
- ✅ Error handling

**Total**: 15+ test cases

### Running Tests

```bash
npm test -- par.test.ts
```

---

## Client Libraries

### JavaScript/TypeScript

```typescript
async function authorizeWithPAR(config: {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce: string;
}) {
  // Step 1: Push authorization request
  const parResponse = await fetch('https://hibana.sgrastar.workers.dev/as/par', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: config.redirectUri,
      scope: config.scope,
      state: config.state,
      nonce: config.nonce,
    }),
  });

  const { request_uri } = await parResponse.json();

  // Step 2: Redirect to authorization endpoint
  const authUrl = new URL('https://hibana.sgrastar.workers.dev/authorize');
  authUrl.searchParams.set('request_uri', request_uri);
  authUrl.searchParams.set('client_id', config.clientId);

  window.location.href = authUrl.toString();
}
```

### Python

```python
import requests
from urllib.parse import urlencode

def authorize_with_par(
    client_id: str,
    redirect_uri: str,
    scope: str,
    state: str,
    nonce: str
):
    # Step 1: Push authorization request
    par_response = requests.post(
        'https://hibana.sgrastar.workers.dev/as/par',
        data={
            'client_id': client_id,
            'response_type': 'code',
            'redirect_uri': redirect_uri,
            'scope': scope,
            'state': state,
            'nonce': nonce,
        },
        headers={'Content-Type': 'application/x-www-form-urlencoded'}
    )

    request_uri = par_response.json()['request_uri']

    # Step 2: Build authorization URL
    auth_params = {
        'request_uri': request_uri,
        'client_id': client_id,
    }

    auth_url = f'https://hibana.sgrastar.workers.dev/authorize?{urlencode(auth_params)}'

    return auth_url
```

---

## Comparison: Traditional vs PAR

### Traditional Authorization Request

```
GET /authorize
  ?response_type=code
  &client_id=my_client_id
  &redirect_uri=https://myapp.example.com/callback
  &scope=openid+profile+email
  &state=abc123
  &nonce=xyz789
  &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
  &code_challenge_method=S256
```

**Issues**:
- ❌ Parameters exposed in URL
- ❌ Visible in browser history
- ❌ Limited by URL length
- ❌ Can be tampered with

### PAR Authorization Request

```
POST /as/par
  client_id=my_client_id
  &response_type=code
  &redirect_uri=...
  &scope=...
  (all parameters)

GET /authorize
  ?request_uri=urn:ietf:params:oauth:request_uri:6esc_11ACC5bwc014ltc14eY22c
  &client_id=my_client_id
```

**Benefits**:
- ✅ Parameters sent securely via POST
- ✅ Not visible in browser history
- ✅ No URL length limitations
- ✅ Cannot be tampered with
- ✅ Client authentication possible

---

## Compliance

### FAPI (Financial-grade API)

PAR is **required** for FAPI 2.0 compliance:

- ✅ **FAPI 2.0 Security Profile**: PAR mandatory
- ✅ **FAPI 1.0 Advanced**: PAR recommended

### Other Standards

- ✅ **OpenID Connect**: Compatible with all OIDC flows
- ✅ **OAuth 2.1**: PAR is part of OAuth 2.1 draft
- ✅ **OAuth 2.0 Security Best Current Practice**: Recommended

---

## Troubleshooting

### Common Issues

#### "Invalid or expired request_uri"

**Causes**:
- Request URI has expired (> 10 minutes old)
- Request URI was already used (single-use)
- Request URI format is invalid

**Solution**:
- Generate a new request URI via PAR endpoint
- Ensure prompt user redirection (< 10 minutes)

#### "client_id mismatch"

**Causes**:
- `client_id` in authorization request doesn't match PAR request

**Solution**:
- Use the same `client_id` for both PAR and authorization requests

#### "Client not found"

**Causes**:
- Client is not registered in the system
- `client_id` is incorrect

**Solution**:
- Register client via Dynamic Client Registration endpoint
- Verify `client_id` is correct

---

## Future Enhancements

### Planned Features (Phase 5+)

- [ ] **JAR (JWT-Secured Authorization Request)**: Support signed/encrypted request objects
- [ ] **Request Object Endpoint**: Separate endpoint for fetching request objects
- [ ] **PAR Requirement per Client**: Allow requiring PAR on a per-client basis
- [ ] **Enhanced Logging**: Detailed PAR usage analytics

---

## References

- [RFC 9126 - OAuth 2.0 Pushed Authorization Requests](https://datatracker.ietf.org/doc/html/rfc9126)
- [FAPI 2.0 Security Profile](https://openid.net/specs/fapi-2_0-security-profile.html)
- [OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)

---

**Last Updated**: 2025-11-12
**Status**: ✅ Implemented and Tested
**Tests**: 15+ passing tests
**Implementation**: `src/handlers/par.ts`, `src/handlers/authorize.ts` (lines 74-136)
**Discovery**: `src/handlers/discovery.ts` (line 26)
