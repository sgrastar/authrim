#!/bin/bash
#
# Authrim Audit Infrastructure Setup Script
# This script creates Queue and R2 bucket for async audit logging
#
# Usage:
#   ./setup-audit.sh --env=dev           - Set up audit infrastructure for dev environment
#   ./setup-audit.sh --env=prod --reset  - Reset mode (deletes and recreates)
#
# Prerequisites:
#   - wrangler CLI installed and logged in
#   - Cloudflare Workers Paid plan ($5/month, usage-based for Queues)
#     - Queues: $0.40/million operations (write+read+ack = ~$1.20/million messages)
#     - No additional subscription cost, just usage fees
#     - See: https://developers.cloudflare.com/queues/platform/pricing/
#
# Resources created:
#   - Queue: ${env}-audit-queue (main audit queue)
#   - Queue: ${env}-audit-queue-dlq (dead letter queue)
#   - R2 Bucket: ${env}-audit-archive (for large payloads and archives)
#

set -e

# Parse command line arguments
RESET_MODE=false
DEPLOY_ENV=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --env=*)
            DEPLOY_ENV="${1#*=}"
            shift
            ;;
        --reset)
            RESET_MODE=true
            shift
            ;;
        *)
            echo "❌ Unknown parameter: $1"
            echo ""
            echo "Usage: $0 --env=<environment> [--reset]"
            echo ""
            echo "Options:"
            echo "  --env=<name>    Environment name (required, e.g., dev, staging, prod)"
            echo "  --reset         Delete and recreate all resources (WARNING: deletes all data)"
            echo ""
            echo "Examples:"
            echo "  $0 --env=dev"
            echo "  $0 --env=conformance"
            echo "  $0 --env=prod --reset"
            exit 1
            ;;
    esac
done

# Validate required parameters
if [ -z "$DEPLOY_ENV" ]; then
    echo "❌ Error: --env parameter is required"
    echo ""
    echo "Usage: $0 --env=<environment> [--reset]"
    exit 1
fi

if [ "$RESET_MODE" = true ]; then
    echo "⚠️  RESET MODE ENABLED for environment: $DEPLOY_ENV"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "All existing audit resources for $DEPLOY_ENV will be deleted and recreated."
    echo "This will delete ALL data in the queues and R2 bucket."
    echo ""
    read -p "Are you sure you want to continue? Type 'YES' to confirm: " -r
    if [ "$REPLY" != "YES" ]; then
        echo "❌ Reset cancelled"
        exit 1
    fi
    echo ""
fi

echo "⚡️ Authrim Audit Infrastructure Setup - Environment: $DEPLOY_ENV"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Error: wrangler is not installed"
    echo "Please install it with: npm install -g wrangler"
    exit 1
fi

# Check if user is logged in
if ! wrangler whoami &> /dev/null; then
    echo "❌ Error: Not logged in to Cloudflare"
    echo "Please run: wrangler login"
    exit 1
fi

echo "📦 Audit Infrastructure Setup"
echo ""
echo "This script will create or update the following resources:"
echo "  • Queue: ${DEPLOY_ENV}-audit-queue (async audit log processing)"
echo "  • Queue: ${DEPLOY_ENV}-audit-queue-dlq (dead letter queue for failed messages)"
echo "  • R2 Bucket: ${DEPLOY_ENV}-audit-archive (large payloads & long-term storage)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Skip confirmation prompt in reset mode
if [ "$RESET_MODE" = false ]; then
    read -p "Ready to start? Type 'y' to continue, 'N' to cancel: " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ Setup cancelled"
        exit 1
    fi
    echo ""
fi

# Define resource names
QUEUE_NAME="${DEPLOY_ENV}-audit-queue"
DLQ_NAME="${DEPLOY_ENV}-audit-queue-dlq"
R2_BUCKET_NAME="${DEPLOY_ENV}-audit-archive"

# =============================================================================
# Queue Creation
# =============================================================================

create_queue() {
    local queue_name=$1
    local is_dlq=$2

    echo "📝 Creating Queue: $queue_name"

    # Check if queue exists
    local list_output=$(wrangler queues list 2>&1)

    if echo "$list_output" | grep -q "\"$queue_name\""; then
        if [ "$RESET_MODE" = true ]; then
            echo "  🗑️  Deleting existing queue: $queue_name"
            if wrangler queues delete "$queue_name" 2>&1; then
                echo "  ✓ Deleted"
                sleep 3
            else
                echo "  ⚠️  Warning: Could not delete queue (may not exist or in use)"
            fi
        else
            echo "  ✓ Queue already exists: $queue_name"
            return 0
        fi
    fi

    # Create queue
    echo "  📝 Creating queue: $queue_name"
    if wrangler queues create "$queue_name" 2>&1; then
        echo "  ✓ Queue created: $queue_name"
    else
        echo "  ⚠️  Warning: Queue creation may have failed (could already exist)"
    fi
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📬 Setting up Cloudflare Queues..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Create main audit queue
create_queue "$QUEUE_NAME" false

# Create dead letter queue
create_queue "$DLQ_NAME" true

# =============================================================================
# R2 Bucket Creation
# =============================================================================

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📦 Setting up R2 Bucket..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if bucket exists
echo "📝 Creating R2 Bucket: $R2_BUCKET_NAME"

bucket_list=$(wrangler r2 bucket list 2>&1)

if echo "$bucket_list" | grep -q "\"$R2_BUCKET_NAME\""; then
    if [ "$RESET_MODE" = true ]; then
        echo "  🗑️  Deleting existing R2 bucket: $R2_BUCKET_NAME"
        echo "  ⚠️  Note: R2 bucket deletion requires the bucket to be empty"
        if wrangler r2 bucket delete "$R2_BUCKET_NAME" 2>&1; then
            echo "  ✓ Deleted"
            sleep 3
        else
            echo "  ⚠️  Warning: Could not delete bucket (may not be empty or doesn't exist)"
        fi
    else
        echo "  ✓ R2 bucket already exists: $R2_BUCKET_NAME"
    fi
fi

# Create bucket (only if it doesn't exist or was deleted)
if ! echo "$bucket_list" | grep -q "\"$R2_BUCKET_NAME\"" || [ "$RESET_MODE" = true ]; then
    echo "  📝 Creating R2 bucket: $R2_BUCKET_NAME"
    if wrangler r2 bucket create "$R2_BUCKET_NAME" 2>&1; then
        echo "  ✓ R2 bucket created: $R2_BUCKET_NAME"
    else
        echo "  ⚠️  Warning: Bucket creation may have failed (could already exist)"
    fi
fi

# =============================================================================
# Update wrangler.toml files
# =============================================================================

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📝 Updating wrangler.toml configuration..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Function to uncomment and update audit config in wrangler.toml
update_audit_config() {
    local file=$1

    if [ ! -f "$file" ]; then
        echo "  ⚠️  File not found: $file"
        return 1
    fi

    echo "  📝 Updating: $file"

    # Check if audit config section exists (commented or not)
    if grep -q "AUDIT_ARCHIVE\|AUDIT_QUEUE" "$file"; then
        # Uncomment the audit sections
        sed -i '' \
            -e 's/# \[\[r2_buckets\]\]/[[r2_buckets]]/' \
            -e 's/# binding = "AUDIT_ARCHIVE"/binding = "AUDIT_ARCHIVE"/' \
            -e "s/# bucket_name = \".*-audit-archive\"/bucket_name = \"$R2_BUCKET_NAME\"/" \
            -e 's/# \[\[queues.producers\]\]/[[queues.producers]]/' \
            -e "s/# queue = \".*-audit-queue\"/queue = \"$QUEUE_NAME\"/" \
            -e 's/# binding = "AUDIT_QUEUE"/binding = "AUDIT_QUEUE"/' \
            -e 's/# \[\[queues.consumers\]\]/[[queues.consumers]]/' \
            -e 's/# max_batch_size = 100/max_batch_size = 100/' \
            -e 's/# max_batch_timeout = 30/max_batch_timeout = 30/' \
            -e 's/# max_retries = 5/max_retries = 5/' \
            -e "s/# dead_letter_queue = \".*-audit-queue-dlq\"/dead_letter_queue = \"$DLQ_NAME\"/" \
            -e 's/# binding = "AUDIT_QUEUE_DLQ"/binding = "AUDIT_QUEUE_DLQ"/' \
            "$file"
        echo "  ✓ Updated audit configuration"
    else
        echo "  ⚠️  No audit configuration found in $file"
        echo "  💡 Hint: Add the audit configuration manually or check wrangler.toml template"
    fi
}

# Update ar-management wrangler.toml (main audit consumer)
update_audit_config "packages/ar-management/wrangler.${DEPLOY_ENV}.toml"

# Also update other workers that produce audit logs
for pkg in ar-auth ar-token ar-userinfo ar-bridge ar-policy ar-saml ar-vc ar-async; do
    if [ -f "packages/$pkg/wrangler.${DEPLOY_ENV}.toml" ]; then
        update_audit_config "packages/$pkg/wrangler.${DEPLOY_ENV}.toml"
    fi
done

# =============================================================================
# Summary
# =============================================================================

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 Audit Infrastructure Setup Complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Created resources:"
echo "  • Queue: $QUEUE_NAME"
echo "  • Queue (DLQ): $DLQ_NAME"
echo "  • R2 Bucket: $R2_BUCKET_NAME"
echo ""
echo "Configuration updated in wrangler.${DEPLOY_ENV}.toml files."
echo ""
echo "⚠️  Important Notes:"
echo ""
echo "1. Queue Consumer Setup:"
echo "   The queue consumer is configured in ar-management/wrangler.toml."
echo "   Make sure to deploy ar-management to start processing audit logs."
echo ""
echo "2. Queue Binding in wrangler.toml:"
echo "   Producers need [[queues.producers]] with binding = \"AUDIT_QUEUE\""
echo "   Consumer needs [[queues.consumers]] with the queue name"
echo ""
echo "3. R2 Bucket Access:"
echo "   Workers need [[r2_buckets]] with binding = \"AUDIT_ARCHIVE\""
echo ""
echo "4. Dead Letter Queue:"
echo "   Failed messages (after max_retries) go to $DLQ_NAME"
echo "   Monitor this queue for processing failures."
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next steps:"
echo "  1. Review the updated wrangler.${DEPLOY_ENV}.toml files"
echo "  2. Deploy workers: pnpm run deploy -- --env=$DEPLOY_ENV"
echo "  3. Enable audit logging in Admin API: PUT /api/admin/settings/audit-storage"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
