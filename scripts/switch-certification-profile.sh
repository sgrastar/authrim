#!/bin/bash

# OpenID Certification Profile Switcher
# Usage: ADMIN_TOKEN=<token> ./switch-certification-profile.sh <profile-name> [api-url]
#
# Applies a certification profile (a set of Settings API values) to the tenant the API URL
# resolves to. ADMIN_TOKEN is an Admin API bearer token allowed to change that tenant's settings.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
DEFAULT_API_URL="http://localhost:8787"
PROFILE_NAME="${1:-}"
API_URL="${2:-$DEFAULT_API_URL}"
ADMIN_TOKEN="${3:-$ADMIN_TOKEN}"

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

# The Admin API request headers (an array, so the token is passed as one argument)
AUTH_HEADERS=(-H "Authorization: Bearer ${ADMIN_TOKEN}")

# Function to list available profiles
list_profiles() {
    print_info "Fetching available certification profiles..."

    local response=$(curl -s -X GET "${API_URL}/api/admin/certification-profiles" \
        "${AUTH_HEADERS[@]}")

    if [ $? -eq 0 ]; then
        echo "$response" | jq -r '.profiles[] | "\(.id): \(.name) - \(.description)"'
        return 0
    else
        print_error "Failed to fetch profiles"
        return 1
    fi
}

# Function to apply a profile
apply_profile() {
    local profile=$1

    print_info "Applying certification profile: ${profile}"

    local response=$(curl -s -w "\n%{http_code}" -X POST \
        "${API_URL}/api/admin/certification-profiles/${profile}/apply" \
        -H "Content-Type: application/json" \
        "${AUTH_HEADERS[@]}")

    local http_code=$(echo "$response" | tail -n1)
    local body=$(echo "$response" | sed '$d')

    if [ "$http_code" -eq 200 ]; then
        print_success "Profile applied successfully"
        echo "$body" | jq '{
            profile: .profile,
            tenant_id: .tenant_id,
            applied: (.results | map_values(.applied)),
            cleared: (.results | map_values(.cleared))
        }'
        return 0
    else
        print_error "Failed to apply profile (HTTP $http_code)"
        echo "$body" | jq .
        return 1
    fi
}

# Function to verify current configuration
verify_config() {
    print_info "Verifying Discovery configuration..."

    local discovery=$(curl -s "${API_URL}/.well-known/openid-configuration")

    echo "$discovery" | jq '{
        issuer,
        require_pushed_authorization_requests,
        token_endpoint_auth_methods_supported,
        code_challenge_methods_supported,
        dpop_signing_alg_values_supported
    }'
}

# Main script
main() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║  OpenID Certification Profile Switcher                   ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo ""

    # Check if jq is installed
    if ! command -v jq &> /dev/null; then
        print_error "jq is required but not installed. Please install jq."
        exit 1
    fi

    if [ -z "$ADMIN_TOKEN" ]; then
        print_error "ADMIN_TOKEN is required (an Admin API bearer token)"
        print_info "Usage: ADMIN_TOKEN=<token> $0 <profile-name> [api-url]"
        exit 1
    fi

    print_info "API URL: ${API_URL}"
    echo ""

    # If no profile specified, list available profiles
    if [ -z "$PROFILE_NAME" ]; then
        print_warning "No profile specified. Available profiles:"
        echo ""
        list_profiles
        echo ""
        print_info "Usage: ADMIN_TOKEN=<token> $0 <profile-name> [api-url]"
        print_info "Example: ADMIN_TOKEN=<token> $0 basic-op https://auth.example.com"
        print_info "Example: ADMIN_TOKEN=<token> $0 fapi-2 http://localhost:8786"
        echo ""
        exit 0
    fi

    # Apply the profile
    if apply_profile "$PROFILE_NAME"; then
        echo ""
        print_success "Configuration updated successfully!"
        echo ""

        # Wait a moment for settings to propagate
        print_info "Waiting 2 seconds for configuration to propagate..."
        sleep 2

        # Verify the configuration
        verify_config
        echo ""

        print_success "Profile switch complete!"
        print_warning "Note: Discovery endpoint cache may take up to 5 minutes to refresh"
        echo ""
    else
        print_error "Failed to apply profile"
        echo ""
        print_info "Available profiles:"
        list_profiles
        exit 1
    fi
}

# Run main function
main
