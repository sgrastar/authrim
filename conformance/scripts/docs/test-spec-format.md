# Test Specification Format Specification

## Overview

The test specification is a JSON format file referenced during OIDC conformance test execution.
It specifies whether and when screenshots should be taken for each test.

## Generation Method

```bash
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/generate-test-spec.ts \
  --plan-name basic-op \
  --output ./test-spec.json
```

### Available Plan Names

| Key | Description |
|------|------|
| `basic-op` | OIDC Basic OP (Authorization Code Flow) |
| `implicit-op` | OIDC Implicit OP |
| `hybrid-op` | OIDC Hybrid OP |
| `config-op` | OIDC Config OP (Discovery/JWKS) |
| `dynamic-op` | OIDC Dynamic OP (Dynamic Client Registration) |
| `formpost-basic` | Form Post + Authorization Code |
| `formpost-implicit` | Form Post + Implicit |
| `formpost-hybrid` | Form Post + Hybrid |
| `rp-logout-op` | RP-Initiated Logout |
| `session-management-op` | Session Management |
| `3rdparty-login-op` | 3rd Party Initiated Login |
| `fapi-2` | FAPI 2.0 Security Profile |

## File Structure

```json
{
  "planName": "oidcc-basic-certification-test-plan",
  "generatedAt": "2025-11-26T10:00:00.000Z",
  "configFile": "basic-op.json",
  "tests": [
    {
      "testModule": "oidcc-response-type-missing",
      "testSummary": "This test sends an authorization request...",
      "variant": {
        "client_auth_type": "client_secret_basic",
        "response_type": "code"
      },
      "requiresScreenshot": true,
      "screenshotTiming": "on_error_page",
      "expectedError": "unsupported_response_type|invalid_request",
      "notes": "Screenshot of error page required"
    }
  ]
}
```

---

## Top-Level Parameters

| Parameter | Type | Description |
|-----------|-----|------|
| `planName` | string | OpenID Conformance Suite test plan name. Example: `oidcc-basic-certification-test-plan` |
| `generatedAt` | string | Date and time when the specification was generated (ISO 8601 format) |
| `configFile` | string | Configuration file name to use. File in the `config/` directory |
| `tests` | array | Array of test entries |

---

## Test Entries (elements in the tests array)

### testModule
- **Type**: `string`
- **Required**: Yes
- **Description**: Test module identifier. Test name defined in the Conformance Suite
- **Example**: `"oidcc-server"`, `"oidcc-response-type-missing"`, `"oidcc-prompt-login"`

### testSummary
- **Type**: `string`
- **Required**: Yes
- **Description**: Test overview description. Retrieved from the Conformance Suite Plan API. Describes the test purpose and expected behavior
- **Example**: `"This test sends an authorization request that is missing the response_type parameter..."`

### variant
- **Type**: `object`
- **Required**: No
- **Description**: Test variation settings. Specifies authentication method and response type

| Sub-parameter | Example Value | Description |
|---------------|--------|------|
| `client_auth_type` | `"client_secret_basic"`, `"client_secret_post"`, `"private_key_jwt"` | Client authentication method |
| `response_type` | `"code"`, `"id_token"`, `"code id_token"` | OAuth 2.0 response type |
| `response_mode` | `"default"`, `"form_post"` | Response mode |

### requiresScreenshot
- **Type**: `boolean`
- **Required**: Yes
- **Description**: Whether screenshot upload is required for this test
- **Auto-detection logic**: Set to `true` if `testSummary` contains the following keywords:
  - `"screenshot"`
  - `"uploaded"`
  - `"image should be"`

| Value | Description |
|----|------|
| `true` | Screenshot upload required |
| `false` | Screenshot not required |

### screenshotTiming
- **Type**: `string | null`
- **Required**: No (null when `requiresScreenshot: false`)
- **Description**: Timing to capture the screenshot

#### Error-related
| Value | Description | Use Case |
|----|------|-----------|
| `"on_error_page"` | When error page is displayed | Verify error display for invalid requests (invalid_request, etc.) |
| `"on_error_redirect"` | When redirected with error | When error response is returned to callback URL |

#### Login-related
| Value | Description | Use Case |
|----|------|-----------|
| `"on_login"` | Initial login screen | Verify login screen display |
| `"on_login_2nd"` | Second login screen | Re-authentication with `prompt=login` |
| `"on_login_3rd"` | Third login screen | Tests requiring multiple authentications |
| `"on_reauth"` | Re-authentication screen | Forced re-authentication with `max_age` |

#### Consent-related
| Value | Description | Use Case |
|----|------|-----------|
| `"on_consent"` | Initial consent screen | Verify consent screen display |
| `"on_consent_2nd"` | Second consent screen | Re-consent with `prompt=consent` |

#### Session Management-related
| Value | Description | Use Case |
|----|------|-----------|
| `"on_logout"` | Logout screen | Display logout confirmation screen |
| `"on_logout_confirm"` | Logout confirmation dialog | Front-channel logout confirmation |
| `"on_session_check"` | Session check screen | Session management iframe confirmation |

#### Special Cases
| Value | Description | Use Case |
|----|------|-----------|
| `"on_interaction"` | Screen requiring user interaction | Screen when `interaction_required` error occurs |
| `"on_account_selection"` | Account selection screen | Selection screen with `prompt=select_account` |
| `"on_mfa"` | MFA/2-factor auth screen | When additional authentication is required |
| `"manual"` | Manually capture screenshot | Cases where automatic capture is difficult |
| `null` | Screenshot not required | When `requiresScreenshot: false` |

#### Multiple Timing Specification
When screenshots are needed at multiple timings, specify with comma separation:
```json
"screenshotTiming": "on_login_2nd,on_error_page"
```

#### Auto-detection Logic

`generate-test-spec.ts` automatically determines timing based on the following rules:

| testModule pattern | Detected timing |
|-------------------|-------------------|
| `prompt-login` | `on_login_2nd` |
| `max-age` | `on_reauth` |
| `id-token-hint` | `on_login_2nd` |
| `prompt-consent` | `on_consent_2nd` |
| `logout` | `on_logout` |
| `session` | `on_session_check` |
| `select-account` | `on_account_selection` |
| `interaction` | `on_interaction` |
| `missing`, `invalid`, `mismatch` | `on_error_page` |
| `prompt-none-not-logged-in` | `on_error_page` |

### expectedError
- **Type**: `string | null`
- **Required**: No
- **Description**: OAuth 2.0 error code expected in the test. Multiple codes separated by pipe (`|`)
- **Auto-detection logic**: Extracts the following error codes from `testSummary`:

| Error Code | Description |
|-------------|------|
| `unsupported_response_type` | Unsupported response type |
| `invalid_request` | Invalid request |
| `access_denied` | Access denied |
| `login_required` | Login required |
| `interaction_required` | User interaction required |
| `consent_required` | Consent required |
| `invalid_scope` | Invalid scope |
| `invalid_grant` | Invalid grant |
| `unauthorized_client` | Unauthorized client |
| `invalid_client` | Invalid client |

- **Example**: `"unsupported_response_type|invalid_request"` (either error is expected)

### notes
- **Type**: `string`
- **Required**: No
- **Description**: User-editable notes field. Notes or supplementary information for test execution
- **Auto-generation**: Japanese descriptions are set based on `screenshotTiming`
- **Example**: `"Screenshot of error page required"`, `"Screenshot of second login screen required"`

---

## Usage Examples

### Basic Test (No Screenshot Required)

```json
{
  "testModule": "oidcc-server",
  "testSummary": "Tests primarily 'happy' flows",
  "variant": {
    "client_auth_type": "client_secret_basic",
    "response_type": "code"
  },
  "requiresScreenshot": false,
  "screenshotTiming": null,
  "expectedError": null,
  "notes": ""
}
```

### Test Requiring Error Page Screenshot

```json
{
  "testModule": "oidcc-response-type-missing",
  "testSummary": "This test sends an authorization request that is missing the response_type parameter. The authorization server must either redirect back with an 'unsupported_response_type' or 'invalid_request' error, or must display an error saying the response type is missing, a screenshot of which should be uploaded.",
  "variant": {
    "client_auth_type": "client_secret_basic",
    "response_type": "code"
  },
  "requiresScreenshot": true,
  "screenshotTiming": "on_error_page",
  "expectedError": "unsupported_response_type|invalid_request",
  "notes": "Screenshot of error page required"
}
```

### Test Requiring Re-authentication Screen Screenshot

```json
{
  "testModule": "oidcc-prompt-login",
  "testSummary": "This test calls the authorization endpoint test twice. The second time it will include prompt=login, so that the authorization server is required to ask the user to login a second time. A screenshot of the second authorization should be uploaded.",
  "variant": {
    "client_auth_type": "client_secret_basic",
    "response_type": "code"
  },
  "requiresScreenshot": true,
  "screenshotTiming": "on_login_2nd",
  "expectedError": null,
  "notes": "Screenshot of second login screen required"
}
```

### max_age Re-authentication Test

```json
{
  "testModule": "oidcc-max-age-1",
  "testSummary": "This test calls the authorization endpoint test twice. The second time it waits 1 second and includes max_age=1, so that the authorization server is required to ask the user to login a second time and must return an auth_time claim in the second id_token. A screenshot of the second authorization should be uploaded.",
  "variant": {
    "client_auth_type": "client_secret_basic",
    "response_type": "code"
  },
  "requiresScreenshot": true,
  "screenshotTiming": "on_reauth",
  "expectedError": null,
  "notes": "Screenshot of re-authentication screen required"
}
```

### Test Requiring Manual Screenshot

```json
{
  "testModule": "oidcc-custom-test",
  "testSummary": "This test requires manual screenshot capture...",
  "variant": {
    "client_auth_type": "client_secret_basic",
    "response_type": "code"
  },
  "requiresScreenshot": true,
  "screenshotTiming": "manual",
  "expectedError": null,
  "notes": "Manual screenshot capture required"
}
```

---

## User Editing Guidelines

### Editable Fields

The following fields are intended for user editing:

1. **`requiresScreenshot`** - Correct if auto-detection is wrong
2. **`screenshotTiming`** - Change to appropriate timing
3. **`notes`** - Add supplementary information or notes

### Fields That Should Not Be Edited

Do not change the following fields:

- `testModule` - Test identifier
- `testSummary` - Description obtained from API
- `variant` - Test variation settings

### Editing Example

When auto-detection sets `requiresScreenshot: false` but a screenshot is actually required:

```json
// Before
{
  "testModule": "oidcc-custom-test",
  "requiresScreenshot": false,
  "screenshotTiming": null,
  "notes": ""
}

// After (User edited)
{
  "testModule": "oidcc-custom-test",
  "requiresScreenshot": true,
  "screenshotTiming": "on_error_page",
  "notes": "Error display confirmation required"
}
```

---

## Related Commands

```bash
# Generate specification
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/generate-test-spec.ts \
  --plan-name basic-op \
  --output ./test-spec.json

# Run test using specification
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/run-conformance.ts \
  --plan basic-op \
  --spec ./test-spec.json

# Check placeholders
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/check-image-placeholders.ts \
  --plan <planId>

# Manually upload image
CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/check-image-placeholders.ts \
  --module <moduleId> \
  --upload ./screenshot.png
```

---

## Conformance Suite API

### Image Upload Endpoint

#### Limitations
- **File format**: PNG or JPEG only
- **Maximum size**: 500KB
- **Format**: Data URI format (`data:image/png;base64,<base64data>`)

#### New Image Upload
```
POST /api/log/{moduleId}/images
Content-Type: text/plain;charset=UTF-8
Authorization: Bearer {token}

Body: data:image/png;base64,iVBORw0KGgo...  (Data URI format, raw string)

Query Parameters:
- description: Image description (optional)
```

#### Upload to Placeholder
```
POST /api/log/{moduleId}/images/{placeholder}
Content-Type: text/plain;charset=UTF-8
Authorization: Bearer {token}

Body: data:image/png;base64,iVBORw0KGgo...  (Data URI format, raw string)
```

### Detecting Image Placeholders

Check the `upload.placeholder` field in the test log:

```json
{
  "src": "VerifyUserAuthenticated",
  "msg": "Please upload a screenshot...",
  "upload": {
    "placeholder": "error_screenshot"
  }
}
```
