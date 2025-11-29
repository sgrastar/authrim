#!/bin/bash
# Regenerate all non-FAPI/CIBA specs

cd "$(dirname "$0")"

PLANS=$(jq -r '.plans | keys[]' config/test-plans.json | grep -v -E '(fapi|ciba)')
TOTAL=$(echo "$PLANS" | wc -l | tr -d ' ')
COUNT=0
SUCCESS=0
FAILED=0

echo "Regenerating $TOTAL spec files (excluding FAPI/CIBA)..."
echo ""

for plan in $PLANS; do
  COUNT=$((COUNT + 1))
  echo "[$COUNT/$TOTAL] $plan"
  
  if CONFORMANCE_TOKEN="$CONFORMANCE_TOKEN" npx tsx generate-test-spec.ts --plan-name "$plan" --output "specs/${plan}.json" 2>&1 | grep -q "Test Specification Generated"; then
    echo "  ✓ Success"
    SUCCESS=$((SUCCESS + 1))
  else
    echo "  ✗ Failed"
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "============================================"
echo "Done! Success: $SUCCESS, Failed: $FAILED"
echo "============================================"
