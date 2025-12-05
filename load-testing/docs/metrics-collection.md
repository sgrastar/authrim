# Metrics Collection Procedures

## Overview

After load test execution, collect metrics using Cloudflare Graph API (GraphQL Analytics) and wrangler.

## Prerequisites

### 1. Prepare Cloudflare API Token

Create an API Token from Cloudflare Dashboard:

1. Access https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Grant the following permissions:
   - **Account** → **Workers Scripts** → **Read**
   - **Account** → **Analytics** → **Read**
   - **Account** → **Logs** → **Read**
4. Copy and save the token

### 2. Configure Environment Variables

Add to `.env` file:

```bash
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_api_token_here
WORKER_NAME=authrim-worker
```

Or export directly as environment variables:

```bash
export CLOUDFLARE_ACCOUNT_ID=your_account_id
export CLOUDFLARE_API_TOKEN=your_api_token_here
```

### 3. Authenticate wrangler

```bash
# Using API token
export CLOUDFLARE_API_TOKEN=your_api_token_here

# Or interactive login
wrangler login
```

## Metrics to Collect

### 1. Workers Metrics

| Metric | Description | Importance |
|-----------|------|--------|
| **requests** | Total request count | ★★★ |
| **errors** | Error count (4xx/5xx) | ★★★ |
| **cpuTime** | CPU usage time (ms) | ★★★ |
| **duration** | Processing time (p50/p90/p99) | ★★★ |
| **subrequests** | Subrequest count (DO/KV/D1) | ★★☆ |

### 2. Durable Objects Metrics

| Metric | Description | Importance |
|-----------|------|--------|
| **invocations** | DO execution count | ★★★ |
| **activeTime** | Active time | ★★☆ |
| **cpuTime** | CPU time | ★★★ |

### 3. D1 Metrics

| Metric | Description | Importance |
|-----------|------|--------|
| **readQueries** | Read query count | ★★☆ |
| **writeQueries** | Write query count | ★★★ |
| **rowsRead** | Rows read count | ★☆☆ |
| **rowsWritten** | Rows written count | ★★☆ |

### 4. KV Metrics

| Metric | Description | Importance |
|-----------|------|--------|
| **reads** | Read count | ★★☆ |
| **writes** | Write count | ★☆☆ |

## Execute GraphQL Queries

### Method 1: Manual Query with wrangler (Recommended)

#### Get Workers Statistics

```bash
wrangler graphql --account-id $CLOUDFLARE_ACCOUNT_ID <<'EOF'
query {
  viewer {
    accounts(filter: { accountTag: "$CLOUDFLARE_ACCOUNT_ID" }) {
      workersInvocationsAdaptive(
        limit: 10000
        filter: {
          scriptName: "authrim-worker"
          datetime_geq: "2025-11-30T00:00:00Z"
          datetime_lt: "2025-11-30T23:59:59Z"
        }
      ) {
        sum {
          requests
          errors
          subrequests
        }
        quantiles {
          cpuTimeP50
          cpuTimeP90
          cpuTimeP99
          durationP50
          durationP90
          durationP99
        }
      }
    }
  }
}
EOF
```

#### Get Durable Objects Statistics

```bash
wrangler graphql --account-id $CLOUDFLARE_ACCOUNT_ID <<'EOF'
query {
  viewer {
    accounts(filter: { accountTag: "$CLOUDFLARE_ACCOUNT_ID" }) {
      durableObjectsInvocationsAdaptive(
        limit: 10000
        filter: {
          scriptName: "authrim-worker"
          datetime_geq: "2025-11-30T00:00:00Z"
          datetime_lt: "2025-11-30T23:59:59Z"
        }
      ) {
        sum {
          requests
          cpuTime
          inboundWebsocketMsgCount
          outboundWebsocketMsgCount
        }
        dimensions {
          className
        }
      }
    }
  }
}
EOF
```

### Method 2: Direct API Call with curl

```bash
curl -X POST https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data @queries/worker_stats.graphql
```

### Method 3: Automation Script (described below)

```bash
./scripts/collect-metrics.sh
```

## Real-time Logs with wrangler tail

View logs in real-time during test execution:

```bash
wrangler tail authrim-worker --format pretty
```

### Filtering Examples

```bash
# Display errors only
wrangler tail authrim-worker --status error

# Specific method only
wrangler tail authrim-worker --method POST

# Sampling (10%)
wrangler tail authrim-worker --sampling-rate 0.1
```

## Save and Format Results

### Save in JSON Format

```bash
wrangler graphql --account-id $CLOUDFLARE_ACCOUNT_ID \
  --query-file queries/worker_stats.graphql \
  > results/metrics_$(date +%Y%m%d_%H%M%S).json
```

### Format with jq

```bash
# Extract p99 response time
cat results/metrics_latest.json | jq '.data.viewer.accounts[0].workersInvocationsAdaptive.quantiles.durationP99'

# Calculate error rate
cat results/metrics_latest.json | jq '
  .data.viewer.accounts[0].workersInvocationsAdaptive.sum |
  (.errors / .requests * 100)
'

# Display execution count by DO
cat results/metrics_latest.json | jq '
  .data.viewer.accounts[0].durableObjectsInvocationsAdaptive[] |
  {className: .dimensions.className, requests: .sum.requests}
'
```

## Use Automated Collection Script

### Basic Usage

```bash
# Collect latest test results
./scripts/collect-metrics.sh

# Specify time range
./scripts/collect-metrics.sh --start "2025-11-30T10:00:00Z" --end "2025-11-30T11:00:00Z"

# Specify test name and save
./scripts/collect-metrics.sh --test-name "test1-standard" --output results/
```

### Output Example

```
Metrics collection started...

Test information:
- Worker: authrim-worker
- Period: 2025-11-30T10:00:00Z ~ 2025-11-30T11:00:00Z

Workers metrics retrieval in progress...
Completed

Durable Objects metrics retrieval in progress...
Completed

D1 metrics retrieval in progress...
Completed

Results summary:
┌────────────────────┬──────────┐
│ Metric             │ Value    │
├────────────────────┼──────────┤
│ Total Requests     │ 120,000  │
│ Errors             │ 120      │
│ Error Rate         │ 0.10%    │
│ p50 Response       │ 45ms     │
│ p90 Response       │ 120ms    │
│ p99 Response       │ 350ms    │
│ Average CPU Time   │ 25ms     │
│ DO Executions      │ 240,000  │
│ D1 Writes          │ 80,000   │
└────────────────────┴──────────┘

Saved to: results/test1-standard_20251130_103045.json
```

## Metrics Analysis

### 1. Performance Analysis

#### CPU Time Analysis

```bash
# Identify requests with high CPU Time
cat results/metrics_latest.json | jq '.data.viewer.accounts[0].workersInvocationsAdaptive.quantiles | {
  p50: .cpuTimeP50,
  p90: .cpuTimeP90,
  p99: .cpuTimeP99
}'
```

**Evaluation Criteria**:
- p99 < 50ms: Excellent
- p99 < 100ms: Good
- p99 > 150ms: Needs optimization

#### Response Time Analysis

```bash
# Check Duration distribution
cat results/metrics_latest.json | jq '.data.viewer.accounts[0].workersInvocationsAdaptive.quantiles | {
  p50: .durationP50,
  p90: .durationP90,
  p99: .durationP99
}'
```

**Evaluation Criteria**:
- p99 < 300ms: Excellent
- p99 < 500ms: Good
- p99 > 1000ms: Needs improvement

### 2. Error Analysis

```bash
# Calculate error rate
cat results/metrics_latest.json | jq '
  .data.viewer.accounts[0].workersInvocationsAdaptive.sum |
  {
    total: .requests,
    errors: .errors,
    error_rate: ((.errors / .requests) * 100 | tostring + "%")
  }
'
```

**Evaluation Criteria**:
- < 0.1%: Excellent
- < 1%: Good
- < 5%: Acceptable
- > 5%: Needs improvement

### 3. DO Performance Analysis

```bash
# Statistics by DO class
cat results/metrics_latest.json | jq '
  .data.viewer.accounts[0].durableObjectsInvocationsAdaptive |
  map({
    class: .dimensions.className,
    invocations: .sum.requests,
    avg_cpu: (.sum.cpuTime / .sum.requests)
  })
'
```

### 4. D1 Performance Analysis

```bash
# Write/read ratio
cat results/metrics_latest.json | jq '
  .data.viewer.accounts[0].d1Queries.sum |
  {
    reads: .readQueries,
    writes: .writeQueries,
    write_ratio: ((.writeQueries / (.readQueries + .writeQueries)) * 100)
  }
'
```

## Report Generation

### Generate HTML Report

```bash
./scripts/generate-report.sh results/metrics_latest.json
```

Generated report example:

```html
<!DOCTYPE html>
<html>
<head>
  <title>Authrim Load Test Results</title>
</head>
<body>
  <h1>TEST 1 - Standard Preset</h1>
  <h2>Summary</h2>
  <table>
    <tr><td>Total Requests</td><td>120,000</td></tr>
    <tr><td>Error Rate</td><td>0.10%</td></tr>
    <tr><td>p99 Response</td><td>350ms</td></tr>
  </table>
  <!-- Graphs and charts -->
</body>
</html>
```

### CSV Export

```bash
./scripts/export-csv.sh results/metrics_latest.json > results/metrics.csv
```

Can be opened and analyzed in Excel or Google Sheets.

## Troubleshooting

### 1. API Token Error

```
Error: Authentication error
```

**Solution**:
```bash
# Verify token
echo $CLOUDFLARE_API_TOKEN

# Reset token
export CLOUDFLARE_API_TOKEN=new_token_here

# Or re-login with wrangler
wrangler logout
wrangler login
```

### 2. Account ID Not Found

```
Error: Account not found
```

**Solution**:
```bash
# Verify Account ID
wrangler whoami

# Or check from Cloudflare Dashboard
# https://dash.cloudflare.com/ → Account name (top right) → Account ID
```

### 3. Empty Data

```json
{
  "data": {
    "viewer": {
      "accounts": []
    }
  }
}
```

**Cause**: Time range is incorrect or data not yet aggregated

**Solution**:
- Verify time range (specify in UTC)
- Wait 5-10 minutes after test completion before execution
- Correctly set `datetime_geq` and `datetime_lt`

### 4. GraphQL Query Error

```
Error: GraphQL query error
```

**Solution**:
- Verify query syntax
- Check if schema is up-to-date (possibility of Cloudflare API changes)
- Verify version of `queries/worker_stats.graphql`

## Best Practices

### 1. Regular Collection

Collect 5-10 minutes after test execution, not immediately:

```bash
# Test execution
./scripts/run-test.sh test1 standard

# Wait 10 minutes
sleep 600

# Metrics collection
./scripts/collect-metrics.sh --test-name "test1-standard"
```

### 2. Version Control

```bash
# Manage test results with Git tags
git tag load-test-20251130-test1-standard
git push origin --tags
```

### 3. Result Comparison

```bash
# Compare with past results
./scripts/compare-results.sh results/metrics_20251130.json results/metrics_20251129.json
```

### 4. Automation

Integrate into CI/CD pipeline:

```yaml
# .github/workflows/load-test.yml
- name: Run Load Test
  run: ./scripts/run-test.sh test1 standard

- name: Collect Metrics
  run: |
    sleep 600
    ./scripts/collect-metrics.sh --test-name "ci-test1-standard"

- name: Validate Results
  run: ./scripts/validate-results.sh results/ci-test1-standard.json
```

## References

- [Cloudflare GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/)
- [Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/)
- [Wrangler GraphQL Command](https://developers.cloudflare.com/workers/wrangler/commands/#graphql)
