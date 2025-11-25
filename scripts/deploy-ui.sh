#!/bin/bash

# UI Deployment script for Cloudflare Pages
#
# Usage:
#   ./scripts/deploy-ui.sh --env=dev
#   ./scripts/deploy-ui.sh --env=conformance
#   ./scripts/deploy-ui.sh --env=prod

set -e

DEPLOY_ENV=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --env=*)
            DEPLOY_ENV="${1#*=}"
            shift
            ;;
        *)
            echo "❌ Unknown parameter: $1"
            echo ""
            echo "Usage: $0 --env=<environment>"
            echo ""
            echo "Options:"
            echo "  --env=<name>    Environment name (required)"
            echo ""
            echo "Examples:"
            echo "  $0 --env=dev"
            echo "  $0 --env=conformance"
            echo "  $0 --env=prod"
            exit 1
            ;;
    esac
done

# Validate required parameters
if [ -z "$DEPLOY_ENV" ]; then
    echo "❌ Error: --env parameter is required"
    echo ""
    echo "Usage: $0 --env=<environment>"
    echo ""
    echo "Examples:"
    echo "  $0 --env=dev"
    echo "  $0 --env=conformance"
    echo "  $0 --env=prod"
    exit 1
fi

# Determine project name based on environment
case $DEPLOY_ENV in
    prod|production)
        PROJECT_NAME="authrim-ui"
        ;;
    *)
        PROJECT_NAME="${DEPLOY_ENV}-authrim-ui"
        ;;
esac

echo "🚀 Deploying UI to Cloudflare Pages"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   Environment:  $DEPLOY_ENV"
echo "   Project:      $PROJECT_NAME"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Build UI
echo "🔨 Building UI..."
pnpm --filter=ui build
echo ""

# Deploy to Cloudflare Pages
echo "📤 Deploying to Cloudflare Pages..."
wrangler pages deploy packages/ui/.svelte-kit/cloudflare --project-name="$PROJECT_NAME"

echo ""
echo "✅ UI deployment complete!"
