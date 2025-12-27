# Rollback Procedures

This document describes how to rollback Cloudflare Workers deployments when issues are detected.

## Overview

Authrim uses Cloudflare's native rollback capabilities (`wrangler rollback`) combined with automated detection during gradual rollouts. This provides:

- **Instant rollback**: Cloudflare maintains previous versions, enabling immediate rollback
- **Gradual rollout**: Deploy to a percentage of traffic first (10% → 50% → 100%)
- **Automatic rollback**: Health check failures trigger automatic rollback during gradual deployment

## Rollback Decision Criteria

### When to Rollback

Consider immediate rollback when:

| Indicator | Threshold | Action |
|-----------|-----------|--------|
| Error rate spike | >5% of requests returning 5xx | Immediate rollback |
| Latency increase | >2x baseline p99 latency | Investigate, rollback if persistent |
| OIDC failures | Any token validation errors | Immediate rollback |
| Health check fail | OIDC Discovery returns non-200 | Automatic rollback (gradual mode) |

### Monitoring Points

1. **Cloudflare Analytics**: Request success rate, error distribution
2. **OIDC Discovery**: `/.well-known/openid-configuration` availability
3. **Token Endpoint**: `/token` response times and error rates
4. **Application Logs**: Error patterns, stack traces

## Rollback Procedures

### Single Worker Rollback

To rollback a single worker to its previous version:

```bash
# Navigate to the package directory
cd packages/ar-token

# Rollback to previous version
pnpm exec wrangler rollback --config wrangler.prod.toml

# Verify the rollback
pnpm exec wrangler deployments list --config wrangler.prod.toml
```

### All Workers Rollback

Use the provided script to rollback all workers:

```bash
# Rollback all workers in production
./scripts/rollback-all.sh --env=prod

# Rollback all workers in staging
./scripts/rollback-all.sh --env=staging
```

### Manual All-Workers Rollback

If the script is unavailable:

```bash
DEPLOY_ENV=prod

for pkg_dir in packages/ar-*; do
    name=$(basename "$pkg_dir")
    if [ -f "$pkg_dir/wrangler.${DEPLOY_ENV}.toml" ]; then
        echo "Rolling back $name..."
        (cd "$pkg_dir" && pnpm exec wrangler rollback --config "wrangler.${DEPLOY_ENV}.toml")
    fi
done
```

## Post-Rollback Checklist

After performing a rollback, verify the following:

### Immediate Verification

- [ ] OIDC Discovery endpoint returns 200: `curl https://your-domain/.well-known/openid-configuration`
- [ ] JWKS endpoint accessible: `curl https://your-domain/.well-known/jwks.json`
- [ ] Token endpoint responding: Test with a known client
- [ ] UserInfo endpoint responding: Test with a valid access token

### API Version Verification

- [ ] Check `X-Authrim-Version` header in responses
- [ ] Verify deprecation headers are correctly applied (if applicable)

### Configuration Considerations

After rollback, consider these actions:

| Situation | Action |
|-----------|--------|
| Rollback due to API version issue | Consider disabling deprecation headers temporarily |
| Rollback due to breaking change | Check API version configuration in KV |
| Multiple workers affected | Consider disabling gradual rollout for next deploy |

## Gradual Rollout & Rollback

### Gradual Deployment Flow

```
Deploy at 10% → Health Check → Wait 3min
  ↓
Deploy at 50% → Health Check → Wait 3min
  ↓
Deploy at 100% → Complete
```

### Automatic Rollback Trigger

During gradual rollout, automatic rollback is triggered when:

1. Health check fails (OIDC Discovery not returning 200)
2. Deployment command fails
3. Traffic split command fails (for non-100% stages)

### Manual Abort During Gradual Rollout

Press `Ctrl+C` during gradual deployment to abort. Then:

```bash
# Rollback the partially deployed worker
cd packages/ar-<worker-name>
pnpm exec wrangler rollback --config wrangler.prod.toml
```

## Troubleshooting

### Rollback Fails

If `wrangler rollback` fails:

1. Check if previous version exists:
   ```bash
   pnpm exec wrangler deployments list --config wrangler.prod.toml
   ```

2. Manually select a specific version:
   ```bash
   pnpm exec wrangler deployments view <deployment-id> --config wrangler.prod.toml
   ```

3. If no previous version, redeploy from a known-good git commit:
   ```bash
   git checkout <known-good-commit>
   ./scripts/deploy-with-retry.sh --env=prod
   ```

### VersionManager DO Out of Sync

If using the legacy VersionManager DO and versions are mismatched:

```bash
# Re-register versions for all workers
ISSUER_URL="https://your-domain"
ADMIN_SECRET="your-admin-secret"

for worker in ar-auth ar-token ar-management ar-userinfo ar-async ar-discovery ar-policy ar-saml ar-bridge ar-vc; do
    curl -X POST "${ISSUER_URL}/api/internal/versions/${worker}" \
        -H "Authorization: Bearer ${ADMIN_SECRET}" \
        -H "Content-Type: application/json" \
        -d '{"uuid":"current-uuid","deployTime":"2025-01-01T00:00:00Z"}'
done
```

## Related Documentation

- [Version Management](./version-management.md) - Version management system (legacy)
- [Performance Optimization](./performance-optimization.md) - Performance tuning
- [Worker Optimization](./worker-optimization.md) - Worker-specific optimizations

## Emergency Contacts

For critical production issues:

1. Check Cloudflare Status: https://www.cloudflarestatus.com/
2. Review Cloudflare Workers Dashboard for error patterns
3. Follow the rollback procedure above
