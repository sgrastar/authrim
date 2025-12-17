# Admin Settings API

**Last Updated**: 2025-12-15

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

## Region Shards Settings

Region sharding enables Durable Objects (SessionStore, AuthCodeStore, ChallengeStore) to be placed in specific geographic regions using Cloudflare's `locationHint` feature. This reduces latency for users in specific regions.

### GET /api/admin/settings/region-shards

Get current region sharding configuration.

**Response**:
```json
{
  "currentGeneration": 1,
  "currentTotalShards": 20,
  "currentRegions": {
    "wnam": {
      "startShard": 0,
      "endShard": 19,
      "shardCount": 20
    }
  },
  "previousGenerations": [],
  "maxPreviousGenerations": 5,
  "updatedAt": 1702644000000,
  "updatedBy": "admin-api"
}
```

### PUT /api/admin/settings/region-shards

Update region sharding configuration. If `totalShards` or `regionDistribution` changes, a new generation is created automatically.

**Request Body**:
```json
{
  "totalShards": 20,
  "regionDistribution": {
    "wnam": 100
  }
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| totalShards | number | Yes | >= active region count | Total number of shards |
| regionDistribution | object | Yes | Must sum to 100 | Percentage allocation per region |

**Valid Region Keys**:
| Key | Region | Cloudflare Location |
|-----|--------|---------------------|
| `apac` | Asia Pacific | Tokyo, Singapore, Sydney |
| `enam` | Eastern North America | Ashburn, Virginia |
| `wnam` | Western North America | Portland, Oregon |
| `weur` | Western Europe | Frankfurt, London |
| `oc` | Oceania | Sydney |
| `afr` | Africa | Johannesburg |
| `me` | Middle East | Dubai |

**Response**:
```json
{
  "success": true,
  "generationIncremented": true,
  "currentGeneration": 2,
  "currentTotalShards": 20,
  "currentRegions": {
    "wnam": {
      "startShard": 0,
      "endShard": 19,
      "shardCount": 20
    }
  },
  "previousGenerationsCount": 1,
  "updatedAt": 1702644000000,
  "note": "New generation created. Existing resources will continue to use old config until they expire."
}
```

**Validation Rules**:
- `regionDistribution` percentages must sum to exactly 100
- `totalShards` must be >= number of active regions (percentage > 0)
- Each region with percentage > 0 must get at least 1 shard after rounding
- Regions with 0% are allowed (disabled regions)
- Only valid region keys are accepted

### DELETE /api/admin/settings/region-shards

Delete region sharding configuration (reset to defaults).

**Response**:
```json
{
  "success": true,
  "message": "Region shard configuration deleted. System will use defaults.",
  "defaults": {
    "totalShards": 20,
    "regionDistribution": {
      "apac": 20,
      "enam": 40,
      "weur": 40
    },
    "regions": {
      "apac": { "startShard": 0, "endShard": 3, "shardCount": 4 },
      "enam": { "startShard": 4, "endShard": 11, "shardCount": 8 },
      "weur": { "startShard": 12, "endShard": 19, "shardCount": 8 }
    }
  },
  "note": "Existing resources with embedded generation/region info will continue to work."
}
```

### Region Sharding Examples

**Example 1: US West Only (for k6 Cloud Portland)**
```bash
curl -X PUT https://your-domain.com/api/admin/settings/region-shards \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"totalShards": 20, "regionDistribution": {"wnam": 100}}'
```

**Example 2: Multi-Region Distribution**
```bash
curl -X PUT https://your-domain.com/api/admin/settings/region-shards \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"totalShards": 20, "regionDistribution": {"apac": 20, "enam": 40, "weur": 40}}'
```

**Example 3: Using wrangler directly**
```bash
# Set configuration (US West 100%)
npx wrangler kv key put "region_shard_config:default" \
  '{"currentGeneration":1,"currentTotalShards":20,"currentRegions":{"wnam":{"startShard":0,"endShard":19,"shardCount":20}},"previousGenerations":[],"maxPreviousGenerations":5,"updatedAt":1702644000000,"updatedBy":"wrangler"}' \
  --namespace-id=YOUR_NAMESPACE_ID --remote

# Check current value
npx wrangler kv key get "region_shard_config:default" \
  --namespace-id=YOUR_NAMESPACE_ID --remote

# Delete (reset to default)
npx wrangler kv key delete "region_shard_config:default" \
  --namespace-id=YOUR_NAMESPACE_ID --remote
```

### k6 Cloud Load Zone Mapping

| k6 Cloud Load Zone | Cloudflare Region Key |
|-------------------|----------------------|
| `amazon:us:portland` | `wnam` |
| `amazon:us:ashburn` | `enam` |
| `amazon:jp:tokyo` | `apac` |
| `amazon:eu:frankfurt` | `weur` |

---

## Introspection Cache Settings

Token Introspection (RFC 7662) のレスポンスをキャッシュする設定です。キャッシュは `active=true` のレスポンスのみを対象とし、revocation 状態は常にフレッシュに確認されます。

### GET /api/admin/settings/introspection-cache

Get current introspection cache configuration.

**Response**:
```json
{
  "settings": {
    "enabled": {
      "value": true,
      "source": "default",
      "default": true,
      "description": "When enabled, caches active=true introspection responses to reduce KeyManager DO and D1 load"
    },
    "ttlSeconds": {
      "value": 60,
      "source": "default",
      "default": 60,
      "description": "Cache TTL in seconds (recommended: 30-120 seconds)"
    }
  },
  "note": "Cache only stores active=true responses. Revocation checks bypass cache for security."
}
```

### PUT /api/admin/settings/introspection-cache

Update introspection cache settings.

**Request Body**:
```json
{
  "enabled": true,
  "ttlSeconds": 60
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| enabled | boolean | No | - | Enable/disable caching |
| ttlSeconds | number | No | 1 - 3600 | Cache TTL in seconds |

**Response**:
```json
{
  "success": true,
  "settings": {
    "enabled": true,
    "ttlSeconds": 60
  },
  "note": "Introspection cache settings updated successfully."
}
```

### DELETE /api/admin/settings/introspection-cache

Clear introspection cache settings override (revert to env/default).

**Response**:
```json
{
  "success": true,
  "settings": {
    "enabled": true,
    "ttlSeconds": 60
  },
  "sources": {
    "enabled": "default",
    "ttlSeconds": "default"
  },
  "note": "Introspection cache settings cleared. Using env/default values."
}
```

### Security Considerations

1. **Only `active=true` responses are cached** - Inactive token responses are never cached to prevent false positives
2. **Revocation is always checked fresh** - Even on cache hit, the revocation status is verified in real-time
3. **Cache key is hashed** - JTI values are SHA-256 hashed to prevent key enumeration attacks
4. **RFC 7662 Section 4 compliance** - The spec's "no caching" requirement refers to HTTP caching; application-level caching is acceptable
5. **Industry standard** - Similar caching is implemented by Keycloak, Auth0, and other major providers

### Cache Behavior

```
┌─────────────────────────────────────────────────────────────────┐
│                    Introspection Request Flow                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Parse token → Extract JTI                                   │
│                    ↓                                            │
│  2. Check cache (if enabled)                                    │
│      ├── Cache HIT → Check expiration → Check revocation        │
│      │                                    ├── Not revoked → ✓   │
│      │                                    └── Revoked → Delete  │
│      │                                         cache → active:  │
│      │                                         false            │
│      └── Cache MISS → Continue full validation                  │
│                    ↓                                            │
│  3. Full validation (signature, claims, revocation)             │
│                    ↓                                            │
│  4. If active=true → Store in cache with TTL                    │
│                    ↓                                            │
│  5. Return response                                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `INTROSPECTION_CACHE_ENABLED` | string | "true" | Enable caching ("true"/"false") |
| `INTROSPECTION_CACHE_TTL_SECONDS` | string | "60" | Cache TTL in seconds |

### CLI Examples

```bash
# Enable cache with 30 second TTL
curl -X PUT https://your-domain.com/api/admin/settings/introspection-cache \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "ttlSeconds": 30}'

# Disable cache for debugging
curl -X PUT https://your-domain.com/api/admin/settings/introspection-cache \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# Reset to defaults
curl -X DELETE https://your-domain.com/api/admin/settings/introspection-cache \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET"
```

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
| Region Shard Config | `region_shard_config:default` | JSON | See below |

### Region Shard Config Default

```json
{
  "currentGeneration": 1,
  "currentTotalShards": 20,
  "currentRegions": {
    "apac": { "startShard": 0, "endShard": 3, "shardCount": 4 },
    "enam": { "startShard": 4, "endShard": 11, "shardCount": 8 },
    "weur": { "startShard": 12, "endShard": 19, "shardCount": 8 }
  },
  "previousGenerations": [],
  "maxPreviousGenerations": 5
}
```

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
