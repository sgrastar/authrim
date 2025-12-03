#!/bin/bash
#
# Authrim RSA Key Generation Script
# Generates RSA key pair for JWT signing
#
# Usage:
#   ./setup-keys.sh [--kid=custom-key-id]
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
for arg in "$@"; do
    if [[ $arg == --kid=* ]]; then
        KID="${arg#--kid=}"
    fi
done

# Generate default KID if not provided
if [ -z "$KID" ]; then
    TIMESTAMP=$(date +%s)
    RANDOM_STR=$(head -c 6 /dev/urandom | base64 | tr -dc 'a-z0-9' | cut -c1-6)
    KID="dev-key-${TIMESTAMP}-${RANDOM_STR}"
fi

echo -e "${BLUE}🔐 Generating RSA key pair...${NC}"
echo "   Key ID: $KID"
echo ""

# Check if .keys directory exists
KEYS_DIR=".keys"
if [ ! -d "$KEYS_DIR" ]; then
    mkdir -p "$KEYS_DIR"
    echo "📁 Created .keys directory"
fi

# Generate RSA private key (2048-bit)
PRIVATE_KEY_PATH="$KEYS_DIR/private.pem"
openssl genrsa -out "$PRIVATE_KEY_PATH" 2048 2>/dev/null

if [ ! -f "$PRIVATE_KEY_PATH" ]; then
    echo -e "${RED}❌ Error: Failed to generate private key${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Private key generated${NC}"
echo "📝 Saved to: $PRIVATE_KEY_PATH"
echo ""

# Generate RP Token Encryption Key (32 bytes = 256 bits, hex encoded)
RP_ENCRYPTION_KEY_PATH="$KEYS_DIR/rp_token_encryption_key.txt"
RP_TOKEN_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | xxd -p -c 64)
echo -n "$RP_TOKEN_ENCRYPTION_KEY" > "$RP_ENCRYPTION_KEY_PATH"

echo -e "${GREEN}✅ RP Token Encryption Key generated${NC}"
echo "📝 Saved to: $RP_ENCRYPTION_KEY_PATH"
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
    "rpTokenEncryptionKey": "$RP_ENCRYPTION_KEY_PATH"
  }
}
EOF

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
echo ""
echo "2. For Remote environment, upload keys as secrets:"
echo ""
echo "   cat $PRIVATE_KEY_PATH | wrangler secret put PRIVATE_KEY_PEM"
echo "   wrangler vars set KEY_ID \"$KID\""
echo "   cat $RP_ENCRYPTION_KEY_PATH | wrangler secret put RP_TOKEN_ENCRYPTION_KEY"
echo ""
echo "3. Or use setup-resend.sh to configure Resend:"
echo ""
echo "   ./scripts/setup-resend.sh --env=local"
echo "   ./scripts/setup-resend.sh --env=remote"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "${YELLOW}⚠️  Security Note:${NC}"
echo "   The .keys directory is gitignored by default."
echo "   Never commit private keys to version control!"
echo ""
echo "📊 Public JWK (for JWKS endpoint):"
echo ""

if [ -f "$PUBLIC_JWK_PATH" ]; then
    cat "$PUBLIC_JWK_PATH"
fi

echo ""
