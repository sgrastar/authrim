#!/bin/bash
set -e

# Deploy all components (UI + API)
# Usage: ./scripts/deploy-all.sh --env=<environment>

echo "🚀 Deploying all components..."

# Pass all arguments to deploy-ui.sh
./scripts/deploy-ui.sh "$@"

# Pass all arguments to deploy-with-retry.sh
BUILD_TARGET=api ./scripts/deploy-with-retry.sh "$@"

echo "✅ All deployments complete!"
