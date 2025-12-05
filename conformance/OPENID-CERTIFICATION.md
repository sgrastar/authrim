# OpenID Certification Testing Guide

This guide explains how to test Authrim with [OpenID Certification](https://www.certification.openid.net/).

**⚠️ Important**: Admin API is currently accessible without authentication. ABAC-based authentication mechanism will be implemented in the future.

## 📋 Table of Contents

1. [Overview](#overview)
2. [Profile Switching Methods](#profile-switching-methods)
3. [Profile List](#profile-list)
4. [API Usage Examples](#api-usage-examples)
5. [Recommended Settings for Certification](#recommended-settings-for-certification)

## Overview

Authrim can support the following OpenID Connect profiles by changing settings:

- **Basic OP**: Standard Authorization Code Flow
- **Implicit OP**: Implicit Flow (for SPAs)
- **Hybrid OP**: Hybrid Flow
- **FAPI 1.0 Advanced**: Security profile for financial institutions (MTLS)
- **FAPI 2.0**: Next-generation security profile for financial institutions (PAR + private_key_jwt)
- **FAPI 2.0 + DPoP**: FAPI 2.0 + sender-constrained tokens

## Profile Switching Methods

### Method 1: Via Admin API (Recommended)

**Note**: Admin API currently requires no authentication. The following commands can be executed as-is.

#### Retrieve Profile List

```bash
curl -X GET https://your-authrim.com/api/admin/settings/profiles
```

**Response Example:**
```json
{
  "profiles": [
    {
      "name": "Basic OP",
      "description": "Standard OpenID Connect Provider (Authorization Code Flow)"
    },
    {
      "name": "FAPI 2.0",
      "description": "Financial-grade API Security Profile 2.0"
    },
    ...
  ]
}
```

#### Apply Profile

```bash
# Switch to Basic OP mode
curl -X PUT https://your-authrim.com/api/admin/settings/profile/basic-op \
  -H "Content-Type: application/json"

# Switch to FAPI 2.0 mode
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2 \
  -H "Content-Type: application/json"

# Switch to FAPI 2.0 + DPoP mode
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2-dpop \
  -H "Content-Type: application/json"
```

**Response Example:**
```json
{
  "success": true,
  "message": "Applied certification profile: FAPI 2.0",
  "profile": {
    "name": "FAPI 2.0",
    "description": "Financial-grade API Security Profile 2.0"
  },
  "settings": {
    "fapi": {
      "enabled": true,
      "requireDpop": false,
      "allowPublicClients": false
    },
    "oidc": {
      "requirePar": true,
      "responseTypesSupported": ["code"],
      "tokenEndpointAuthMethodsSupported": ["private_key_jwt", "client_secret_jwt"]
    }
  }
}
```

### Method 2: Manual Configuration

If you need finer control, you can update settings directly:

```bash
curl -X PUT https://your-authrim.com/api/admin/settings \
  -H "Content-Type: application/json" \
  -d '{
    "settings": {
      "fapi": {
        "enabled": true,
        "requireDpop": false,
        "allowPublicClients": false
      },
      "oidc": {
        "requirePar": true,
        "tokenEndpointAuthMethodsSupported": ["private_key_jwt"]
      }
    }
  }'
```

## Profile List

### basic-op (Basic OP)

**Description**: Standard OpenID Connect Provider (Authorization Code Flow)

**Settings**:
```json
{
  "fapi": {
    "enabled": false,
    "requireDpop": false,
    "allowPublicClients": true
  },
  "oidc": {
    "requirePar": false,
    "responseTypesSupported": ["code"],
    "tokenEndpointAuthMethodsSupported": [
      "client_secret_basic",
      "client_secret_post",
      "client_secret_jwt",
      "private_key_jwt",
      "none"
    ]
  }
}
```

**How to Apply**:
```bash
curl -X PUT https://your-authrim.com/api/admin/settings/profile/basic-op \
  -H "Content-Type: application/json"
```

---

### implicit-op (Implicit OP)

**Description**: Supports Implicit Flow (for SPAs)

**Settings**:
```json
{
  "fapi": {
    "enabled": false,
    "requireDpop": false,
    "allowPublicClients": true
  },
  "oidc": {
    "requirePar": false,
    "responseTypesSupported": ["code", "id_token", "id_token token"],
    "tokenEndpointAuthMethodsSupported": [
      "client_secret_basic",
      "client_secret_post",
      "none"
    ]
  }
}
```

**How to Apply**:
```bash
curl -X PUT https://your-authrim.com/api/admin/settings/profile/implicit-op \
  -H "Content-Type: application/json"
```

---

### hybrid-op (Hybrid OP)

**Description**: Supports Hybrid Flow

**Settings**:
```json
{
  "fapi": {
    "enabled": false,
    "requireDpop": false,
    "allowPublicClients": true
  },
  "oidc": {
    "requirePar": false,
    "responseTypesSupported": [
      "code",
      "code id_token",
      "code token",
      "code id_token token"
    ],
    "tokenEndpointAuthMethodsSupported": [
      "client_secret_basic",
      "client_secret_post",
      "client_secret_jwt",
      "private_key_jwt",
      "none"
    ]
  }
}
```

**How to Apply**:
```bash
curl -X PUT https://your-authrim.com/api/admin/settings/profile/hybrid-op \
  -H "Content-Type: application/json"
```

---

### fapi-1-advanced (FAPI 1.0 Advanced)

**Description**: Financial-grade API Security Profile 1.0 - Advanced (uses MTLS)

**Settings**:
```json
{
  "fapi": {
    "enabled": false,
    "requireDpop": false,
    "allowPublicClients": false
  },
  "oidc": {
    "requirePar": false,
    "responseTypesSupported": ["code", "code id_token"],
    "tokenEndpointAuthMethodsSupported": [
      "private_key_jwt",
      "tls_client_auth"
    ]
  }
}
```

**How to Apply**:
```bash
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-1-advanced \
  -H "Content-Type: application/json"
```

**Note**: FAPI 1.0 requires MTLS (Mutual TLS). Please verify support status in Cloudflare Workers.

---

### fapi-2 (FAPI 2.0)

**Description**: Financial-grade API Security Profile 2.0 (latest version)

**Settings**:
```json
{
  "fapi": {
    "enabled": true,
    "requireDpop": false,
    "allowPublicClients": false
  },
  "oidc": {
    "requirePar": true,
    "responseTypesSupported": ["code"],
    "tokenEndpointAuthMethodsSupported": [
      "private_key_jwt",
      "client_secret_jwt"
    ]
  }
}
```

**How to Apply**:
```bash
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2 \
  -H "Content-Type: application/json"
```

**Required Features**:
- ✅ PAR (Pushed Authorization Requests) required
- ✅ Confidential Clients only
- ✅ PKCE S256 required
- ✅ `iss` parameter (RFC 9207)
- ✅ private_key_jwt or client_secret_jwt

---

### fapi-2-dpop (FAPI 2.0 + DPoP)

**Description**: FAPI 2.0 + DPoP (sender-constrained tokens)

**Settings**:
```json
{
  "fapi": {
    "enabled": true,
    "requireDpop": true,
    "allowPublicClients": false
  },
  "oidc": {
    "requirePar": true,
    "responseTypesSupported": ["code"],
    "tokenEndpointAuthMethodsSupported": ["private_key_jwt"]
  }
}
```

**How to Apply**:
```bash
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2-dpop \
  -H "Content-Type: application/json"
```

**Additional Requirements**:
- ✅ DPoP proof required (RFC 9449)
- ✅ DPoP header required for all token requests

---

### development (Development Mode)

**Description**: Relaxed settings for local development

**Settings**:
```json
{
  "fapi": {
    "enabled": false,
    "requireDpop": false,
    "allowPublicClients": true
  },
  "oidc": {
    "requirePar": false,
    "responseTypesSupported": ["code"],
    "tokenEndpointAuthMethodsSupported": [
      "client_secret_basic",
      "client_secret_post",
      "none"
    ]
  }
}
```

**How to Apply**:
```bash
curl -X PUT https://your-authrim.com/api/admin/settings/profile/development \
  -H "Content-Type: application/json"
```

## API Usage Examples

**Note**: Authentication headers are not required in the examples below (Admin API is currently accessible without authentication).

### TypeScript/JavaScript

```typescript
// Get profile list
async function listProfiles() {
  const response = await fetch('https://your-authrim.com/api/admin/settings/profiles');
  const data = await response.json();
  console.log('Available profiles:', data.profiles);
}

// Apply profile
async function applyProfile(profileName: string) {
  const response = await fetch(
    `https://your-authrim.com/api/admin/settings/profile/${profileName}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );
  const data = await response.json();
  console.log('Applied profile:', data);
}

// Usage example
await applyProfile('fapi-2');  // Switch to FAPI 2.0 mode
```

### Python

```python
import requests

BASE_URL = "https://your-authrim.com"

# Get profile list
def list_profiles():
    response = requests.get(f"{BASE_URL}/api/admin/settings/profiles")
    return response.json()

# Apply profile
def apply_profile(profile_name):
    response = requests.put(
        f"{BASE_URL}/api/admin/settings/profile/{profile_name}",
        headers={"Content-Type": "application/json"}
    )
    return response.json()

# Usage example
profiles = list_profiles()
print(f"Available profiles: {profiles}")

result = apply_profile("fapi-2")
print(f"Applied profile: {result}")
```

## Recommended Settings for Certification

### 1. Basic OP Certification

```bash
# Step 1: Apply Basic OP profile
curl -X PUT https://your-authrim.com/api/admin/settings/profile/basic-op \
  -H "Content-Type: application/json"

# Step 2: Verify Discovery URL
# https://your-authrim.com/.well-known/openid-configuration

# Step 3: Register URL in OpenID Certification tool
# https://www.certification.openid.net/
```

### 2. FAPI 2.0 Certification

```bash
# Step 1: Apply FAPI 2.0 profile
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2 \
  -H "Content-Type: application/json"

# Step 2: Client registration
# - Prepare public key (JWKS) for private_key_jwt authentication
# - Provide jwks_uri or jwks during client registration

# Step 3: Verify configuration
curl https://your-authrim.com/.well-known/openid-configuration | jq '{
  require_pushed_authorization_requests,
  token_endpoint_auth_methods_supported,
  code_challenge_methods_supported,
  dpop_signing_alg_values_supported
}'

# Expected output:
# {
#   "require_pushed_authorization_requests": true,
#   "token_endpoint_auth_methods_supported": ["private_key_jwt", "client_secret_jwt"],
#   "code_challenge_methods_supported": ["S256"],
#   "dpop_signing_alg_values_supported": ["RS256", "ES256"]
# }

# Step 4: Run FAPI 2.0 tests in OpenID Certification tool
```

### 3. FAPI 2.0 + DPoP Certification

```bash
# Step 1: Apply FAPI 2.0 + DPoP profile
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2-dpop \
  -H "Content-Type: application/json"

# Step 2: Verify DPoP
# - Use DPoP proof generation library
# - Include DPoP header in all token requests

# Step 3: Verification before test execution
curl https://your-authrim.com/.well-known/openid-configuration | jq '.dpop_signing_alg_values_supported'

# Step 4: Run FAPI 2.0 + DPoP tests in OpenID Certification tool
```

## Troubleshooting

### If settings are not applied

1. **Clear cache**: Discovery endpoint is cached for 5 minutes
   ```bash
   # Wait 5 minutes or redeploy worker
   wrangler deploy
   ```

2. **Verify settings**:
   ```bash
   curl -X GET https://your-authrim.com/api/admin/settings
   ```

3. **Verify Discovery metadata**:
   ```bash
   curl https://your-authrim.com/.well-known/openid-configuration | jq .
   ```

### If Certification tests fail

#### PAR Required Error

```bash
# Verify configuration
curl https://your-authrim.com/.well-known/openid-configuration | \
  jq '.require_pushed_authorization_requests'

# Verify it is true
# If false, reapply profile
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2 \
  -H "Content-Type: application/json"
```

#### DPoP Required Error

```bash
# Verify FAPI configuration
curl -X GET https://your-authrim.com/api/admin/settings | \
  jq '.settings.fapi'

# Verify requireDpop is true
```

#### Public Client Rejected Error

```bash
# Verify FAPI configuration
curl -X GET https://your-authrim.com/api/admin/settings | \
  jq '.settings.fapi.allowPublicClients'

# Verify it is false (required for FAPI 2.0)
```

## Reference Links

- [OpenID Certification](https://www.certification.openid.net/)
- [FAPI 2.0 Specification](https://openid.net/specs/fapi-security-profile-2_0-final.html)
- [RFC 9126: OAuth 2.0 Pushed Authorization Requests](https://www.rfc-editor.org/rfc/rfc9126.html)
- [RFC 9449: OAuth 2.0 Demonstrating Proof of Possession](https://www.rfc-editor.org/rfc/rfc9449.html)
- [RFC 9207: OAuth 2.0 Authorization Server Issuer Identification](https://www.rfc-editor.org/rfc/rfc9207.html)
- [RFC 7636: Proof Key for Code Exchange (PKCE)](https://www.rfc-editor.org/rfc/rfc7636.html)

## Summary

Authrim allows you to easily switch OpenID Connect profiles via the Admin API:

1. **Get profile list**: `GET /api/admin/settings/profiles`
2. **Apply profile**: `PUT /api/admin/settings/profile/:profileName`
3. **Verify settings**: `GET /.well-known/openid-configuration`
4. **Run Certification tests**: https://www.certification.openid.net/

Each profile is pre-configured to comply with the corresponding OpenID Connect specification, so manual configuration adjustment is not required.
