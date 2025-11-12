# Token Management

This document describes Hibana's token management capabilities, including refresh token flow, token introspection, and token revocation.

## Overview

Hibana implements comprehensive token management features as defined in:
- **RFC 6749 Section 6**: Refresh Token Grant
- **RFC 7662**: OAuth 2.0 Token Introspection
- **RFC 7009**: OAuth 2.0 Token Revocation

These features provide clients with advanced token lifecycle management capabilities.

---

## Refresh Token Flow

### Specification

- **RFC**: [RFC 6749 Section 6](https://tools.ietf.org/html/rfc6749#section-6)
- **Endpoint**: `POST /token`
- **Grant Type**: `refresh_token`

### Overview

Refresh tokens allow clients to obtain new access tokens without requiring the user to re-authenticate. This improves user experience while maintaining security through token rotation.

### Security Features

#### Refresh Token Rotation

Hibana implements **automatic refresh token rotation** as a security best practice:

1. When a refresh token is used, it is immediately invalidated
2. A new refresh token is issued with the new access token
3. This prevents refresh token replay attacks

#### Scope Downgrading

Clients can request a reduced scope when using a refresh token:

```http
POST /token HTTP/1.1
Host: hibana.sgrastar.workers.dev
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
&client_id=my_client_id
&client_secret=my_client_secret
&scope=openid profile
```

**Note**: The requested scope must be a subset of the original scope. Attempting to request additional scopes will result in an `invalid_scope` error.

### Request Format

**Endpoint**: `POST /token`

**Headers**:
```http
Content-Type: application/x-www-form-urlencoded
Authorization: Basic <base64(client_id:client_secret)>  # Optional, alternative to form params
```

**Body Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `grant_type` | ✅ Yes | Must be `refresh_token` |
| `refresh_token` | ✅ Yes | The refresh token issued during authorization code exchange |
| `client_id` | ✅ Yes | The client identifier (or via Basic auth) |
| `client_secret` | ❌ No | The client secret (if confidential client, or via Basic auth) |
| `scope` | ❌ No | Optional reduced scope (must be subset of original) |

### Response Format

**Success Response** (200 OK):

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "id_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "scope": "openid profile email"
}
```

**Error Responses**:

| Error Code | HTTP Status | Description |
|------------|-------------|-------------|
| `invalid_request` | 400 | Missing or invalid `refresh_token` parameter |
| `invalid_client` | 401 | Invalid or missing client credentials |
| `invalid_grant` | 400 | Refresh token is invalid, expired, or revoked |
| `invalid_scope` | 400 | Requested scope exceeds original scope |
| `server_error` | 500 | Server configuration error |

### Example Usage

#### Using Form Parameters

```bash
curl -X POST https://hibana.sgrastar.workers.dev/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token" \
  -d "refresh_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -d "client_id=my_client_id" \
  -d "client_secret=my_client_secret"
```

#### Using HTTP Basic Authentication

```bash
curl -X POST https://hibana.sgrastar.workers.dev/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "my_client_id:my_client_secret" \
  -d "grant_type=refresh_token" \
  -d "refresh_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### Refresh Token Structure

Refresh tokens are JWTs containing the following claims:

```json
{
  "iss": "https://hibana.sgrastar.workers.dev",
  "sub": "user-abc123",
  "aud": "my_client_id",
  "exp": 1234567890,
  "iat": 1234564290,
  "jti": "rt_unique_identifier",
  "scope": "openid profile email",
  "client_id": "my_client_id"
}
```

### Storage and Expiration

- **Storage**: Refresh tokens are stored in Cloudflare KV with metadata
- **Default Expiration**: 7 days (configurable via `REFRESH_TOKEN_EXPIRY` environment variable)
- **Rotation**: Old refresh tokens are deleted when new ones are issued

---

## Token Introspection

### Specification

- **RFC**: [RFC 7662](https://tools.ietf.org/html/rfc7662)
- **Endpoint**: `POST /introspect`

### Overview

Token introspection allows authorized clients to query the authorization server about the state of an access token or refresh token. This is useful for:

- Resource servers validating access tokens
- Clients checking token validity before use
- Administrative tools auditing token state

### Request Format

**Endpoint**: `POST /introspect`

**Headers**:
```http
Content-Type: application/x-www-form-urlencoded
Authorization: Basic <base64(client_id:client_secret)>  # Optional
```

**Body Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `token` | ✅ Yes | The token to introspect (access or refresh token) |
| `token_type_hint` | ❌ No | Hint about token type: `access_token` or `refresh_token` |
| `client_id` | ✅ Yes | The client identifier (or via Basic auth) |
| `client_secret` | ❌ No | The client secret (if confidential client, or via Basic auth) |

### Response Format

**Active Token** (200 OK):

```json
{
  "active": true,
  "scope": "openid profile email",
  "client_id": "my_client_id",
  "token_type": "Bearer",
  "exp": 1234567890,
  "iat": 1234564290,
  "sub": "user-abc123",
  "aud": "https://hibana.sgrastar.workers.dev",
  "iss": "https://hibana.sgrastar.workers.dev",
  "jti": "at_unique_identifier"
}
```

**Inactive Token** (200 OK):

```json
{
  "active": false
}
```

**Note**: Per RFC 7662, the response for invalid tokens is intentionally minimal to prevent token scanning attacks.

### Token States

A token is considered **inactive** if:

1. ❌ Token signature verification fails
2. ❌ Token has expired (`exp` claim < current time)
3. ❌ Token has been revoked (for access tokens)
4. ❌ Token does not exist in storage (for refresh tokens)
5. ❌ Token format is invalid

### Example Usage

```bash
curl -X POST https://hibana.sgrastar.workers.dev/introspect \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "my_client_id:my_client_secret" \
  -d "token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -d "token_type_hint=access_token"
```

### Security Considerations

- **Client Authentication Required**: Only authenticated clients can introspect tokens
- **No Information Disclosure**: Invalid tokens return minimal response
- **Token Ownership**: Tokens can be introspected regardless of which client they were issued to (this is standard behavior per RFC 7662)

---

## Token Revocation

### Specification

- **RFC**: [RFC 7009](https://tools.ietf.org/html/rfc7009)
- **Endpoint**: `POST /revoke`

### Overview

Token revocation allows clients to notify the authorization server that a token is no longer needed. This is important for:

- **User Logout**: Invalidate tokens when user logs out
- **Security**: Revoke tokens if compromise is suspected
- **Cleanup**: Remove tokens that are no longer needed

### Request Format

**Endpoint**: `POST /revoke`

**Headers**:
```http
Content-Type: application/x-www-form-urlencoded
Authorization: Basic <base64(client_id:client_secret)>  # Optional
```

**Body Parameters**:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `token` | ✅ Yes | The token to revoke (access or refresh token) |
| `token_type_hint` | ❌ No | Hint about token type: `access_token` or `refresh_token` |
| `client_id` | ✅ Yes | The client identifier (or via Basic auth) |
| `client_secret` | ❌ No | The client secret (if confidential client, or via Basic auth) |

### Response Format

**Success** (200 OK):

```http
HTTP/1.1 200 OK
Content-Length: 0
```

**Note**: Per RFC 7009, the server always returns 200 OK, even if the token was invalid or didn't exist. This prevents information disclosure.

### Example Usage

#### Revoke Access Token

```bash
curl -X POST https://hibana.sgrastar.workers.dev/revoke \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "my_client_id:my_client_secret" \
  -d "token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -d "token_type_hint=access_token"
```

#### Revoke Refresh Token

```bash
curl -X POST https://hibana.sgrastar.workers.dev/revoke \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "my_client_id:my_client_secret" \
  -d "token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -d "token_type_hint=refresh_token"
```

### Revocation Behavior

#### Access Tokens

1. Token is added to a revocation list in Cloudflare KV
2. Revocation entry expires when the original token would have expired
3. Subsequent introspection or userinfo requests will fail

#### Refresh Tokens

1. Token is deleted from Cloudflare KV storage
2. Subsequent refresh requests will fail immediately

### Security Considerations

- **Client Ownership Verification**: Clients can only revoke their own tokens
- **Silent Failures**: Invalid tokens or tokens belonging to other clients return 200 OK (prevents information disclosure)
- **Logging**: Unauthorized revocation attempts are logged for security monitoring

---

## Integration with Other Flows

### Authorization Code Reuse Protection

When an authorization code is reused, Hibana automatically revokes all tokens issued with that code:

```typescript
// Per RFC 6749 Section 4.1.2: Authorization codes are single-use
if (authCodeData.used && authCodeData.jti) {
  console.warn(`Authorization code reuse detected!`);

  // Revoke the previously issued access token
  await revokeToken(env, authCodeData.jti, expiresIn);

  return error('invalid_grant', 'Authorization code has already been used');
}
```

This prevents attackers from using stolen authorization codes.

### UserInfo Endpoint Validation

The UserInfo endpoint automatically checks token revocation status:

```typescript
// Check if token has been revoked
const revoked = await isTokenRevoked(env, jti);
if (revoked) {
  return error('invalid_token', 'Token has been revoked');
}
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TOKEN_EXPIRY` | `3600` | Access token lifetime in seconds (1 hour) |
| `REFRESH_TOKEN_EXPIRY` | `604800` | Refresh token lifetime in seconds (7 days) |

### Example Configuration

```toml
# wrangler.toml
[vars]
TOKEN_EXPIRY = "3600"          # 1 hour
REFRESH_TOKEN_EXPIRY = "604800" # 7 days
```

---

## Storage Architecture

### Cloudflare KV Namespaces

Hibana uses Cloudflare KV for token metadata storage:

#### Refresh Tokens
- **Key Format**: `refresh_token:{jti}`
- **Value**: JSON metadata (client_id, sub, scope, iat, exp)
- **TTL**: Automatic expiration based on `REFRESH_TOKEN_EXPIRY`

#### Revoked Access Tokens
- **Key Format**: `revoked_token:{jti}`
- **Value**: Timestamp of revocation
- **TTL**: Automatic expiration based on original token expiry

---

## Testing

### Test Coverage

Hibana includes comprehensive tests for token management:

- **Refresh Token Flow**: 20+ test cases
- **Token Introspection**: 15+ test cases
- **Token Revocation**: 12+ test cases

**Total**: 47+ tests covering all scenarios

### Test File

```bash
test/handlers/token-refresh-introspect-revoke.test.ts
```

### Running Tests

```bash
npm test -- token-refresh-introspect-revoke
```

---

## Best Practices

### For Clients

1. **Store Refresh Tokens Securely**: Use secure storage (e.g., encrypted database, secure keychain)
2. **Revoke on Logout**: Always revoke tokens when user logs out
3. **Handle Rotation**: Update stored refresh token after each use
4. **Error Handling**: Implement proper error handling for `invalid_grant` errors

### For Resource Servers

1. **Introspect Regularly**: Check token status before processing sensitive requests
2. **Cache Introspection Results**: Cache results briefly to reduce load (but respect token expiry)
3. **Handle Revoked Tokens**: Reject requests with revoked tokens

---

## Security Considerations

### Refresh Token Rotation

- ✅ **Implemented**: Automatic refresh token rotation
- ✅ **Benefit**: Prevents refresh token replay attacks
- ✅ **Compliance**: Recommended by OAuth 2.0 Security Best Current Practice

### Token Revocation List

- ✅ **Implemented**: Revoked access tokens stored in KV
- ✅ **Benefit**: Immediate invalidation of compromised tokens
- ✅ **Performance**: Minimal overhead using KV lookups

### Information Disclosure Prevention

- ✅ **Implemented**: Consistent responses for invalid tokens
- ✅ **Benefit**: Prevents token scanning attacks
- ✅ **Compliance**: Per RFC 7009 Section 2.2

---

## Troubleshooting

### Common Issues

#### "invalid_grant: Refresh token is invalid or expired"

**Causes**:
- Refresh token has expired (default: 7 days)
- Refresh token was already used (rotation)
- Refresh token was revoked

**Solution**:
- User must re-authenticate via authorization code flow

#### "invalid_scope: Requested scope exceeds original scope"

**Causes**:
- Attempting to request scopes not granted in original authorization

**Solution**:
- Only request scopes that were originally granted
- For new scopes, initiate a new authorization code flow

#### Token Not Revoked Immediately

**Causes**:
- KV eventual consistency (rare)
- Cached introspection results

**Solution**:
- Wait 1-2 seconds and retry
- Clear any local caches

---

## Future Enhancements

### Planned Features (Phase 4+)

- [ ] **Token Binding**: Bind tokens to specific devices/certificates
- [ ] **DPoP (Demonstrating Proof of Possession)**: RFC 9449 support
- [ ] **Token Exchange**: RFC 8693 for delegation scenarios
- [ ] **Incremental Authorization**: Request additional scopes without re-auth

---

## References

- [RFC 6749 - OAuth 2.0](https://tools.ietf.org/html/rfc6749)
- [RFC 6749 Section 6 - Refresh Token](https://tools.ietf.org/html/rfc6749#section-6)
- [RFC 7662 - Token Introspection](https://tools.ietf.org/html/rfc7662)
- [RFC 7009 - Token Revocation](https://tools.ietf.org/html/rfc7009)
- [OAuth 2.0 Security Best Current Practice](https://tools.ietf.org/html/draft-ietf-oauth-security-topics)

---

**Last Updated**: 2025-11-12
**Status**: ✅ Implemented and Tested
**Tests**: 47+ passing tests
**Implementation**: `src/handlers/token.ts`, `src/handlers/introspect.ts`, `src/handlers/revoke.ts`
