#!/bin/bash
#
# Authrim Resend Email Configuration Script
# Configures Resend API for sending magic link emails
#
# Usage:
#   ./setup-resend.sh [--env=local|remote]
#

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Parse command line arguments
ENV=""
for arg in "$@"; do
    if [[ $arg == --env=* ]]; then
        ENV="${arg#--env=}"
    fi
done

echo -e "${BLUE}📧 Authrim Resend Email Configuration${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# If environment not specified, prompt for it
if [ -z "$ENV" ]; then
    echo "Select environment:"
    echo "  1) local   (not supported: local development logs notifications instead)"
    echo "  2) dev     (Remote dev environment with Cloudflare Secrets)"
    echo "  3) staging (Remote staging environment with Cloudflare Secrets)"
    echo "  4) prod    (Remote production environment with Cloudflare Secrets)"
    echo "  5) Custom  (Enter custom environment name)"
    echo "  6) Cancel"
    echo ""
    read -p "Enter your choice (1-6): " -r choice
    echo ""

    case $choice in
        1)
            ENV="local"
            ;;
        2)
            ENV="dev"
            ;;
        3)
            ENV="staging"
            ;;
        4)
            ENV="prod"
            ;;
        5)
            read -p "Enter environment name: " -r ENV
            if [ -z "$ENV" ]; then
                echo -e "${RED}❌ Error: Environment name cannot be empty${NC}"
                exit 1
            fi
            ;;
        6|*)
            echo -e "${BLUE}❌ Setup cancelled${NC}"
            exit 0
            ;;
    esac
fi

echo "Environment: $ENV"

if [ "$ENV" = "local" ]; then
    echo ""
    echo -e "${YELLOW}Local development does not send email.${NC}"
    echo "'pnpm setup:local init' routes every notification to the Worker log, so one-time"
    echo "codes and magic links appear in .authrim-local/<env>/logs/workers.log."
    echo "To test a real provider, configure a deployed environment (--env=dev|staging|prod)."
    exit 1
fi
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📧 Resend Email Configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Authrim uses Resend (https://resend.com) for sending magic link emails."
echo "This is optional - without it, magic links will return URLs instead."
echo ""
echo "Do you want to configure Resend? (y/N): " | tr -d '\n'
read -n 1 -r
echo
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}⊗ Resend configuration skipped${NC}"
    echo "   Magic links will return URLs instead of sending emails"
    echo ""
    exit 0
fi

# Prompt for Resend API key
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Getting your Resend API key:"
echo ""
echo "1. Go to https://resend.com/dashboard/api-keys"
echo "2. Create a new API key"
echo "3. Copy the key"
echo ""

read -sp "Paste your Resend API key: " RESEND_API_KEY
echo ""
echo ""

if [ -z "$RESEND_API_KEY" ]; then
    echo -e "${YELLOW}⊗ No API key provided - skipping Resend configuration${NC}"
    exit 0
fi

# Validate API key format (Resend keys start with 're_')
if [[ ! $RESEND_API_KEY =~ ^re_ ]]; then
    echo -e "${YELLOW}⚠️  Warning: API key doesn't look like a Resend key (should start with 're_')${NC}"
    read -p "Continue anyway? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}❌ Setup cancelled${NC}"
        exit 0
    fi
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📧 Email From Address"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Enter the email address to use as the sender for magic links."
echo ""
echo "Examples:"
echo "  • noreply@yourdomain.com"
echo "  • hello@example.com"
echo ""

read -p "Email From address: " EMAIL_FROM

if [ -z "$EMAIL_FROM" ]; then
    EMAIL_FROM="noreply@yourdomain.com"
fi

echo ""
echo -e "${GREEN}✅ Configuration:${NC}"
echo "   API Key: ${RESEND_API_KEY:0:10}...${RESEND_API_KEY: -5}"
echo "   Email From: $EMAIL_FROM"
echo ""

# Apply configuration (deployed environments use Wrangler secrets)
if true; then
    # Remote environment: use wrangler secrets
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🔧 Uploading to Cloudflare Secrets - Environment: $ENV"
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

    echo "Uploading Resend API key as secret..."
    echo ""

    # Upload secrets to each worker that needs them
    BASE_WORKERS=(
        "ar-auth"
        "ar-management"
    )

    for base_worker in "${BASE_WORKERS[@]}"; do
        worker_name="${ENV}-authrim-${base_worker}"
        echo "  • Uploading to $worker_name..."
        echo "$RESEND_API_KEY" | wrangler secret put RESEND_API_KEY --name="$worker_name"
        echo "    ✅ Secret uploaded"
    done

    echo ""
    echo "Uploading EMAIL_FROM as secret (instead of environment variable)..."
    echo ""

    for base_worker in "${BASE_WORKERS[@]}"; do
        worker_name="${ENV}-authrim-${base_worker}"
        echo "  • Setting in $worker_name..."
        echo "$EMAIL_FROM" | wrangler secret put EMAIL_FROM --name="$worker_name"
        echo "    ✅ Secret uploaded"
    done

    echo ""
    echo -e "${GREEN}✅ Resend configuration uploaded to Cloudflare${NC}"
    echo ""
    echo "📋 Updated workers:"
    for base_worker in "${BASE_WORKERS[@]}"; do
        echo "   • ${ENV}-authrim-${base_worker}"
    done
    echo ""

    echo "⚠️  Note: Changes are immediate (no redeployment needed for secrets)"
    echo "   However, if this is a new worker, you'll need to deploy it first:"
    echo "   pnpm run deploy -- --env=$ENV"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}🎉 Resend configuration complete!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📧 Email Setup Summary:"
echo "   • Sender: $EMAIL_FROM"
echo "   • Provider: Resend (https://resend.com)"
echo "   • Status: ✅ Configured"
echo ""
echo "🔐 Security Notes:"
echo "   • API key stored as Cloudflare Secret"
echo "   • Email From stored as Cloudflare Environment Variable"
echo "   • Secrets are encrypted and never exposed in logs"
echo ""
echo "Next steps:"
echo "   1. Run 'pnpm run deploy -- --env=$ENV' to deploy with Resend support"
echo "   2. Magic links will send emails via Resend"
echo ""
