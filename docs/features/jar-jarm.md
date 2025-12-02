# JAR (JWT-Secured Authorization Request) and JARM (JWT-Secured Authorization Response Mode)

This document describes the implementation of JAR and JARM in Authrim.

## Overview

### JAR (JWT-Secured Authorization Request) - RFC 9101

JAR is a specification that enhances security by signing and encrypting Authorization Request parameters as JWT.

### JARM (JWT-Secured Authorization Response Mode)

JARM is a specification that guarantees the integrity and confidentiality of responses by signing and encrypting Authorization Responses as JWT.

## JAR (JWT-Secured Authorization Request)

### Implemented Features

#### 1. `request` Parameter (RFC 9101)

You can include a Request Object in JWT format in the Authorization Request.

```http
GET /authorize?
  client_id=client123&
  response_type=code&
  request=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Supported Signature Algorithms:**
- `RS256` - RSA signature (recommended)
- `none` - No signature (development environment only)

#### 2. `request_uri` Parameter (RFC 9101)

Request Objects can be retrieved via URL.

**For PAR (Pushed Authorization Request):**
```http
GET /authorize?
  client_id=client123&
  request_uri=urn:ietf:params:oauth:request_uri:abc123
```

**For HTTPS URL:**
```http
GET /authorize?
  client_id=client123&
  request_uri=https://client.example.com/request/xyz789
```

#### 3. Request Object JWE Encryption

Request Objects can be encrypted in JWE format (5-part format).

**Supported Encryption Algorithms:**
- **alg (key management):** RSA-OAEP, RSA-OAEP-256, ECDH-ES, ECDH-ES+A128KW, ECDH-ES+A192KW, ECDH-ES+A256KW
- **enc (content encryption):** A128GCM, A192GCM, A256GCM, A128CBC-HS256, A192CBC-HS384, A256CBC-HS512

**Processing Flow:**
1. Detect JWE (5-part format)
2. Decrypt with server's private key
3. Verify internal JWT (if nested)
4. Extract parameters

#### 4. Signature Verification with Client Public Key

Request Object signatures are verified with the public key registered by the client.

**Methods for Obtaining Public Keys:**

1. **`jwks` field at client registration:**
```json
{
  "client_id": "client123",
  "jwks": {
    "keys": [
      {
        "kty": "RSA",
        "use": "sig",
        "kid": "key1",
        "n": "...",
        "e": "AQAB"
      }
    ]
  }
}
```

2. **Dynamic retrieval from `jwks_uri`:**
```json
{
  "client_id": "client123",
  "jwks_uri": "https://client.example.com/.well-known/jwks.json"
}
```

### Request Object Example

**JWT Header:**
```json
{
  "alg": "RS256",
  "typ": "JWT"
}
```

**JWT Payload:**
```json
{
  "iss": "https://op.example.com",
  "aud": "client123",
  "response_type": "code",
  "client_id": "client123",
  "redirect_uri": "https://client.example.com/callback",
  "scope": "openid profile email",
  "state": "abc123",
  "nonce": "xyz789",
  "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  "code_challenge_method": "S256"
}
```

## JARM (JWT-Secured Authorization Response Mode)

### Implemented Features

#### 1. JWT Format Response Mode

**Supported Response Modes:**
- `query.jwt` - Return JWT as URL query parameter
- `fragment.jwt` - Return JWT as URL fragment
- `form_post.jwt` - Return JWT as HTML form POST
- `jwt` - Generic JWT mode (automatically selected based on flow)

**Usage Example:**
```http
GET /authorize?
  response_type=code&
  client_id=client123&
  redirect_uri=https://client.example.com/callback&
  scope=openid&
  response_mode=query.jwt
```

#### 2. Response JWT Signature

Authorization Responses are returned as JWTs signed with the server's private key.

**JWT Payload Example:**
```json
{
  "iss": "https://op.example.com",
  "aud": "client123",
  "exp": 1234567890,
  "iat": 1234567290,
  "code": "abc123...",
  "state": "xyz789"
}
```

**Response Format (for query.jwt):**
```http
HTTP/1.1 302 Found
Location: https://client.example.com/callback?response=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### 3. Response JWT Encryption (Optional)

If the client requests encryption, the signed JWT is further encrypted.

**Client Configuration:**
```json
{
  "client_id": "client123",
  "authorization_signed_response_alg": "RS256",
  "authorization_encrypted_response_alg": "RSA-OAEP",
  "authorization_encrypted_response_enc": "A256GCM"
}
```

**Processing Flow:**
1. Build Authorization Response parameters as JWT payload
2. Sign JWT with server's private key
3. If client requests encryption, encrypt to JWE with client's public key
4. Return as `response` parameter

### JARM Response Verification (Client-Side)

```javascript
// 1. Get response parameter
const params = new URLSearchParams(window.location.search);
const responseJWT = params.get('response');

// 2. Verify JWT
const publicKey = await getOPPublicKey(); // Get OP's public key
const verified = await jose.jwtVerify(responseJWT, publicKey, {
  issuer: 'https://op.example.com',
  audience: 'client123'
});

// 3. Decrypt if encrypted
if (isJWE(responseJWT)) {
  const privateKey = await getClientPrivateKey();
  const decrypted = await jose.compactDecrypt(responseJWT, privateKey);
  // ... decode and verify
}

// 4. Get Authorization Code
const code = verified.payload.code;
const state = verified.payload.state;
```

## Discovery Metadata

JAR/JARM support can be confirmed at the Discovery endpoint.

```http
GET /.well-known/openid-configuration
```

**Response Example:**
```json
{
  "issuer": "https://op.example.com",
  "request_parameter_supported": true,
  "request_uri_parameter_supported": true,
  "request_object_signing_alg_values_supported": ["RS256", "none"],
  "request_object_encryption_alg_values_supported": ["RSA-OAEP", "RSA-OAEP-256", ...],
  "request_object_encryption_enc_values_supported": ["A128GCM", "A256GCM", ...],
  "response_modes_supported": [
    "query",
    "fragment",
    "form_post",
    "query.jwt",
    "fragment.jwt",
    "form_post.jwt",
    "jwt"
  ],
  "authorization_signing_alg_values_supported": ["RS256"],
  "authorization_encryption_alg_values_supported": ["RSA-OAEP", "RSA-OAEP-256", ...],
  "authorization_encryption_enc_values_supported": ["A128GCM", "A256GCM", ...]
}
```

## Security Considerations

### JAR

1. **Signature Verification:** In production environments, always verify Request Object signatures with the client's public key
2. **Encryption Recommended:** Use JWE encryption when including sensitive parameters
3. **request_uri Validation:** When retrieving Request Objects from HTTPS URLs, verify TLS certificates
4. **Replay Attack Prevention:** Recommended to include `exp` (expiration time) in Request Objects

### JARM

1. **Mandatory Signatures:** All Authorization Responses are signed
2. **Encryption Recommended:** Use encryption for sensitive responses (containing access tokens)
3. **JWT Verification:** Clients must verify `iss` (issuer) and `aud` (audience)
4. **Short Expiration:** Response JWTs have a 10-minute expiration (default)

## Error Handling

### JAR Errors

| Error Code | Description |
|------------|-------------|
| `invalid_request_object` | Invalid Request Object format |
| `invalid_request_object` | JWT verification failed |
| `invalid_request_uri` | Failed to retrieve request_uri |
| `server_error` | Server configuration error (private key not configured, etc.) |

### JARM Errors

| Error Code | Description |
|------------|-------------|
| `server_error` | Failed to generate Response JWT |
| `invalid_client` | Failed to retrieve client information |

## Implementation Files

### JAR Related

- `/packages/op-auth/src/authorize.ts` - Request Object processing (lines 281-505)
- `/packages/shared/src/utils/jwt.ts` - JWT utilities
- `/packages/shared/src/utils/jwe.ts` - JWE utilities

### JARM Related

- `/packages/op-auth/src/authorize.ts` - JARM response generation (lines 1610-1641, 1804-1924)
- `/packages/op-discovery/src/discovery.ts` - Discovery metadata (lines 88-106)

### Type Definitions

- `/packages/shared/src/types/oidc.ts` - ClientMetadata, OIDCProviderMetadata

## References

- [RFC 9101: The OAuth 2.0 Authorization Framework: JWT-Secured Authorization Request (JAR)](https://datatracker.ietf.org/doc/html/rfc9101)
- [JARM: JWT-Secured Authorization Response Mode for OAuth 2.0](https://openid.net/specs/oauth-v2-jarm.html)
- [RFC 7516: JSON Web Encryption (JWE)](https://datatracker.ietf.org/doc/html/rfc7516)
- [RFC 7519: JSON Web Token (JWT)](https://datatracker.ietf.org/doc/html/rfc7519)
