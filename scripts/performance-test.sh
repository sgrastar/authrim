#!/bin/bash
# Enrai Performance Benchmark Script
# Tests endpoint latency and throughput for Phase 3 completion

set -e

ISSUER="${ISSUER:-https://enrai.sgrastar.workers.dev}"
RESULTS_DIR="docs/conformance/test-results"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_FILE="${RESULTS_DIR}/performance-results-${TIMESTAMP}.md"

echo "🔥 Enrai Performance Benchmark"
echo "================================"
echo "Issuer: ${ISSUER}"
echo "Timestamp: ${TIMESTAMP}"
echo ""

# Check if curl is available
if ! command -v curl &> /dev/null; then
    echo "❌ Error: curl is required but not installed"
    exit 1
fi

# Create results file
mkdir -p "${RESULTS_DIR}"
cat > "${RESULTS_FILE}" << EOF
# Enrai Performance Benchmark Results

**Test Date:** $(date +%Y-%m-%d)
**Test Time:** $(date +%H:%M:%S)
**Issuer:** ${ISSUER}
**Test Environment:** Production (Cloudflare Workers)
**Tester:** Automated Script

---

## Test Configuration

- **Tool:** curl with time measurements
- **Measurements:** Response time, DNS lookup, TCP connect, TLS handshake, Time to First Byte (TTFB)
- **Test Runs:** 10 iterations per endpoint (best, worst, average)
- **Target Metrics:**
  - p95 Latency: <50ms (edge)
  - JWT Signing: <10ms (estimated)
  - Total Request: <100ms (with cold start)

---

## Test Results

EOF

# Function to test endpoint with detailed timing
test_endpoint() {
    local name="$1"
    local url="$2"
    local iterations="${3:-10}"

    echo "Testing: ${name}"
    echo "URL: ${url}"

    local total_time=0
    local min_time=999999
    local max_time=0
    local times=()

    for i in $(seq 1 $iterations); do
        # Use curl with time format
        output=$(curl -o /dev/null -s -w "%{time_total},%{time_namelookup},%{time_connect},%{time_appconnect},%{time_starttransfer},%{http_code}" "${url}" 2>&1)

        IFS=',' read -r total dns connect tls ttfb status <<< "$output"

        # Convert to milliseconds
        total_ms=$(echo "$total * 1000" | bc | cut -d. -f1)
        dns_ms=$(echo "$dns * 1000" | bc | cut -d. -f1)
        connect_ms=$(echo "$connect * 1000" | bc | cut -d. -f1)
        tls_ms=$(echo "$tls * 1000" | bc | cut -d. -f1)
        ttfb_ms=$(echo "$ttfb * 1000" | bc | cut -d. -f1)

        times+=($total_ms)
        total_time=$(($total_time + $total_ms))

        if [ $total_ms -lt $min_time ]; then
            min_time=$total_ms
        fi
        if [ $total_ms -gt $max_time ]; then
            max_time=$total_ms
        fi

        echo "  Run $i: ${total_ms}ms (Status: ${status})"
        sleep 0.1
    done

    # Calculate average
    avg_time=$(($total_time / $iterations))

    # Calculate p95 (simplified: 90th percentile ≈ 9th value in sorted array of 10)
    IFS=$'\n' sorted=($(sort -n <<<"${times[*]}"))
    p95_time=${sorted[8]}  # 0-indexed, so 8 is the 9th element

    echo "  ✓ Min: ${min_time}ms, Max: ${max_time}ms, Avg: ${avg_time}ms, p95: ${p95_time}ms"
    echo ""

    # Write to results file
    cat >> "${RESULTS_FILE}" << EOF
### ${name}

**Endpoint:** \`${url}\`

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| **Min Response Time** | ${min_time}ms | - | - |
| **Max Response Time** | ${max_time}ms | - | - |
| **Average Response Time** | ${avg_time}ms | <100ms | $([ $avg_time -lt 100 ] && echo "✅ PASS" || echo "⚠️ REVIEW") |
| **p95 Response Time** | ${p95_time}ms | <50ms | $([ $p95_time -lt 50 ] && echo "✅ PASS" || echo "⚠️ REVIEW") |
| **Iterations** | ${iterations} | - | - |

**Sample Breakdown (Last Run):**
- DNS Lookup: ${dns_ms}ms
- TCP Connect: ${connect_ms}ms
- TLS Handshake: ${tls_ms}ms
- Time to First Byte: ${ttfb_ms}ms
- Total: ${total_ms}ms

---

EOF
}

# Test all endpoints
echo "Starting endpoint tests..."
echo ""

test_endpoint "Discovery Endpoint" "${ISSUER}/.well-known/openid-configuration" 10
test_endpoint "JWKS Endpoint" "${ISSUER}/.well-known/jwks.json" 10
test_endpoint "Authorization Endpoint (Error Response)" "${ISSUER}/authorize?response_type=code&client_id=test&redirect_uri=https://example.com/callback" 10
test_endpoint "UserInfo Endpoint (Error Response)" "${ISSUER}/userinfo" 10

# Add summary
cat >> "${RESULTS_FILE}" << EOF
## Summary

### Performance Targets

| Target | Status | Notes |
|--------|--------|-------|
| p95 Latency <50ms (edge) | See individual results | Cloudflare Workers edge deployment |
| Average Latency <100ms | See individual results | Including cold starts |
| JWT Operations <10ms | Estimated from total latency | Cannot measure directly without instrumentation |

### Key Findings

1. **Discovery Endpoint:**
   - Static JSON response, should have the best performance
   - Benefits from Cloudflare edge caching

2. **JWKS Endpoint:**
   - Returns public key from environment variable
   - Minimal computation required

3. **Authorization Endpoint:**
   - Tested with invalid request (no state parameter)
   - Tests error handling performance

4. **UserInfo Endpoint:**
   - Tested without authorization header
   - Tests authentication check performance

### Recommendations

1. **Cold Start Optimization:**
   - Consider implementing edge caching for Discovery and JWKS endpoints
   - Current implementation may experience cold starts on first request

2. **JWT Performance:**
   - JWT signing performance cannot be measured directly without code instrumentation
   - Consider adding performance monitoring in Phase 4

3. **Regional Performance:**
   - Current tests run from a single location
   - Consider multi-region testing for global latency validation

4. **Load Testing:**
   - Current tests use sequential requests
   - Consider implementing concurrent load tests in Phase 4

---

**Test Completed:** $(date +%Y-%m-%d\ %H:%M:%S)
**Results File:** ${RESULTS_FILE}
**Phase:** Phase 3 Completion

EOF

echo "✅ Performance benchmark completed!"
echo "📊 Results saved to: ${RESULTS_FILE}"
echo ""
cat "${RESULTS_FILE}"
