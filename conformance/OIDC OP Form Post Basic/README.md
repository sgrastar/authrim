# authrim – OpenID Connect Form Post OP Conformance

## Vision & Objectives

**OIDC Form Post OP Profile** is a certification profile that verifies authorization response delivery methods compliant with the OAuth 2.0 Form Post Response Mode specification.

### Objectives
- ✅ Support `response_mode=form_post`
- 🔒 Secure response delivery without using URL fragments or query parameters
- ✅ Safe token passing via browser
- ✅ Compatibility with SPAs and web applications

### Use Cases
- **SPA (Single Page Application)**: When you don't want to expose tokens in fragments
- **Enterprise Apps**: When security policies prohibit token delivery via URL
- **Log Management**: Prevent tokens from being logged in URLs

---

## Required Features & Behavior

### 1. Form Post Response Mode (OAuth 2.0 Form Post Response Mode)

| Requirement | Description | Specification Reference |
|:--|:--|:--|
| **response_mode Parameter** | Support `response_mode=form_post` parameter | Form Post Section 3 |
| **HTML Form Response** | Return authorization response as HTML form | Form Post Section 4 |
| **Auto-submit Form** | Auto-submit form with JavaScript | Form Post Section 4.1 |
| **POST to redirect_uri** | POST request to `redirect_uri` | Form Post Section 4.2 |
| **Parameter Encoding** | Embed parameters as hidden inputs | Form Post Section 4.1 |
| **Content-Type** | Response with `text/html` | Form Post Section 4 |

### 2. Response Parameters

**Authorization Code Flow with Form Post:**
- `code` - Authorization code
- `state` - State for CSRF protection
- `iss` - Issuer Identifier (OIDC Core 3.1.2.5)

**Implicit Flow with Form Post (if supported):**
- `access_token` - Access token
- `token_type` - Token type
- `expires_in` - Expiration time
- `id_token` - ID Token
- `state` - State for CSRF protection

**Error Response:**
- `error` - Error code
- `error_description` - Error description
- `error_uri` - Error details URI (optional)
- `state` - State for CSRF protection

### 3. HTML Form Structure

Form Post Response Mode must return HTML with the following structure:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Submit This Form</title>
</head>
<body onload="javascript:document.forms[0].submit()">
  <form method="post" action="https://client.example.com/callback">
    <input type="hidden" name="code" value="AUTHORIZATION_CODE"/>
    <input type="hidden" name="state" value="STATE_VALUE"/>
    <input type="hidden" name="iss" value="https://op.example.com"/>
  </form>
</body>
</html>
```

### 4. Security Considerations

| Requirement | Description | Specification Reference |
|:--|:--|:--|
| **CSRF Protection** | Validate `state` parameter | RFC 6749 Section 10.12 |
| **Issuer Validation** | Verify issuer with `iss` parameter | OIDC Core 3.1.2.5 |
| **HTTPS Enforcement** | `redirect_uri` must use HTTPS | OAuth 2.0 Security BCP |
| **No URL Leakage** | Tokens are not exposed in URL | Form Post Section 1 |

---

## Authrim Implementation Status

### Form Post Response Mode

| Feature | Status | Implementation |
|:--|:--|:--|
| `response_mode=form_post` | ✅ | `op-auth` Worker |
| HTML form generation | ✅ | Auto-submit form template |
| POST to redirect_uri | ✅ | JavaScript auto-submit |
| Parameter encoding | ✅ | Hidden input fields |
| Content-Type: text/html | ✅ | Proper HTTP headers |
| Error response | ✅ | Form Post error handling |

### Supported Response Types with Form Post

| Response Type | Status | Notes |
|:--|:--|:--|
| `code` | ✅ | Authorization Code Flow |
| `id_token` | ✅ | Implicit Flow (ID Token only) |
| `id_token token` | ✅ | Implicit Flow (ID Token + Access Token) |
| `code id_token` | ✅ | Hybrid Flow |
| `code token` | ✅ | Hybrid Flow |
| `code id_token token` | ✅ | Hybrid Flow |

### Response Parameters

| Parameter | Status | Flow |
|:--|:--|:--|
| `code` | ✅ | Authorization Code, Hybrid |
| `id_token` | ✅ | Implicit, Hybrid |
| `access_token` | ✅ | Implicit, Hybrid |
| `token_type` | ✅ | Implicit, Hybrid |
| `expires_in` | ✅ | Implicit, Hybrid |
| `state` | ✅ | All flows |
| `iss` | ✅ | All flows (OIDC Core 3.1.2.5) |

### Security Features

| Feature | Status | Implementation |
|:--|:--|:--|
| CSRF protection (state) | ✅ | state validation |
| Issuer validation (iss) | ✅ | iss parameter included |
| HTTPS enforcement | ✅ | redirect_uri validation |
| No URL token leakage | ✅ | POST body only |

### Implementation Details

**Phase 4: Form Post Response Mode** (Completed)
- ✅ `op-auth` Worker
- ✅ `/authorize` endpoint with `response_mode=form_post`
- ✅ HTML form template generation
- ✅ JavaScript auto-submit
- ✅ Error handling with Form Post

**Worker:** `packages/op-auth/src/index.ts`
**Endpoint:** `GET /authorize?response_mode=form_post`

**Test Coverage:**
- ✅ 19 unit tests (Phase 4)
- ✅ Form Post with Authorization Code Flow
- ✅ Form Post with Implicit Flow
- ✅ Form Post with Hybrid Flow
- ✅ Form Post error responses

**HTML Template Example:**
```typescript
function generateFormPostResponse(
  redirectUri: string,
  params: Record<string, string>
): string {
  const inputs = Object.entries(params)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${value}"/>`)
    .join('\n    ');

  return `<!DOCTYPE html>
<html>
<head>
  <title>Submit This Form</title>
</head>
<body onload="javascript:document.forms[0].submit()">
  <form method="post" action="${redirectUri}">
    ${inputs}
  </form>
</body>
</html>`;
}
```

---

## Related Specifications

| Specification | Title | Status |
|:--|:--|:--|
| **OAuth 2.0 Form Post** | OAuth 2.0 Form Post Response Mode | ✅ Implemented |
| **OIDC Core 3.1.2.5** | Authentication Response Validation (iss parameter) | ✅ Implemented |
| **RFC 6749** | OAuth 2.0 Authorization Framework | ✅ Core Standard |

**Primary References:**
- [OAuth 2.0 Form Post Response Mode](https://openid.net/specs/oauth-v2-form-post-response-mode-1_0.html)
- [OIDC Core 3.1.2.5](https://openid.net/specs/openid-connect-core-1_0.html#AuthResponseValidation)

---

## Testing Plan

### OpenID Conformance Suite

**Test Profile:**
- **Name:** OpenID Connect Form Post OP
- **Purpose:** Verify Form Post Response Mode functionality

**Test URL:**
https://www.certification.openid.net/

**Configuration:**
```bash
# Test Configuration
Issuer: https://authrim.YOUR_SUBDOMAIN.workers.dev
Authorization Endpoint: https://authrim.YOUR_SUBDOMAIN.workers.dev/authorize

# Enable Form Post Response Mode
response_mode: form_post
```

### Test Procedure

1. **Deploy Authrim**
   ```bash
   pnpm run deploy
   ```

2. **Verify Form Post Response (Manual)**
   ```bash
   # 1. Navigate to authorization endpoint with response_mode=form_post
   https://authrim.YOUR_SUBDOMAIN.workers.dev/authorize?
     client_id=CLIENT_ID&
     redirect_uri=https://example.com/callback&
     response_type=code&
     response_mode=form_post&
     scope=openid&
     state=STATE_VALUE

   # 2. After authentication, verify HTML form auto-submit
   # 3. Verify POST request to redirect_uri with code, state, iss
   ```

3. **Test Different Response Types**
   ```bash
   # Authorization Code Flow
   response_type=code&response_mode=form_post

   # Implicit Flow
   response_type=id_token&response_mode=form_post

   # Hybrid Flow
   response_type=code id_token&response_mode=form_post
   ```

4. **Run Conformance Tests**
   - Access OpenID Conformance Suite
   - Create test plan: **OpenID Connect Provider → Form Post OP**
   - Configure Issuer URL
   - Enable Form Post Response Mode
   - Execute all tests

### Expected Test Coverage

| Test Category | Description | Expected |
|:--|:--|:--|
| Form Post - Code Flow | response_type=code with form_post | ✅ Pass |
| Form Post - Implicit Flow | response_type=id_token with form_post | ✅ Pass |
| Form Post - Hybrid Flow | response_type=code id_token with form_post | ✅ Pass |
| HTML Structure | Valid HTML form generation | ✅ Pass |
| Auto-submit | JavaScript auto-submit works | ✅ Pass |
| Parameter Encoding | Hidden inputs with correct values | ✅ Pass |
| iss Parameter | Issuer included in response | ✅ Pass |
| state Parameter | CSRF protection with state | ✅ Pass |
| Error Response | Error in Form Post format | ✅ Pass |

**Note:** Specific test results will be recorded after individual testing.

---

## Certification Roadmap

### Current Status
- ✅ **Phase 4 Complete**: Form Post Response Mode implemented (19 tests)
- ✅ **Ready for Testing**: All required features implemented

### Next Steps
1. **Individual Testing**: Run OpenID Form Post OP conformance tests
2. **Record Results**: Document test outcomes in this README
3. **Address Issues**: Fix any discovered issues
4. **Certification**: Submit for OpenID Certified™ Form Post OP

---

## Related Documents

- [OIDC Basic OP](../OIDC%20Basic%20OP/README.md) - Basic OP profile conformance
- [OIDC Config OP](../OIDC%20Config%20OP/README.md) - Discovery configuration conformance
- [OIDC Hybrid OP](../OIDC%20Hybrid%20OP/README.md) - Hybrid Flow conformance
- [Test Plan](../OIDC%20Basic%20OP/test-plan.md) - Overall conformance testing strategy
- [Project README](../../README.md) - Authrim project overview

---

> **Status:** ✅ Implementation Complete – Ready for Individual Testing
> **Last Updated:** 2025-11-18
