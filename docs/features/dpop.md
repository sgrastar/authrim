# DPoP (Demonstrating Proof of Possession)

## Overview

**RFC 9449** - OAuth 2.0 Demonstrating Proof of Possession (DPoP)

Hibana implements DPoP, a modern OAuth 2.0 security extension that binds access tokens to a specific client's cryptographic key, preventing token theft and replay attacks even if tokens are intercepted.

## Specification

- **RFC**: [RFC 9449 - OAuth 2.0 Demonstrating Proof of Possession (DPoP)](https://datatracker.ietf.org/doc/html/rfc9449)
- **Status**: ✅ Implemented
- **Supported Endpoints**: `/token`, `/userinfo`

---

## Why Use DPoP?

### Security Benefits

1. **🔐 Token Theft Protection**
   - Access tokens are cryptographically bound to client's key pair
   - Stolen tokens cannot be used by attackers (no private key)
   - Eliminates bearer token vulnerabilities
   - Prevents man-in-the-middle attacks

2. **🛡️ Replay Attack Prevention**
   - Each request requires fresh DPoP proof (60-second window)
   - Unique `jti` (JWT ID) enforced per proof
   - Automatic replay detection via nonce tracking
   - Protection against token reuse attacks

3. **🌐 Edge-Native Security**
   - Perfect for distributed edge architectures
   - No shared session state required
   - Stateless verification using JWT
   - Ideal for Cloudflare Workers

4. **🚀 OAuth 2.1 Ready**
   - DPoP is part of OAuth 2.1 draft
   - Future-proof security standard
   - Recommended by OAuth working group
   - Industry-leading security posture

### Use Cases

- **Financial Services**: FAPI (Financial-grade API) compliance
- **Healthcare**: HIPAA-compliant token security
- **High-Security APIs**: Government, banking, enterprise
- **Mobile Apps**: Secure token storage and usage
- **Public Networks**: Protection on untrusted networks
- **Zero Trust Architecture**: Cryptographic proof of possession

---

## How DPoP Works

### Flow Diagram

```
┌──────────┐                                    ┌────────────────┐
│  Client  │                                    │ Authorization  │
│          │                                    │     Server     │
└─────┬────┘                                    └───────┬────────┘
      │                                                 │
      │ 1. Generate Key Pair (once)                    │
      │    Private Key + Public Key (JWK)              │
      │                                                 │
      │ 2. POST /token                                 │
      │    Authorization: Basic client_id:secret       │
      │    DPoP: <dpop_proof_jwt>                      │
      │    (body: grant_type, code, ...)               │
      ├────────────────────────────────────────────────>│
      │                                                 │
      │                                                 │ 3. Validate
      │                                                 │    DPoP Proof
      │                                                 │    (signature,
      │                                                 │     claims)
      │                                                 │
      │                                                 │ 4. Bind Token
      │                                                 │    to JWK
      │                                                 │    (cnf claim)
      │                                                 │
      │ 5. 200 OK                                      │
      │    {                                            │
      │      "access_token": "...",                     │
      │      "token_type": "DPoP",  ← bound!           │
      │      ...                                        │
      │    }                                            │
      │<────────────────────────────────────────────────┤
      │                                                 │
      │ 6. Use access token with DPoP proof            │
      │    GET /userinfo                                │
      │    Authorization: DPoP <access_token>           │
      │    DPoP: <dpop_proof_jwt>                      │
      ├────────────────────────────────────────────────>│
      │                                                 │
      │                                                 │ 7. Validate
      │                                                 │    - DPoP proof
      │                                                 │    - Token cnf
      │                                                 │    - ath claim
      │                                                 │
      │ 8. 200 OK (user info)                          │
      │<────────────────────────────────────────────────┤
      │                                                 │
```

### Step-by-Step Process

1. **Client generates key pair**: Client creates an asymmetric key pair (RSA, EC) and keeps private key secure
2. **Client creates DPoP proof**: Signs JWT with private key, includes public key in `jwk` header
3. **Client sends request with DPoP header**: Includes `DPoP` header with proof JWT
4. **Server validates DPoP proof**: Verifies signature, claims, freshness, and replay protection
5. **Server binds token to key**: Includes `cnf` claim with JWK thumbprint in access token
6. **Client uses DPoP-bound token**: Sends token with fresh DPoP proof for each request
7. **Server validates proof and binding**: Verifies DPoP proof matches token binding

---

## API Reference

### DPoP Proof JWT Structure

#### Header

```json
{
  "typ": "dpop+jwt",
  "alg": "RS256",
  "jwk": {
    "kty": "RSA",
    "n": "...",
    "e": "AQAB"
  }
}
```

**Required Header Fields**:

| Field | Value | Description |
|-------|-------|-------------|
| `typ` | `dpop+jwt` | Type must be exactly `dpop+jwt` |
| `alg` | Algorithm | Signing algorithm (e.g., `RS256`, `ES256`) - MUST NOT be `none` |
| `jwk` | JWK | Public key (MUST NOT include private key material) |

#### Payload (Claims)

```json
{
  "jti": "unique-identifier-123",
  "htm": "POST",
  "htu": "https://hibana.sgrastar.workers.dev/token",
  "iat": 1699876543,
  "ath": "base64url-hash-of-access-token"
}
```

**Required Claims**:

| Claim | Type | Description |
|-------|------|-------------|
| `jti` | string | Unique identifier for this proof (prevents replay attacks) |
| `htm` | string | HTTP method (uppercase): `POST`, `GET`, etc. |
| `htu` | string | HTTP URL of the request (without query/fragment) |
| `iat` | number | Issued at timestamp (must be recent, within 60 seconds) |
| `ath` | string | Access token hash (required when using access token) - base64url(SHA-256(access_token)) |

---

### Token Endpoint with DPoP

**POST /token**

#### Request

**Headers**:
```http
Content-Type: application/x-www-form-urlencoded
Authorization: Basic <base64(client_id:client_secret)>
DPoP: <dpop_proof_jwt>
```

**DPoP Header**: JWT proof signed with client's private key

**Body** (same as standard token request):
```
grant_type=authorization_code
&code=abc123...
&redirect_uri=https://myapp.example.com/callback
&code_verifier=xyz789... (if PKCE)
```

#### Success Response

**Status**: `200 OK`

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "DPoP",
  "expires_in": 3600,
  "id_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "scope": "openid profile email"
}
```

**Key Differences**:
- `token_type` is `DPoP` (instead of `Bearer`)
- Access token includes `cnf` claim with JWK thumbprint

**Access Token Claims (includes)**:
```json
{
  "cnf": {
    "jkt": "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I"
  }
}
```

#### Error Responses

**400 Bad Request**:

```json
{
  "error": "invalid_dpop_proof",
  "error_description": "DPoP proof signature verification failed"
}
```

**Common DPoP Errors**:

| Error Code | Description |
|------------|-------------|
| `invalid_dpop_proof` | DPoP proof validation failed (signature, format, claims) |
| `use_dpop_nonce` | DPoP proof jti already used (replay attack detected) |

---

### UserInfo Endpoint with DPoP

**GET /userinfo**

#### Request

**Headers**:
```http
Authorization: DPoP <access_token>
DPoP: <dpop_proof_jwt>
```

**Note**: Authorization scheme is `DPoP` (not `Bearer`)

#### DPoP Proof Claims (for UserInfo)

```json
{
  "jti": "unique-identifier-456",
  "htm": "GET",
  "htu": "https://hibana.sgrastar.workers.dev/userinfo",
  "iat": 1699876600,
  "ath": "fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo"
}
```

**ath claim**: Must match SHA-256 hash of the access token

#### Success Response

**Status**: `200 OK`

```json
{
  "sub": "user-123",
  "name": "John Doe",
  "email": "john@example.com",
  "email_verified": true
}
```

#### Error Responses

**401 Unauthorized**:

```json
{
  "error": "invalid_token",
  "error_description": "DPoP proof ath claim does not match access token"
}
```

---

## Usage Examples

### Example 1: Full DPoP Flow with Token Request

#### Step 1: Generate Key Pair (Client-Side)

```javascript
// Generate RSA key pair
const keyPair = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify']
);

// Export public key as JWK
const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

// Store private key securely
// (IndexedDB, secure enclave, etc.)
```

#### Step 2: Create DPoP Proof JWT

```javascript
import { SignJWT, exportJWK, calculateJwkThumbprint } from 'jose';

async function createDPoPProof(privateKey, publicKeyJwk, method, url, accessToken) {
  const jti = crypto.randomUUID(); // Unique ID
  const iat = Math.floor(Date.now() / 1000);

  const claims = {
    jti,
    htm: method.toUpperCase(),
    htu: new URL(url).origin + new URL(url).pathname, // No query/fragment
    iat,
  };

  // Add ath claim if access token is present
  if (accessToken) {
    const encoder = new TextEncoder();
    const data = encoder.encode(accessToken);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    claims.ath = base64url(hashBuffer);
  }

  // Sign JWT with private key
  const dpopProof = await new SignJWT(claims)
    .setProtectedHeader({
      typ: 'dpop+jwt',
      alg: 'RS256',
      jwk: publicKeyJwk,
    })
    .sign(privateKey);

  return dpopProof;
}
```

#### Step 3: Request Tokens with DPoP

```javascript
const dpopProof = await createDPoPProof(
  privateKey,
  publicKeyJwk,
  'POST',
  'https://hibana.sgrastar.workers.dev/token'
);

const tokenResponse = await fetch('https://hibana.sgrastar.workers.dev/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': `Basic ${btoa(clientId + ':' + clientSecret)}`,
    'DPoP': dpopProof,
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: 'https://myapp.example.com/callback',
  }),
});

const tokens = await tokenResponse.json();
// tokens.token_type === 'DPoP'
// tokens.access_token is now bound to your key pair
```

#### Step 4: Use Access Token with DPoP

```javascript
const accessToken = tokens.access_token;

// Create fresh DPoP proof for UserInfo request
const dpopProofUserInfo = await createDPoPProof(
  privateKey,
  publicKeyJwk,
  'GET',
  'https://hibana.sgrastar.workers.dev/userinfo',
  accessToken // Include access token for ath claim
);

const userInfoResponse = await fetch('https://hibana.sgrastar.workers.dev/userinfo', {
  method: 'GET',
  headers: {
    'Authorization': `DPoP ${accessToken}`,
    'DPoP': dpopProofUserInfo,
  },
});

const userInfo = await userInfoResponse.json();
```

---

### Example 2: DPoP with Refresh Token

```javascript
const dpopProof = await createDPoPProof(
  privateKey,
  publicKeyJwk,
  'POST',
  'https://hibana.sgrastar.workers.dev/token'
);

const tokenResponse = await fetch('https://hibana.sgrastar.workers.dev/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': `Basic ${btoa(clientId + ':' + clientSecret)}`,
    'DPoP': dpopProof,
  },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }),
});

const tokens = await tokenResponse.json();
// New access token is also DPoP-bound
```

---

## Implementation Details

### DPoP Proof Validation

Hibana validates the following:

1. **JWT Structure**: Must be valid 3-part JWT (header.payload.signature)
2. **Header Validation**:
   - `typ` must be exactly `dpop+jwt`
   - `alg` must be valid signing algorithm (not `none`)
   - `jwk` must be present and valid public key
   - `jwk` must NOT contain private key material (`d`, `p`, `q`, etc.)
3. **Signature Verification**: JWT signature verified using public key from `jwk` header
4. **Claims Validation**:
   - `jti` must be present and unique
   - `htm` must match HTTP method (uppercase)
   - `htu` must match request URL (without query/fragment)
   - `iat` must be present and recent (within 60 seconds)
   - `ath` must match access token hash (when access token is present)
5. **Replay Protection**: `jti` checked against used JTIs in KV store
6. **Freshness**: Proof must be issued within last 60 seconds

### Access Token Binding

DPoP-bound access tokens include a `cnf` (confirmation) claim:

```json
{
  "iss": "https://hibana.sgrastar.workers.dev",
  "sub": "user-123",
  "aud": "https://hibana.sgrastar.workers.dev",
  "exp": 1699880143,
  "iat": 1699876543,
  "scope": "openid profile email",
  "cnf": {
    "jkt": "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I"
  }
}
```

**cnf.jkt**: JWK thumbprint (SHA-256) of the client's public key

### JWK Thumbprint Calculation

```typescript
import { calculateJwkThumbprint } from 'jose';

const jkt = await calculateJwkThumbprint(jwk, 'sha256');
// Example: "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I"
```

### Replay Protection (JTI Storage)

**KV Namespace**: `NONCE_STORE`

**Key Format**: `dpop_jti:{jti}`

**Value**: `"1"` (presence indicates used)

**TTL**: 60 seconds (same as proof freshness window)

This ensures each DPoP proof can only be used once within its validity period.

---

## Security Considerations

### 1. Key Pair Management

**Client Responsibilities**:
- ✅ Generate strong key pairs (RSA 2048+ or EC P-256+)
- ✅ Store private key securely (secure enclave, encrypted storage)
- ✅ Never transmit private key
- ✅ Rotate keys periodically
- ✅ Use separate key pairs per device/instance

**Server Validation**:
- ✅ Rejects JWK with private key material
- ✅ Validates JWK structure and parameters
- ✅ Supports multiple signing algorithms

### 2. DPoP Proof Freshness

- ✅ **60-second window**: Proofs must be issued within last 60 seconds
- ✅ **Clock skew tolerance**: 60 seconds for `iat` validation
- ✅ **Single-use**: Each `jti` can only be used once

### 3. Access Token Hash (ath)

- ✅ **Required for protected resources**: When using access token, `ath` claim is mandatory
- ✅ **SHA-256 hash**: Cryptographic hash of the access token
- ✅ **Prevents token substitution**: Proof is bound to specific access token

### 4. Replay Attack Prevention

- ✅ **JTI tracking**: All used JTIs stored in KV with 60-second TTL
- ✅ **Automatic cleanup**: Expired JTIs automatically removed
- ✅ **Distributed protection**: Works across edge nodes (KV global replication)

### 5. Algorithm Security

**Supported Algorithms** (secure):
- ✅ RS256, RS384, RS512 (RSA)
- ✅ ES256, ES384, ES512 (ECDSA)
- ✅ PS256, PS384, PS512 (RSA-PSS)

**Rejected Algorithms**:
- ❌ `none` (no signature)
- ❌ Symmetric algorithms (HS256, HS384, HS512)

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NONCE_STORE` | Required | KV namespace for JTI replay protection |

### Discovery Metadata

DPoP support is advertised in the OpenID Provider metadata:

```json
{
  "dpop_signing_alg_values_supported": [
    "RS256", "RS384", "RS512",
    "ES256", "ES384", "ES512",
    "PS256", "PS384", "PS512"
  ]
}
```

---

## Testing

### Test Coverage

Hibana includes comprehensive tests for DPoP:

**Test File**: `test/dpop.test.ts`

**Test Scenarios**:
- ✅ Access token hash calculation (SHA-256)
- ✅ Consistent hash for same token
- ✅ Different hashes for different tokens
- ✅ DPoP-bound token detection (`isDPoPBoundToken`)
- ✅ Token extraction from DPoP Authorization header
- ✅ Case-insensitive scheme matching
- ✅ Whitespace handling
- ✅ Invalid format rejection
- ✅ Bearer token distinction

**Total**: 12+ test cases

### Integration Tests

Additional integration tests in:
- `test/handlers/token.test.ts` - DPoP token issuance
- `test/handlers/userinfo.test.ts` - DPoP proof validation with access tokens
- `test/token-introspection.test.ts` - DPoP-bound token introspection

### Running Tests

```bash
npm test -- dpop.test.ts
```

---

## Client Libraries

### JavaScript/TypeScript (with jose)

```typescript
import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { encode as base64url } from 'jose/util/base64url';

class DPoPClient {
  private keyPair: CryptoKeyPair | null = null;
  private publicKeyJwk: any = null;

  async initialize() {
    // Generate key pair
    this.keyPair = await generateKeyPair('RS256');
    this.publicKeyJwk = await exportJWK(this.keyPair.publicKey);
  }

  async createProof(method: string, url: string, accessToken?: string): Promise<string> {
    if (!this.keyPair) throw new Error('Client not initialized');

    const jti = crypto.randomUUID();
    const iat = Math.floor(Date.now() / 1000);

    const parsedUrl = new URL(url);
    const htu = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;

    const claims: any = { jti, htm: method.toUpperCase(), htu, iat };

    if (accessToken) {
      // Calculate ath
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(accessToken));
      claims.ath = base64url(new Uint8Array(hashBuffer));
    }

    return await new SignJWT(claims)
      .setProtectedHeader({
        typ: 'dpop+jwt',
        alg: 'RS256',
        jwk: this.publicKeyJwk,
      })
      .sign(this.keyPair.privateKey);
  }

  async requestToken(authCode: string, clientId: string, clientSecret: string, redirectUri: string) {
    const dpopProof = await this.createProof('POST', 'https://hibana.sgrastar.workers.dev/token');

    const response = await fetch('https://hibana.sgrastar.workers.dev/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${btoa(clientId + ':' + clientSecret)}`,
        'DPoP': dpopProof,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        redirect_uri: redirectUri,
      }),
    });

    return await response.json();
  }

  async getUserInfo(accessToken: string) {
    const dpopProof = await this.createProof(
      'GET',
      'https://hibana.sgrastar.workers.dev/userinfo',
      accessToken
    );

    const response = await fetch('https://hibana.sgrastar.workers.dev/userinfo', {
      headers: {
        'Authorization': `DPoP ${accessToken}`,
        'DPoP': dpopProof,
      },
    });

    return await response.json();
  }
}

// Usage
const client = new DPoPClient();
await client.initialize();

const tokens = await client.requestToken(authCode, clientId, clientSecret, redirectUri);
const userInfo = await client.getUserInfo(tokens.access_token);
```

---

## Comparison: Bearer vs DPoP

### Bearer Token (Traditional)

```http
GET /userinfo HTTP/1.1
Host: hibana.sgrastar.workers.dev
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9...
```

**Issues**:
- ❌ Token can be used by anyone who has it
- ❌ Stolen tokens are fully usable
- ❌ No cryptographic binding
- ❌ Vulnerable to token theft attacks

### DPoP Token (Secure)

```http
GET /userinfo HTTP/1.1
Host: hibana.sgrastar.workers.dev
Authorization: DPoP eyJhbGciOiJSUzI1NiJ9...
DPoP: eyJhbGciOiJSUzI1NiIsInR5cCI6ImRwb3Arand0IiwiandrIjp7Imt0eSI6IlJTQSIsIm4iOiIuLi4iLCJlIjoiQVFBQiJ9fQ.eyJqdGkiOiJ1bmlxdWUtaWQiLCJodG0iOiJHRVQiLCJodHUiOiJodHRwczovL2hpYmFuYS5zZ3Jhc3Rhci53b3JrZXJzLmRldi91c2VyaW5mbyIsImlhdCI6MTY5OTg3NjYwMCwiYXRoIjoiZlVIeU8ycjJaM0RaNTNFc05yV0JiMHhXWG9hTnk1OUlpS0NBcWtzbVFFbyJ9.signature...
```

**Benefits**:
- ✅ Token bound to client's private key
- ✅ Stolen tokens unusable without private key
- ✅ Cryptographic proof of possession
- ✅ Protection against token theft

---

## Troubleshooting

### Common Issues

#### "DPoP proof typ header must be 'dpop+jwt'"

**Cause**: Incorrect JWT type in header

**Solution**:
```javascript
{
  "typ": "dpop+jwt",  // Must be exactly this
  "alg": "RS256",
  "jwk": {...}
}
```

#### "DPoP proof must include jwk header parameter"

**Cause**: Missing or invalid `jwk` in JWT header

**Solution**: Include public key JWK in header:
```javascript
const header = {
  typ: 'dpop+jwt',
  alg: 'RS256',
  jwk: publicKeyJwk  // Must include public key
};
```

#### "JWK must not contain private key material"

**Cause**: Private key parameters (`d`, `p`, `q`, etc.) in JWK

**Solution**: Export only public key:
```javascript
const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
// Remove any private parameters
delete publicKeyJwk.d;
delete publicKeyJwk.p;
delete publicKeyJwk.q;
```

#### "DPoP proof htm claim must match request method"

**Cause**: HTTP method mismatch

**Solution**:
```javascript
htm: 'POST'  // Must match actual request method (uppercase)
```

#### "DPoP proof htu claim must match request URL"

**Cause**: URL mismatch or includes query/fragment

**Solution**:
```javascript
// Correct: protocol + host + pathname only
htu: 'https://hibana.sgrastar.workers.dev/userinfo'

// Incorrect: includes query
htu: 'https://hibana.sgrastar.workers.dev/userinfo?foo=bar'
```

#### "DPoP proof is too old (must be within 60 seconds)"

**Cause**: Proof issued more than 60 seconds ago

**Solution**: Generate fresh proof for each request:
```javascript
iat: Math.floor(Date.now() / 1000)  // Current timestamp
```

#### "DPoP proof ath claim does not match access token"

**Cause**: Access token hash mismatch

**Solution**: Calculate correct ath:
```javascript
const encoder = new TextEncoder();
const data = encoder.encode(accessToken);
const hashBuffer = await crypto.subtle.digest('SHA-256', data);
const ath = base64url(new Uint8Array(hashBuffer));
```

#### "DPoP proof jti has already been used (replay attack detected)"

**Cause**: Reusing same DPoP proof

**Solution**: Generate new unique `jti` for each request:
```javascript
jti: crypto.randomUUID()  // Fresh UUID for each proof
```

---

## Best Practices

### For Clients

1. **Generate Strong Keys**
   - Use RSA 2048+ or EC P-256+
   - Use secure random number generator
   - Store private key in secure enclave/keychain

2. **Fresh Proofs**
   - Generate new proof for each request
   - Never reuse proofs
   - Use current timestamp for `iat`

3. **Unique JTI**
   - Generate cryptographically random `jti`
   - Use UUID v4 or similar
   - Never reuse JTI values

4. **Secure Key Storage**
   - Use Web Crypto API secure key storage
   - Use hardware security modules when available
   - Never log or transmit private keys

5. **Key Rotation**
   - Rotate keys periodically (e.g., every 30-90 days)
   - Support multiple active keys during rotation
   - Revoke old keys properly

### For Security

1. **Use DPoP for High-Value APIs**
   - Financial transactions
   - Healthcare data access
   - Government services
   - Enterprise APIs

2. **Combine with PKCE**
   - Use DPoP + PKCE for maximum security
   - PKCE protects authorization code
   - DPoP protects access token

3. **Monitor for Anomalies**
   - Log DPoP proof validation failures
   - Alert on replay attack attempts
   - Monitor for suspicious patterns

---

## Future Enhancements

### Planned Features (Phase 5+)

- [ ] **DPoP Nonce**: Server-provided nonce for enhanced replay protection
- [ ] **Key Rotation API**: Endpoint for rotating DPoP keys
- [ ] **Multiple Key Support**: Allow clients to register multiple keys
- [ ] **DPoP with mTLS**: Combined DPoP + mutual TLS
- [ ] **Hardware Key Support**: WebAuthn/FIDO2 key integration
- [ ] **Analytics**: DPoP usage statistics and security metrics

---

## References

- [RFC 9449 - OAuth 2.0 Demonstrating Proof of Possession (DPoP)](https://datatracker.ietf.org/doc/html/rfc9449)
- [OAuth 2.1 Draft](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1)
- [FAPI 2.0 Security Profile](https://openid.net/specs/fapi-2_0-security-profile.html)
- [OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics)
- [RFC 9110 - HTTP Semantics](https://datatracker.ietf.org/doc/html/rfc9110)

---

**Last Updated**: 2025-11-12
**Status**: ✅ Implemented and Tested
**Tests**: 12+ passing tests (unit + integration)
**Implementation**: `src/utils/dpop.ts`, `src/handlers/token.ts`, `src/handlers/userinfo.ts`
**Discovery**: `src/handlers/discovery.ts` (dpop_signing_alg_values_supported)
