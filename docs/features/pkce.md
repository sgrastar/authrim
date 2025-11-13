# PKCE (Proof Key for Code Exchange)

## Overview

**RFC 7636** - Proof Key for Code Exchange by OAuth Public Clients

Hibana implements PKCE, a critical security extension that protects authorization codes from interception attacks, especially for public clients (mobile apps, SPAs) that cannot securely store client secrets.

## Specification

- **RFC**: [RFC 7636 - Proof Key for Code Exchange by OAuth Public Clients](https://tools.ietf.org/html/rfc7636)
- **Status**: ✅ Implemented
- **Method**: `S256` (SHA-256) - **Recommended and enforced**
- **Supported Flows**: Authorization Code Flow

---

## Why Use PKCE?

### Security Benefits

1. **🔐 Authorization Code Interception Protection**
   - Prevents authorization code theft by malicious apps
   - Protects against code injection attacks
   - Mitigates authorization code interception on mobile
   - Essential for public clients (no client secret)

2. **📱 Mobile App Security**
   - Protects against malicious apps with same custom URI scheme
   - Prevents authorization code stealing on the device
   - Works with app-to-app redirects
   - Compatible with OAuth 2.1 requirements

3. **🌐 Single Page Application (SPA) Security**
   - Eliminates need for client secret in browser
   - Protects against XSS attacks stealing codes
   - Recommended by OAuth 2.0 Security Best Current Practice
   - Part of OAuth 2.1 mandatory requirements

4. **✅ OAuth 2.1 Compliance**
   - PKCE is **mandatory** in OAuth 2.1
   - Recommended for **all** clients (including confidential)
   - Industry best practice
   - Future-proof security

### Use Cases

- **Mobile Apps**: iOS, Android native apps
- **Single Page Applications**: React, Vue, Angular apps
- **Desktop Applications**: Electron, native desktop apps
- **CLI Tools**: Command-line OAuth clients
- **IoT Devices**: Smart home, embedded systems
- **Public Clients**: Any client that cannot store secrets securely

---

## How PKCE Works

### Flow Diagram

```
┌──────────┐                                    ┌────────────────┐
│  Client  │                                    │ Authorization  │
│          │                                    │     Server     │
└─────┬────┘                                    └───────┬────────┘
      │                                                 │
      │ 1. Generate code_verifier (random string)      │
      │    code_verifier = "dBjftJe...z1LTQ" (43-128)  │
      │                                                 │
      │ 2. Calculate code_challenge                    │
      │    code_challenge = BASE64URL(SHA256(verifier))│
      │                   = "E9Melhoa2Owv...cM"         │
      │                                                 │
      │ 3. Authorization Request                       │
      │    /authorize?...                              │
      │    &code_challenge=E9Melhoa2Owv...cM           │
      │    &code_challenge_method=S256                 │
      ├────────────────────────────────────────────────>│
      │                                                 │
      │                                                 │ 4. Store
      │                                                 │    challenge
      │                                                 │    with code
      │                                                 │
      │ 5. Authorization Code                          │
      │    ?code=abc123&state=xyz                      │
      │<────────────────────────────────────────────────┤
      │                                                 │
      │ 6. Token Request                                │
      │    POST /token                                  │
      │    code=abc123                                  │
      │    &code_verifier=dBjftJe...z1LTQ              │
      ├────────────────────────────────────────────────>│
      │                                                 │
      │                                                 │ 7. Verify
      │                                                 │    SHA256(
      │                                                 │      verifier
      │                                                 │    ) ==
      │                                                 │    challenge
      │                                                 │
      │ 8. Tokens                                      │
      │    {access_token, id_token, ...}               │
      │<────────────────────────────────────────────────┤
      │                                                 │
```

### PKCE Algorithm

**Step 1: Generate code_verifier**
```
code_verifier = cryptographically_random_string(43-128 characters)
                using [A-Z] [a-z] [0-9] - . _ ~ (unreserved characters)
```

**Step 2: Calculate code_challenge**
```
code_challenge = BASE64URL(SHA-256(ASCII(code_verifier)))
```

**Step 3: Verify at Token Endpoint**
```
If SHA-256(code_verifier) == code_challenge:
  ✅ Issue tokens
Else:
  ❌ Reject request (invalid_grant)
```

---

## API Reference

### Authorization Endpoint with PKCE

**GET/POST /authorize**

#### Request Parameters

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `code_challenge` | ✅ Yes* | string | Base64url-encoded SHA-256 hash of code_verifier |
| `code_challenge_method` | ✅ Yes* | string | Must be `S256` (SHA-256) |
| `response_type` | ✅ Yes | string | Must be `code` |
| `client_id` | ✅ Yes | string | Client identifier |
| `redirect_uri` | ✅ Yes | string | Callback URI |
| `scope` | ✅ Yes | string | Requested scopes |
| `state` | ❌ Recommended | string | CSRF protection |

\* Highly recommended for public clients, supported for all clients

#### Example Request

```http
GET /authorize
  ?response_type=code
  &client_id=my_client_id
  &redirect_uri=https://myapp.example.com/callback
  &scope=openid+profile+email
  &state=abc123
  &code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
  &code_challenge_method=S256
Host: hibana.sgrastar.workers.dev
```

---

### Token Endpoint with PKCE

**POST /token**

#### Request Parameters

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `grant_type` | ✅ Yes | string | Must be `authorization_code` |
| `code` | ✅ Yes | string | Authorization code from /authorize |
| `redirect_uri` | ✅ Yes | string | Same redirect_uri from /authorize |
| `client_id` | ✅ Yes | string | Client identifier |
| `code_verifier` | ✅ Yes* | string | Original random string (43-128 chars) |

\* Required if code_challenge was provided in authorization request

#### Example Request

```http
POST /token HTTP/1.1
Host: hibana.sgrastar.workers.dev
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=abc123...
&redirect_uri=https://myapp.example.com/callback
&client_id=my_client_id
&code_verifier=dBjftJe...z1LTQ
```

#### Success Response

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "id_token": "eyJhbGciOiJSUzI1NiJ9...",
  "refresh_token": "eyJhbGciOiJSUzI1NiJ9...",
  "scope": "openid profile email"
}
```

#### Error Responses

**400 Bad Request**:

```json
{
  "error": "invalid_request",
  "error_description": "code_verifier is required when code_challenge was provided"
}
```

**401 Unauthorized**:

```json
{
  "error": "invalid_grant",
  "error_description": "code_verifier does not match code_challenge"
}
```

---

## Usage Examples

### Example 1: JavaScript/TypeScript (Browser)

```typescript
// Step 1: Generate code_verifier
function generateCodeVerifier(): string {
  const array = new Uint8Array(32); // 32 bytes → 43 chars in base64url
  crypto.getRandomValues(array);
  return base64urlEncode(array);
}

function base64urlEncode(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// Step 2: Calculate code_challenge
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return base64urlEncode(new Uint8Array(hashBuffer));
}

// Step 3: Start authorization flow
async function startAuthorization() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Store code_verifier for later use
  sessionStorage.setItem('code_verifier', codeVerifier);

  // Build authorization URL
  const authUrl = new URL('https://hibana.sgrastar.workers.dev/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', 'my_client_id');
  authUrl.searchParams.set('redirect_uri', 'https://myapp.example.com/callback');
  authUrl.searchParams.set('scope', 'openid profile email');
  authUrl.searchParams.set('state', generateRandomState());
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  window.location.href = authUrl.toString();
}

// Step 4: Handle callback and exchange code for tokens
async function handleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');

  // Validate state (CSRF protection)
  // ...

  // Retrieve code_verifier
  const codeVerifier = sessionStorage.getItem('code_verifier');
  if (!codeVerifier) {
    throw new Error('code_verifier not found');
  }

  // Exchange code for tokens
  const response = await fetch('https://hibana.sgrastar.workers.dev/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: 'https://myapp.example.com/callback',
      client_id: 'my_client_id',
      code_verifier: codeVerifier,
    }),
  });

  const tokens = await response.json();
  // tokens.access_token, tokens.id_token, etc.
}
```

---

### Example 2: React App (Full Flow)

```typescript
import { useState, useEffect } from 'react';

function AuthComponent() {
  const [tokens, setTokens] = useState(null);

  useEffect(() => {
    // Check if returning from authorization
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');

    if (code) {
      handleAuthCallback(code);
    }
  }, []);

  async function login() {
    // Generate PKCE parameters
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Store verifier
    sessionStorage.setItem('code_verifier', codeVerifier);

    // Redirect to authorization endpoint
    const authUrl = new URL('https://hibana.sgrastar.workers.dev/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', process.env.REACT_APP_CLIENT_ID!);
    authUrl.searchParams.set('redirect_uri', window.location.origin + '/callback');
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', crypto.randomUUID());
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    window.location.href = authUrl.toString();
  }

  async function handleAuthCallback(code: string) {
    const codeVerifier = sessionStorage.getItem('code_verifier');
    if (!codeVerifier) {
      console.error('No code_verifier found');
      return;
    }

    try {
      const response = await fetch('https://hibana.sgrastar.workers.dev/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: window.location.origin + '/callback',
          client_id: process.env.REACT_APP_CLIENT_ID!,
          code_verifier: codeVerifier,
        }),
      });

      const tokens = await response.json();
      setTokens(tokens);

      // Clean up
      sessionStorage.removeItem('code_verifier');
      window.history.replaceState({}, document.title, window.location.pathname);
    } catch (error) {
      console.error('Token exchange failed:', error);
    }
  }

  return (
    <div>
      {tokens ? (
        <div>Logged in! Access token: {tokens.access_token}</div>
      ) : (
        <button onClick={login}>Login with PKCE</button>
      )}
    </div>
  );
}
```

---

### Example 3: Mobile App (React Native)

```typescript
import * as Crypto from 'expo-crypto';
import * as AuthSession from 'expo-auth-session';

const discovery = {
  authorizationEndpoint: 'https://hibana.sgrastar.workers.dev/authorize',
  tokenEndpoint: 'https://hibana.sgrastar.workers.dev/token',
};

export function useAuth() {
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: 'my_mobile_app_client_id',
      scopes: ['openid', 'profile', 'email'],
      redirectUri: AuthSession.makeRedirectUri({
        scheme: 'myapp',
      }),
      usePKCE: true, // Enable PKCE
      codeChallenge: await AuthSession.generateCodeChallengeAsync(
        AuthSession.CodeChallengeMethod.S256
      ),
    },
    discovery
  );

  useEffect(() => {
    if (response?.type === 'success') {
      const { code } = response.params;

      // Exchange code for tokens (PKCE handled automatically)
      exchangeCodeForTokens(code);
    }
  }, [response]);

  async function exchangeCodeForTokens(code: string) {
    const tokenResponse = await AuthSession.exchangeCodeAsync(
      {
        clientId: 'my_mobile_app_client_id',
        code,
        redirectUri: AuthSession.makeRedirectUri({
          scheme: 'myapp',
        }),
        extraParams: {
          code_verifier: request?.codeVerifier!, // PKCE verifier
        },
      },
      discovery
    );

    const { accessToken, idToken } = tokenResponse;
    // Store tokens securely
  }

  return { login: () => promptAsync() };
}
```

---

### Example 4: CLI Tool (Python)

```python
import hashlib
import base64
import secrets
from urllib.parse import urlencode
import webbrowser
import requests

def generate_code_verifier():
    """Generate cryptographically secure code_verifier"""
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode('utf-8').rstrip('=')

def generate_code_challenge(verifier):
    """Calculate code_challenge from verifier"""
    digest = hashlib.sha256(verifier.encode('utf-8')).digest()
    return base64.urlsafe_b64encode(digest).decode('utf-8').rstrip('=')

def start_oauth_flow():
    # Generate PKCE parameters
    code_verifier = generate_code_verifier()
    code_challenge = generate_code_challenge(code_verifier)
    state = secrets.token_urlsafe(32)

    # Build authorization URL
    auth_params = {
        'response_type': 'code',
        'client_id': 'my_cli_client_id',
        'redirect_uri': 'http://localhost:8080/callback',
        'scope': 'openid profile email',
        'state': state,
        'code_challenge': code_challenge,
        'code_challenge_method': 'S256',
    }

    auth_url = f'https://hibana.sgrastar.workers.dev/authorize?{urlencode(auth_params)}'

    print(f'Opening browser for authorization...')
    webbrowser.open(auth_url)

    # Start local callback server to receive authorization code
    # (implementation omitted for brevity)
    code = wait_for_callback()

    # Exchange code for tokens
    token_response = requests.post(
        'https://hibana.sgrastar.workers.dev/token',
        data={
            'grant_type': 'authorization_code',
            'code': code,
            'redirect_uri': 'http://localhost:8080/callback',
            'client_id': 'my_cli_client_id',
            'code_verifier': code_verifier,
        },
        headers={'Content-Type': 'application/x-www-form-urlencoded'}
    )

    tokens = token_response.json()
    return tokens
```

---

## Implementation Details

### code_verifier Requirements

- **Length**: 43-128 characters
- **Characters**: `[A-Z]`, `[a-z]`, `[0-9]`, `-`, `.`, `_`, `~` (unreserved characters per RFC 3986)
- **Entropy**: Minimum 256 bits of entropy (recommended)
- **Generation**: Use cryptographically secure random number generator

### code_challenge Calculation

```typescript
// SHA-256 hash of code_verifier
const encoder = new TextEncoder();
const data = encoder.encode(codeVerifier);
const hashBuffer = await crypto.subtle.digest('SHA-256', data);

// Base64url encoding (no padding)
const hashArray = new Uint8Array(hashBuffer);
const base64 = btoa(String.fromCharCode(...hashArray));
const codeChallenge = base64
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=/g, '');
```

### Storage

**Authorization Code Storage** (KV):
```json
{
  "client_id": "my_client_id",
  "redirect_uri": "https://myapp.example.com/callback",
  "scope": "openid profile email",
  "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  "code_challenge_method": "S256",
  "used": false,
  "created_at": 1699876543
}
```

### Verification at Token Endpoint

```typescript
// 1. Retrieve authorization code data
const authCodeData = await getAuthCode(code);

// 2. If code_challenge present, code_verifier is required
if (authCodeData.code_challenge && !code_verifier) {
  return error('invalid_request', 'code_verifier is required');
}

// 3. Verify code_challenge matches code_verifier
if (authCodeData.code_challenge) {
  const calculatedChallenge = await calculateCodeChallenge(code_verifier);

  if (calculatedChallenge !== authCodeData.code_challenge) {
    return error('invalid_grant', 'code_verifier does not match code_challenge');
  }
}

// 4. Issue tokens
// ...
```

---

## Security Considerations

### 1. code_verifier Security

**Best Practices**:
- ✅ Use cryptographically secure random number generator
- ✅ Minimum 32 bytes (256 bits) of entropy
- ✅ Store securely (sessionStorage, secure enclave)
- ✅ Never log or expose code_verifier
- ✅ Delete after use

### 2. Challenge Method

**Hibana Supports**:
- ✅ **S256** (SHA-256) - **Recommended and default**
- ❌ `plain` - **Not supported** (insecure, deprecated)

**Why S256 Only**:
- SHA-256 is cryptographically secure
- `plain` method provides no security benefit
- OAuth 2.1 mandates S256 only
- Prevents downgrade attacks

### 3. Public Clients

**PKCE is Mandatory for**:
- Mobile apps (iOS, Android, React Native, Flutter)
- Single Page Applications (SPAs)
- Desktop applications
- CLI tools
- Any client that cannot securely store client_secret

### 4. Confidential Clients

**PKCE is Recommended for ALL clients**:
- Provides defense-in-depth
- Protects against code injection attacks
- OAuth 2.1 compliance
- No downside to using PKCE

---

## Configuration

### Discovery Metadata

PKCE support is advertised in OpenID Provider metadata:

```json
{
  "code_challenge_methods_supported": ["S256"]
}
```

---

## Testing

### Test Coverage

Hibana includes comprehensive tests for PKCE:

**Test Files**:
- `test/handlers/authorize.test.ts` - PKCE parameter validation
- `test/handlers/token.test.ts` - PKCE verification
- `test/integration/pkce.test.ts` - End-to-end PKCE flow

**Test Scenarios**:
- ✅ Authorization with code_challenge
- ✅ Token exchange with code_verifier
- ✅ Code challenge method validation (S256 only)
- ✅ Code verifier format validation
- ✅ Challenge/verifier matching
- ✅ Missing verifier rejection
- ✅ Invalid verifier rejection
- ✅ Mismatched challenge/verifier rejection

**Total**: 15+ test cases

### Running Tests

```bash
npm test -- authorize.test.ts
npm test -- token.test.ts
```

---

## Troubleshooting

### Common Issues

#### "code_verifier is required when code_challenge was provided"

**Cause**: Authorization request included `code_challenge`, but token request missing `code_verifier`

**Solution**: Always provide `code_verifier` in token request when PKCE was used

#### "code_verifier does not match code_challenge"

**Cause**: Incorrect `code_verifier` or challenge calculation error

**Solution**:
- Ensure correct verifier is stored and retrieved
- Verify SHA-256 hash calculation
- Check base64url encoding (no padding)

#### "code_challenge_method must be S256"

**Cause**: Using unsupported challenge method (e.g., `plain`)

**Solution**: Always use `code_challenge_method=S256`

#### "Invalid code_verifier format"

**Cause**: code_verifier doesn't meet RFC 7636 requirements

**Solution**:
- Length: 43-128 characters
- Characters: `[A-Za-z0-9._~-]` only
- Use secure random generation

---

## Best Practices

### For Public Clients

1. **Always Use PKCE**
   - Mandatory for security
   - No exceptions

2. **Secure Storage**
   - sessionStorage (web) for temporary storage
   - Secure enclave (mobile) for sensitive data
   - Never localStorage (persistent, accessible to XSS)

3. **Generate Fresh Verifiers**
   - New verifier for each authorization flow
   - Never reuse verifiers

### For Confidential Clients

1. **Use PKCE Anyway**
   - Defense-in-depth
   - OAuth 2.1 compliance
   - No downside

2. **Combine with Client Secret**
   - PKCE + client secret = maximum security
   - Protects against multiple attack vectors

---

## Compliance

### OAuth 2.1

**PKCE Requirements**:
- ✅ **Mandatory** for all authorization code flows
- ✅ **S256 method only** (plain deprecated)
- ✅ Recommended for confidential clients
- ✅ Part of core specification

### FAPI (Financial-grade API)

**Requirements**:
- ✅ PKCE mandatory for FAPI 2.0
- ✅ S256 method required
- ✅ Combined with other security measures

---

## References

- [RFC 7636 - Proof Key for Code Exchange by OAuth Public Clients](https://tools.ietf.org/html/rfc7636)
- [OAuth 2.1 Draft](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1)
- [OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics)
- [FAPI 2.0 Security Profile](https://openid.net/specs/fapi-2_0-security-profile.html)

---

**Last Updated**: 2025-11-12
**Status**: ✅ Implemented and Tested
**Tests**: 15+ passing tests
**Implementation**: `src/handlers/authorize.ts` (lines 32-33, 49-50, 71-72), `src/handlers/token.ts` (verification logic)
**Discovery**: `src/handlers/discovery.ts` (code_challenge_methods_supported)
