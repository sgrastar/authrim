# Admin Settings API

**Last Updated**: 2025-12-25

Administrative API for dynamic system configuration. These settings can be modified at runtime without requiring redeployment.

---

## Overview

The Settings API allows administrators to configure system behavior dynamically. All settings use a **hybrid approach**:

**Configuration Priority**:

1. **Environment Variable** (env) - Deployment-time override (highest priority)
2. **KV Store** (AUTHRIM_CONFIG) - Dynamic override via API
3. **Default Value** - Secure code default (fallback)

This allows settings to be changed instantly via API while maintaining performance through caching (5-second TTL).

---

## ⭐ Settings API v2 (Recommended)

> **NEW in December 2025**: Unified settings management with category-based endpoints, optimistic locking, and audit logging.

### Key Features

- **URL-based scope**: `tenantId` / `clientId` in URL prevents accidental cross-tenant changes
- **PATCH with ifMatch**: Optimistic locking prevents concurrent update conflicts
- **Source tracking**: Know where each setting value comes from (env/kv/default)
- **Audit logging**: All changes are automatically logged with actor and diff

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/tenants/:tenantId/settings/:category` | GET | Get tenant settings |
| `/api/admin/tenants/:tenantId/settings/:category` | PATCH | Update tenant settings |
| `/api/admin/clients/:clientId/settings` | GET | Get client settings |
| `/api/admin/clients/:clientId/settings` | PATCH | Update client settings |
| `/api/admin/platform/settings/:category` | GET | Get platform settings (read-only) |
| `/api/admin/settings/meta/:category` | GET | Get settings metadata |
| `/api/admin/settings/meta` | GET | List all categories |
| `/api/admin/settings/migrate` | POST | Migrate from v1 to v2 format |
| `/api/admin/settings/migrate/status` | GET | Get migration status |

### Categories

| Category | Scope | Description | Settings Count |
|----------|-------|-------------|----------------|
| `oauth` | Tenant | OAuth/OIDC settings | 85+ |
| `session` | Tenant | Session management | 12 |
| `security` | Tenant | Security policies | 11 |
| `consent` | Tenant | Consent handling | 8 |
| `ciba` | Tenant | CIBA flow settings | 7 |
| `rate-limit` | Tenant | Rate limiting | 7 |
| `device-flow` | Tenant | Device flow settings | 5 |
| `tokens` | Tenant | Token settings | 5 |
| `external-idp` | Tenant | External IdP settings | 4 |
| `credentials` | Tenant | Credential settings | 7 |
| `federation` | Tenant | Federation settings | 7 |
| `scim` | Tenant | SCIM provisioning | 7 |
| `client` | Client | Per-client settings | 42 |
| `infrastructure` | Platform | Infrastructure (read-only) | 85 |
| `encryption` | Platform | Encryption keys (read-only) | 10 |

### GET Response Format

```json
{
  "category": "oauth",
  "scope": { "type": "tenant", "id": "tenant_123" },
  "version": "sha256:9b1c...",
  "values": {
    "oauth.access_token_expiry": 3600,
    "oauth.refresh_token_rotation": true
  },
  "sources": {
    "oauth.access_token_expiry": "env",
    "oauth.refresh_token_rotation": "kv"
  }
}
```

### PATCH Request Format (ifMatch Required)

```json
{
  "ifMatch": "sha256:9b1c...",
  "set": {
    "oauth.access_token_expiry": 1800
  },
  "clear": ["oauth.refresh_token_rotation"],
  "disable": ["oauth.some_optional_feature"]
}
```

| Operation | Description |
|-----------|-------------|
| `set` | Set key to value (stored in KV) |
| `clear` | Remove KV override, fall back to env/default |
| `disable` | Explicitly disable (value becomes `false`) |

### PATCH Response Format

```json
{
  "version": "sha256:aa02...",
  "applied": ["oauth.access_token_expiry"],
  "cleared": ["oauth.refresh_token_rotation"],
  "disabled": ["oauth.some_optional_feature"],
  "rejected": {
    "oauth.pkce_required": "read-only (env override)"
  }
}
```

### Error Responses

**409 Conflict** (Version mismatch):
```json
{
  "error": "conflict",
  "message": "Settings were updated by someone else. Please refresh.",
  "currentVersion": "sha256:aa02..."
}
```

**405 Method Not Allowed** (Platform settings):
```json
{
  "error": "method_not_allowed",
  "message": "Platform settings are read-only"
}
```

### CLI Examples (v2)

```bash
# Get tenant OAuth settings
curl -X GET "https://your-domain.com/api/admin/tenants/default/settings/oauth" \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET"

# Update tenant OAuth settings (with optimistic locking)
VERSION=$(curl -s "https://your-domain.com/api/admin/tenants/default/settings/oauth" \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" | jq -r '.version')

curl -X PATCH "https://your-domain.com/api/admin/tenants/default/settings/oauth" \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d "{
    \"ifMatch\": \"$VERSION\",
    \"set\": { \"oauth.access_token_expiry\": 1800 }
  }"

# Get settings metadata
curl -X GET "https://your-domain.com/api/admin/settings/meta/oauth" \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET"

# Migrate from v1 to v2 (dry-run first!)
curl -X POST "https://your-domain.com/api/admin/settings/migrate" \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

---

## Legacy Settings API (Deprecated)

> **⚠️ DEPRECATED**: The following endpoints are deprecated and will be removed in a future release. Please migrate to Settings API v2.

> **Note**: The legacy cache TTL was 180 seconds (3 minutes). The new v2 API uses 5-second TTL for faster propagation.

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
  "cache_ttl_seconds": 180,
  "note": "Changes take effect within 180 seconds (cache TTL)"
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

| Field         | Type   | Required | Constraints   | Description                 |
| ------------- | ------ | -------- | ------------- | --------------------------- |
| maxRequests   | number | No       | 1 - 1,000,000 | Maximum requests per window |
| windowSeconds | number | No       | 1 - 86400     | Time window in seconds      |

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
  "note": "Changes will take effect within 180 seconds (cache TTL)"
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
  "note": "Profile reset to default values. Changes will take effect within 180 seconds."
}
```

---

## Rate Limit Profiles

| Profile    | Default maxRequests | Default windowSeconds | Usage                              |
| ---------- | ------------------- | --------------------- | ---------------------------------- |
| `strict`   | 10                  | 60                    | Sensitive endpoints (token, PAR)   |
| `moderate` | 60                  | 60                    | Standard API endpoints             |
| `lenient`  | 300                 | 60                    | Public endpoints (discovery, JWKS) |
| `loadTest` | 10,000              | 60                    | Load testing mode                  |

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

| Field  | Type   | Required | Constraints | Description                         |
| ------ | ------ | -------- | ----------- | ----------------------------------- |
| shards | number | Yes      | 1 - 256     | Number of authorization code shards |

**Response**:

```json
{
  "success": true,
  "shards": 128,
  "note": "Cache will refresh within 180 seconds"
}
```

---

## OAuth Configuration Settings

Centralized configuration for OAuth/OIDC parameters. All settings follow the **KV > env > default** priority.

### GET /api/admin/settings/oauth-config

Get all OAuth/OIDC configuration values with their sources.

**Response**:

```json
{
  "configs": {
    "TOKEN_EXPIRY": {
      "value": 3600,
      "source": "default",
      "default": 3600,
      "metadata": {
        "type": "number",
        "label": "Access Token TTL",
        "description": "Access token lifetime in seconds",
        "min": 60,
        "max": 86400,
        "unit": "seconds"
      }
    },
    "USER_CACHE_TTL": {
      "value": 3600,
      "source": "kv",
      "default": 3600,
      "metadata": {
        "type": "number",
        "label": "User Cache TTL",
        "description": "User cache (includes PII) TTL in seconds. Lower values provide fresher data but more DB load. Set shorter for stricter PII handling.",
        "min": 60,
        "max": 86400,
        "unit": "seconds"
      }
    }
  }
}
```

### PUT /api/admin/settings/oauth-config/:name

Update specific OAuth configuration value (stored in KV).

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| name | string | Configuration key name (see table below) |

**Request Body**:

```json
{
  "value": 1800
}
```

**Response**:

```json
{
  "success": true,
  "config": "USER_CACHE_TTL",
  "value": 1800,
  "note": "Config updated. Cache will refresh within 180 seconds."
}
```

### DELETE /api/admin/settings/oauth-config/:name

Reset specific OAuth configuration to default (removes KV override).

**Response**:

```json
{
  "success": true,
  "config": "USER_CACHE_TTL",
  "note": "Config override cleared. Will use env/default value. Cache will refresh within 180 seconds."
}
```

### DELETE /api/admin/settings/oauth-config

Reset all OAuth configuration overrides (revert all to env/default).

**Response**:

```json
{
  "success": true,
  "note": "All config overrides cleared. Will use env/default values. Cache will refresh within 180 seconds."
}
```

### Available Configuration Keys

| Key                              | Type    | Default | Min  | Max      | Description                                    |
| -------------------------------- | ------- | ------- | ---- | -------- | ---------------------------------------------- |
| `TOKEN_EXPIRY`                   | number  | 3600    | 60   | 86400    | Access token TTL in seconds                    |
| `AUTH_CODE_TTL`                  | number  | 60      | 10   | 86400    | Authorization code TTL in seconds              |
| `STATE_EXPIRY`                   | number  | 300     | 60   | 3600     | OAuth state parameter TTL in seconds           |
| `NONCE_EXPIRY`                   | number  | 300     | 60   | 3600     | OIDC nonce TTL in seconds                      |
| `REFRESH_TOKEN_EXPIRY`           | number  | 7776000 | 3600 | 31536000 | Refresh token TTL in seconds (90 days default) |
| `REFRESH_TOKEN_ROTATION_ENABLED` | boolean | true    | -    | -        | Enable refresh token rotation                  |
| `MAX_CODES_PER_USER`             | number  | 100     | 10   | 1000000  | Max auth codes per user (DDoS protection)      |
| `CODE_SHARDS`                    | number  | 64      | 1    | 256      | Number of auth code DO shards                  |
| `STATE_REQUIRED`                 | boolean | false   | -    | -        | Require state parameter (CSRF protection)      |
| `USERINFO_REQUIRE_OPENID_SCOPE`  | boolean | true    | -    | -        | Require openid scope for UserInfo endpoint     |
| `USER_CACHE_TTL`                 | number  | 3600    | 60   | 86400    | User cache TTL in seconds (includes PII)       |
| `CONSENT_CACHE_TTL`              | number  | 86400   | 60   | 604800   | Consent cache TTL in seconds                   |
| `CONFIG_CACHE_TTL`               | number  | 180     | 10   | 3600     | In-memory config cache TTL in seconds          |

### Environment Variable Override

Each configuration can also be set via environment variable (requires redeployment):

```bash
# Example environment variables
TOKEN_EXPIRY=3600
AUTH_CODE_TTL=60
USER_CACHE_TTL=3600
CONSENT_CACHE_TTL=86400
```

### CLI Examples

```bash
# Get all OAuth config values
curl -X GET https://your-domain.com/api/admin/settings/oauth-config \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET"

# Set USER_CACHE_TTL to 5 minutes (stricter PII handling)
curl -X PUT https://your-domain.com/api/admin/settings/oauth-config/USER_CACHE_TTL \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"value": 300}'

# Set CONSENT_CACHE_TTL to 1 hour
curl -X PUT https://your-domain.com/api/admin/settings/oauth-config/CONSENT_CACHE_TTL \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"value": 3600}'

# Reset USER_CACHE_TTL to default
curl -X DELETE https://your-domain.com/api/admin/settings/oauth-config/USER_CACHE_TTL \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET"

# Reset all OAuth config to defaults
curl -X DELETE https://your-domain.com/api/admin/settings/oauth-config \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET"
```

### Cache TTL Considerations

**USER_CACHE_TTL** contains PII (email, name, phone, address). Consider these trade-offs:

| TTL Setting       | Performance     | Data Freshness | PII Exposure Window |
| ----------------- | --------------- | -------------- | ------------------- |
| 60s (1 min)       | More DB load    | Very fresh     | Minimal             |
| 300s (5 min)      | Moderate        | Fresh          | Short               |
| 3600s (1 hour)    | Optimal         | Good           | Standard            |
| 86400s (24 hours) | Minimal DB load | May be stale   | Extended            |

**Recommendation**: For stricter PII handling (e.g., healthcare, finance), consider setting `USER_CACHE_TTL` to 300-600 seconds.

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

Region sharding enables Durable Objects (SessionStore, AuthCodeStore, ChallengeStore, DPoPJTIStore, PARRequestStore, etc.) to be placed in specific geographic regions using Cloudflare's `locationHint` feature. This reduces latency for users in specific regions.

**V2 Features**:

- Colocation groups (user-client group ensures AuthCode and RefreshToken are colocated)
- Per-group shard count configuration
- Rolling migration with generation tracking
- Environment variable fallback support

### Configuration Priority

```
1. KV Store (region_shard_config:{tenantId})  → Dynamic configuration
2. Environment Variables                       → Deployment-time defaults
3. Hardcoded Defaults                          → Safe fallback
```

**Environment Variables**:

| Variable                    | Type   | Default | Description                       |
| --------------------------- | ------ | ------- | --------------------------------- |
| `REGION_SHARD_TOTAL_SHARDS` | number | 20      | Default total shards              |
| `REGION_SHARD_GENERATION`   | number | 1       | Current generation                |
| `REGION_SHARD_APAC_PERCENT` | number | 20      | APAC region percentage            |
| `REGION_SHARD_ENAM_PERCENT` | number | 40      | Eastern North America percentage  |
| `REGION_SHARD_WEUR_PERCENT` | number | 40      | Western Europe percentage         |
| `REGION_SHARD_GROUPS_JSON`  | string | -       | JSON-encoded groups configuration |

### GET /api/admin/settings/region-shards

Get current region sharding configuration (V2 format with groups).

**Response**:

```json
{
  "version": 2,
  "currentGeneration": 1,
  "currentTotalShards": 20,
  "baseRegions": {
    "apac": 20,
    "enam": 40,
    "weur": 40
  },
  "currentRegions": {
    "apac": { "startShard": 0, "endShard": 3, "shardCount": 4 },
    "enam": { "startShard": 4, "endShard": 11, "shardCount": 8 },
    "weur": { "startShard": 12, "endShard": 19, "shardCount": 8 }
  },
  "groups": {
    "user-client": {
      "totalShards": 64,
      "members": ["authcode", "refresh"],
      "description": "Colocated by userId:clientId - MUST have identical shard counts"
    },
    "random-high-rps": {
      "totalShards": 64,
      "members": ["revocation", "dpop"],
      "description": "High RPS endpoints with random UUID keys"
    },
    "random-medium-rps": {
      "totalShards": 32,
      "members": ["session", "challenge"],
      "description": "Medium RPS endpoints"
    },
    "client-based": {
      "totalShards": 32,
      "members": ["par", "device", "ciba"],
      "description": "client_id based sharding"
    },
    "vc": {
      "totalShards": 16,
      "members": ["credoffer", "vprequest"],
      "description": "Verifiable Credentials"
    }
  },
  "previousGenerations": [],
  "maxPreviousGenerations": 5,
  "updatedAt": 1702644000000,
  "updatedBy": "admin-api",
  "source": "kv"
}
```

### PUT /api/admin/settings/region-shards

Update region sharding configuration. If `totalShards`, `regionDistribution`, or `groups` changes, a new generation is created automatically.

**Request Body**:

```json
{
  "totalShards": 20,
  "regionDistribution": {
    "apac": 20,
    "enam": 40,
    "weur": 40
  },
  "groups": {
    "user-client": {
      "totalShards": 64,
      "members": ["authcode", "refresh"]
    },
    "client-based": {
      "totalShards": 32,
      "members": ["par", "device", "ciba", "dpop"]
    }
  }
}
```

| Field              | Type   | Required | Constraints            | Description                      |
| ------------------ | ------ | -------- | ---------------------- | -------------------------------- |
| totalShards        | number | Yes      | >= active region count | Total number of shards           |
| regionDistribution | object | Yes      | Must sum to 100        | Percentage allocation per region |
| groups             | object | No       | Valid group structure  | Per-group shard configuration    |

**Valid Region Keys**:

| Key    | Region                | Cloudflare Location      |
| ------ | --------------------- | ------------------------ |
| `apac` | Asia Pacific          | Tokyo, Singapore, Sydney |
| `enam` | Eastern North America | Ashburn, Virginia        |
| `wnam` | Western North America | Portland, Oregon         |
| `weur` | Western Europe        | Frankfurt, London        |
| `oc`   | Oceania               | Sydney                   |
| `afr`  | Africa                | Johannesburg             |
| `me`   | Middle East           | Dubai                    |

**Response**:

```json
{
  "success": true,
  "generationIncremented": true,
  "currentGeneration": 2,
  "currentTotalShards": 20,
  "currentRegions": {
    "apac": { "startShard": 0, "endShard": 3, "shardCount": 4 },
    "enam": { "startShard": 4, "endShard": 11, "shardCount": 8 },
    "weur": { "startShard": 12, "endShard": 19, "shardCount": 8 }
  },
  "groups": { ... },
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
- **CRITICAL**: `user-client` group members MUST have identical shard counts

### POST /api/admin/settings/region-shards/migrate

Create a new generation for rolling migration. Use this for shard count changes without breaking existing resources.

**Request Body**:

```json
{
  "totalShards": 64,
  "regionDistribution": {
    "apac": 30,
    "enam": 35,
    "weur": 35
  }
}
```

**Response**:

```json
{
  "success": true,
  "previousGeneration": 1,
  "newGeneration": 2,
  "previousTotalShards": 20,
  "newTotalShards": 64,
  "newRegions": {
    "apac": { "startShard": 0, "endShard": 18, "shardCount": 19 },
    "enam": { "startShard": 19, "endShard": 41, "shardCount": 23 },
    "weur": { "startShard": 42, "endShard": 63, "shardCount": 22 }
  },
  "note": "New generation created. Writes go to gen 2, reads fall back to gen 1."
}
```

### GET /api/admin/settings/region-shards/validate

Validate current configuration for potential issues.

**Response** (valid):

```json
{
  "valid": true,
  "checks": {
    "regionDistributionSum": { "passed": true, "value": 100 },
    "userClientGroupColocation": { "passed": true, "shardCounts": [64, 64] },
    "minShardsPerRegion": { "passed": true },
    "previousGenerationsLimit": { "passed": true, "count": 1, "max": 5 }
  }
}
```

**Response** (invalid):

```json
{
  "valid": false,
  "checks": {
    "regionDistributionSum": { "passed": false, "value": 90, "error": "Must sum to 100" },
    "userClientGroupColocation": {
      "passed": false,
      "shardCounts": [64, 32],
      "error": "CRITICAL: user-client group members have mismatched shard counts. This will cause intermittent auth failures."
    }
  }
}
```

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

### Colocation Groups

**⚠️ CRITICAL: user-client Group**

The `user-client` group (AuthCodeStore + RefreshTokenRotator) MUST have identical shard counts. Mismatched shard counts cause intermittent authentication failures:

```
Why colocation matters:
- Auth code issued → stored in AuthCodeStore shard N (based on userId:clientId)
- Token request → RefreshToken stored in RefreshTokenRotator shard N
- If shard counts differ:
  - hash("user1:client1") % 64 = 15
  - hash("user1:client1") % 32 = 15 (coincidence, works)
  - hash("user2:client2") % 64 = 47
  - hash("user2:client2") % 32 = 15 (DIFFERENT! breaks)
```

### Region Sharding Examples

**Example 1: US West Only (for k6 Cloud Portland)**

```bash
curl -X PUT https://your-domain.com/api/admin/settings/region-shards \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"totalShards": 20, "regionDistribution": {"wnam": 100}}'
```

**Example 2: Multi-Region Distribution with Groups**

```bash
curl -X PUT https://your-domain.com/api/admin/settings/region-shards \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "totalShards": 64,
    "regionDistribution": {"apac": 20, "enam": 40, "weur": 40},
    "groups": {
      "user-client": {"totalShards": 64, "members": ["authcode", "refresh"]},
      "client-based": {"totalShards": 32, "members": ["par", "dpop"]}
    }
  }'
```

**Example 3: Rolling Migration**

```bash
# Step 1: Create new generation
curl -X POST https://your-domain.com/api/admin/settings/region-shards/migrate \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"totalShards": 64, "regionDistribution": {"apac": 30, "enam": 35, "weur": 35}}'

# Step 2: Validate configuration
curl -X GET https://your-domain.com/api/admin/settings/region-shards/validate \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET"
```

**Example 4: Using wrangler directly**

```bash
# Set configuration (US West 100%)
npx wrangler kv key put "region_shard_config:default" \
  '{"version":2,"currentGeneration":1,"currentTotalShards":20,"baseRegions":{"wnam":100},"currentRegions":{"wnam":{"startShard":0,"endShard":19,"shardCount":20}},"groups":{},"previousGenerations":[],"maxPreviousGenerations":5,"updatedAt":1702644000000,"updatedBy":"wrangler"}' \
  --namespace-id=YOUR_NAMESPACE_ID --remote

# Check current value
npx wrangler kv key get "region_shard_config:default" \
  --namespace-id=YOUR_NAMESPACE_ID --remote

# Delete (reset to default)
npx wrangler kv key delete "region_shard_config:default" \
  --namespace-id=YOUR_NAMESPACE_ID --remote
```

### k6 Cloud Load Zone Mapping

| k6 Cloud Load Zone    | Cloudflare Region Key |
| --------------------- | --------------------- |
| `amazon:us:portland`  | `wnam`                |
| `amazon:us:ashburn`   | `enam`                |
| `amazon:jp:tokyo`     | `apac`                |
| `amazon:eu:frankfurt` | `weur`                |

### ID Format Reference

All region-sharded resources use this ID format:

```
g{generation}:{region}:{shard}:{type}_{uuid}
```

| Component    | Description                | Example             |
| ------------ | -------------------------- | ------------------- |
| `generation` | Config version (1-999)     | `g1`, `g2`          |
| `region`     | Cloudflare region key      | `apac`, `enam`      |
| `shard`      | Shard index (0 to N-1)     | `0`, `31`, `63`     |
| `type`       | 3-character DO type prefix | `ses`, `acd`, `dpp` |
| `uuid`       | Unique identifier          | `abc123-def456`     |

**Example**: `g1:apac:3:ses_abc123-def456`

### Type Prefix Reference

| DO                   | ID Prefix | Description                       |
| -------------------- | --------- | --------------------------------- |
| SessionStore         | `ses`     | User sessions                     |
| AuthCodeStore        | `acd`     | Authorization codes               |
| RefreshTokenRotator  | `rft`     | Refresh token families            |
| ChallengeStore       | `cha`     | WebAuthn/FIDO2 challenges         |
| TokenRevocationStore | `rev`     | Revoked tokens                    |
| CredentialOfferStore | `cof`     | OpenID4VCI credential offers      |
| VPRequestStore       | `vpr`     | OpenID4VP verification requests   |
| DPoPJTIStore         | `dpp`     | DPoP proof replay prevention      |
| PARRequestStore      | `par`     | Pushed Authorization Requests     |
| DeviceCodeStore      | `dev`     | Device Authorization Flow         |
| CIBARequestStore     | `cba`     | Client-Initiated Backchannel Auth |

---

## Introspection Cache Settings

Settings for caching Token Introspection (RFC 7662) responses. The cache only stores `active=true` responses, and revocation status is always checked fresh.

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

| Field      | Type    | Required | Constraints | Description            |
| ---------- | ------- | -------- | ----------- | ---------------------- |
| enabled    | boolean | No       | -           | Enable/disable caching |
| ttlSeconds | number  | No       | 1 - 3600    | Cache TTL in seconds   |

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

| Variable                          | Type   | Default | Description                     |
| --------------------------------- | ------ | ------- | ------------------------------- |
| `INTROSPECTION_CACHE_ENABLED`     | string | "true"  | Enable caching ("true"/"false") |
| `INTROSPECTION_CACHE_TTL_SECONDS` | string | "60"    | Cache TTL in seconds            |

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

## PII Partition Settings

Configure partitioning for PII (Personally Identifiable Information) data. This enables compliance with privacy regulations such as GDPR/CCPA and supports multi-tenant isolation.

### GET /api/admin/settings/pii-partitions

Get current PII partition configuration.

**Response**:

```json
{
  "defaultPartition": "default",
  "ipRoutingEnabled": false,
  "availablePartitions": ["default", "eu", "tenant-acme"],
  "tenantPartitions": {
    "tenant-acme": "tenant-acme",
    "tenant-contoso": "eu"
  },
  "partitionRules": [
    {
      "name": "enterprise-users",
      "condition": {
        "attribute": "plan",
        "operator": "eq",
        "value": "enterprise"
      },
      "targetPartition": "premium"
    }
  ]
}
```

### PUT /api/admin/settings/pii-partitions

Update PII partition settings.

**Request Body**:

```json
{
  "defaultPartition": "default",
  "ipRoutingEnabled": false,
  "availablePartitions": ["default", "eu"],
  "tenantPartitions": {},
  "partitionRules": []
}
```

| Field               | Type     | Required | Description                                            |
| ------------------- | -------- | -------- | ------------------------------------------------------ |
| defaultPartition    | string   | No       | Default partition for new users                        |
| ipRoutingEnabled    | boolean  | No       | Enable IP-based geo-routing (low trust, fallback only) |
| availablePartitions | string[] | No       | List of available partition names                      |
| tenantPartitions    | object   | No       | Tenant ID → Partition mapping                          |
| partitionRules      | array    | No       | Attribute-based partition rules                        |

**Response**:

```json
{
  "success": true,
  "settings": {
    "defaultPartition": "default",
    "ipRoutingEnabled": false,
    "availablePartitions": ["default", "eu"],
    "tenantPartitions": {},
    "partitionRules": []
  },
  "note": "PII partition settings updated successfully."
}
```

### POST /api/admin/settings/pii-partitions/test

Test partition routing for given user attributes without actually creating a user.

**Request Body**:

```json
{
  "tenantId": "tenant-acme",
  "userAttributes": {
    "plan": "enterprise",
    "declared_residence": "eu"
  },
  "cfCountry": "DE"
}
```

| Field          | Type   | Required | Description                         |
| -------------- | ------ | -------- | ----------------------------------- |
| tenantId       | string | No       | Tenant ID to test                   |
| userAttributes | object | No       | User attributes for rule evaluation |
| cfCountry      | string | No       | Simulated Cloudflare country code   |

**Response**:

```json
{
  "resolvedPartition": "eu",
  "reason": "declared_residence",
  "evaluatedRules": [
    {
      "rule": "enterprise-users",
      "matched": false,
      "reason": "attribute 'plan' was 'standard', expected 'enterprise'"
    }
  ],
  "tenantOverride": null,
  "ipRoutingResult": "eu",
  "note": "This is a simulation. No user was created."
}
```

### GET /api/admin/settings/pii-partitions/stats

Get PII partition distribution statistics.

**Response**:

```json
{
  "partitions": {
    "default": {
      "userCount": 15420,
      "percentage": 85.3
    },
    "eu": {
      "userCount": 2341,
      "percentage": 12.9
    },
    "tenant-acme": {
      "userCount": 324,
      "percentage": 1.8
    }
  },
  "totalUsers": 18085,
  "statusBreakdown": {
    "active": 17892,
    "pending": 12,
    "failed": 3,
    "deleted": 178
  }
}
```

### Partition Routing Priority

Partition determination priority (higher priority at top):

| Priority | Source             | Trust Level | Description                                     |
| -------- | ------------------ | ----------- | ----------------------------------------------- |
| 1        | Tenant Policy      | High        | Explicitly specified via `tenantPartitions`     |
| 2        | declared_residence | High        | User's self-declared residence                  |
| 3        | Partition Rules    | Medium      | Attribute-based rule evaluation                 |
| 4        | IP Routing         | Low         | Cloudflare country code (fallback only)         |
| 5        | Default            | -           | `defaultPartition`                              |

**⚠️ Note**: IP-based routing is unreliable due to VPN/Proxy/Warp/roaming and cannot be used as evidence for GDPR compliance. Prefer `declared_residence` or tenant policy.

---

## Tombstones (GDPR Deletion Tracking)

Tracks PII deletion based on GDPR Art.17 "Right to be Forgotten". Only deletion metadata is retained; actual PII is not stored.

### GET /api/admin/tombstones

List tombstone records with pagination.

**Query Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | number | 20 | Maximum records per page (1-100) |
| offset | number | 0 | Records to skip |
| tenant_id | string | - | Filter by tenant ID |
| deletion_reason | string | - | Filter by reason: `user_request`, `admin_action`, `inactivity` |
| expired | boolean | - | Filter expired (`true`) or active (`false`) tombstones |

**Response**:

```json
{
  "tombstones": [
    {
      "id": "usr_abc123",
      "tenant_id": "default",
      "deleted_at": 1702644000000,
      "deleted_by": "admin_usr_xyz789",
      "deletion_reason": "user_request",
      "retention_until": 1710420000000,
      "is_expired": false
    }
  ],
  "pagination": {
    "total": 178,
    "limit": 20,
    "offset": 0,
    "has_more": true
  }
}
```

### GET /api/admin/tombstones/:id

Get specific tombstone details.

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| id | string | Original user ID |

**Response**:

```json
{
  "id": "usr_abc123",
  "tenant_id": "default",
  "email_blind_index": "sha256:a1b2c3d4...",
  "deleted_at": 1702644000000,
  "deleted_by": "admin_usr_xyz789",
  "deletion_reason": "user_request",
  "retention_until": 1710420000000,
  "deletion_metadata": {
    "request_id": "req_123",
    "ip_address": "192.168.1.1",
    "user_agent": "Mozilla/5.0..."
  },
  "is_expired": false,
  "days_until_expiry": 45
}
```

### GET /api/admin/tombstones/stats

Get tombstone statistics.

**Response**:

```json
{
  "total": 178,
  "by_reason": {
    "user_request": 120,
    "admin_action": 45,
    "inactivity": 13
  },
  "by_tenant": {
    "default": 150,
    "tenant-acme": 28
  },
  "expired": 23,
  "expiring_soon": 12,
  "average_retention_days": 67
}
```

### POST /api/admin/tombstones/cleanup

Cleanup expired tombstone records.

**Request Body** (optional):

```json
{
  "dry_run": false,
  "before_timestamp": 1702644000000
}
```

| Field            | Type    | Default | Description                                           |
| ---------------- | ------- | ------- | ----------------------------------------------------- |
| dry_run          | boolean | false   | Preview without deleting                              |
| before_timestamp | number  | now     | Only cleanup tombstones expired before this timestamp |

**Response**:

```json
{
  "success": true,
  "deleted_count": 23,
  "dry_run": false,
  "note": "Expired tombstones have been permanently deleted."
}
```

Or with `dry_run: true`:

```json
{
  "success": true,
  "would_delete_count": 23,
  "dry_run": true,
  "sample_ids": ["usr_abc123", "usr_def456", "usr_ghi789"],
  "note": "No records were deleted. This was a dry run."
}
```

### Tombstone Lifecycle

```
User Deletion Request
         ↓
┌────────────────────────────────────────────┐
│  1. Create Tombstone Record                │
│     - Store deletion metadata              │
│     - Set retention_until (default 90 days)│
│     - Store email_blind_index for          │
│       duplicate prevention                 │
└────────────────────────────────────────────┘
         ↓
┌────────────────────────────────────────────┐
│  2. Delete PII Data                        │
│     - users_pii record                     │
│     - linked_identities                    │
│     - subject_identifiers                  │
└────────────────────────────────────────────┘
         ↓
┌────────────────────────────────────────────┐
│  3. Update Core DB                         │
│     - Set pii_status = 'deleted'           │
│     - Set is_active = false                │
└────────────────────────────────────────────┘
         ↓
  [Retention Period: 90 days]
         ↓
┌────────────────────────────────────────────┐
│  4. Cleanup (scheduled or manual)          │
│     - Delete expired tombstone records     │
│     - Optionally delete users_core record  │
└────────────────────────────────────────────┘
```

### Re-registration Prevention

The tombstone's `email_blind_index` prevents re-registration with deleted email addresses during the retention period.

```
Registration Attempt
         ↓
Check email_blind_index in all tombstones
         ↓
┌─── Found & Not Expired ───┐
│                           │
│  Return Error:            │
│  "This email address was  │
│   recently deleted and    │
│   cannot be re-registered │
│   until [date]"           │
│                           │
└───────────────────────────┘
         │
         ↓ (Not Found or Expired)
┌───────────────────────────┐
│  Continue Registration    │
└───────────────────────────┘
```

---

## JIT Provisioning Settings

Just-In-Time (JIT) Provisioning is a feature that automatically creates users on their first login from an external IdP. It supports automatic organization joining based on domain and automatic role assignment based on IdP claims.

### GET /api/admin/settings/jit-provisioning

Get current JIT provisioning configuration.

**Response**:

```json
{
  "enabled": true,
  "auto_create_org_on_domain_match": false,
  "join_all_matching_orgs": false,
  "allow_user_without_org": true,
  "default_role_id": "role_end_user",
  "allow_unverified_domain_mappings": false,
  "version": "1"
}
```

| Field                            | Type    | Default         | Description                                            |
| -------------------------------- | ------- | --------------- | ------------------------------------------------------ |
| enabled                          | boolean | true            | Enable/disable JIT Provisioning                        |
| auto_create_org_on_domain_match  | boolean | false           | Automatically create organization on domain match      |
| join_all_matching_orgs           | boolean | false           | Join all matching organizations when multiple match    |
| allow_user_without_org           | boolean | true            | Allow users without organization membership            |
| default_role_id                  | string  | "role_end_user" | Default role ID to assign                              |
| allow_unverified_domain_mappings | boolean | false           | Allow unverified domain mappings                       |

### PUT /api/admin/settings/jit-provisioning

Update JIT provisioning settings.

**Request Body**:

```json
{
  "enabled": true,
  "auto_create_org_on_domain_match": false,
  "join_all_matching_orgs": false,
  "allow_user_without_org": true,
  "default_role_id": "role_end_user",
  "allow_unverified_domain_mappings": false
}
```

**Response**:

```json
{
  "success": true,
  "settings": {
    "enabled": true,
    "auto_create_org_on_domain_match": false,
    "join_all_matching_orgs": false,
    "allow_user_without_org": true,
    "default_role_id": "role_end_user",
    "allow_unverified_domain_mappings": false,
    "version": "2"
  },
  "note": "JIT provisioning settings updated successfully."
}
```

### DELETE /api/admin/settings/jit-provisioning

Reset JIT provisioning settings to defaults.

**Response**:

```json
{
  "success": true,
  "settings": {
    "enabled": true,
    "auto_create_org_on_domain_match": false,
    "join_all_matching_orgs": false,
    "allow_user_without_org": true,
    "default_role_id": "role_end_user",
    "allow_unverified_domain_mappings": false
  },
  "note": "JIT provisioning settings reset to defaults."
}
```

### JIT Provisioning Flow

```
External IdP Login
         ↓
┌────────────────────────────────────────────┐
│  1. Identity Resolution                     │
│     - Check existing linked_identity        │
│     - Attempt identity stitching by email   │
└────────────────────────────────────────────┘
         ↓ (New User)
┌────────────────────────────────────────────┐
│  2. Generate email_domain_hash              │
│     - HMAC-SHA256(lowercase(domain), secret)│
│     - Store hash (not email) in users_core  │
└────────────────────────────────────────────┘
         ↓
┌────────────────────────────────────────────┐
│  3. Resolve Organization                    │
│     - Match domain_hash → org_domain_mapping│
│     - Apply verified > priority > created   │
│     - Optionally join multiple orgs         │
└────────────────────────────────────────────┘
         ↓
┌────────────────────────────────────────────┐
│  4. Evaluate Role Assignment Rules          │
│     - Sort by priority DESC                 │
│     - Evaluate conditions in order          │
│     - Apply matching actions                │
│     - Stop if stop_processing = true        │
└────────────────────────────────────────────┘
         ↓
┌────────────────────────────────────────────┐
│  5. Create User                             │
│     - users_core (Non-PII)                  │
│     - users_pii (PII partition)             │
│     - linked_identity                       │
│     - role_assignments                      │
│     - org_memberships                       │
└────────────────────────────────────────────┘
```

---

## Domain Hash Keys Settings (Key Rotation)

Manages HMAC secret keys used for email_domain_hash generation. Supports key rotation to update secret keys without downtime.

### Algorithm Specification

```
Algorithm: HMAC-SHA256
Input: lowercase(email_domain)
Output: 64-character hex string

Example: "user@Example.COM" → "example.com" → HMAC-SHA256(secret, "example.com") → "a1b2c3..."
```

### GET /api/admin/settings/domain-hash-keys

Get domain hash key configuration (secrets are masked).

**Response**:

```json
{
  "current_version": 2,
  "secrets": {
    "1": "***masked***",
    "2": "***masked***"
  },
  "migration_in_progress": true,
  "deprecated_versions": [],
  "version": "3"
}
```

| Field                 | Type     | Description                                     |
| --------------------- | -------- | ----------------------------------------------- |
| current_version       | number   | Version used for new users                      |
| secrets               | object   | Version → secret key (masked in API response)   |
| migration_in_progress | boolean  | Migration in progress flag                      |
| deprecated_versions   | number[] | List of deprecated versions                     |

### POST /api/admin/settings/domain-hash-keys/rotate

Start key rotation by adding a new secret version.

**Request Body**:

```json
{
  "new_secret": "new-secret-key-at-least-16-characters"
}
```

| Field      | Type   | Required | Constraints    | Description    |
| ---------- | ------ | -------- | -------------- | -------------- |
| new_secret | string | Yes      | 16+ characters | New secret key |

**Response**:

```json
{
  "success": true,
  "new_version": 2,
  "migration_in_progress": true,
  "message": "Key rotation started. New logins will use version 2.",
  "note": "Existing users will be migrated on their next login."
}
```

### PUT /api/admin/settings/domain-hash-keys/complete

Complete key rotation and deprecate old versions.

**Request Body** (optional):

```json
{
  "deprecate_versions": [1]
}
```

| Field              | Type     | Required | Description                   |
| ------------------ | -------- | -------- | ----------------------------- |
| deprecate_versions | number[] | No       | List of versions to deprecate |

**Response**:

```json
{
  "success": true,
  "current_version": 2,
  "migration_in_progress": false,
  "deprecated_versions": [1],
  "message": "Key rotation completed. Version 1 is now deprecated."
}
```

### GET /api/admin/settings/domain-hash-keys/status

Get key rotation migration status.

**Response**:

```json
{
  "current_version": 2,
  "migration_in_progress": true,
  "users_by_version": {
    "1": 1234,
    "2": 5678
  },
  "org_mappings_by_version": {
    "1": 10,
    "2": 25
  },
  "migration_progress_percent": 82.1,
  "estimated_completion": "2025-01-15T00:00:00Z"
}
```

### DELETE /api/admin/settings/domain-hash-keys/:version

Delete a deprecated secret version.

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| version | number | Version number to delete |

**Response**:

```json
{
  "success": true,
  "deleted_version": 1,
  "remaining_versions": [2],
  "note": "Secret version 1 has been permanently deleted."
}
```

**Error (400)**:

```json
{
  "error": "cannot_delete_current_version",
  "error_description": "Cannot delete current_version. Rotate to a new version first."
}
```

```json
{
  "error": "cannot_delete_active_version",
  "error_description": "Cannot delete version with active users. Complete migration first."
}
```

### Key Rotation Flow

```
                    Time →
├─────────────────┼─────────────────┼─────────────────┤
│    Phase 1      │    Phase 2      │    Phase 3      │
│   Normal Ops    │   Migration     │   Completed     │
├─────────────────┼─────────────────┼─────────────────┤
│                 │                 │                 │
│  Version 1      │  Version 1 + 2  │  Version 2      │
│  (current)      │  (migration)    │  (current)      │
│                 │                 │                 │
│  All users      │  New → v2       │  All users      │
│  use v1         │  Existing → v1  │  use v2         │
│                 │  (auto-migrate) │                 │
│                 │                 │  v1 deprecated  │
└─────────────────┴─────────────────┴─────────────────┘

Steps:
1. POST /rotate → Add v2, start migration
2. Users auto-migrate on next login
3. GET /status → Monitor progress
4. PUT /complete → Finish migration, deprecate v1
5. DELETE /:version → Remove old secret (optional)
```

---

## Role Assignment Rules

Manages rules for automatically assigning roles at login based on external IdP claims or email domains.

### POST /api/admin/role-assignment-rules

Create a new role assignment rule.

**Request Body**:

```json
{
  "name": "google-workspace-admin",
  "description": "Assign org_admin role to Google Workspace admins",
  "role_id": "role_org_admin",
  "scope_type": "organization",
  "scope_target": "auto",
  "condition": {
    "type": "and",
    "conditions": [
      {
        "field": "provider_id",
        "operator": "eq",
        "value": "google"
      },
      {
        "field": "idp_claim",
        "claim_path": "hd",
        "operator": "eq",
        "value": "company.com"
      },
      {
        "field": "idp_claim",
        "claim_path": "groups",
        "operator": "contains",
        "value": "admins@company.com"
      }
    ]
  },
  "actions": [
    {
      "type": "assign_role",
      "role_id": "role_org_admin",
      "scope_type": "organization",
      "scope_target": "auto"
    },
    {
      "type": "join_org",
      "org_id": "auto"
    }
  ],
  "priority": 100,
  "stop_processing": true,
  "is_active": true
}
```

**Condition Fields**:

| Field             | claim_path | Description                  | Example                                                                                           |
| ----------------- | ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| email_domain_hash | -          | Email domain blind index     | `{ "field": "email_domain_hash", "operator": "eq", "value": "a1b2c3..." }`                        |
| email_verified    | -          | Email verification status    | `{ "field": "email_verified", "operator": "eq", "value": true }`                                  |
| provider_id       | -          | IdP provider ID              | `{ "field": "provider_id", "operator": "in", "value": ["google", "azure-ad"] }`                   |
| idp_claim         | groups     | IdP groups                   | `{ "field": "idp_claim", "claim_path": "groups", "operator": "contains", "value": "admin" }`      |
| idp_claim         | hd         | Google Workspace domain      | `{ "field": "idp_claim", "claim_path": "hd", "operator": "eq", "value": "company.com" }`          |
| idp_claim         | roles      | Azure AD roles               | `{ "field": "idp_claim", "claim_path": "roles", "operator": "contains", "value": "GlobalAdmin" }` |
| idp_claim         | acr        | Authentication context class | `{ "field": "idp_claim", "claim_path": "acr", "operator": "eq", "value": "urn:..." }`             |

**Condition Operators**:

| Operator   | Description                      | Expected Value          |
| ---------- | -------------------------------- | ----------------------- |
| eq         | Equal                            | string, number, boolean |
| ne         | Not equal                        | string, number, boolean |
| in         | Value in array                   | string[]                |
| not_in     | Value not in array               | string[]                |
| contains   | Array contains / String includes | string                  |
| exists     | Field exists                     | true                    |
| not_exists | Field does not exist             | true                    |
| regex      | Regex match                      | string (pattern)        |

**Actions**:

| Type          | Fields                            | Description                                 |
| ------------- | --------------------------------- | ------------------------------------------- |
| assign_role   | role_id, scope_type, scope_target | Assign role                                 |
| join_org      | org_id                            | Join organization ("auto" for domain match) |
| set_attribute | -                                 | (Reserved for future use)                   |
| deny          | deny_code, deny_description       | Deny authentication                         |

**deny_code to OIDC Error Mapping**:

| deny_code            | OIDC error           | Description                              |
| -------------------- | -------------------- | ---------------------------------------- |
| access_denied        | access_denied        | Access denied (RFC 6749)                 |
| interaction_required | interaction_required | Additional interaction required (OIDC Core) |
| login_required       | login_required       | Re-login required (OIDC Core)            |

**Response**:

```json
{
  "id": "rule_abc123",
  "name": "google-workspace-admin",
  "tenant_id": "default",
  "created_at": 1702644000000,
  "updated_at": 1702644000000
}
```

### GET /api/admin/role-assignment-rules

List all role assignment rules.

**Query Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | number | 20 | Maximum records per page |
| offset | number | 0 | Records to skip |
| is_active | boolean | - | Filter by active status |

**Response**:

```json
{
  "rules": [
    {
      "id": "rule_abc123",
      "name": "google-workspace-admin",
      "description": "Assign org_admin role to Google Workspace admins",
      "role_id": "role_org_admin",
      "scope_type": "organization",
      "scope_target": "auto",
      "condition": { ... },
      "actions": [ ... ],
      "priority": 100,
      "stop_processing": true,
      "is_active": true,
      "valid_from": null,
      "valid_until": null,
      "created_at": 1702644000000,
      "updated_at": 1702644000000
    }
  ],
  "pagination": {
    "total": 5,
    "limit": 20,
    "offset": 0,
    "has_more": false
  }
}
```

### GET /api/admin/role-assignment-rules/:id

Get specific rule details.

### PUT /api/admin/role-assignment-rules/:id

Update an existing rule.

### DELETE /api/admin/role-assignment-rules/:id

Delete a rule.

### POST /api/admin/role-assignment-rules/:id/test

Test a single rule against sample context.

**Request Body**:

```json
{
  "context": {
    "email": "user@company.com",
    "email_verified": true,
    "provider_id": "google",
    "idp_claims": {
      "hd": "company.com",
      "groups": ["admins@company.com", "developers@company.com"],
      "acr": "urn:mace:incommon:iap:silver"
    }
  }
}
```

**Response**:

```json
{
  "matched": true,
  "condition_results": [
    {
      "field": "provider_id",
      "matched": true,
      "actual": "google",
      "expected": "google"
    },
    {
      "field": "idp_claim.hd",
      "matched": true,
      "actual": "company.com",
      "expected": "company.com"
    },
    {
      "field": "idp_claim.groups",
      "matched": true,
      "actual": ["admins@company.com", "developers@company.com"],
      "expected": "admins@company.com"
    }
  ],
  "would_apply_actions": [
    {
      "type": "assign_role",
      "role_id": "role_org_admin",
      "resolved_scope_target": "org_xyz789"
    },
    {
      "type": "join_org",
      "resolved_org_id": "org_xyz789"
    }
  ]
}
```

### POST /api/admin/role-assignment-rules/evaluate

Evaluate all rules against sample context.

**Request Body**:

```json
{
  "context": {
    "email": "user@company.com",
    "email_verified": true,
    "provider_id": "google",
    "idp_claims": {
      "hd": "company.com",
      "groups": ["developers@company.com"]
    }
  }
}
```

**Response**:

```json
{
  "matched_rules": ["rule_abc123", "rule_def456"],
  "stopped_at_rule": "rule_abc123",
  "final_roles": [
    {
      "role_id": "role_org_admin",
      "scope_type": "organization",
      "scope_target": "org_xyz789"
    }
  ],
  "final_orgs": ["org_xyz789"],
  "denied": false
}
```

**Error Response (deny rule matched)**:

```json
{
  "matched_rules": ["rule_block_external"],
  "denied": true,
  "deny_code": "access_denied",
  "deny_description": "External users from this domain are not allowed",
  "oidc_error": {
    "error": "access_denied",
    "error_description": "External users from this domain are not allowed"
  }
}
```

### Rule Evaluation Order

```
1. Filter: tenant_id, is_active=true
2. Filter: valid_from <= now <= valid_until (null = no limit)
3. Sort: priority DESC (higher priority first)
4. Evaluate conditions in order
5. Apply actions from matched rules
6. If stop_processing=true matched, stop evaluation
7. If deny action found, stop and return OIDC error
```

---

## Organization Domain Mappings

Maps email domains to organizations and configures automatic organization joining during JIT Provisioning.

### POST /api/admin/org-domain-mappings

Create a new domain-to-organization mapping.

**Request Body**:

```json
{
  "domain": "company.com",
  "org_id": "org_xyz789",
  "auto_join_enabled": true,
  "membership_type": "member",
  "auto_assign_role_id": null,
  "priority": 0
}
```

| Field               | Type    | Required | Default  | Description                                    |
| ------------------- | ------- | -------- | -------- | ---------------------------------------------- |
| domain              | string  | Yes      | -        | Email domain (hashed internally)               |
| org_id              | string  | Yes      | -        | Target organization ID                         |
| auto_join_enabled   | boolean | No       | true     | Enable/disable auto-join                       |
| membership_type     | string  | No       | "member" | Membership type: "member" or "admin"           |
| auto_assign_role_id | string  | No       | null     | Role to auto-assign on organization join       |
| priority            | number  | No       | 0        | Priority for multiple matches (higher = first) |

**Note**: The `domain` field is converted to `email_domain_hash` and stored in DB after being received by the API. The original domain string is not stored (PII protection).

**Response**:

```json
{
  "id": "odm_abc123",
  "tenant_id": "default",
  "domain_hash": "a1b2c3d4e5f6...",
  "domain_hash_version": 2,
  "org_id": "org_xyz789",
  "auto_join_enabled": true,
  "membership_type": "member",
  "auto_assign_role_id": null,
  "verified": false,
  "priority": 0,
  "is_active": true,
  "created_at": 1702644000000,
  "updated_at": 1702644000000
}
```

### GET /api/admin/org-domain-mappings

List all domain mappings.

**Query Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | number | 20 | Maximum records per page |
| offset | number | 0 | Records to skip |
| org_id | string | - | Filter by organization ID |
| verified | boolean | - | Filter by verification status |
| is_active | boolean | - | Filter by active status |

**Response**:

```json
{
  "mappings": [
    {
      "id": "odm_abc123",
      "tenant_id": "default",
      "domain_hash": "a1b2c3d4e5f6...",
      "domain_hash_version": 2,
      "org_id": "org_xyz789",
      "org_name": "Company Inc.",
      "auto_join_enabled": true,
      "membership_type": "member",
      "auto_assign_role_id": null,
      "verified": true,
      "priority": 0,
      "is_active": true,
      "created_at": 1702644000000,
      "updated_at": 1702644000000
    }
  ],
  "pagination": {
    "total": 10,
    "limit": 20,
    "offset": 0,
    "has_more": false
  }
}
```

### GET /api/admin/org-domain-mappings/:id

Get specific mapping details.

### PUT /api/admin/org-domain-mappings/:id

Update an existing mapping.

**Request Body**:

```json
{
  "auto_join_enabled": true,
  "membership_type": "admin",
  "auto_assign_role_id": "role_org_admin",
  "priority": 10,
  "is_active": true
}
```

**Note**: `domain` and `org_id` cannot be changed. Delete and recreate if modification is needed.

### DELETE /api/admin/org-domain-mappings/:id

Delete a domain mapping.

### GET /api/admin/organizations/:org_id/domain-mappings

List domain mappings for a specific organization.

### POST /api/admin/org-domain-mappings/verify

Verify domain ownership (DNS TXT record check).

**Request Body**:

```json
{
  "mapping_id": "odm_abc123"
}
```

**Response (Success)**:

```json
{
  "success": true,
  "mapping_id": "odm_abc123",
  "verified": true,
  "verification_method": "dns_txt",
  "verified_at": 1702644000000
}
```

**Response (Failed)**:

```json
{
  "success": false,
  "mapping_id": "odm_abc123",
  "verified": false,
  "error": "dns_txt_not_found",
  "expected_txt_record": "_authrim-verify.company.com",
  "expected_txt_value": "authrim-verify=abc123xyz",
  "note": "Add a DNS TXT record with the expected value to verify ownership."
}
```

### Domain Mapping Resolution

Resolution order when multiple mappings match the same domain:

```sql
SELECT * FROM org_domain_mappings
WHERE tenant_id = ?
  AND domain_hash = ?
  AND auto_join_enabled = 1
  AND is_active = 1
ORDER BY
  verified DESC,      -- Verified takes priority
  priority DESC,      -- Priority order
  created_at ASC      -- Same priority: older takes priority
LIMIT 1
```

**JIT Config Behavior**:

- `allow_unverified_domain_mappings = false` → Skip mappings with `verified = 0`
- `join_all_matching_orgs = true` → Remove LIMIT and join all matching organizations

---

## KV Key Reference

All settings are stored in the `AUTHRIM_CONFIG` KV namespace with the following keys:

| Setting                             | KV Key                                   | Type   | Default   |
| ----------------------------------- | ---------------------------------------- | ------ | --------- |
| Code Shards                         | `code_shards`                            | number | 64        |
| Session Shards                      | `session_shards`                         | number | 32        |
| Rate Limit (strict) maxRequests     | `rate_limit_strict_max_requests`         | number | 10        |
| Rate Limit (strict) windowSeconds   | `rate_limit_strict_window_seconds`       | number | 60        |
| Rate Limit (moderate) maxRequests   | `rate_limit_moderate_max_requests`       | number | 60        |
| Rate Limit (moderate) windowSeconds | `rate_limit_moderate_window_seconds`     | number | 60        |
| Rate Limit (lenient) maxRequests    | `rate_limit_lenient_max_requests`        | number | 300       |
| Rate Limit (lenient) windowSeconds  | `rate_limit_lenient_window_seconds`      | number | 60        |
| Rate Limit (loadTest) maxRequests   | `rate_limit_loadtest_max_requests`       | number | 10,000    |
| Rate Limit (loadTest) windowSeconds | `rate_limit_loadtest_window_seconds`     | number | 60        |
| RBAC Cache TTL                      | `rbac_cache_ttl`                         | number | 600       |
| User Cache TTL                      | `oauth_config:USER_CACHE_TTL`            | number | 3600      |
| Consent Cache TTL                   | `oauth_config:CONSENT_CACHE_TTL`         | number | 86400     |
| Config Cache TTL                    | `oauth_config:CONFIG_CACHE_TTL`          | number | 180       |
| Region Shard Config                 | `region_shard_config:default`            | JSON   | See below |
| PII Partition Config                | `pii_partition_config:{tenantId}`        | JSON   | See below |
| JIT Provisioning Config             | `jit_provisioning_config`                | JSON   | See below |
| Domain Hash Config                  | `email_domain_hash_config`               | JSON   | See below |
| Role Assignment Rules Cache         | `role_assignment_rules_cache:{tenantId}` | JSON   | TTL 300s  |

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

### PII Partition Config Default

```json
{
  "defaultPartition": "default",
  "ipRoutingEnabled": false,
  "availablePartitions": ["default"],
  "tenantPartitions": {},
  "partitionRules": []
}
```

### JIT Provisioning Config Default

```json
{
  "enabled": true,
  "auto_create_org_on_domain_match": false,
  "join_all_matching_orgs": false,
  "allow_user_without_org": true,
  "default_role_id": "role_end_user",
  "allow_unverified_domain_mappings": false
}
```

### Domain Hash Config Default

```json
{
  "current_version": 1,
  "secrets": { "1": "${EMAIL_DOMAIN_HASH_SECRET}" },
  "migration_in_progress": false,
  "deprecated_versions": []
}
```

**Note**: The `secrets` value is initialized from the `EMAIL_DOMAIN_HASH_SECRET` environment variable. After being stored in KV, it can only be updated via the API.

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
