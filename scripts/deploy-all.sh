#!/bin/bash
set -e

# Deploy all components (UI + API)
# Usage: ./scripts/deploy-all.sh --env=<environment>

echo "🚀 Deploying all components..."

DEPLOY_ENV=""
KEYS_DIR_ARGS=()
arguments=("$@")
index=0
while [ $index -lt ${#arguments[@]} ]; do
  argument="${arguments[$index]}"
  case "$argument" in
    --env=*) DEPLOY_ENV="${argument#*=}" ;;
    --keys-dir=*) KEYS_DIR_ARGS=("$argument") ;;
    --keys-dir)
      index=$((index + 1))
      if [ $index -ge ${#arguments[@]} ]; then
        echo "❌ --keys-dir requires a directory path"
        exit 1
      fi
      KEYS_DIR_ARGS=("--keys-dir=${arguments[$index]}")
      ;;
  esac
  index=$((index + 1))
done

if [ -z "$DEPLOY_ENV" ]; then
  echo "❌ --env=<environment> is required"
  exit 1
fi

# The API deployer creates missing UI binding targets before ar-router.
# Gradual/API-specific flags are intentionally sent only to the API deployer.
./scripts/deploy-with-retry.sh "$@" --api-only

# Deploy the final UI assets only after ar-router exists.
./scripts/deploy-ui.sh --env="$DEPLOY_ENV" --phase=final "${KEYS_DIR_ARGS[@]}"

echo "✅ All deployments complete!"
