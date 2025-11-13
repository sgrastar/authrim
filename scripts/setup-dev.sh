#!/bin/bash
#
# Enrai Development Setup Script
# This script generates RSA keys and configures .dev.vars for local development

set -e

echo "🔐 Enrai Development Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if keys already exist
if [ -f ".keys/private.pem" ]; then
    echo "⚠️  Keys already exist in .keys/ directory"
    read -p "Do you want to regenerate keys? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Using existing keys..."
        PRIVATE_KEY=$(cat .keys/private.pem)
        PUBLIC_JWK=$(cat .keys/public.jwk.json | jq -c .)
        KEY_ID=$(cat .keys/metadata.json | jq -r '.kid')
    else
        echo "Regenerating keys..."
        pnpm run generate-keys
        PRIVATE_KEY=$(cat .keys/private.pem)
        PUBLIC_JWK=$(cat .keys/public.jwk.json | jq -c .)
        KEY_ID=$(cat .keys/metadata.json | jq -r '.kid')
    fi
else
    echo "📦 Generating RSA keys..."
    pnpm run generate-keys
    PRIVATE_KEY=$(cat .keys/private.pem)
    PUBLIC_JWK=$(cat .keys/public.jwk.json | jq -c .)
    KEY_ID=$(cat .keys/metadata.json | jq -r '.kid')
fi

echo ""
echo "📝 Creating .dev.vars file..."

# Create .dev.vars file
cat > .dev.vars << EOF
PRIVATE_KEY_PEM="$PRIVATE_KEY"
PUBLIC_JWK_JSON='$PUBLIC_JWK'
ALLOW_HTTP_REDIRECT="true"
EOF

echo "✅ .dev.vars file created successfully!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 Setup complete!"
echo ""
echo "📋 Key Information:"
echo "  • Key ID: $KEY_ID"
echo "  • Private Key: .keys/private.pem"
echo "  • Public JWK: .keys/public.jwk.json"
echo ""
echo "Next steps:"
echo "  1. Run 'pnpm install' to install dependencies (if not done)"
echo "  2. Run 'pnpm run build' to build all packages"
echo "  3. Run 'pnpm run dev' to start all workers"
echo "  4. Visit http://localhost:8787/.well-known/openid-configuration"
echo ""
echo "For production deployment:"
echo "  • Run './scripts/setup-kv.sh' to create KV namespaces"
echo "  • Run './scripts/setup-secrets.sh' to configure Cloudflare Secrets"
echo "  • Run './scripts/setup-production.sh' to set production URLs"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
