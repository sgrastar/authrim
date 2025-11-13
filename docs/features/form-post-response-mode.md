# Form Post Response Mode

## Overview

**OAuth 2.0 Form Post Response Mode** allows authorization responses to be delivered via HTTP POST instead of URL redirects with query or fragment parameters.

Enrai implements Form Post Response Mode as specified in the [OAuth 2.0 Form Post Response Mode specification](https://openid.net/specs/oauth-v2-form-post-response-mode-1_0.html).

## Specification

- **Specification**: [OAuth 2.0 Form Post Response Mode](https://openid.net/specs/oauth-v2-form-post-response-mode-1_0.html)
- **Status**: ✅ Implemented
- **Response Mode**: `form_post`

---

## Why Use Form Post Response Mode?

### Benefits

1. **🔒 Improved Security**
   - Authorization response parameters (code, state) not exposed in URL
   - Not visible in browser history
   - Not leaked through Referer headers
   - Reduced attack surface for parameter tampering

2. **📏 URL Length Limitations**
   - Avoids browser/server URL length limits
   - Especially useful for complex responses with many parameters
   - Better compatibility with some server configurations

3. **🛡️ Privacy Protection**
   - Sensitive data not logged in web server access logs
   - No exposure through browser extensions monitoring URLs
   - Prevents surveillance of authorization responses

4. **✅ Better User Experience**
   - Clean URL in browser address bar
   - No visible parameters in URL
   - Professional appearance

### Use Cases

- **Enterprise Applications**: Corporate apps with strict security policies
- **Mobile Apps**: Native apps using web-based authorization
- **Single Page Applications (SPAs)**: Modern web apps
- **High-Security Environments**: Financial, healthcare, government apps

---

## How Form Post Response Mode Works

### Flow Diagram

```
┌──────────┐                                    ┌────────────────┐
│  Client  │                                    │ Authorization  │
│   (RP)   │                                    │     Server     │
└─────┬────┘                                    └───────┬────────┘
      │                                                 │
      │ 1. Authorization Request                       │
      │    (response_mode=form_post)                   │
      ├────────────────────────────────────────────────>│
      │                                                 │
      │                                                 │ 2. User
      │                                                 │    Authentication
      │                                                 │
      │ 3. HTML Page with Auto-Submit Form            │
      │    <form method="post" action="redirect_uri">  │
      │      <input name="code" value="...">           │
      │      <input name="state" value="...">          │
      │    </form>                                      │
      │<────────────────────────────────────────────────┤
      │                                                 │
      │ 4. Browser Auto-Submits Form (POST)           │
      │    to Client's redirect_uri                    │
      │                                                 │
      v                                                 │
  POST /callback                                        │
  code=...&state=...                                    │
```

### Step-by-Step Process

1. **Client initiates authorization**: Includes `response_mode=form_post` in authorization request
2. **User authenticates**: Authorization server authenticates user
3. **Server returns HTML page**: Page contains auto-submitting form with authorization response
4. **Browser auto-submits form**: Form POSTs parameters to client's redirect_uri
5. **Client receives parameters**: Via POST body instead of URL query

---

## API Reference

### Authorization Request with Form Post

**GET/POST /authorize**

#### Request Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `response_mode` | ✅ Yes | Must be `form_post` |
| `response_type` | ✅ Yes | OAuth response type (e.g., `code`) |
| `client_id` | ✅ Yes | The client identifier |
| `redirect_uri` | ✅ Yes | Client's registered redirect URI |
| `scope` | ✅ Yes | Requested scopes (space-separated) |
| `state` | ❌ Recommended | Opaque value for CSRF protection |
| `nonce` | ❌ No | Nonce for ID token binding (OIDC) |

#### Example Request

```http
GET /authorize
  ?response_type=code
  &response_mode=form_post
  &client_id=my_client_id
  &redirect_uri=https://myapp.example.com/callback
  &scope=openid+profile+email
  &state=abc123
  &nonce=xyz789
Host: enrai.sgrastar.workers.dev
```

---

### Form Post Response

**HTTP 200 OK** with HTML page containing auto-submitting form.

#### Response Format

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorization</title>
  <style>
    /* User-friendly loading UI */
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner"></div>
    <p class="message">Redirecting to application...</p>
    <p class="note">Please wait</p>
  </div>

  <form id="auth-form" method="post" action="https://myapp.example.com/callback">
    <input type="hidden" name="code" value="abc123..." />
    <input type="hidden" name="state" value="abc123" />
  </form>

  <script>
    // Auto-submit form immediately
    document.getElementById('auth-form').submit();
  </script>
</body>
</html>
```

#### Response Parameters

The form contains the following hidden inputs:

| Field | Type | Description |
|-------|------|-------------|
| `code` | string | Authorization code |
| `state` | string | State parameter (if provided in request) |

---

### Client Receives POST Request

The client's redirect_uri receives a **POST request** with form parameters:

```http
POST /callback HTTP/1.1
Host: myapp.example.com
Content-Type: application/x-www-form-urlencoded

code=abc123...&state=abc123
```

The client must handle this as a POST request (not GET).

---

## Usage Examples

### Example 1: Basic Form Post Flow

#### Step 1: Client Initiates Authorization

```javascript
const authUrl = new URL('https://enrai.sgrastar.workers.dev/authorize');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('response_mode', 'form_post');
authUrl.searchParams.set('client_id', 'my_client_id');
authUrl.searchParams.set('redirect_uri', 'https://myapp.example.com/callback');
authUrl.searchParams.set('scope', 'openid profile email');
authUrl.searchParams.set('state', 'abc123');

// Redirect user to authorization URL
window.location.href = authUrl.toString();
```

#### Step 2: Client Handles POST Callback

**Express.js Example:**

```javascript
const express = require('express');
const app = express();

// IMPORTANT: Enable form parsing
app.use(express.urlencoded({ extended: true }));

app.post('/callback', (req, res) => {
  const code = req.body.code;  // NOT req.query.code!
  const state = req.body.state;

  // Validate state (CSRF protection)
  if (state !== expectedState) {
    return res.status(400).send('Invalid state');
  }

  // Exchange code for tokens
  // ... (token exchange logic)

  res.send('Authorization successful!');
});
```

**Next.js Example:**

```typescript
// pages/api/callback.ts
import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, state } = req.body;

  // Validate state
  // ... (state validation)

  // Exchange code for tokens
  // ... (token exchange logic)

  res.status(200).json({ success: true });
}
```

---

### Example 2: Form Post with PKCE

```javascript
// Generate PKCE parameters
const codeVerifier = generateRandomString(128);
const codeChallenge = await sha256(codeVerifier);
const codeChallengeBase64 = base64UrlEncode(codeChallenge);

const authUrl = new URL('https://enrai.sgrastar.workers.dev/authorize');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('response_mode', 'form_post');
authUrl.searchParams.set('client_id', 'my_client_id');
authUrl.searchParams.set('redirect_uri', 'https://myapp.example.com/callback');
authUrl.searchParams.set('scope', 'openid profile');
authUrl.searchParams.set('code_challenge', codeChallengeBase64);
authUrl.searchParams.set('code_challenge_method', 'S256');

// Store code_verifier for later use in token exchange
sessionStorage.setItem('code_verifier', codeVerifier);

window.location.href = authUrl.toString();
```

---

### Example 3: Form Post with PAR

```javascript
// Step 1: Push authorization request
const parResponse = await fetch('https://enrai.sgrastar.workers.dev/as/par', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({
    client_id: 'my_client_id',
    response_type: 'code',
    response_mode: 'form_post',
    redirect_uri: 'https://myapp.example.com/callback',
    scope: 'openid profile email',
    state: 'abc123',
  }),
});

const { request_uri } = await parResponse.json();

// Step 2: Redirect to authorization endpoint with request_uri
const authUrl = new URL('https://enrai.sgrastar.workers.dev/authorize');
authUrl.searchParams.set('client_id', 'my_client_id');
authUrl.searchParams.set('request_uri', request_uri);

window.location.href = authUrl.toString();
```

**Result**: User is redirected to authorization server, and after authentication, the response is delivered via form POST.

---

## Response Mode Validation

### Supported Response Modes

| Mode | Description | Compatible with `response_type=code` |
|------|-------------|-------------------------------------|
| `query` | Query parameters (default) | ✅ Yes |
| `form_post` | HTTP POST form | ✅ Yes |
| `fragment` | Fragment parameters | ❌ No (for security reasons) |

### Validation Rules

1. **Unsupported modes**: If `response_mode` is not `query`, `form_post`, or `fragment`, an error is returned
2. **Fragment with code**: `response_mode=fragment` is **not allowed** with `response_type=code` for security reasons
3. **Default mode**: If `response_mode` is not specified, defaults to `query`

---

## Security Considerations

### XSS Prevention

Enrai implements **comprehensive HTML escaping** to prevent XSS attacks:

#### Escaping Functions

All user-provided parameters are escaped before being embedded in HTML:

```typescript
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
```

#### Example

**Input:**
```
state=<script>alert('XSS')</script>
```

**Escaped Output in HTML:**
```html
<input type="hidden" name="state" value="&lt;script&gt;alert(&#039;XSS&#039;)&lt;/script&gt;" />
```

### CSRF Protection

- **State parameter**: Always use `state` parameter for CSRF protection
- **Validation**: Validate state on callback to ensure request originated from your app

### Parameter Integrity

- **POST body**: Parameters in POST body, not URL
- **No logging**: Most web servers don't log POST bodies by default
- **No browser history**: POST parameters not saved in browser history

---

## Client-Side Handling

### Required Configuration

Clients must:

1. **Accept POST requests** on redirect_uri
2. **Parse form-encoded body** (`application/x-www-form-urlencoded`)
3. **Validate state parameter** (CSRF protection)
4. **Handle errors** in form POST

### Common Frameworks

#### Express.js

```javascript
app.use(express.urlencoded({ extended: true }));

app.post('/callback', (req, res) => {
  const { code, state } = req.body;
  // Handle authorization
});
```

#### Hono

```typescript
app.post('/callback', async (c) => {
  const body = await c.req.parseBody();
  const code = body.code;
  const state = body.state;
  // Handle authorization
});
```

#### Python Flask

```python
@app.route('/callback', methods=['POST'])
def callback():
    code = request.form.get('code')
    state = request.form.get('state')
    # Handle authorization
```

---

## HTML Response Structure

### User Experience

Enrai's form post response includes a user-friendly loading screen:

1. **Loading Spinner**: Animated spinner indicating progress
2. **Message**: "Redirecting to application..."
3. **Auto-Submit**: Form submits immediately via JavaScript
4. **Fallback**: Form is visible if JavaScript is disabled (manual submit)

### Styling

The response includes modern, responsive CSS:

- Gradient background
- Centered content
- Smooth animations
- Mobile-friendly

---

## Discovery Metadata

Form Post support is advertised in the OpenID Provider metadata:

```json
{
  "response_modes_supported": ["query", "form_post"]
}
```

Clients can check this metadata to verify Form Post support before using it.

---

## Testing

### Test Coverage

Enrai includes comprehensive tests for Form Post Response Mode:

**Test File**: `test/form-post-response-mode.test.ts`

**Test Scenarios**:
- ✅ HTML form generation
- ✅ State parameter inclusion
- ✅ HTML escaping (XSS prevention)
- ✅ Response mode validation
- ✅ Integration with PKCE
- ✅ Integration with PAR
- ✅ Discovery endpoint
- ✅ Security (XSS, quotes, ampersands)
- ✅ HTML structure (doctype, meta tags, spinner)

**Total**: 19+ test cases

### Running Tests

```bash
npm test -- form-post-response-mode.test.ts
```

---

## Comparison: Query vs Form Post

### Query Mode (Default)

**Request:**
```http
GET /authorize?response_type=code&client_id=...&redirect_uri=...&scope=...
```

**Response:**
```http
HTTP/1.1 302 Found
Location: https://myapp.example.com/callback?code=abc123&state=xyz
```

**Issues**:
- ❌ Code visible in URL
- ❌ Logged in web server logs
- ❌ Saved in browser history
- ❌ Can leak via Referer header

---

### Form Post Mode

**Request:**
```http
GET /authorize?response_type=code&response_mode=form_post&client_id=...&redirect_uri=...&scope=...
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: text/html

<html>
  <form method="post" action="https://myapp.example.com/callback">
    <input type="hidden" name="code" value="abc123" />
    <input type="hidden" name="state" value="xyz" />
  </form>
  <script>document.forms[0].submit();</script>
</html>
```

**Benefits**:
- ✅ Code not visible in URL
- ✅ Not logged in web server logs (usually)
- ✅ Not saved in browser history
- ✅ No Referer leakage

---

## Troubleshooting

### Common Issues

#### Client receives GET instead of POST

**Cause**: Client's redirect_uri only handles GET requests

**Solution**: Ensure callback endpoint accepts POST:

```javascript
// Express.js
app.post('/callback', handler);  // Not app.get()

// Next.js
if (req.method !== 'POST') {
  return res.status(405).end();
}
```

#### Parameters not found in request

**Cause**: Client reading from query parameters instead of body

**Solution**: Read from POST body:

```javascript
// Correct
const code = req.body.code;

// Incorrect
const code = req.query.code;  // Won't work with form_post!
```

#### Form not auto-submitting

**Cause**: JavaScript disabled or error

**Solution**: The form is visible and can be manually submitted. Ensure JavaScript is enabled for best UX.

---

## Best Practices

### For Clients

1. **Always use state**: Include `state` parameter for CSRF protection
2. **Validate state**: Check state matches on callback
3. **Handle POST**: Ensure redirect_uri accepts POST requests
4. **Parse body**: Read parameters from POST body, not URL
5. **PKCE**: Use PKCE for enhanced security (especially public clients)

### For Security

1. **HTTPS only**: Always use HTTPS for redirect_uri in production
2. **Exact URI matching**: Register exact redirect URIs (no wildcards)
3. **Short-lived codes**: Authorization codes expire quickly (120 seconds)
4. **One-time use**: Codes are single-use only

---

## Browser Compatibility

Form Post Response Mode works on all modern browsers:

- ✅ Chrome/Edge (all versions)
- ✅ Firefox (all versions)
- ✅ Safari (all versions)
- ✅ Mobile browsers (iOS Safari, Chrome Mobile)

---

## Future Enhancements

### Planned Features (Phase 5+)

- [ ] **JWT-Secured Response Mode**: Signed/encrypted response JWTs
- [ ] **Fragment Response Mode**: Support for implicit/hybrid flows
- [ ] **Custom HTML Templates**: Configurable form post page design
- [ ] **Analytics**: Track form post usage and success rates

---

## References

- [OAuth 2.0 Form Post Response Mode](https://openid.net/specs/oauth-v2-form-post-response-mode-1_0.html)
- [OAuth 2.0 Multiple Response Types](https://openid.net/specs/oauth-v2-multiple-response-types-1_0.html)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-security-topics)

---

**Last Updated**: 2025-11-12
**Status**: ✅ Implemented and Tested
**Tests**: 19+ passing tests
**Implementation**: `src/handlers/authorize.ts` (lines 200-226, 370-510)
**Discovery**: `src/handlers/discovery.ts` (line 30)
