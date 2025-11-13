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
        npm run generate-keys
        PRIVATE_KEY=$(cat .keys/private.pem)
        PUBLIC_JWK=$(cat .keys/public.jwk.json | jq -c .)
        KEY_ID=$(cat .keys/metadata.json | jq -r '.kid')
    fi
else
    echo "📦 Generating RSA keys..."
    npm run generate-keys
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

# Update KEY_ID in wrangler.toml
echo "📝 Updating KEY_ID in wrangler.toml..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    sed -i '' "s/KEY_ID = \".*\"/KEY_ID = \"$KEY_ID\"/" wrangler.toml
else
    # Linux
    sed -i "s/KEY_ID = \".*\"/KEY_ID = \"$KEY_ID\"/" wrangler.toml
fi

echo "✅ wrangler.toml updated successfully!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Run 'npm run dev' to start the development server"
echo "  2. Run 'npm test' to run the test suite"
echo "  3. Visit http://localhost:8787/.well-known/openid-configuration"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
