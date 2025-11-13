# Enrai Router Worker

The Router Worker provides a unified entry point for all Enrai OpenID Connect endpoints when using workers.dev deployment.

## Purpose

This worker solves the OpenID Connect specification compliance issue where all endpoints must be accessible from a single issuer domain. When deploying to Cloudflare Workers without a custom domain, each worker gets its own subdomain (e.g., `enrai-op-discovery.subdomain.workers.dev`, `enrai-op-auth.subdomain.workers.dev`), which violates the OIDC spec.

The Router Worker acts as a single entry point (`enrai-router.subdomain.workers.dev`) and uses Service Bindings to route requests to the appropriate specialized worker.

## Architecture

```
Client Request → enrai-router.subdomain.workers.dev
                        ↓
                  Router Worker
                  (Service Bindings)
                        ↓
        ┌───────────────┼───────────────┐
        ↓               ↓               ↓
   op-discovery    op-auth         op-token
                                   op-userinfo
                                   op-management
```

## Routing Table

| Path Pattern | Target Worker | Endpoints |
|-------------|---------------|-----------|
| `/.well-known/*` | op-discovery | Discovery, JWKS |
| `/authorize` | op-auth | Authorization endpoint |
| `/as/*` | op-auth | Pushed Authorization Requests (PAR) |
| `/token` | op-token | Token endpoint |
| `/userinfo` | op-userinfo | UserInfo endpoint |
| `/register` | op-management | Dynamic Client Registration |
| `/introspect` | op-management | Token Introspection |
| `/revoke` | op-management | Token Revocation |

## When to Use

**Use Router Worker when:**
- Deploying to workers.dev for testing/development
- You don't have a custom domain
- You need OpenID Connect specification compliance

**Don't use Router Worker when:**
- You have a custom domain managed by Cloudflare
- You're using Cloudflare Routes for direct routing
- You need optimal performance (Routes are faster)

## Configuration

The Router Worker uses Service Bindings, which are automatically configured by `setup-dev.sh`. The bindings are defined in `wrangler.toml`:

```toml
[[services]]
binding = "OP_DISCOVERY"
service = "enrai-op-discovery"

[[services]]
binding = "OP_AUTH"
service = "enrai-op-auth"

# ... etc
```

## Deployment

The Router Worker is conditionally deployed based on your deployment mode:

```bash
# Test environment (with Router Worker)
pnpm run deploy:with-router

# Production environment (without Router Worker)
pnpm run deploy
```

## Performance Considerations

- **Latency**: Adds ~1-5ms overhead per request (Service Binding hop)
- **Simplicity**: Trade-off for OpenID Connect compliance on workers.dev
- **Not needed in production**: Use Cloudflare Routes for optimal performance

## Development

```bash
# Generate wrangler.toml with Service Bindings
./scripts/setup-dev.sh

# Start router in development mode
cd packages/router
pnpm run dev
```

The router runs on port 8786 by default.
