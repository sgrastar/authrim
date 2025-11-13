#!/bin/bash
#
# Generate Initial Access Token for Dynamic Client Registration
#
# This script generates a secure random token and stores it in the
# INITIAL_ACCESS_TOKENS KV namespace. The token can be used by clients
# to register with the OpenID Provider.
#
# Usage:
#   ./scripts/generate-initial-access-token.sh [OPTIONS]
#
# Options:
#   --single-use    Token will be deleted after first use (default: false)
#   --expires       Token expiration in seconds (default: never expires)
#   --description   Description for this token
#

set -e

echo "🔑 Generate Initial Access Token"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Error: wrangler is not installed"
    echo "Please install it with: pnpm install -g wrangler"
    exit 1
fi

# Parse arguments
SINGLE_USE=false
EXPIRES=""
DESCRIPTION=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --single-use)
            SINGLE_USE=true
            shift
            ;;
        --expires)
            EXPIRES="$2"
            shift 2
            ;;
        --description)
            DESCRIPTION="$2"
            shift 2
            ;;
        *)
            echo "❌ Unknown option: $1"
            echo "Usage: $0 [--single-use] [--expires SECONDS] [--description DESC]"
            exit 1
            ;;
    esac
done

# Generate secure random token (32 bytes = 256 bits)
# Using base64url encoding (no padding)
TOKEN=$(openssl rand -base64 32 | tr -d '=' | tr '+/' '-_')

echo "🎲 Generated token:"
echo "   $TOKEN"
echo ""

# Build metadata JSON
METADATA="{\"single_use\":$SINGLE_USE"

if [ -n "$DESCRIPTION" ]; then
    # Escape quotes in description
    ESCAPED_DESC=$(echo "$DESCRIPTION" | sed 's/"/\\"/g')
    METADATA="$METADATA,\"description\":\"$ESCAPED_DESC\""
fi

METADATA="$METADATA,\"created_at\":$(date +%s)}"

echo "📝 Token Metadata:"
echo "   Single-use: $SINGLE_USE"
if [ -n "$DESCRIPTION" ]; then
    echo "   Description: $DESCRIPTION"
fi
if [ -n "$EXPIRES" ]; then
    echo "   Expires in: ${EXPIRES}s ($(($EXPIRES / 3600)) hours)"
fi
echo ""

# Confirm before storing
read -p "Store this token in INITIAL_ACCESS_TOKENS KV? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Cancelled"
    exit 1
fi

# Store in KV namespace
echo ""
echo "💾 Storing token in KV namespace..."

# Build wrangler command
KV_CMD="wrangler kv key put --namespace-id=\$(wrangler kv namespace list | grep 'INITIAL_ACCESS_TOKENS' | grep -o '[a-f0-9]\\{32\\}' | head -1) \"$TOKEN\" '$METADATA'"

if [ -n "$EXPIRES" ]; then
    KV_CMD="$KV_CMD --expiration-ttl=$EXPIRES"
fi

# Get KV namespace ID
echo "🔍 Looking up INITIAL_ACCESS_TOKENS namespace..."
NAMESPACE_LIST=$(wrangler kv namespace list 2>&1)

if ! echo "$NAMESPACE_LIST" | grep -q "INITIAL_ACCESS_TOKENS"; then
    echo ""
    echo "❌ Error: INITIAL_ACCESS_TOKENS namespace not found"
    echo ""
    echo "Please create it first by running:"
    echo "  wrangler kv namespace create INITIAL_ACCESS_TOKENS"
    echo ""
    echo "Or run the setup script:"
    echo "  ./scripts/setup-kv.sh"
    exit 1
fi

NAMESPACE_ID=$(echo "$NAMESPACE_LIST" | grep 'INITIAL_ACCESS_TOKENS' | grep -o '[a-f0-9]\{32\}' | head -1)

if [ -z "$NAMESPACE_ID" ]; then
    echo "❌ Error: Could not extract namespace ID"
    exit 1
fi

echo "✅ Found namespace: $NAMESPACE_ID"
echo ""

# Store the token
if [ -n "$EXPIRES" ]; then
    wrangler kv key put --namespace-id="$NAMESPACE_ID" "$TOKEN" "$METADATA" --expiration-ttl="$EXPIRES"
else
    wrangler kv key put --namespace-id="$NAMESPACE_ID" "$TOKEN" "$METADATA"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Initial Access Token created successfully!"
echo ""
echo "📋 Usage:"
echo ""
echo "   Use this token in the Authorization header when registering clients:"
echo ""
echo "   curl -X POST https://your-op.workers.dev/register \\"
echo "     -H \"Authorization: Bearer $TOKEN\" \\"
echo "     -H \"Content-Type: application/json\" \\"
echo "     -d '{\"redirect_uris\": [\"https://example.com/callback\"]}'"
echo ""
if [ "$SINGLE_USE" = true ]; then
    echo "   ⚠️  This is a SINGLE-USE token. It will be deleted after first use."
else
    echo "   ♻️  This is a REUSABLE token. It can be used multiple times."
fi
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
