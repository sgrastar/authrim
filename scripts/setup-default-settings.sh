#!/bin/bash

# Setup Default Settings for Authrim
#
# This script initializes the SETTINGS KV with default system settings
# based on the "basic-op" certification profile.
#
# Usage:
#   ./scripts/setup-default-settings.sh --env=dev [--force]
#
# Options:
#   --env=ENV    Deployment environment (dev, staging, prod)
#   --force      Overwrite existing settings without confirmation
#   --help       Show this help message

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
DEPLOY_ENV=""
FORCE=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Function to print colored output
print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Function to show help
show_help() {
    cat << EOF
Setup Default Settings for Authrim

Usage:
  ./scripts/setup-default-settings.sh --env=ENV [OPTIONS]

Options:
  --env=ENV    Deployment environment (required: dev, staging, prod)
  --force      Overwrite existing settings without confirmation
  --help       Show this help message

Examples:
  ./scripts/setup-default-settings.sh --env=dev
  ./scripts/setup-default-settings.sh --env=prod --force

This script initializes the SETTINGS KV with default system settings
based on the "basic-op" OpenID Connect certification profile.

Default Profile: basic-op
- Standard OpenID Connect Provider (Authorization Code Flow)
- PAR not required
- Public clients allowed
- Standard authentication methods enabled
- 'none' algorithm allowed for testing

For production deployments, you may want to apply a stricter profile
after initialization using:
  ./scripts/switch-certification-profile.sh fapi-2

EOF
}

# Parse arguments
for arg in "$@"; do
    case $arg in
        --env=*)
            DEPLOY_ENV="${arg#*=}"
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        --help)
            show_help
            exit 0
            ;;
        *)
            print_error "Unknown argument: $arg"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Validate environment
if [ -z "$DEPLOY_ENV" ]; then
    print_error "Deployment environment is required"
    echo "Usage: $0 --env=ENV"
    echo "Use --help for more information"
    exit 1
fi

# Validate environment value
case $DEPLOY_ENV in
    dev|staging|prod)
        ;;
    *)
        print_error "Invalid environment: $DEPLOY_ENV"
        echo "Valid environments: dev, staging, prod"
        exit 1
        ;;
esac

# Main script
main() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║  Authrim - Default Settings Initialization               ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo ""

    print_info "Environment: ${DEPLOY_ENV}"
    print_info "Profile: basic-op (Standard OpenID Connect Provider)"
    echo ""

    # Check if wrangler is installed
    if ! command -v wrangler &> /dev/null; then
        print_error "wrangler CLI is not installed"
        echo "Install with: npm install -g wrangler"
        exit 1
    fi

    # Check if jq is installed
    if ! command -v jq &> /dev/null; then
        print_error "jq is not installed"
        echo "Install with: brew install jq (macOS) or apt-get install jq (Linux)"
        exit 1
    fi

    # Get SETTINGS KV namespace ID from wrangler.toml
    print_info "Reading KV namespace ID from wrangler.toml..."

    SETTINGS_ID=""
    if [ -f "$PROJECT_ROOT/wrangler.toml" ]; then
        # Extract SETTINGS KV namespace ID for the specified environment
        SETTINGS_ID=$(grep -A 5 "binding = \"SETTINGS\"" "$PROJECT_ROOT/wrangler.toml" | grep "id = " | head -1 | sed 's/.*id = "\(.*\)".*/\1/')
    fi

    if [ -z "$SETTINGS_ID" ]; then
        print_error "Could not find SETTINGS KV namespace ID in wrangler.toml"
        print_info "Please run ./scripts/setup-kv.sh first to create KV namespaces"
        exit 1
    fi

    print_success "Found SETTINGS namespace ID: ${SETTINGS_ID}"
    echo ""

    # Check if settings already exist
    if [ "$FORCE" = false ]; then
        print_info "Checking for existing settings..."

        EXISTING_SETTINGS=$(wrangler kv:key get --namespace-id="$SETTINGS_ID" "system_settings" 2>/dev/null || echo "")

        if [ -n "$EXISTING_SETTINGS" ] && [ "$EXISTING_SETTINGS" != "null" ]; then
            print_warning "Settings already exist in KV"
            echo ""
            echo "Existing settings preview:"
            echo "$EXISTING_SETTINGS" | jq '.' 2>/dev/null || echo "$EXISTING_SETTINGS"
            echo ""
            read -p "Do you want to overwrite? (y/N): " -n 1 -r
            echo ""
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                print_info "Initialization cancelled"
                exit 0
            fi
        fi
    fi

    # Create default settings JSON (based on basic-op profile + admin defaults)
    print_info "Creating default settings..."

    DEFAULT_SETTINGS=$(cat <<'EOF'
{
  "general": {
    "siteName": "Authrim",
    "logoUrl": "",
    "language": "en",
    "timezone": "UTC"
  },
  "appearance": {
    "primaryColor": "#3B82F6",
    "secondaryColor": "#10B981",
    "fontFamily": "Inter"
  },
  "security": {
    "sessionTimeout": 86400,
    "mfaEnforced": false,
    "passwordMinLength": 8,
    "passwordRequireSpecialChar": true
  },
  "email": {
    "emailProvider": "resend",
    "smtpHost": "",
    "smtpPort": 587,
    "smtpUsername": "",
    "smtpPassword": ""
  },
  "advanced": {
    "accessTokenTtl": 3600,
    "idTokenTtl": 3600,
    "refreshTokenTtl": 2592000,
    "passkeyEnabled": true,
    "magicLinkEnabled": true
  },
  "ciba": {
    "enabled": true,
    "defaultExpiresIn": 300,
    "minExpiresIn": 60,
    "maxExpiresIn": 600,
    "defaultInterval": 5,
    "minInterval": 2,
    "maxInterval": 60,
    "supportedDeliveryModes": ["poll", "ping", "push"],
    "userCodeEnabled": true,
    "bindingMessageMaxLength": 140,
    "notificationsEnabled": false,
    "notificationProviders": {
      "email": false,
      "sms": false,
      "push": false
    }
  },
  "oidc": {
    "requirePar": false,
    "claimsSupported": [
      "sub", "iss", "aud", "exp", "iat", "auth_time", "nonce",
      "acr", "amr", "azp", "at_hash", "c_hash",
      "name", "given_name", "family_name", "middle_name", "nickname",
      "preferred_username", "profile", "picture", "website",
      "email", "email_verified", "gender", "birthdate",
      "zoneinfo", "locale", "phone_number", "phone_number_verified",
      "address", "updated_at"
    ],
    "responseTypesSupported": ["code"],
    "tokenEndpointAuthMethodsSupported": [
      "client_secret_basic",
      "client_secret_post",
      "client_secret_jwt",
      "private_key_jwt",
      "none"
    ],
    "allowNoneAlgorithm": true
  },
  "fapi": {
    "enabled": false,
    "requireDpop": false,
    "allowPublicClients": true
  }
}
EOF
)

    # Validate JSON
    if ! echo "$DEFAULT_SETTINGS" | jq '.' > /dev/null 2>&1; then
        print_error "Invalid JSON in default settings"
        exit 1
    fi

    print_success "Default settings validated"
    echo ""

    # Write to KV
    print_info "Writing settings to KV..."

    if echo "$DEFAULT_SETTINGS" | wrangler kv:key put \
        --namespace-id="$SETTINGS_ID" \
        "system_settings" \
        --path=/dev/stdin 2>&1; then

        print_success "Settings initialized successfully!"
        echo ""

        # Verify write
        print_info "Verifying settings..."
        STORED_SETTINGS=$(wrangler kv:key get --namespace-id="$SETTINGS_ID" "system_settings")

        if [ -n "$STORED_SETTINGS" ]; then
            print_success "Settings verified in KV"
            echo ""
            echo "Configuration summary:"
            echo "$STORED_SETTINGS" | jq '{
                profile: "basic-op",
                fapi: .fapi,
                oidc: {
                    requirePar: .oidc.requirePar,
                    allowNoneAlgorithm: .oidc.allowNoneAlgorithm,
                    tokenEndpointAuthMethodsSupported: .oidc.tokenEndpointAuthMethodsSupported
                }
            }'
        else
            print_warning "Could not verify settings in KV"
        fi

    else
        print_error "Failed to write settings to KV"
        exit 1
    fi

    echo ""
    print_success "Initialization complete!"
    echo ""
    print_info "Next steps:"
    echo "  1. Deploy your workers: wrangler deploy"
    echo "  2. Test discovery endpoint: curl https://your-domain/.well-known/openid-configuration"
    echo "  3. (Optional) Switch profile: ./scripts/switch-certification-profile.sh fapi-2"
    echo ""
}

# Run main function
main
