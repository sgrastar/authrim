#!/bin/bash
#
# Authrim Key Generation Script
# Generates RSA key pair for JWT signing and initial admin setup token
#
# Usage:
#   ./setup-keys.sh [--env=ENV] [--kid=custom-key-id] [--skip-setup-token] [--setup-url=URL] [--kv-namespace-id=ID]
#
# Options:
#   --env=ENV              Environment name (default: "default"). Keys are saved to .authrim-keys/{env}/
#   --kid=KEY_ID           Custom key ID for RSA key pair
#   --skip-setup-token     Skip setup token generation
#   --setup-url=URL        Base URL for setup page (e.g., https://auth.example.com)
#   --kv-namespace-id=ID   AUTHRIM_CONFIG KV namespace ID to store token
#
# Examples:
#   # Local development (keys only, no KV upload)
#   ./setup-keys.sh
#
#   # Production deployment with automatic KV upload
#   ./setup-keys.sh --setup-url=https://auth.example.com --kv-namespace-id=abc123
#

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Parse arguments
KID=""
ENV=""
SKIP_SETUP_TOKEN=""
SETUP_URL=""
KV_NAMESPACE_ID=""
for arg in "$@"; do
    if [[ $arg == --kid=* ]]; then
        KID="${arg#--kid=}"
    elif [[ $arg == --env=* ]]; then
        ENV="${arg#--env=}"
    elif [[ $arg == --skip-setup-token ]]; then
        SKIP_SETUP_TOKEN="true"
    elif [[ $arg == --setup-url=* ]]; then
        SETUP_URL="${arg#--setup-url=}"
    elif [[ $arg == --kv-namespace-id=* ]]; then
        KV_NAMESPACE_ID="${arg#--kv-namespace-id=}"
    fi
done

# Default environment name
if [ -z "$ENV" ]; then
    ENV="default"
fi

# Validate environment name (prevent path traversal)
if [[ "$ENV" =~ \.\. ]] || [[ "$ENV" =~ / ]] || [[ "$ENV" =~ \\ ]]; then
    echo -e "${RED}❌ Error: Invalid environment name '${ENV}': path traversal characters not allowed${NC}"
    exit 1
fi
if ! [[ "$ENV" =~ ^[a-z][a-z0-9-]*$ ]]; then
    echo -e "${RED}❌ Error: Invalid environment name '${ENV}': must be lowercase alphanumeric with hyphens, starting with a letter${NC}"
    exit 1
fi

# Generate default KID if not provided
if [ -z "$KID" ]; then
    TIMESTAMP=$(date +%s)
    RANDOM_STR=$(head -c 6 /dev/urandom | base64 | tr -dc 'a-z0-9' | cut -c1-6)
    KID="dev-key-${TIMESTAMP}-${RANDOM_STR}"
fi

echo -e "${BLUE}🔐 Generating RSA key pair...${NC}"
echo "   Key ID: $KID"
echo ""

# Check if .authrim-keys/{env} directory exists
KEYS_DIR=".authrim-keys/$ENV"
if [ ! -d "$KEYS_DIR" ]; then
    mkdir -p -m 700 "$KEYS_DIR"
    echo "📁 Created $KEYS_DIR directory"
fi

# Generate RSA private key (2048-bit)
PRIVATE_KEY_PATH="$KEYS_DIR/private.pem"
openssl genrsa -out "$PRIVATE_KEY_PATH" 2048 2>/dev/null

if [ ! -f "$PRIVATE_KEY_PATH" ]; then
    echo -e "${RED}❌ Error: Failed to generate private key${NC}"
    exit 1
fi
chmod 600 "$PRIVATE_KEY_PATH"

echo -e "${GREEN}✅ Private key generated${NC}"
echo "📝 Saved to: $PRIVATE_KEY_PATH"
echo ""

# Generate RP Token Encryption Key (32 bytes = 256 bits, hex encoded)
RP_ENCRYPTION_KEY_PATH="$KEYS_DIR/rp_token_encryption_key.txt"
RP_TOKEN_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | xxd -p -c 64)
echo -n "$RP_TOKEN_ENCRYPTION_KEY" > "$RP_ENCRYPTION_KEY_PATH"
chmod 600 "$RP_ENCRYPTION_KEY_PATH"

echo -e "${GREEN}✅ RP Token Encryption Key generated${NC}"
echo "📝 Saved to: $RP_ENCRYPTION_KEY_PATH"
echo ""

# Generate PII Encryption Key (32 bytes = 256 bits, hex encoded)
PII_ENCRYPTION_KEY_PATH="$KEYS_DIR/pii_encryption_key.txt"
PII_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | xxd -p -c 64)
echo -n "$PII_ENCRYPTION_KEY" > "$PII_ENCRYPTION_KEY_PATH"
chmod 600 "$PII_ENCRYPTION_KEY_PATH"

echo -e "${GREEN}✅ PII Encryption Key generated${NC}"
echo "📝 Saved to: $PII_ENCRYPTION_KEY_PATH"
echo ""

# Generate OTP HMAC Secret (32 bytes = 256 bits, base64url encoded)
OTP_HMAC_SECRET_PATH="$KEYS_DIR/otp_hmac_secret.txt"
OTP_HMAC_SECRET=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=' | tr -d '\n')
echo -n "$OTP_HMAC_SECRET" > "$OTP_HMAC_SECRET_PATH"
chmod 600 "$OTP_HMAC_SECRET_PATH"

echo -e "${GREEN}✅ OTP HMAC Secret generated${NC}"
echo "📝 Saved to: $OTP_HMAC_SECRET_PATH"
echo ""

# Extract public key from private key
TEMP_PUBLIC_KEY=$(mktemp)
openssl rsa -in "$PRIVATE_KEY_PATH" -pubout -out "$TEMP_PUBLIC_KEY" 2>/dev/null

# Convert public key to JWK format using Node.js
# Since we need JSON output, we'll use a Node.js snippet
PUBLIC_JWK_PATH="$KEYS_DIR/public.jwk.json"

# Create Node.js script inline to convert public key to JWK
read -r -d '' NODE_CONVERT_SCRIPT << 'EOF' || true
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const publicKeyPem = fs.readFileSync(process.argv[1], 'utf-8');
const publicKey = crypto.createPublicKey({
  key: publicKeyPem,
  format: 'pem'
});

const publicJWK = publicKey.export({ format: 'jwk' });
publicJWK.kid = process.argv[2];
publicJWK.use = 'sig';
publicJWK.alg = 'RS256';

console.log(JSON.stringify(publicJWK, null, 2));
EOF

# Execute Node.js conversion
if command -v node &> /dev/null; then
    node -e "
const crypto = require('crypto');
const fs = require('fs');

const publicKeyPem = fs.readFileSync('$TEMP_PUBLIC_KEY', 'utf-8');
const publicKey = crypto.createPublicKey({
  key: publicKeyPem,
  format: 'pem'
});

const publicJWK = publicKey.export({ format: 'jwk' });
publicJWK.kid = '$KID';
publicJWK.use = 'sig';
publicJWK.alg = 'RS256';

fs.writeFileSync('$PUBLIC_JWK_PATH', JSON.stringify(publicJWK, null, 2), 'utf-8');
" 2>/dev/null

    if [ -f "$PUBLIC_JWK_PATH" ]; then
        chmod 600 "$PUBLIC_JWK_PATH"
        echo -e "${GREEN}✅ Public key (JWK) generated${NC}"
        echo "📝 Saved to: $PUBLIC_JWK_PATH"
    else
        echo -e "${RED}❌ Error: Failed to generate JWK${NC}"
        rm "$TEMP_PUBLIC_KEY"
        exit 1
    fi
else
    echo -e "${YELLOW}⚠️  Warning: Node.js not found, skipping JWK generation${NC}"
    echo "   Please install Node.js to generate JWK format"
fi

# Save metadata
METADATA_PATH="$KEYS_DIR/metadata.json"
CREATED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > "$METADATA_PATH" << EOF
{
  "kid": "$KID",
  "algorithm": "RS256",
  "keySize": 2048,
  "createdAt": "$CREATED_AT",
  "files": {
    "privateKey": "$PRIVATE_KEY_PATH",
    "publicKey": "$PUBLIC_JWK_PATH",
    "rpTokenEncryptionKey": "$RP_ENCRYPTION_KEY_PATH",
    "piiEncryptionKey": "$PII_ENCRYPTION_KEY_PATH",
    "otpHmacSecret": "$OTP_HMAC_SECRET_PATH"
  }
}
EOF

chmod 600 "$METADATA_PATH"
echo -e "${GREEN}✅ Metadata saved${NC}"
echo "📝 Saved to: $METADATA_PATH"
echo ""

# Clean up temp files
rm -f "$TEMP_PUBLIC_KEY"

# Display summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}📋 Next Steps:${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. For Local development, add to .dev.vars:"
echo ""
echo "   PRIVATE_KEY_PEM=\"\$(cat $PRIVATE_KEY_PATH)\""
echo "   KEY_ID=\"$KID\""
echo "   RP_TOKEN_ENCRYPTION_KEY=\"\$(cat $RP_ENCRYPTION_KEY_PATH)\""
echo "   PII_ENCRYPTION_KEY=\"\$(cat $PII_ENCRYPTION_KEY_PATH)\""
echo "   OTP_HMAC_SECRET=\"\$(cat $OTP_HMAC_SECRET_PATH)\""
echo ""
echo "2. For Remote environment, upload keys as secrets:"
echo ""
echo "   cat $PRIVATE_KEY_PATH | wrangler secret put PRIVATE_KEY_PEM"
echo "   wrangler vars set KEY_ID \"$KID\""
echo "   cat $RP_ENCRYPTION_KEY_PATH | wrangler secret put RP_TOKEN_ENCRYPTION_KEY"
echo "   cat $PII_ENCRYPTION_KEY_PATH | wrangler secret put PII_ENCRYPTION_KEY"
echo "   cat $OTP_HMAC_SECRET_PATH | wrangler secret put OTP_HMAC_SECRET"
echo ""
echo "3. Or use setup-resend.sh to configure Resend:"
echo ""
echo "   ./scripts/setup-resend.sh --env=local"
echo "   ./scripts/setup-resend.sh --env=remote"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "${YELLOW}⚠️  Security Note:${NC}"
echo "   The .authrim-keys directory is gitignored by default."
echo "   Never commit private keys to version control!"
echo ""
echo "📊 Public JWK (for JWKS endpoint):"
echo ""

if [ -f "$PUBLIC_JWK_PATH" ]; then
    cat "$PUBLIC_JWK_PATH"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Initial Admin Setup Token Generation
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if [ -n "$SKIP_SETUP_TOKEN" ]; then
    echo -e "${YELLOW}⏭️  Skipping setup token generation (--skip-setup-token)${NC}"
    echo ""
    exit 0
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}🔐 Initial Admin Setup Token${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Generate setup token (64 hex characters = 256 bits)
SETUP_TOKEN=$(head -c 32 /dev/urandom | xxd -p -c 64)

# Save setup token to file
SETUP_TOKEN_PATH="$KEYS_DIR/setup_token.txt"
echo -n "$SETUP_TOKEN" > "$SETUP_TOKEN_PATH"
chmod 600 "$SETUP_TOKEN_PATH"

echo -e "${GREEN}✅ Setup token generated${NC}"
echo "📝 Saved to: $SETUP_TOKEN_PATH"
echo ""

# Display setup instructions
if [ -n "$SETUP_URL" ]; then
    FULL_SETUP_URL="${SETUP_URL}/setup?token=${SETUP_TOKEN}"
    echo -e "${YELLOW}⚠️  This token expires in 1 hour!${NC}"
    echo ""
    echo "Open this URL in your browser to create the initial admin account:"
    echo ""
    echo -e "  ${GREEN}${FULL_SETUP_URL}${NC}"
    echo ""
fi

# Store in KV if namespace ID is provided
if [ -n "$KV_NAMESPACE_ID" ]; then
    echo "Storing setup token in KV..."

    # Check if wrangler is available
    if command -v wrangler &> /dev/null; then
        # Check if setup is already completed
        SETUP_COMPLETED=$(wrangler kv:key get "setup:completed" --namespace-id="$KV_NAMESPACE_ID" 2>/dev/null || echo "")

        if [ "$SETUP_COMPLETED" = "true" ]; then
            echo ""
            echo -e "${RED}❌ Error: Setup has already been completed.${NC}"
            echo "   The initial admin account has already been created."
            echo "   This setup token will not be stored."
            echo ""
            exit 1
        fi

        # Store the token with 1 hour TTL
        wrangler kv:key put "setup:token" "$SETUP_TOKEN" \
            --namespace-id="$KV_NAMESPACE_ID" \
            --expiration-ttl=3600 2>/dev/null

        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✅ Setup token stored in KV (TTL: 1 hour)${NC}"
        else
            echo -e "${RED}❌ Failed to store setup token in KV${NC}"
            echo "   You may need to manually upload the token."
        fi
    else
        echo -e "${YELLOW}⚠️  wrangler not found, skipping KV storage${NC}"
        echo "   Please install wrangler or manually upload the token."
    fi
    echo ""
fi

# Display manual upload instructions if KV namespace not provided
if [ -z "$KV_NAMESPACE_ID" ]; then
    echo "To enable the setup page, store the token in KV:"
    echo ""
    echo "   wrangler kv:key put \"setup:token\" \"\$(cat $SETUP_TOKEN_PATH)\" \\"
    echo "       --namespace-id=YOUR_AUTHRIM_CONFIG_KV_ID \\"
    echo "       --expiration-ttl=3600"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
