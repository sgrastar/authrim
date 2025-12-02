#!/bin/bash
#
# Authrim Durable Objects Setup Script
# This script helps configure and deploy Durable Objects for the shared package
#
# Usage:
#   ./setup-durable-objects.sh          - Deploy Durable Objects
#   ./setup-durable-objects.sh --info   - Show information about DOs
#

set -e

echo "⚡️ Authrim Durable Objects Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Error: wrangler is not installed"
    echo "Please install it with: pnpm install -g wrangler"
    exit 1
fi

# Check if user is logged in
if ! wrangler whoami &> /dev/null; then
    echo "❌ Error: Not logged in to Cloudflare"
    echo "Please run: wrangler login"
    exit 1
fi

# Parse command line arguments
if [ "$1" = "--info" ]; then
    echo "📊 Durable Objects Information"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Authrim uses the following Durable Objects:"
    echo ""
    echo "1. SessionStore"
    echo "   • Purpose: Manage user sessions with hot/cold storage pattern"
    echo "   • Features: Multi-device support, instant invalidation, D1 fallback"
    echo "   • Used by: op-auth, op-token, op-userinfo"
    echo ""
    echo "2. AuthorizationCodeStore"
    echo "   • Purpose: OAuth 2.0 authorization code management"
    echo "   • Features: One-time use, PKCE validation, replay attack prevention"
    echo "   • Used by: op-auth, op-token"
    echo ""
    echo "3. RefreshTokenRotator"
    echo "   • Purpose: Atomic refresh token rotation with theft detection"
    echo "   • Features: Token family tracking, theft detection, D1 audit logging"
    echo "   • Used by: op-token, op-management"
    echo ""
    echo "4. KeyManager"
    echo "   • Purpose: Cryptographic key management and rotation"
    echo "   • Features: JWK generation, key rotation, secure storage"
    echo "   • Used by: All workers (for JWT signing/verification)"
    echo "5. ChallengeStore"
    echo "   • Purpose: One-time challenges for Passkey and Magic Link authentication"
    echo "   • Features: Atomic consume, TTL enforcement, replay attack prevention"
    echo "   • Used by: op-auth (passkey, magic link, session tokens)"
    echo ""
    echo "6. RateLimiterCounter"
    echo "   • Purpose: Atomic rate limiting with perfect precision"
    echo "   • Features: 100% accurate counting, sliding window, no race conditions"
    echo "   • Used by: All endpoints (rate limiting)"
    echo ""
    echo "7. PARRequestStore"
    echo "   • Purpose: PAR request_uri single-use guarantee (RFC 9126)"
    echo "   • Features: Atomic consume, prevents replay attacks"
    echo "   • Used by: op-auth (PAR endpoint)"
    echo ""
    echo "8. DPoPJTIStore"
    echo "   • Purpose: DPoP JTI replay protection"
    echo "   • Features: Atomic check-and-store, prevents parallel replay"
    echo "   • Used by: All token endpoints (DPoP validation)"
    echo ""
    echo "9. TokenRevocationStore"
    echo "   • Purpose: Token revocation list management"
    echo "   • Features: Atomic revocation, D1 persistence"
    echo "   • Used by: op-management (token revocation)"
    echo ""
    echo "10. DeviceCodeStore"
    echo "   • Purpose: RFC 8628 Device Authorization Grant"
    echo "   • Features: Device code management, user code verification"
    echo "   • Used by: op-async (device flow)"
    echo ""
    echo "11. CIBARequestStore"
    echo "   • Purpose: OpenID Connect CIBA Flow"
    echo "   • Features: Backchannel authentication, polling management"
    echo "   • Used by: op-async (CIBA flow)"
    echo ""
    echo "12. VersionManager"
    echo "   • Purpose: Worker bundle version management"
    echo "   • Features: Stale bundle detection, forced shutdown of outdated workers"
    echo "   • Used by: All workers (version check middleware)"
    echo ""
    echo "13. SAMLRequestStore"
    echo "   • Purpose: SAML 2.0 request/response state management"
    echo "   • Features: AuthnRequest tracking, artifact resolution, assertion ID tracking"
    echo "   • Used by: op-saml (SAML IdP/SP flows)"
    echo ""
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦 Package: @authrim/shared"
    echo "   Script name: authrim-shared"
    echo "   Location: packages/shared/"
    echo ""
    echo "To deploy Durable Objects:"
    echo "  ./scripts/setup-durable-objects.sh"
    echo ""
    echo "To deploy entire application (including DOs):"
    echo "  pnpm run deploy:retry"
    echo ""
    exit 0
fi

echo "📦 Durable Objects Deployment"
echo ""
echo "This script will deploy the shared package containing all Durable Objects."
echo ""
echo "Durable Objects to be deployed:"
echo "  • SessionStore"
echo "  • AuthorizationCodeStore"
echo "  • RefreshTokenRotator"
echo "  • KeyManager"
echo "  • ChallengeStore"
echo "  • RateLimiterCounter"
echo "  • PARRequestStore"
echo "  • DPoPJTIStore"
echo "  • TokenRevocationStore"
echo "  • DeviceCodeStore"
echo "  • CIBARequestStore"
echo "  • VersionManager"
echo "  • SAMLRequestStore"
echo ""

# Check if wrangler.toml exists
if [ ! -f "packages/shared/wrangler.toml" ]; then
    echo "❌ Error: packages/shared/wrangler.toml not found"
    echo ""
    echo "Please run './scripts/setup-dev.sh' first to generate wrangler.toml files"
    exit 1
fi

# Show current configuration
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Current Configuration:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
cat packages/shared/wrangler.toml
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

read -p "Deploy Durable Objects now? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Deployment cancelled"
    exit 1
fi

echo ""
echo "🔨 Building shared package..."
(cd packages/shared && pnpm run build)
echo "✅ Build complete"
echo ""

echo "🚀 Deploying Durable Objects..."
echo ""

# Deploy with retry logic (max 3 attempts)
MAX_RETRIES=3
RETRY_DELAY=5

for i in $(seq 1 $MAX_RETRIES); do
    if (cd packages/shared && pnpm run deploy); then
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "✅ Durable Objects deployed successfully!"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "📋 Deployment Summary:"
        echo "   • Worker name: authrim-shared"
        echo "   • Durable Objects: 13 (SessionStore, AuthCodeStore, RefreshTokenRotator, KeyManager, ChallengeStore, RateLimiterCounter, PARRequestStore, DPoPJTIStore, TokenRevocationStore, DeviceCodeStore, CIBARequestStore, VersionManager, SAMLRequestStore)"
        echo ""
        echo "⚠️  Important: Wait 10-30 seconds before deploying other workers"
        echo "   to allow Cloudflare to propagate the Durable Objects bindings."
        echo ""
        echo "Next steps:"
        echo "  1. Wait 30 seconds for DO propagation"
        echo "  2. Deploy other workers: pnpm run deploy:retry"
        echo "  3. Verify deployment: curl https://authrim-shared.<subdomain>.workers.dev/"
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        exit 0
    else
        if [ $i -lt $MAX_RETRIES ]; then
            echo "⚠️  Deployment failed (attempt $i/$MAX_RETRIES)"
            echo "   Retrying in ${RETRY_DELAY}s..."
            sleep $RETRY_DELAY
        else
            echo ""
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "❌ Deployment failed after $MAX_RETRIES attempts"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            echo "Troubleshooting:"
            echo "  1. Check your Cloudflare account limits"
            echo "  2. Verify wrangler authentication: wrangler whoami"
            echo "  3. Check wrangler.toml configuration"
            echo "  4. Try deploying manually: cd packages/shared && pnpm run deploy"
            echo ""
            echo "For more help, see: https://developers.cloudflare.com/workers/platform/limits/"
            echo ""
            exit 1
        fi
    fi
done
