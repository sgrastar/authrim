#!/bin/bash
# Generate spec files for all test plans

cd "$(dirname "$0")"
mkdir -p specs

PLANS=$(jq -r '.plans | keys[]' config/test-plans.json)
TOTAL=$(echo "$PLANS" | wc -l | tr -d ' ')
COUNT=0

for plan in $PLANS; do
  COUNT=$((COUNT + 1))
  echo "[$COUNT/$TOTAL] Generating: $plan"
  CONFORMANCE_TOKEN="$CONFORMANCE_TOKEN" npx tsx generate-test-spec.ts --plan-name "$plan" --output "specs/${plan}.json" 2>&1 | grep -E "(Total tests|Tests requiring|Error:)"
  echo ""
done

echo "Done! Generated $COUNT spec files in specs/"
