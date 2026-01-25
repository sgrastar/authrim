# Environment Variables

This document describes the environment variable naming conventions and all available configuration options for Authrim.

## Naming Conventions

Authrim follows consistent naming conventions for environment variables to improve readability and maintainability.

### General Rules

1. **SCREAMING_SNAKE_CASE**: All environment variables use uppercase with underscores
2. **Descriptive Names**: Names should clearly indicate their purpose
3. **Consistent Prefixes**: Related variables share common prefixes

### Time-Related Variables

| Category          | Pattern            | Unit         | Example                                         |
| ----------------- | ------------------ | ------------ | ----------------------------------------------- |
| Token/Auth Expiry | `*_EXPIRY`         | Seconds      | `ACCESS_TOKEN_EXPIRY`, `AUTH_CODE_EXPIRY`       |
| Cache TTL         | `*_CACHE_TTL`      | Seconds      | `INTROSPECTION_CACHE_TTL`, `SETTINGS_CACHE_TTL` |
| Timeouts          | `*_TIMEOUT_MS`     | Milliseconds | `HTTPS_REQUEST_URI_TIMEOUT_MS`                  |
| Windows           | `*_WINDOW_SECONDS` | Seconds      | `LOCKOUT_WINDOW_SECONDS`                        |

**Rationale:**

- `*_EXPIRY` aligns with OAuth/OIDC RFC terminology (`expires_in`)
- `*_CACHE_TTL` follows Redis/caching industry standards
- `*_TIMEOUT_MS` explicitly indicates milliseconds for operation timeouts

### Feature Flags

All boolean feature flags use the `ENABLE_*` prefix:

```
ENABLE_CONFORMANCE_MODE
ENABLE_RATE_LIMIT
ENABLE_REFRESH_TOKEN_ROTATION
ENABLE_TOKEN_EXCHANGE
ENABLE_CLIENT_CREDENTIALS
```

**Rationale:**

- Consistent prefix makes flags easy to identify
- `ENABLE_` clearly indicates an on/off toggle
- Avoids confusion with `*_ENABLED` suffix (deprecated)

### Prefix Categories

| Prefix     | Purpose                   | Example                         |
| ---------- | ------------------------- | ------------------------------- |
| (none)     | Core settings             | `ISSUER_URL`, `BASE_DOMAIN`     |
| `AUTHRIM_` | Authrim-specific settings | `AUTHRIM_CODE_SHARDS`           |
| `SCIM_`    | SCIM provisioning         | `SCIM_AUTH_FAILURE_DELAY_MS`    |
| `RBAC_`    | Role-based access control | `RBAC_ID_TOKEN_CLAIMS`          |
| `API_`     | API configuration         | `API_VERSIONING_SUNSET_SECONDS` |
| `PII_`     | PII encryption settings   | `PII_ENCRYPTION_KEY`            |
| `ENABLE_`  | Feature flags             | `ENABLE_CONFORMANCE_MODE`       |

---

## Environment Variables Reference

### Core Configuration

| Variable          | Type   | Default | Description                                              |
| ----------------- | ------ | ------- | -------------------------------------------------------- |
| `ISSUER_URL`      | string | -       | OAuth/OIDC issuer URL (e.g., `https://auth.example.com`) |
| `UI_URL`          | string | -       | Login/consent UI URL                                     |
| `BASE_DOMAIN`     | string | -       | Base domain for multi-tenant deployment                  |
| `TRUSTED_DOMAINS` | string | -       | Comma-separated list of trusted redirect domains         |
| `ALLOWED_ORIGINS` | string | -       | CORS allowed origins                                     |

### Token Configuration

| Variable               | Type   | Default   | Description                                 |
| ---------------------- | ------ | --------- | ------------------------------------------- |
| `ACCESS_TOKEN_EXPIRY`  | number | `3600`    | Access token lifetime in seconds            |
| `AUTH_CODE_EXPIRY`     | number | `120`     | Authorization code lifetime in seconds      |
| `STATE_EXPIRY`         | number | `600`     | State parameter lifetime in seconds         |
| `NONCE_EXPIRY`         | number | `600`     | Nonce parameter lifetime in seconds         |
| `REFRESH_TOKEN_EXPIRY` | number | `2592000` | Refresh token lifetime in seconds (30 days) |

### Feature Flags

| Variable                        | Type    | Default | Description                                                 |
| ------------------------------- | ------- | ------- | ----------------------------------------------------------- |
| `ENABLE_CONFORMANCE_MODE`       | boolean | `false` | Enable built-in login/consent forms for conformance testing |
| `ENABLE_HTTP_REDIRECT`          | boolean | `false` | Allow HTTP redirect URIs (insecure, for development only)   |
| `ENABLE_OPEN_REGISTRATION`      | boolean | `false` | Allow public client registration without IAT                |
| `ENABLE_REFRESH_TOKEN_ROTATION` | boolean | `false` | Enable refresh token rotation on use                        |
| `ENABLE_TOKEN_EXCHANGE`         | boolean | `false` | Enable RFC 8693 Token Exchange                              |
| `ENABLE_CLIENT_CREDENTIALS`     | boolean | `false` | Enable RFC 6749 Client Credentials grant                    |
| `ENABLE_RATE_LIMIT`             | boolean | `true`  | Enable rate limiting                                        |
| `ENABLE_HTTPS_REQUEST_URI`      | boolean | `false` | Enable HTTPS request_uri support (JAR)                      |
| `ENABLE_RAR`                    | boolean | `false` | Enable RFC 9396 Rich Authorization Requests                 |
| `ENABLE_AI_SCOPES`              | boolean | `false` | Enable AI Ephemeral Auth scopes                             |
| `ENABLE_NATIVE_SSO`             | boolean | `false` | Enable OIDC Native SSO 1.0                                  |
| `ENABLE_ID_JAG`                 | boolean | `false` | Enable ID-JAG identity assertion grant                      |

### Security Configuration

| Variable             | Type   | Default | Description                             |
| -------------------- | ------ | ------- | --------------------------------------- |
| `KEY_MANAGER_SECRET` | string | -       | Secret for KeyManager DO encryption     |
| `ADMIN_API_SECRET`   | string | -       | Secret for Admin API authentication     |
| `POLICY_API_SECRET`  | string | -       | Secret for Policy service communication |
| `KEY_ID`             | string | -       | Current signing key ID                  |
| `PRIVATE_KEY_PEM`    | string | -       | RSA private key (PEM format)            |
| `PUBLIC_JWK_JSON`    | string | -       | Public JWK for verification             |

### Identity Stitching

| Variable                                           | Type    | Default | Description                                   |
| -------------------------------------------------- | ------- | ------- | --------------------------------------------- |
| `ENABLE_IDENTITY_STITCHING`                        | boolean | `false` | Enable automatic identity linking             |
| `ENABLE_IDENTITY_STITCHING_REQUIRE_VERIFIED_EMAIL` | boolean | `true`  | Require verified email for identity stitching |

### Introspection Settings

| Variable                                 | Type    | Default | Description                           |
| ---------------------------------------- | ------- | ------- | ------------------------------------- |
| `ENABLE_INTROSPECTION_CACHE`             | boolean | `false` | Enable introspection response caching |
| `INTROSPECTION_CACHE_TTL`                | number  | `60`    | Cache TTL in seconds                  |
| `ENABLE_INTROSPECTION_STRICT_VALIDATION` | boolean | `false` | Enable strict token validation        |
| `INTROSPECTION_EXPECTED_AUDIENCE`        | string  | -       | Expected audience for introspection   |

### NIST Assurance Levels

| Variable                       | Type    | Default | Description                            |
| ------------------------------ | ------- | ------- | -------------------------------------- |
| `ENABLE_NIST_ASSURANCE_LEVELS` | boolean | `false` | Enable NIST AAL/FAL/IAL claims         |
| `DEFAULT_AAL`                  | string  | `aal1`  | Default Authentication Assurance Level |
| `DEFAULT_FAL`                  | string  | `fal1`  | Default Federation Assurance Level     |
| `DEFAULT_IAL`                  | string  | `ial1`  | Default Identity Assurance Level       |

### Sharding Configuration

| Variable                   | Type   | Default | Description                                  |
| -------------------------- | ------ | ------- | -------------------------------------------- |
| `AUTHRIM_CODE_SHARDS`      | number | `1`     | Authorization code DO shards (for high load) |
| `AUTHRIM_SESSION_SHARDS`   | number | `1`     | Session DO shards (for high load)            |
| `AUTHRIM_CHALLENGE_SHARDS` | number | `1`     | Challenge DO shards (for high load)          |

### Rate Limiting

| Variable             | Type    | Default    | Description                                           |
| -------------------- | ------- | ---------- | ----------------------------------------------------- |
| `ENABLE_RATE_LIMIT`  | boolean | `true`     | Enable rate limiting                                  |
| `RATE_LIMIT_PROFILE` | string  | `standard` | Rate limit profile (`standard`, `strict`, `loadTest`) |

### SCIM Configuration

| Variable                      | Type    | Default | Description                              |
| ----------------------------- | ------- | ------- | ---------------------------------------- |
| `ENABLE_SCIM_AUTH_RATE_LIMIT` | boolean | `true`  | Enable SCIM auth rate limiting           |
| `SCIM_AUTH_FAILURE_DELAY_MS`  | number  | `1000`  | Delay after auth failure in milliseconds |

### Logging Configuration

| Variable                  | Type    | Default | Description                                  |
| ------------------------- | ------- | ------- | -------------------------------------------- |
| `LOG_LEVEL`               | string  | `info`  | Log level (`debug`, `info`, `warn`, `error`) |
| `LOG_FORMAT`              | string  | `json`  | Log format (`json`, `pretty`)                |
| `ENABLE_LOG_HASH_USER_ID` | boolean | `false` | Hash user IDs in logs for privacy            |

### Check API (Policy Service)

| Variable                     | Type    | Default | Description                                  |
| ---------------------------- | ------- | ------- | -------------------------------------------- |
| `ENABLE_CHECK_API`           | boolean | `false` | Enable Check API endpoints                   |
| `ENABLE_CHECK_API_WEBSOCKET` | boolean | `false` | Enable WebSocket push for permission changes |
| `ENABLE_CHECK_API_DEBUG`     | boolean | `false` | Enable debug mode for Check API              |

### RBAC Claims

| Variable                          | Type    | Default | Description                                                    |
| --------------------------------- | ------- | ------- | -------------------------------------------------------------- |
| `RBAC_ID_TOKEN_CLAIMS`            | string  | `roles` | Claims to include in ID token (`none`, `roles`, `permissions`) |
| `RBAC_ACCESS_TOKEN_CLAIMS`        | string  | `roles` | Claims to include in access token                              |
| `ENABLE_RBAC_CONSENT_SCOPES`      | boolean | `false` | Show RBAC scopes in consent screen                             |
| `ENABLE_RBAC_CONSENT_PERMISSIONS` | boolean | `false` | Show RBAC permissions in consent screen                        |

---

## Configuration Priority

Authrim uses a 3-layer fallback system for configuration:

```
Cache → KV (SETTINGS) → Environment Variables → Default Values
```

1. **Cache**: In-memory cache for frequently accessed settings
2. **KV**: Dynamic configuration stored in Cloudflare KV (modifiable via Admin API)
3. **Environment Variables**: Deployment-time configuration
4. **Default Values**: Secure defaults defined in code

This allows:

- Dynamic configuration changes without redeployment
- Safe fallback to environment variables if KV fails
- Secure defaults when neither KV nor env vars are set

---

## Migration from Legacy Names

The following environment variable names have been deprecated:

| Legacy Name                       | New Name                                       |
| --------------------------------- | ---------------------------------------------- |
| `TOKEN_EXPIRY`                    | `ACCESS_TOKEN_EXPIRY`                          |
| `CODE_EXPIRY`                     | `AUTH_CODE_EXPIRY`                             |
| `AUTH_CODE_TTL`                   | `AUTH_CODE_EXPIRY`                             |
| `CONFORMANCE_MODE`                | `ENABLE_CONFORMANCE_MODE`                      |
| `ALLOW_HTTP_REDIRECT`             | `ENABLE_HTTP_REDIRECT`                         |
| `OPEN_REGISTRATION`               | `ENABLE_OPEN_REGISTRATION`                     |
| `REFRESH_TOKEN_ROTATION_ENABLED`  | `ENABLE_REFRESH_TOKEN_ROTATION`                |
| `RATE_LIMIT_DISABLED`             | `ENABLE_RATE_LIMIT` (logic inverted)           |
| `SCIM_AUTH_RATE_LIMIT_DISABLED`   | `ENABLE_SCIM_AUTH_RATE_LIMIT` (logic inverted) |
| `IDENTITY_STITCHING_ENABLED`      | `ENABLE_IDENTITY_STITCHING`                    |
| `NIST_ASSURANCE_LEVELS_ENABLED`   | `ENABLE_NIST_ASSURANCE_LEVELS`                 |
| `INTROSPECTION_CACHE_ENABLED`     | `ENABLE_INTROSPECTION_CACHE`                   |
| `INTROSPECTION_CACHE_TTL_SECONDS` | `INTROSPECTION_CACHE_TTL`                      |
| `INTROSPECTION_STRICT_VALIDATION` | `ENABLE_INTROSPECTION_STRICT_VALIDATION`       |
| `LOG_HASH_USER_ID`                | `ENABLE_LOG_HASH_USER_ID`                      |
| `CHECK_API_WEBSOCKET_ENABLED`     | `ENABLE_CHECK_API_WEBSOCKET`                   |
| `CHECK_API_DEBUG_MODE`            | `ENABLE_CHECK_API_DEBUG`                       |
| `ID_JAG_ENABLED`                  | `ENABLE_ID_JAG`                                |
| `VERSION_CHECK_ENABLED`           | (deprecated - use Cloudflare Versions Deploy)  |

---

## Examples

### Minimal Production Configuration

```toml
[vars]
ISSUER_URL = "https://auth.example.com"
UI_URL = "https://login.example.com"
ENABLE_HTTP_REDIRECT = "false"
ENABLE_OPEN_REGISTRATION = "false"
ENABLE_RATE_LIMIT = "true"
ACCESS_TOKEN_EXPIRY = "3600"
AUTH_CODE_EXPIRY = "120"
REFRESH_TOKEN_EXPIRY = "2592000"
```

### High-Load Configuration

```toml
[vars]
# Enable sharding for high throughput
AUTHRIM_CODE_SHARDS = "32"
AUTHRIM_SESSION_SHARDS = "32"
AUTHRIM_CHALLENGE_SHARDS = "16"

# Extended expiry for load testing
AUTH_CODE_EXPIRY = "28800"

# Disable rate limiting for benchmarks
ENABLE_RATE_LIMIT = "false"
```

### Conformance Testing Configuration

```toml
[vars]
ENABLE_CONFORMANCE_MODE = "true"
ENABLE_HTTPS_REQUEST_URI = "true"
HTTPS_REQUEST_URI_ALLOWED_DOMAINS = "www.certification.openid.net"
TRUSTED_DOMAINS = "www.certification.openid.net"
```

---

## Admin UI Configuration (Safari ITP Proxy)

### Background

Safari's Intelligent Tracking Prevention (ITP) blocks cross-site cookies. When Admin UI and API are on different domains (e.g., `ar-admin-ui.pages.dev` and `ar-router.workers.dev`), Safari won't send cookies, breaking authentication.

### Solution: SvelteKit Server Proxy

The Admin UI uses a server-side proxy in `hooks.server.ts` to forward `/api/*` requests to the backend. This makes requests appear same-origin to the browser, bypassing ITP restrictions.

```
Browser → pages.dev/api/* → (SvelteKit Server Proxy) → workers.dev/api/*
```

### UI Environment Variables

These are configured in `.authrim/{env}/ui.env` and set in Cloudflare Pages:

| Variable              | Type   | Description                                  |
| --------------------- | ------ | -------------------------------------------- |
| `PUBLIC_API_BASE_URL` | string | Frontend API base URL (empty for proxy mode) |
| `API_BACKEND_URL`     | string | Backend URL for server-side proxy            |

### Configuration Modes

#### Proxy Mode (Default - Cross-Domain)

Used when Admin UI and API are on different registrable domains (e.g., `pages.dev` vs `workers.dev`):

```env
# .authrim/{env}/ui.env
PUBLIC_API_BASE_URL=
API_BACKEND_URL=https://xxx-ar-router.workers.dev
```

- Frontend sends requests to same-origin `/api/*`
- Server proxy forwards to `API_BACKEND_URL`
- Safari ITP compatible

#### Direct Mode (Custom Domain - Same Domain)

Used when Admin UI and API share the same registrable domain (e.g., `admin.example.com` and `api.example.com`):

```env
# .authrim/{env}/ui.env
PUBLIC_API_BASE_URL=https://api.example.com
API_BACKEND_URL=
```

- Frontend sends requests directly to backend
- Proxy disabled (lower latency)
- Works because same registrable domain

### Setup Tool Behavior

The `authrim-setup deploy` command automatically detects the configuration:

- **Custom domain set for both Admin UI and API**: Direct mode (proxy disabled)
- **Default workers.dev/pages.dev URLs**: Proxy mode (enabled)

### Manual Configuration

To switch modes after deployment:

```bash
# Enable proxy mode
wrangler pages secret put API_BACKEND_URL --project-name {env}-ar-admin-ui
# Enter: https://xxx-ar-router.workers.dev

# Disable proxy mode (custom domain)
wrangler pages secret delete API_BACKEND_URL --project-name {env}-ar-admin-ui
```

Or edit `.authrim/{env}/ui.env` and redeploy:

```bash
authrim-setup deploy --env {env}
```
