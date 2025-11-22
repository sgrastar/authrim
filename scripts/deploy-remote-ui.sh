#!/bin/bash
#
# Authrim Remote UI Deployment Script
# Deploy SvelteKit UI to Cloudflare Pages and configure CORS
#
# Usage:
#   ./scripts/deploy-remote-ui.sh
#

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

echo -e "${MAGENTA}🚀 Authrim Remote UI Deployment${NC}"
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

# Check if UI package exists
if [[ ! -d "packages/ui" ]]; then
    echo -e "${RED}❌ Error: packages/ui directory not found${NC}"
    exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📍 Domain Configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "How would you like to configure UI domains?"
echo ""
echo "  1) Custom Domain (e.g., https://login.example.com)"
echo "  2) Cloudflare Pages auto-generated URL (e.g., https://authrim-login-abc.pages.dev)"
echo "  3) Cancel"
echo ""

read -p "Enter your choice (1-3): " -r DOMAIN_CHOICE
echo ""

case $DOMAIN_CHOICE in
    1)
        DOMAIN_TYPE="custom"
        echo "📝 Enter custom domains:"
        echo ""

        read -p "Login Page domain (e.g., https://login.example.com): " LOGIN_DOMAIN

        if [[ -z "$LOGIN_DOMAIN" ]]; then
            echo -e "${RED}❌ Error: Login domain cannot be empty${NC}"
            exit 1
        fi

        read -p "Admin Page domain (e.g., https://admin.example.com): " ADMIN_DOMAIN

        if [[ -z "$ADMIN_DOMAIN" ]]; then
            echo -e "${RED}❌ Error: Admin domain cannot be empty${NC}"
            exit 1
        fi
        ;;
    2)
        DOMAIN_TYPE="pages-dev"
        echo "ℹ️  Pages.dev URLs will be assigned after deployment"
        LOGIN_DOMAIN="TBD"
        ADMIN_DOMAIN="TBD"
        ;;
    3|*)
        echo -e "${BLUE}❌ Deployment cancelled${NC}"
        exit 0
        ;;
esac

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔧 API & Project Configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# API Base URL
read -p "API Base URL (e.g., https://authrim.subdomain.workers.dev): " API_BASE_URL

if [[ -z "$API_BASE_URL" ]]; then
    echo -e "${RED}❌ Error: API Base URL cannot be empty${NC}"
    exit 1
fi

# Remove trailing slash
API_BASE_URL=${API_BASE_URL%/}

echo ""

# Deployment type
echo "Which UI components would you like to deploy?"
echo ""
echo "  1) Login Page only"
echo "  2) Admin Page only"
echo "  3) Both (Login + Admin)"
echo ""

read -p "Enter your choice (1-3) [3]: " -r DEPLOY_TYPE
DEPLOY_TYPE=${DEPLOY_TYPE:-3}

case $DEPLOY_TYPE in
    1)
        DEPLOY_LOGIN="true"
        DEPLOY_ADMIN="false"
        ;;
    2)
        DEPLOY_LOGIN="false"
        DEPLOY_ADMIN="true"
        ;;
    3|*)
        DEPLOY_LOGIN="true"
        DEPLOY_ADMIN="true"
        ;;
esac

echo ""

# Project names
if [[ "$DEPLOY_LOGIN" == "true" ]]; then
    read -p "Login Page project name (default: authrim-login): " LOGIN_PROJECT
    LOGIN_PROJECT=${LOGIN_PROJECT:-"authrim-login"}
fi

if [[ "$DEPLOY_ADMIN" == "true" ]]; then
    read -p "Admin Page project name (default: authrim-admin): " ADMIN_PROJECT
    ADMIN_PROJECT=${ADMIN_PROJECT:-"authrim-admin"}
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Configuration Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🌐 Domain Configuration:"
echo "   Type: $([ "$DOMAIN_TYPE" = "custom" ] && echo "Custom Domain" || echo "Cloudflare Pages")"

if [[ "$DEPLOY_LOGIN" == "true" ]]; then
    echo "   Login Page: $LOGIN_DOMAIN"
fi

if [[ "$DEPLOY_ADMIN" == "true" ]]; then
    echo "   Admin Page: $ADMIN_DOMAIN"
fi

echo ""
echo "🔌 API Configuration:"
echo "   Base URL: $API_BASE_URL"
echo ""

if [[ "$DEPLOY_LOGIN" == "true" ]]; then
    echo "📦 Login Page:"
    echo "   Project: $LOGIN_PROJECT"
fi

if [[ "$DEPLOY_ADMIN" == "true" ]]; then
    echo "📦 Admin Page:"
    echo "   Project: $ADMIN_PROJECT"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

read -p "Proceed with deployment? (y/N): " -n 1 -r
echo
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${BLUE}❌ Deployment cancelled${NC}"
    exit 0
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}🔨 Starting Deployment${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Create .env file
echo "📝 Creating .env file..."
cat > packages/ui/.env <<EOF
# Auto-generated by deploy-remote-ui.sh
# API Configuration
PUBLIC_API_BASE_URL=$API_BASE_URL
EOF

echo -e "${GREEN}✅ .env file created${NC}"
echo ""

# Build UI
echo "🔨 Building UI package..."
if pnpm --filter=ui build; then
    echo -e "${GREEN}✅ Build complete${NC}"
else
    echo -e "${RED}❌ Build failed${NC}"
    exit 1
fi

echo ""

# Deploy to Cloudflare Pages
DEPLOYED_URLS=()

if [[ "$DEPLOY_LOGIN" == "true" ]]; then
    echo "📤 Deploying Login Page: $LOGIN_PROJECT"
    if yes | wrangler pages deploy packages/ui/.svelte-kit/cloudflare \
        --project-name="$LOGIN_PROJECT" \
        --branch=main 2>/dev/null; then
        echo -e "${GREEN}✅ Login Page deployed${NC}"

        # Extract deployed URL
        if [[ "$DOMAIN_TYPE" == "custom" ]]; then
            DEPLOYED_URLS+=("$LOGIN_DOMAIN")
        else
            DEPLOYED_URLS+=("https://$LOGIN_PROJECT.pages.dev")
        fi
    else
        echo -e "${RED}❌ Login Page deployment failed${NC}"
        exit 1
    fi

    echo ""
fi

if [[ "$DEPLOY_ADMIN" == "true" ]]; then
    echo "📤 Deploying Admin Page: $ADMIN_PROJECT"
    if yes | wrangler pages deploy packages/ui/.svelte-kit/cloudflare \
        --project-name="$ADMIN_PROJECT" \
        --branch=main 2>/dev/null; then
        echo -e "${GREEN}✅ Admin Page deployed${NC}"

        # Extract deployed URL
        if [[ "$DOMAIN_TYPE" == "custom" ]]; then
            DEPLOYED_URLS+=("$ADMIN_DOMAIN")
        else
            DEPLOYED_URLS+=("https://$ADMIN_PROJECT.pages.dev")
        fi
    else
        echo -e "${RED}❌ Admin Page deployment failed${NC}"
        exit 1
    fi

    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}🎉 UI Deployment Complete!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "📋 Deployed URLs:"
for url in "${DEPLOYED_URLS[@]}"; do
    echo "   🌐 $url"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔒 CORS Configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

read -p "Configure CORS for these origins? (Y/n): " -n 1 -r
echo
echo ""

if [[ ! $REPLY =~ ^[Nn]$ ]]; then
    # Build origins string
    ORIGINS_STR=$(IFS=,; echo "${DEPLOYED_URLS[*]}")

    echo "🔧 Running CORS configuration..."
    echo ""

    if [[ -f "scripts/setup-remote-cors.sh" ]]; then
        # Call setup-remote-cors.sh with origins
        ./scripts/setup-remote-cors.sh --origins="$ORIGINS_STR"
    else
        echo -e "${YELLOW}⚠️  setup-remote-cors.sh not found${NC}"
        echo "   Please run manually:"
        echo "   ./scripts/setup-remote-cors.sh"
    fi
else
    echo "⊗ CORS configuration skipped"
    echo ""
    echo "To configure CORS later, run:"
    echo "   ./scripts/setup-remote-cors.sh --origins=\"$(IFS=,; echo "${DEPLOYED_URLS[*]}")\""
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Next Steps"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. Verify UI is accessible:"

for url in "${DEPLOYED_URLS[@]}"; do
    echo "   curl -I $url"
done

echo ""
echo "2. Test API integration:"

for url in "${DEPLOYED_URLS[@]}"; do
    echo "   • Visit: $url"
done

echo ""
echo "3. If using custom domains, verify DNS configuration"
echo ""
