#!/bin/bash
#
# Authrim Remote CORS Configuration Script
# Configure CORS settings in SETTINGS_KV namespace for remote Cloudflare Workers
#
# Usage:
#   ./scripts/setup-remote-cors.sh
#   ./scripts/setup-remote-cors.sh --origins="https://app.example.com"
#

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}⚙️  Authrim Remote CORS Configuration${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if wrangler is available
if ! command -v wrangler &> /dev/null; then
    echo -e "${RED}❌ Error: wrangler is not installed${NC}"
    echo "Please install it with: pnpm install -g wrangler"
    exit 1
fi

# Check if logged in to Cloudflare
if ! wrangler whoami &> /dev/null; then
    echo -e "${RED}❌ Error: Not logged in to Cloudflare${NC}"
    echo "Please run: wrangler login"
    exit 1
fi

# Parse command line arguments
ORIGINS_ARG=""
for arg in "$@"; do
    if [[ $arg == --origins=* ]]; then
        ORIGINS_ARG="${arg#--origins=}"
    fi
done

# Get SETTINGS_KV namespace ID
echo "🔍 Finding SETTINGS_KV namespace..."
SETTINGS_KV_ID=$(wrangler kv namespace list --json 2>/dev/null | jq -r '.[] | select(.title == "SETTINGS_KV") | .id' 2>/dev/null | head -1)

if [[ -z "$SETTINGS_KV_ID" || "$SETTINGS_KV_ID" == "null" ]]; then
    echo -e "${YELLOW}⚠️  SETTINGS_KV namespace not found${NC}"
    echo ""
    echo "Enter the SETTINGS_KV namespace ID manually:"
    echo "(You can find it in Cloudflare Dashboard → KV → Namespaces)"
    echo ""
    read -p "SETTINGS_KV namespace ID: " SETTINGS_KV_ID

    if [[ -z "$SETTINGS_KV_ID" ]]; then
        echo -e "${RED}❌ Error: Namespace ID cannot be empty${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✅ Found SETTINGS_KV: $SETTINGS_KV_ID${NC}"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 CORS Configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Get Allowed Origins
if [[ -n "$ORIGINS_ARG" ]]; then
    ALLOWED_ORIGINS="$ORIGINS_ARG"
    echo "Origins (from argument): $ALLOWED_ORIGINS"
else
    echo "Enter allowed origins (comma-separated URLs)"
    echo "Examples:"
    echo "  • https://login.example.com"
    echo "  • https://login.example.com,https://admin.example.com"
    echo "  • https://authrim-login-abc.pages.dev,https://authrim-admin-xyz.pages.dev"
    echo ""
    read -p "Allowed Origins: " ALLOWED_ORIGINS
fi

if [[ -z "$ALLOWED_ORIGINS" ]]; then
    echo -e "${RED}❌ Error: Origins cannot be empty${NC}"
    exit 1
fi

echo ""

# Get Allowed Methods
echo "Allowed Methods (default: GET, POST, PUT, DELETE, OPTIONS)"
read -p "Allowed Methods (or press Enter for default): " ALLOWED_METHODS
ALLOWED_METHODS=${ALLOWED_METHODS:-"GET, POST, PUT, DELETE, OPTIONS"}

echo ""

# Get Allowed Headers
echo "Allowed Headers (default: Content-Type, Authorization, Accept)"
read -p "Allowed Headers (or press Enter for default): " ALLOWED_HEADERS
ALLOWED_HEADERS=${ALLOWED_HEADERS:-"Content-Type, Authorization, Accept"}

echo ""

# Get Max Age
echo "Max Age in seconds (default: 86400 = 24 hours)"
read -p "Max Age (or press Enter for default): " MAX_AGE
MAX_AGE=${MAX_AGE:-"86400"}

# Validate Max Age is a number
if ! [[ "$MAX_AGE" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}❌ Error: Max Age must be a number${NC}"
    exit 1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Configuration Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📦 Namespace: SETTINGS_KV"
echo "   ID: $SETTINGS_KV_ID"
echo ""
echo "🌐 Allowed Origins:"
echo "   $ALLOWED_ORIGINS"
echo ""
echo "📋 Allowed Methods:"
echo "   $ALLOWED_METHODS"
echo ""
echo "📄 Allowed Headers:"
echo "   $ALLOWED_HEADERS"
echo ""
echo "⏱️  Max Age:"
echo "   $MAX_AGE seconds"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

read -p "Proceed with CORS configuration? (y/N): " -n 1 -r
echo
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${BLUE}❌ CORS configuration cancelled${NC}"
    exit 0
fi

# Create CORS settings JSON
CORS_SETTINGS=$(cat <<EOF
{
  "enabled": true,
  "allowed_origins": [$(echo "$ALLOWED_ORIGINS" | sed 's/,/"\n  , "/g' | sed 's/^/"/' | sed 's/$/"/')]
  "allowed_methods": [$(echo "$ALLOWED_METHODS" | sed 's/, /", "/g' | sed 's/^/"/' | sed 's/$/" /')]
  "allowed_headers": [$(echo "$ALLOWED_HEADERS" | sed 's/, /", "/g' | sed 's/^/"/' | sed 's/$/" /')]
  "max_age": $MAX_AGE
}
EOF
)

echo "🔧 Uploading CORS configuration to SETTINGS_KV..."
echo ""

# Upload to KV
if echo "$CORS_SETTINGS" | wrangler kv key put "cors_settings" \
  --namespace-id="$SETTINGS_KV_ID" \
  --path=/dev/stdin 2>/dev/null; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${GREEN}✅ CORS Configuration Complete!${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "📌 Configuration Details:"
    echo "   • Stored in: SETTINGS_KV[cors_settings]"
    echo "   • Allowed Origins: $ALLOWED_ORIGINS"
    echo "   • Methods: $ALLOWED_METHODS"
    echo "   • Headers: $ALLOWED_HEADERS"
    echo ""
    echo "⚠️  Note: CORS configuration will be applied on the next worker deployment"
    echo "   Deploy workers to activate:"
    echo "   pnpm run deploy:retry"
    echo ""
else
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${RED}❌ Failed to upload CORS configuration${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Possible reasons:"
    echo "  1. Invalid namespace ID"
    echo "  2. KV namespace not found in Cloudflare"
    echo "  3. Network error"
    echo ""
    exit 1
fi
