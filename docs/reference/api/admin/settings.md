# Admin Settings API

**Last Updated**: 2025-12-11

Administrative API for dynamic system configuration. These settings can be modified at runtime without requiring redeployment.

---

## Overview

The Settings API allows administrators to configure system behavior dynamically. All settings use a **hybrid approach**:

**Configuration Priority**:
1. **In-memory Cache** (10 second TTL) - For performance
2. **KV Store** (AUTHRIM_CONFIG) - Dynamic override
3. **Environment Variable** - Deployment-time default
4. **Default Value** - Hardcoded fallback

This allows settings to be changed instantly via API while maintaining performance through caching.

---

## Authentication

All Settings API endpoints require admin authentication:

```http
Authorization: Bearer {admin_access_token}
```

Or using Admin API Secret (for automation):

```http
X-Admin-Secret: {ADMIN_API_SECRET}
```

---

## Rate Limit Settings

### GET /api/admin/settings/rate-limit

Get all rate limit profile configurations.

**Response**:
```json
{
  "profiles": {
    "strict": {
      "current": { "maxRequests": 10, "windowSeconds": 60 },
      "source": { "maxRequests": "default", "windowSeconds": "default" },
      "default": { "maxRequests": 10, "windowSeconds": 60 },
      "kv_values": { "maxRequests": null, "windowSeconds": null }
    },
    "moderate": {
      "current": { "maxRequests": 60, "windowSeconds": 60 },
      "source": { "maxRequests": "default", "windowSeconds": "default" },
      "default": { "maxRequests": 60, "windowSeconds": 60 },
      "kv_values": { "maxRequests": null, "windowSeconds": null }
    },
    "lenient": {
      "current": { "maxRequests": 300, "windowSeconds": 60 },
      "source": { "maxRequests": "default", "windowSeconds": "default" },
      "default": { "maxRequests": 300, "windowSeconds": 60 },
      "kv_values": { "maxRequests": null, "windowSeconds": null }
    },
    "loadTest": {
      "current": { "maxRequests": 20000, "windowSeconds": 60 },
      "source": { "maxRequests": "kv", "windowSeconds": "default" },
      "default": { "maxRequests": 10000, "windowSeconds": 60 },
      "kv_values": { "maxRequests": "20000", "windowSeconds": null }
    }
  },
  "env_rate_limit_profile": "loadTest",
  "cache_ttl_seconds": 10,
  "note": "Changes take effect within 10 seconds (cache TTL)"
}
```

### GET /api/admin/settings/rate-limit/:profile

Get specific rate limit profile configuration.

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| profile | string | Profile name: `strict`, `moderate`, `lenient`, `loadTest` |

**Response**:
```json
{
  "profile": "loadTest",
  "current": {
    "maxRequests": 20000,
    "windowSeconds": 60
  },
  "source": {
    "maxRequests": "kv",
    "windowSeconds": "default"
  },
  "default": {
    "maxRequests": 10000,
    "windowSeconds": 60
  },
  "kv_keys": {
    "maxRequests": "rate_limit_loadtest_max_requests",
    "windowSeconds": "rate_limit_loadtest_window_seconds"
  }
}
```

### PUT /api/admin/settings/rate-limit/:profile

Update rate limit profile settings.

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| profile | string | Profile name: `strict`, `moderate`, `lenient`, `loadTest` |

**Request Body**:
```json
{
  "maxRequests": 20000,
  "windowSeconds": 60
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| maxRequests | number | No | 1 - 1,000,000 | Maximum requests per window |
| windowSeconds | number | No | 1 - 86400 | Time window in seconds |

**Response**:
```json
{
  "success": true,
  "profile": "loadTest",
  "updated": {
    "maxRequests": 20000,
    "windowSeconds": null
  },
  "kv_keys": {
    "maxRequests": "rate_limit_loadtest_max_requests",
    "windowSeconds": "rate_limit_loadtest_window_seconds"
  },
  "note": "Changes will take effect within 10 seconds (cache TTL)"
}
```

### DELETE /api/admin/settings/rate-limit/:profile

Reset rate limit profile to default values (removes KV overrides).

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| profile | string | Profile name: `strict`, `moderate`, `lenient`, `loadTest` |

**Response**:
```json
{
  "success": true,
  "profile": "loadTest",
  "reset_to_default": {
    "maxRequests": 10000,
    "windowSeconds": 60
  },
  "note": "Profile reset to default values. Changes will take effect within 10 seconds."
}
```

---

## Rate Limit Profiles

| Profile | Default maxRequests | Default windowSeconds | Usage |
|---------|---------------------|----------------------|-------|
| `strict` | 10 | 60 | Sensitive endpoints (token, PAR) |
| `moderate` | 60 | 60 | Standard API endpoints |
| `lenient` | 300 | 60 | Public endpoints (discovery, JWKS) |
| `loadTest` | 10,000 | 60 | Load testing mode |

---

## Code Shards Settings

### GET /api/admin/settings/code-shards

Get authorization code shard configuration.

**Response**:
```json
{
  "current": 64,
  "source": "kv",
  "kv_value": "64",
  "env_value": null
}
```

### PUT /api/admin/settings/code-shards

Update authorization code shard count.

**Request Body**:
```json
{
  "shards": 128
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| shards | number | Yes | 1 - 256 | Number of authorization code shards |

**Response**:
```json
{
  "success": true,
  "shards": 128,
  "note": "Cache will refresh within 10 seconds"
}
```

---

## OAuth Configuration Settings

### GET /api/admin/settings/oauth-config

Get all OAuth/OIDC configuration values.

### PUT /api/admin/settings/oauth-config/:name

Update specific OAuth configuration value.

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| name | string | Configuration key name |

### DELETE /api/admin/settings/oauth-config/:name

Reset specific OAuth configuration to default.

---

## Refresh Token Sharding Settings

### GET /api/admin/settings/refresh-token-sharding

Get refresh token sharding configuration.

### PUT /api/admin/settings/refresh-token-sharding

Update refresh token sharding settings.

### GET /api/admin/settings/refresh-token-sharding/stats

Get refresh token shard distribution statistics.

### DELETE /api/admin/settings/refresh-token-sharding/cleanup

Cleanup old generation shards after shard count changes.

---

## KV Key Reference

All settings are stored in the `AUTHRIM_CONFIG` KV namespace with the following keys:

| Setting | KV Key | Type | Default |
|---------|--------|------|---------|
| Code Shards | `code_shards` | number | 64 |
| Session Shards | `session_shards` | number | 32 |
| Rate Limit (strict) maxRequests | `rate_limit_strict_max_requests` | number | 10 |
| Rate Limit (strict) windowSeconds | `rate_limit_strict_window_seconds` | number | 60 |
| Rate Limit (moderate) maxRequests | `rate_limit_moderate_max_requests` | number | 60 |
| Rate Limit (moderate) windowSeconds | `rate_limit_moderate_window_seconds` | number | 60 |
| Rate Limit (lenient) maxRequests | `rate_limit_lenient_max_requests` | number | 300 |
| Rate Limit (lenient) windowSeconds | `rate_limit_lenient_window_seconds` | number | 60 |
| Rate Limit (loadTest) maxRequests | `rate_limit_loadtest_max_requests` | number | 10,000 |
| Rate Limit (loadTest) windowSeconds | `rate_limit_loadtest_window_seconds` | number | 60 |
| RBAC Cache TTL | `rbac_cache_ttl` | number | 600 |

---

## Error Responses

### 400 Bad Request

```json
{
  "error": "invalid_profile",
  "error_description": "Invalid profile name. Valid profiles: strict, moderate, lenient, loadTest"
}
```

```json
{
  "error": "invalid_max_requests",
  "error_description": "maxRequests must be a number between 1 and 1,000,000"
}
```

### 500 Internal Server Error

```json
{
  "error": "kv_not_configured",
  "error_description": "AUTHRIM_CONFIG KV namespace is not configured"
}
```

---

## CLI Examples

### Using wrangler directly

```bash
# Set rate limit for load testing (bypassing API)
npx wrangler kv key put "rate_limit_loadtest_max_requests" "20000" \
  --namespace-id=YOUR_NAMESPACE_ID --remote

# Check current value
npx wrangler kv key get "rate_limit_loadtest_max_requests" \
  --namespace-id=YOUR_NAMESPACE_ID --remote

# Delete override (reset to default)
npx wrangler kv key delete "rate_limit_loadtest_max_requests" \
  --namespace-id=YOUR_NAMESPACE_ID --remote
```

### Using curl with Admin API

```bash
# Get all rate limit settings
curl -X GET https://your-domain.com/api/admin/settings/rate-limit \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET"

# Update loadTest profile
curl -X PUT https://your-domain.com/api/admin/settings/rate-limit/loadTest \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"maxRequests": 50000}'

# Reset to default
curl -X DELETE https://your-domain.com/api/admin/settings/rate-limit/loadTest \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET"
```
