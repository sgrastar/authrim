#!/bin/bash

# UI Deployment script for Cloudflare Pages
#
# Usage:
#   ./scripts/deploy-ui.sh --env=dev                       # Deploy both Admin and Login UI
#   ./scripts/deploy-ui.sh --env=dev --package=ar-admin-ui # Deploy only Admin UI
#   ./scripts/deploy-ui.sh --env=dev --package=ar-login-ui # Deploy only Login UI

set -e

DEPLOY_ENV=""
PACKAGE=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --env=*)
            DEPLOY_ENV="${1#*=}"
            shift
            ;;
        --package=*)
            PACKAGE="${1#*=}"
            shift
            ;;
        *)
            echo "❌ Unknown parameter: $1"
            echo ""
            echo "Usage: $0 --env=<environment> [--package=<package>]"
            echo ""
            echo "Options:"
            echo "  --env=<name>      Environment name (required)"
            echo "  --package=<name>  Package to deploy: ar-admin-ui or ar-login-ui (optional, defaults to both)"
            echo ""
            echo "Examples:"
            echo "  $0 --env=dev                        # Deploy both UI packages"
            echo "  $0 --env=dev --package=ar-admin-ui  # Deploy only Admin UI"
            echo "  $0 --env=dev --package=ar-login-ui  # Deploy only Login UI"
            echo "  $0 --env=prod"
            exit 1
            ;;
    esac
done

# Validate required parameters
if [ -z "$DEPLOY_ENV" ]; then
    echo "❌ Error: --env parameter is required"
    echo ""
    echo "Usage: $0 --env=<environment> [--package=<package>]"
    echo ""
    echo "Examples:"
    echo "  $0 --env=dev"
    echo "  $0 --env=prod"
    exit 1
fi

# Validate package parameter if provided
if [ -n "$PACKAGE" ] && [ "$PACKAGE" != "ar-admin-ui" ] && [ "$PACKAGE" != "ar-login-ui" ]; then
    echo "❌ Error: Invalid package name: $PACKAGE"
    echo ""
    echo "Valid packages: ar-admin-ui, ar-login-ui"
    exit 1
fi

# Function to deploy a single UI package
deploy_package() {
    local pkg=$1
    local project_name

    # Determine project name based on environment
    case $DEPLOY_ENV in
        prod|production)
            project_name="authrim-${pkg#ar-}"  # Remove ar- prefix: ar-admin-ui -> authrim-admin-ui
            ;;
        *)
            project_name="${DEPLOY_ENV}-${pkg}"
            ;;
    esac

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📦 Deploying $pkg"
    echo "   Project:  $project_name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # Check if package exists
    if [ ! -d "packages/$pkg" ]; then
        echo "⚠️  Package $pkg not found, skipping..."
        return 0
    fi

    # Build UI
    echo "🔨 Building $pkg..."
    pnpm --filter="@authrim/$pkg" build
    echo ""

    # Deploy to Cloudflare Pages
    echo "📤 Deploying to Cloudflare Pages..."
    wrangler pages deploy "packages/$pkg/.svelte-kit/cloudflare" --project-name="$project_name"

    echo ""
    echo "✅ $pkg deployment complete!"
    echo ""
}

echo "🚀 Deploying UI to Cloudflare Pages"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   Environment:  $DEPLOY_ENV"
if [ -n "$PACKAGE" ]; then
    echo "   Package:      $PACKAGE"
else
    echo "   Package:      all (ar-admin-ui, ar-login-ui)"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Deploy packages
if [ -n "$PACKAGE" ]; then
    # Deploy single package
    deploy_package "$PACKAGE"
else
    # Deploy both packages
    deploy_package "ar-login-ui"
    deploy_package "ar-admin-ui"
fi

echo "🎉 All UI deployments complete!"
