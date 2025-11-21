#!/bin/bash
# Authrim Database Migration Script
# Usage: ./migrations/migrate.sh [dev|prod] [up|down|reset|status]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ENV=${1:-dev}
ACTION=${2:-up}

# Determine database name and remote flag
if [ "$ENV" = "local" ]; then
    DB_NAME="authrim-local"
    REMOTE_FLAG=""
else
    DB_NAME="authrim-${ENV}"
    REMOTE_FLAG="--remote"
fi

# Helper functions
log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check if wrangler is installed
check_wrangler() {
    if ! command -v wrangler &> /dev/null; then
        log_error "Wrangler CLI is not installed"
        echo "Install with: npm install -g wrangler"
        exit 1
    fi
    log_success "Wrangler CLI found"
}

# Check if database exists
check_database() {
    log_info "Checking database: ${DB_NAME}"

    if ! wrangler d1 info "${DB_NAME}" &> /dev/null; then
        log_warning "Database '${DB_NAME}' does not exist"
        read -p "Create database? (y/n): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            wrangler d1 create "${DB_NAME}"
            log_success "Database created: ${DB_NAME}"
        else
            log_error "Database required. Exiting."
            exit 1
        fi
    else
        log_success "Database found: ${DB_NAME}"
    fi
}

# Run migrations (up)
migrate_up() {
    log_info "Running migrations on ${DB_NAME}..."

    # Confirmation for production
    if [ "$ENV" = "prod" ]; then
        log_warning "You are about to run migrations on PRODUCTION!"
        read -p "Are you sure? (yes/no): " -r
        if [ "$REPLY" != "yes" ]; then
            log_error "Migration cancelled"
            exit 1
        fi
    fi

    # Apply migrations in order
    log_info "Applying 001_initial_schema.sql..."
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --file=migrations/001_initial_schema.sql
    log_success "Schema migration complete"

    log_info "Applying 002_seed_default_data.sql..."
    if [ "$ENV" = "prod" ]; then
        log_warning "Skipping test data for production"
        log_info "Please manually review and edit 002_seed_default_data.sql"
        log_info "Remove test users and clients before running on production"
    else
        wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --file=migrations/002_seed_default_data.sql
        log_success "Seed data migration complete"
    fi

    log_info "Applying 003_add_consent_table.sql..."
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --file=migrations/003_add_consent_table.sql || log_warning "Migration 003 may already be applied"
    log_success "Consent table migration complete"

    log_info "Applying 004_add_client_trust_settings.sql..."
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --file=migrations/004_add_client_trust_settings.sql || log_warning "Migration 004 may already be applied"
    log_success "Trusted client settings migration complete"

    log_info "Applying 005_add_claims_parameter_setting.sql..."
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --file=migrations/005_add_claims_parameter_setting.sql || log_warning "Migration 005 may already be applied"
    log_success "Claims parameter settings migration complete"

    log_success "All migrations applied successfully!"
}

# Show database status
show_status() {
    log_info "Database status for ${DB_NAME}:"
    echo ""

    log_info "Tables:"
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
    echo ""

    log_info "Table counts:"
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --command="
        SELECT 'users' as table_name, COUNT(*) as count FROM users
        UNION ALL SELECT 'roles', COUNT(*) FROM roles
        UNION ALL SELECT 'oauth_clients', COUNT(*) FROM oauth_clients
        UNION ALL SELECT 'passkeys', COUNT(*) FROM passkeys
        UNION ALL SELECT 'sessions', COUNT(*) FROM sessions
        UNION ALL SELECT 'audit_log', COUNT(*) FROM audit_log;
    "
}

# Reset database (local/dev only)
reset_database() {
    if [ "$ENV" = "prod" ]; then
        log_error "Cannot reset production database"
        exit 1
    fi

    log_warning "This will DELETE ALL DATA in ${DB_NAME}!"
    read -p "Are you sure? (yes/no): " -r
    if [ "$REPLY" != "yes" ]; then
        log_error "Reset cancelled"
        exit 1
    fi

    log_info "Dropping all tables..."
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --command="DROP TABLE IF EXISTS audit_log;"
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --command="DROP TABLE IF EXISTS identity_providers;"
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --command="DROP TABLE IF EXISTS branding_settings;"
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --command="DROP TABLE IF EXISTS scope_mappings;"
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --command="DROP TABLE IF EXISTS user_roles;"
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --command="DROP TABLE IF EXISTS roles;"
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --command="DROP TABLE IF EXISTS sessions;"
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --command="DROP TABLE IF EXISTS oauth_clients;"
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --command="DROP TABLE IF EXISTS passkeys;"
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --command="DROP TABLE IF EXISTS user_custom_fields;"
    wrangler d1 execute "${DB_NAME}" ${REMOTE_FLAG} --command="DROP TABLE IF EXISTS users;"
    log_success "All tables dropped"

    log_info "Re-running migrations..."
    migrate_up
}

# Show help
show_help() {
    echo "Authrim Database Migration Script"
    echo ""
    echo "Usage: ./migrations/migrate.sh [env] [action]"
    echo ""
    echo "Environments:"
    echo "  local  - Local D1 database (for local development)"
    echo "  dev    - Development database on Cloudflare (default)"
    echo "  prod   - Production database on Cloudflare"
    echo ""
    echo "Actions:"
    echo "  up     - Run migrations (default)"
    echo "  status - Show database status"
    echo "  reset  - Reset database (local/dev only)"
    echo "  help   - Show this help"
    echo ""
    echo "Examples:"
    echo "  ./migrations/migrate.sh local up"
    echo "  ./migrations/migrate.sh dev up"
    echo "  ./migrations/migrate.sh prod status"
    echo "  ./migrations/migrate.sh local reset"
}

# Main script
main() {
    echo "╔════════════════════════════════════════╗"
    echo "║   Authrim Database Migration Tool      ║"
    echo "╚════════════════════════════════════════╝"
    echo ""

    case "$ACTION" in
        up)
            check_wrangler
            check_database
            migrate_up
            ;;
        status)
            check_wrangler
            check_database
            show_status
            ;;
        reset)
            check_wrangler
            check_database
            reset_database
            ;;
        help)
            show_help
            ;;
        *)
            log_error "Unknown action: $ACTION"
            show_help
            exit 1
            ;;
    esac
}

main
