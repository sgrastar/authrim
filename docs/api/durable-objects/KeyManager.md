# KeyManager Durable Object API Reference

**Last Updated**: 2025-11-13
**Status**: ✅ Implemented
**Phase**: Phase 5

---

## Overview

The `KeyManager` Durable Object manages RSA key pairs for JWT signing with support for automatic key rotation. It provides strong consistency guarantees for cryptographic key management and ensures zero-downtime during key rotation.

### Key Features

- **Multi-Key Support**: Maintains multiple active keys simultaneously
- **Automatic Rotation**: Configurable rotation intervals (default: 90 days)
- **Zero-Downtime**: Old keys remain available for verification during transition
- **Secure Storage**: Private keys stored in Durable Object persistent storage
- **JWKS Endpoint**: Public keys exposed in JWKS (JSON Web Key Set) format
- **Authentication**: Bearer token authentication for all operations

---

## Authentication

All API requests require authentication using a Bearer token.

### Headers

```http
Authorization: Bearer YOUR_SECRET_TOKEN
```

The secret token is configured via the `KEY_MANAGER_SECRET` environment variable.

### Unauthorized Response

```json
{
  "error": "Unauthorized",
  "message": "Valid authentication token required"
}
```

**Status Code**: `401 Unauthorized`

---

## API Endpoints

### 1. Get Active Signing Key

Retrieves the currently active key used for signing new JWTs.

**Endpoint**: `GET /active`

**Request**:
```bash
curl -X GET https://your-worker.workers.dev/key-manager/active \
  -H "Authorization: Bearer YOUR_SECRET_TOKEN"
```

**Response** (Success - 200 OK):
```json
{
  "kid": "key-1731847200000-abc123",
  "publicJWK": {
    "kty": "RSA",
    "n": "...",
    "e": "AQAB",
    "use": "sig",
    "alg": "RS256",
    "kid": "key-1731847200000-abc123"
  },
  "createdAt": 1731847200000,
  "isActive": true
}
```

**Response** (No Active Key - 404 Not Found):
```json
{
  "error": "No active key found"
}
```

**Fields**:
- `kid` (string): Unique key identifier
- `publicJWK` (object): Public key in JWK format
- `createdAt` (number): Unix timestamp of key creation
- `isActive` (boolean): Whether this key is active for signing

**Note**: Private key material (`privatePEM`) is never exposed via HTTP.

---

### 2. Get All Public Keys (JWKS)

Retrieves all public keys in JWKS (JSON Web Key Set) format for JWT verification.

**Endpoint**: `GET /jwks`

**Request**:
```bash
curl -X GET https://your-worker.workers.dev/key-manager/jwks \
  -H "Authorization: Bearer YOUR_SECRET_TOKEN"
```

**Response** (Success - 200 OK):
```json
{
  "keys": [
    {
      "kty": "RSA",
      "n": "...",
      "e": "AQAB",
      "use": "sig",
      "alg": "RS256",
      "kid": "key-1731847200000-abc123"
    },
    {
      "kty": "RSA",
      "n": "...",
      "e": "AQAB",
      "use": "sig",
      "alg": "RS256",
      "kid": "key-1731760800000-def456"
    }
  ]
}
```

**Use Case**: This endpoint provides data for the OpenID Connect JWKS endpoint (`/.well-known/jwks.json`).

---

### 3. Trigger Key Rotation

Manually triggers a key rotation. A new key is generated, activated, and old keys are cleaned up based on the retention period.

**Endpoint**: `POST /rotate`

**Request**:
```bash
curl -X POST https://your-worker.workers.dev/key-manager/rotate \
  -H "Authorization: Bearer YOUR_SECRET_TOKEN"
```

**Response** (Success - 200 OK):
```json
{
  "success": true,
  "key": {
    "kid": "key-1731933600000-xyz789",
    "publicJWK": {
      "kty": "RSA",
      "n": "...",
      "e": "AQAB",
      "use": "sig",
      "alg": "RS256",
      "kid": "key-1731933600000-xyz789"
    },
    "createdAt": 1731933600000,
    "isActive": true
  }
}
```

**Rotation Process**:
1. Generate new 2048-bit RSA key pair
2. Assign unique `kid` with timestamp
3. Store key in Durable Object storage
4. Activate new key (deactivate previous active key)
5. Update last rotation timestamp
6. Clean up expired keys (older than retention period)

---

### 4. Check If Rotation Is Needed

Checks whether key rotation should be performed based on the configured rotation interval.

**Endpoint**: `GET /should-rotate`

**Request**:
```bash
curl -X GET https://your-worker.workers.dev/key-manager/should-rotate \
  -H "Authorization: Bearer YOUR_SECRET_TOKEN"
```

**Response** (Success - 200 OK):
```json
{
  "shouldRotate": true
}
```

**Fields**:
- `shouldRotate` (boolean): `true` if rotation is needed, `false` otherwise

**Rotation Logic**:
- Returns `true` if no keys have been generated yet
- Returns `true` if time since last rotation exceeds `rotationIntervalDays`
- Otherwise returns `false`

---

### 5. Get Configuration

Retrieves the current key rotation configuration.

**Endpoint**: `GET /config`

**Request**:
```bash
curl -X GET https://your-worker.workers.dev/key-manager/config \
  -H "Authorization: Bearer YOUR_SECRET_TOKEN"
```

**Response** (Success - 200 OK):
```json
{
  "rotationIntervalDays": 90,
  "retentionPeriodDays": 30
}
```

**Fields**:
- `rotationIntervalDays` (number): Days between automatic key rotations (default: 90)
- `retentionPeriodDays` (number): Days to keep old keys after rotation (default: 30)

---

### 6. Update Configuration

Updates the key rotation configuration.

**Endpoint**: `POST /config`

**Request**:
```bash
curl -X POST https://your-worker.workers.dev/key-manager/config \
  -H "Authorization: Bearer YOUR_SECRET_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "rotationIntervalDays": 60,
    "retentionPeriodDays": 14
  }'
```

**Request Body**:
```json
{
  "rotationIntervalDays": 60,
  "retentionPeriodDays": 14
}
```

**Response** (Success - 200 OK):
```json
{
  "success": true
}
```

**Validation**:
- Both fields are optional (partial updates supported)
- `rotationIntervalDays` must be a positive number
- `retentionPeriodDays` must be a positive number

---

## Error Responses

### 401 Unauthorized

```json
{
  "error": "Unauthorized",
  "message": "Valid authentication token required"
}
```

**Cause**: Missing or invalid `Authorization` header.

---

### 404 Not Found

```json
{
  "error": "No active key found"
}
```

**Cause**: No active signing key exists (e.g., KeyManager not initialized).

---

### 500 Internal Server Error

```json
{
  "error": "Internal Server Error"
}
```

**Cause**: Unexpected error during key operation.

---

## Usage Examples

### TypeScript Example

```typescript
// Get active signing key
const keyManagerId = env.KEY_MANAGER.idFromName('default');
const keyManagerStub = env.KEY_MANAGER.get(keyManagerId);

const response = await keyManagerStub.fetch('http://internal/active', {
  headers: {
    Authorization: `Bearer ${env.KEY_MANAGER_SECRET}`,
  },
});

const { kid, publicJWK, privatePEM } = await response.json();
```

### Automated Key Rotation

```typescript
// Check if rotation is needed
const shouldRotateResponse = await keyManagerStub.fetch('http://internal/should-rotate', {
  headers: {
    Authorization: `Bearer ${env.KEY_MANAGER_SECRET}`,
  },
});

const { shouldRotate } = await shouldRotateResponse.json();

if (shouldRotate) {
  // Trigger rotation
  const rotateResponse = await keyManagerStub.fetch('http://internal/rotate', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.KEY_MANAGER_SECRET}`,
    },
  });

  const { success, key } = await rotateResponse.json();
  console.log('Key rotated:', key.kid);
}
```

### Update Rotation Configuration

```typescript
// Update configuration for more frequent rotation
const configResponse = await keyManagerStub.fetch('http://internal/config', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${env.KEY_MANAGER_SECRET}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    rotationIntervalDays: 30, // Rotate every 30 days
    retentionPeriodDays: 14,  // Keep old keys for 14 days
  }),
});

const { success } = await configResponse.json();
```

---

## Key Rotation Strategy

### Zero-Downtime Rotation

1. **New Key Generation**: Generate new RSA key pair with unique `kid`
2. **Activation**: Mark new key as active for signing
3. **Gradual Transition**: New tokens signed with new key
4. **Verification**: Old keys remain available for verification
5. **Cleanup**: Remove expired keys after retention period

### Key Lifecycle

```
[Generate] → [Active Signing] → [Verification Only] → [Expired & Removed]
               (90 days)             (30 days)
```

### Example Timeline

- **Day 0**: Key A generated and activated
- **Day 90**: Key B generated, Key A deactivated (but kept for verification)
- **Day 120**: Key A removed from key set (expired)
- **Day 180**: Key C generated, Key B deactivated

---

## Security Considerations

### Private Key Protection

- Private keys (`privatePEM`) are **never exposed** via HTTP responses
- Keys are stored in Durable Object persistent storage (encrypted at rest)
- Only public keys are exposed via JWKS endpoint

### Authentication

- All API requests require Bearer token authentication
- Token is configured via `KEY_MANAGER_SECRET` environment variable
- Use constant-time comparison to prevent timing attacks

### Best Practices

1. **Rotate Secrets**: Regularly rotate `KEY_MANAGER_SECRET`
2. **Monitor Rotation**: Check `/should-rotate` periodically
3. **Test JWKS**: Verify JWKS endpoint contains all active keys
4. **Backup Keys**: Consider backing up active keys before rotation
5. **Audit Logs**: Log all key rotation events for security audits

---

## Wrangler Configuration

```toml
# packages/shared/wrangler.toml
[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"

[vars]
KEY_MANAGER_SECRET = "your-secret-token-here"
```

---

## Related Documentation

- [Durable Objects Architecture](../../architecture/durable-objects.md)
- [SessionStore API](./SessionStore.md)
- [AuthorizationCodeStore API](./AuthorizationCodeStore.md)
- [RefreshTokenRotator API](./RefreshTokenRotator.md)
- [OpenID Connect JWKS Endpoint](../endpoints/jwks.md)

---

## Implementation Notes

### Lessons Learned

1. **Key ID Generation**: Using timestamp + UUID ensures uniqueness across DO instances
2. **Retention Period**: 30-day retention allows graceful token expiration
3. **Configuration Flexibility**: Separate rotation and retention periods for fine-tuning
4. **Error Handling**: Clear error messages for missing keys or configuration

### Future Enhancements

- [ ] Support for multiple key algorithms (ES256, RS512)
- [ ] Key versioning and rollback
- [ ] Automatic rotation scheduling (cron-based)
- [ ] Key export/import for disaster recovery
- [ ] Audit log for all key operations

---

**Generated**: 2025-11-13
**Version**: 1.0.0
