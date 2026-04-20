#!/bin/bash
#
# Authrim Cloudflare Email Service bootstrap helper
# Usage:
#   ./scripts/setup-cloudflare-email.sh [--env=local|dev|staging|prod]
#

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

ENV=""
for arg in "$@"; do
	if [[ $arg == --env=* ]]; then
		ENV="${arg#--env=}"
	fi
done

if [ -z "$ENV" ]; then
	echo -e "${BLUE}Cloudflare Email Service bootstrap${NC}"
	echo ""
	read -p "Environment (local/dev/staging/prod): " -r ENV
fi

if [ -z "$ENV" ]; then
	echo -e "${RED}Environment is required${NC}"
	exit 1
fi

echo ""
echo "Prerequisites:"
echo "  1. Workers Paid Plan"
echo "  2. Cloudflare DNS for your sender domain"
echo "  3. Domain onboarded in Cloudflare Email Service dashboard"
echo ""

read -p "From email address (e.g. noreply@example.com): " -r EMAIL_FROM
if [ -z "$EMAIL_FROM" ]; then
	echo -e "${RED}EMAIL_FROM is required${NC}"
	exit 1
fi

read -p "From display name (optional): " -r EMAIL_FROM_NAME

if [ "$ENV" = "local" ]; then
	if [ ! -f ".dev.vars" ]; then
		touch .dev.vars
	fi

	sed -i '' '/^EMAIL_FROM=/d' ".dev.vars" 2>/dev/null || true
	sed -i '' '/^EMAIL_FROM_NAME=/d' ".dev.vars" 2>/dev/null || true
	{
		echo "EMAIL_FROM=\"$EMAIL_FROM\""
		if [ -n "$EMAIL_FROM_NAME" ]; then
			echo "EMAIL_FROM_NAME=\"$EMAIL_FROM_NAME\""
		fi
	} >> .dev.vars

	echo -e "${GREEN}Saved Cloudflare email bootstrap to .dev.vars${NC}"
else
	for worker in "${ENV}-authrim-ar-auth" "${ENV}-authrim-ar-management"; do
		echo "$EMAIL_FROM" | wrangler secret put EMAIL_FROM --name="$worker"
	done
	echo -e "${GREEN}Uploaded EMAIL_FROM to ar-auth and ar-management${NC}"
	echo -e "${YELLOW}Wrangler send_email bindings still need to be present in the generated wrangler config.${NC}"
fi

echo ""
echo -e "${YELLOW}Reminder:${NC} Cloudflare sender/domain onboarding is still manual in the dashboard."
