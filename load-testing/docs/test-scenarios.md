# Test Scenario Details

## Overview

This document defines detailed specifications for the three standard test scenarios in Authrim's load testing.

## Test Design Principles

### 1. Realism

- Scenarios based on actual user behavior
- Use same endpoints and paths as production environment
- Realistic payload sizes and request frequencies

### 2. Reproducibility

- Same results when running the same preset multiple times
- Fixed random number seeds
- Pre-prepared test data

### 3. Gradual Load

- Execute in order: Light → Standard → Heavy
- Ensure sufficient cooldown time at each stage
- Gradually explore system limits

## TEST 1: /token Endpoint Load Test

### Purpose

Measure Authrim's **maximum RPS limit** simply and verify CPU load from JWT signature processing and the occurrence domain of DO lock contention.

### Test Target Endpoint

```
POST /token
```

### Request Specification

#### Request Headers

```http
POST /token HTTP/1.1
Host: conformance.authrim.com
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)
```

#### Request Body

```
grant_type=authorization_code
&code={pre_generated_code}
&redirect_uri=https://example.com/callback
&code_verifier={pkce_verifier}
```

### Preparation

Prepare the following before test execution:

1. **Generate large number of authorization codes**
   - Pre-generate at least 10,000 valid authorization codes
   - Save to AuthorizationCodeStore DO
   - Test script loads from CSV file

2. **Register test client**
   - Issue Client ID / Secret
   - Register Redirect URI
   - Set PKCE as mandatory

### Preset Details

#### Light (Low Load)

**Use Case**: Normal operation load of actual service

| Parameter  | Value   |
| ----------- | ------- |
| RPS (Start) | 5       |
| RPS (End)   | 20      |
| Duration    | 60 sec  |
| VUs         | 20      |
| Ramp-up     | 10 sec  |
| Ramp-down   | 10 sec  |

**Expected Results**:

- p50: < 100ms
- p90: < 200ms
- p99: < 250ms
- Error Rate: < 0.1%
- CPU Time: < 50ms/request

**k6 Configuration Example**:

```javascript
export const options = {
  scenarios: {
    token_load_light: {
      executor: 'ramping-arrival-rate',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 30,
      stages: [
        { target: 5, duration: '10s' }, // Ramp up to 5 RPS
        { target: 20, duration: '20s' }, // Ramp up to 20 RPS
        { target: 20, duration: '20s' }, // Stay at 20 RPS
        { target: 5, duration: '10s' }, // Ramp down to 5 RPS
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<250'],
    http_req_failed: ['rate<0.001'],
  },
};
```

#### Standard (Medium Load)

**Use Case**: Peak time scenario for 100K-300K MAU

| Parameter  | Value     |
| ----------- | --------- |
| RPS (Start) | 30        |
| RPS (End)   | 100       |
| Duration    | 120 sec   |
| VUs         | 100       |
| Ramp-up     | 20 sec    |
| Ramp-down   | 20 sec    |

**Expected Results**:

- p50: < 150ms
- p90: < 350ms
- p99: < 500ms
- Error Rate: < 0.5%
- CPU Time: < 80ms/request

#### Heavy (High Load)

**Use Case**: Measure architecture ceiling

| Parameter  | Value       |
| ----------- | ----------- |
| RPS (Start) | 200         |
| RPS (End)   | 600         |
| Duration    | 180 sec     |
| VUs         | 200-600     |
| Ramp-up     | 30 sec      |
| Ramp-down   | 30 sec      |

**Expected Results**:

- **Identify RPS where error rate spikes**
- Confirm occurrence domain of 429 (Rate Limit) or 500 (Internal Error)
- Record point where p99 exceeds 1 second

### Metrics to Measure

1. **Performance Metrics**
   - Response time (p50/p90/p95/p99)
   - Throughput (RPS)
   - Error rate

2. **Cloudflare Metrics**
   - CPU Time (ms)
   - KeyManager DO execution count
   - JWT signature processing time
   - KV read count

3. **Bottleneck Analysis**
   - Requests with longest CPU Time
   - DO lock wait time
   - Network I/O time

### Success Criteria

- Light: All requests succeed (error rate < 0.1%)
- Standard: p99 < 500ms, error rate < 1%
- Heavy: **Record maximum stable RPS** (maximum value with error rate < 5%)

---

## TEST 2: Refresh Token Storm

### Purpose

Assume **real-world maximum traffic** and check D1 write load and DO Token Rotator contention.

### Test Target Endpoint

```
POST /token
```

### Request Specification

#### Request Headers

```http
POST /token HTTP/1.1
Host: conformance.authrim.com
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)
```

#### Request Body

```
grant_type=refresh_token
&refresh_token={valid_refresh_token}
```

### Preparation

1. **Generate large number of Refresh Tokens**
   - Pre-generate at least 50,000 valid Refresh Tokens
   - Save to D1 (persisted state)
   - Each token linked to different user

2. **Token Rotation Configuration**
   - Enable Refresh Token Rotation
   - Immediate invalidation of old tokens

### Preset Details

#### Light (Low Load)

**Use Case**: Daily Refresh traffic

| Parameter | Value          |
| ---------- | -------------- |
| RPS        | 50             |
| Duration   | 5 min (300 sec)|
| VUs        | 50             |
| Think Time | 100ms          |

**Expected Results**:

- p99: < 300ms
- Error Rate: < 0.1%
- D1 write success rate: 100%

#### Standard (Medium Load)

**Use Case**: Peak time Refresh traffic

| Parameter  | Value            |
| ----------- | ---------------- |
| RPS (Start) | 200              |
| RPS (Max)   | 500              |
| Duration    | 10 min (600 sec) |
| VUs         | 200-500          |

**Expected Results**:

- p99: < 500ms
- Error Rate: < 0.1%
- D1 write success rate: > 99.9%

#### Heavy (High Load)

**Use Case**: Extreme Refresh Storm

| Parameter  | Value            |
| ----------- | ---------------- |
| RPS (Start) | 800              |
| RPS (Max)   | 1200             |
| Duration    | 10 min (600 sec) |
| VUs         | 800-1200         |

**Expected Results**:

- **Observe DO lock contention**
- Confirm D1 write error occurrence domain
- Measure timeout and retry behavior

### Metrics to Measure

1. **Performance Metrics**
   - Response time (especially p99)
   - D1 write time
   - Token Rotation processing time

2. **Cloudflare Metrics**
   - TokenStore DO execution count
   - D1 Write query count
   - D1 transaction contention count

3. **Consistency Checks**
   - Refresh Token duplicate usage detection rate
   - Old token invalidation confirmation
   - Session data consistency

### Success Criteria

- Light: error rate < 0.1%, p99 < 300ms
- Standard: error rate < 0.1%, p99 < 500ms
- Heavy: **D1 write errors < 2%**

---

## TEST 3: Full OIDC Authentication Flow

### Purpose

Reproduce the workload closest to actual service and perform end-to-end testing through all PKCE / DO / D1 paths.

### Test Flow

```
1. GET /authorize
   ↓
2. (User authentication and consent screen)
   ↓
3. Redirect to callback with code
   ↓
4. POST /token (code exchange)
   ↓
5. Response: access_token + refresh_token
```

### Request Specification

#### Step 1: Authorization Request

```http
GET /authorize?
  response_type=code
  &client_id={client_id}
  &redirect_uri=https://example.com/callback
  &scope=openid%20profile%20email
  &state={random_state}
  &code_challenge={pkce_challenge}
  &code_challenge_method=S256
  &nonce={random_nonce}
```

#### Step 2: Token Request

```http
POST /token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic base64(client_id:client_secret)

grant_type=authorization_code
&code={received_code}
&redirect_uri=https://example.com/callback
&code_verifier={pkce_verifier}
```

### Preset Details

#### Light (Low Load)

**Use Case**: Normal web app login

| Parameter  | Value         |
| ----------- | ------------- |
| RPS (Start) | 10            |
| RPS (End)   | 20            |
| Duration    | 120 sec       |
| VUs         | 20            |
| Think Time  | 500ms-2s      |

**Expected Results**:

- Full flow completion rate: > 99%
- p99: < 300ms (authorize + token total)
- Error rate: < 0.5%

#### Standard (Medium Load)

**Use Case**: Peak time login traffic

| Parameter  | Value         |
| ----------- | ------------- |
| RPS (Start) | 30            |
| RPS (End)   | 50            |
| Duration    | 180 sec       |
| VUs         | 50            |
| Think Time  | 200ms-1s      |

**Expected Results**:

- Full flow completion rate: > 98%
- p99: < 500ms
- Error rate: < 1%

#### Heavy (High Load)

**Use Case**: Simultaneous mass login (flash sales, etc.)

| Parameter  | Value            |
| ----------- | ---------------- |
| RPS (Start) | 80               |
| RPS (End)   | 100              |
| Duration    | 180 sec          |
| VUs         | 100              |
| Think Time  | 100ms-500ms      |

**Expected Results**:

- **DO contention becomes prominent above 80RPS**
- Identify latency spike point
- Measure queue wait time

### Metrics to Measure

1. **Flow Completion Rate**
   - authorize → token complete success rate
   - Abandonment rate (code acquisition failure, token acquisition failure)

2. **Step-by-Step Response Time**
   - GET /authorize processing time
   - POST /token processing time
   - Total flow time

3. **Cloudflare Metrics**
   - AuthorizationCodeStore DO execution count
   - TokenStore DO execution count
   - D1 Session write count

### Success Criteria

- Light: completion rate > 99%, p99 < 300ms
- Standard: completion rate > 98%, p99 < 500ms
- Heavy: **Stable operation at 80RPS** (error rate < 5%)

---

## Test Execution Order

### Recommended Execution Sequence

1. **TEST 1 - Light** → Run as warmup
2. **TEST 1 - Standard** → Verify basic performance
3. ⏸️ **30-minute cooldown**
4. **TEST 2 - Light** → Initial verification of D1 write load
5. **TEST 2 - Standard** → Full Refresh Storm measurement
6. ⏸️ **1-hour cooldown**
7. **TEST 3 - Light** → End-to-end operation verification
8. **TEST 3 - Standard** → Production-expected load test
9. ⏸️ **2-hour cooldown**
10. **TEST 1/2/3 - Heavy** → Ceiling exploration (any order)

### Importance of Cooldown

- Reset Cloudflare internal cache and metrics
- Clear DO state
- Flush D1 transaction logs
- System-wide stabilization

---

## Data Preparation Scripts

### Pre-Generate Authorization Codes

```bash
# scripts/prepare-authz-codes.sh
./scripts/generate-codes.sh 10000 > data/authz_codes.csv
```

### Pre-Generate Refresh Tokens

```bash
# scripts/prepare-refresh-tokens.sh
./scripts/generate-refresh-tokens.sh 50000 > data/refresh_tokens.csv
```

### Create Test Users

```bash
# scripts/create-test-users.sh
./scripts/create-users.sh 1000
```

---

## Result Evaluation Method

### Pass Criteria Matrix

| Test | Preset | p99      | Error Rate | Additional Condition |
| ------ | ---------- | -------- | ---------- | -------------------- |
| TEST 1 | Light      | < 250ms  | < 0.1%     | -                    |
| TEST 1 | Standard   | < 500ms  | < 1%       | -                    |
| TEST 1 | Heavy      | -        | < 5%       | Record max RPS       |
| TEST 2 | Light      | < 300ms  | < 0.1%     | D1 errors 0          |
| TEST 2 | Standard   | < 500ms  | < 0.1%     | D1 errors < 0.1%     |
| TEST 2 | Heavy      | < 700ms  | < 2%       | Observe DO contention|
| TEST 3 | Light      | < 300ms  | < 0.5%     | Completion > 99%     |
| TEST 3 | Standard   | < 500ms  | < 1%       | Completion > 98%     |
| TEST 3 | Heavy      | < 1000ms | < 5%       | 80RPS stable         |

### Actions on Failure

1. **p99 exceeded**: Algorithm optimization, cache enhancement
2. **Error Rate exceeded**: Review DO lock design, add retry logic
3. **D1 errors**: Transaction isolation, batch writes
4. **Completion rate drop**: Review timeout settings, strengthen error handling

---

## Next Steps

1. **Check Endpoint Requirements**: Refer to [endpoint-requirements.md](./endpoint-requirements.md) to confirm state management rules for each endpoint. For the Refresh Token Storm test especially, RT family separation per VU is mandatory.

2. **Metrics Collection**: After test execution, collect metrics from Cloudflare Analytics according to [metrics-collection.md](./metrics-collection.md).
