# Durable Objects Architecture

## Overview

Hibana uses Cloudflare Durable Objects for managing cryptographic keys and enabling zero-downtime key rotation. Durable Objects provide strongly consistent, distributed storage that is ideal for managing critical infrastructure like signing keys.

## KeyManager Durable Object

### Purpose

The `KeyManager` Durable Object is responsible for:
- Storing RSA key pairs for JWT signing
- Managing multiple active keys simultaneously
- Implementing automatic key rotation
- Providing JWKS (JSON Web Key Set) endpoint data
- Ensuring zero-downtime during key rotation

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     KeyManager Durable Object                │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Durable Storage                                       │  │
│  │                                                        │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │  │
│  │  │  Key 1       │  │  Key 2       │  │  Key 3     │  │  │
│  │  │  kid: key-1  │  │  kid: key-2  │  │  kid: key-3│  │  │
│  │  │  active: no  │  │  active: yes │  │  active: no│  │  │
│  │  │  created: T1 │  │  created: T2 │  │  created:T3│  │  │
│  │  └──────────────┘  └──────────────┘  └────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  Configuration:                                               │
│  - rotationIntervalDays: 90                                   │
│  - retentionPeriodDays: 30                                    │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Key Rotation Strategy

#### Rotation Process

1. **New Key Generation**
   - Generate new RSA key pair (2048-bit)
   - Assign unique `kid` (key ID) with timestamp
   - Store public JWK and private PEM in Durable Object

2. **Activation**
   - Mark new key as active signing key
   - Deactivate previous active key (but keep it for verification)
   - Update `activeKeyId` in state

3. **Gradual Transition**
   - New tokens signed with new key
   - Old keys remain available for verification
   - JWKS endpoint returns all non-expired keys

4. **Cleanup**
   - Keep old keys for retention period (default: 30 days)
   - Remove keys older than retention period
   - Ensures smooth transition for token verification

#### Timeline Example

```
Day 0:   Generate Key 1 (active)
         └─ Sign all tokens with Key 1

Day 90:  Generate Key 2 (active), deactivate Key 1
         ├─ Sign new tokens with Key 2
         └─ Key 1 still available for verification

Day 120: Remove Key 1 (30 days after rotation)
         └─ Only Key 2 remains

Day 180: Generate Key 3 (active), deactivate Key 2
         ├─ Sign new tokens with Key 3
         └─ Key 2 still available for verification

Day 210: Remove Key 2
         └─ Only Key 3 remains
```

### API Endpoints

The KeyManager Durable Object exposes the following HTTP endpoints:

#### `GET /active`
Returns the currently active signing key.

**Response:**
```json
{
  "kid": "key-1234567890-abc123",
  "publicJWK": { ... },
  "privatePEM": "-----BEGIN PRIVATE KEY-----\n...",
  "createdAt": 1699999999999,
  "isActive": true
}
```

#### `GET /jwks`
Returns all public keys in JWKS format (for OpenID Connect Discovery).

**Response:**
```json
{
  "keys": [
    {
      "kty": "RSA",
      "use": "sig",
      "alg": "RS256",
      "kid": "key-1234567890-abc123",
      "n": "...",
      "e": "AQAB"
    }
  ]
}
```

#### `POST /rotate`
Triggers manual key rotation.

**Response:**
```json
{
  "success": true,
  "key": {
    "kid": "key-new-id",
    "publicJWK": { ... },
    "createdAt": 1699999999999
  }
}
```

#### `GET /should-rotate`
Checks if automatic key rotation is needed based on rotation interval.

**Response:**
```json
{
  "shouldRotate": true
}
```

#### `GET /config`
Returns current key rotation configuration.

**Response:**
```json
{
  "rotationIntervalDays": 90,
  "retentionPeriodDays": 30
}
```

#### `POST /config`
Updates key rotation configuration.

**Request:**
```json
{
  "rotationIntervalDays": 60,
  "retentionPeriodDays": 45
}
```

### Configuration

#### Default Settings

- **Rotation Interval**: 90 days
- **Retention Period**: 30 days
- **Key Algorithm**: RS256 (RSA with SHA-256)
- **Key Size**: 2048 bits

#### Customization

Configuration can be updated via the `/config` endpoint or by modifying the initial state in the constructor.

### Security Considerations

1. **Private Key Storage**
   - Private keys stored in Durable Object storage (encrypted at rest)
   - Never exposed via public JWKS endpoint
   - Accessed only by token signing operations

2. **Key Rotation**
   - Regular rotation reduces impact of potential key compromise
   - Automated rotation ensures consistency
   - Retention period allows gradual migration

3. **Access Control**
   - KeyManager should only be accessible from internal Workers
   - No public HTTP access to KeyManager endpoints
   - Use Cloudflare Access or Workers authentication

### Usage in Hibana

#### Initialization

```typescript
// In wrangler.toml
[[durable_objects.bindings]]
name = "KEY_MANAGER"
class_name = "KeyManager"
script_name = "hibana"

// In worker code
const keyManagerId = env.KEY_MANAGER.idFromName('default');
const keyManager = env.KEY_MANAGER.get(keyManagerId);
```

#### Getting Active Key

```typescript
const response = await keyManager.fetch(
  new Request('http://internal/active', { method: 'GET' })
);
const activeKey = await response.json();
```

#### Rotating Keys

```typescript
const response = await keyManager.fetch(
  new Request('http://internal/rotate', { method: 'POST' })
);
const result = await response.json();
```

### Future Enhancements

1. **Multiple Key Manager Instances**
   - Support for regional KeyManagers
   - Cross-region key replication

2. **Key Backup and Recovery**
   - Export keys for backup
   - Import keys from backup

3. **Audit Logging**
   - Log all key operations
   - Track key usage and rotation history

4. **Automatic Rotation**
   - Scheduled key rotation via Cron Triggers
   - Notification on rotation completion

## Implementation Timeline

- **Phase 1 (Weeks 1-5)**: Design and documentation ✅
- **Phase 2 (Weeks 6-12)**: Basic implementation without Durable Objects (use environment secrets)
- **Phase 3 (Weeks 19-20)**: Implement KeyManager Durable Object
- **Phase 4 (Weeks 21-22)**: Enable automatic key rotation

## References

- [Cloudflare Durable Objects Documentation](https://developers.cloudflare.com/durable-objects/)
- [OpenID Connect Core Spec - Key Rotation](https://openid.net/specs/openid-connect-core-1_0.html#RotateSigKeys)
- [JWK Specification (RFC 7517)](https://datatracker.ietf.org/doc/html/rfc7517)
