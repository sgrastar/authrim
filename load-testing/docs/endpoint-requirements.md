# Endpoint Load Testing Requirements Specification

## Overview

This document defines the **required configuration and state management rules for each endpoint** in Authrim's load testing.

> **Important**: Following this specification will achieve the same level of accuracy as the load tests conducted internally by Auth0 / Okta / Azure AD B2C.

---

## Table of Contents

- [Standard Benchmark Tests](#standard-benchmark-tests)
- [Common Principles](#common-principles)
- [Endpoint Requirements](#endpoint-requirements)
  - [/authorize](#1-authorize-authentication-initiation)
  - [/token (authorization_code)](#2-token-grant_typeauthorization_code)
  - [/token (refresh_token)](#3-token-grant_typerefresh_token)
  - [/token (token_exchange)](#4-token-grant_typetoken_exchange)
  - [/userinfo](#5-userinfo)
  - [/.well-known/openid-configuration](#6-well-knownopenid-configuration)
- [State Transition Summary Table](#state-transition-summary-table)
- [Production Presets](#production-presets)

---

## Standard Benchmark Tests

### Unified Conditions: 2-Minute 300 RPS Test

We conduct benchmark tests for all endpoints under the following unified conditions.

| Item      | Value                     |
| --------- | ------------------------- |
| RPS       | **300 RPS (Fixed)**       |
| Duration  | **2 minutes (120 seconds)** |
| Ramp-up   | 10 seconds                |
| Ramp-down | 10 seconds                |

### Purpose

- **Cross-Comparison**: Measure all endpoints under the same conditions to identify bottlenecks
- **Establish Baseline**: Use as a comparison standard before and after improvements
- **Understand Limits**: 300 RPS is equivalent to peak load for 1.5M MAU

### Tests to Conduct

| Test | Endpoint                      | Preparation                            |
| ------ | ----------------------------- | -------------------------------------- |
| TEST 1 | `/token` (authorization_code) | 36,000+ authorization codes            |
| TEST 2 | `/token` (refresh_token)      | 300+ independent RT families           |
| TEST 3 | Full OIDC Flow                | 36,000+ codes + sessions               |

### Success Criteria

| Metric       | Target  |
| ------------ | ------- |
| p95 Latency  | < 300ms |
| p99 Latency  | < 500ms |
| Error Rate   | < 0.1%  |
| Success Rate | > 99.9% |

### Example Execution Commands

```bash
# TEST 1: Token endpoint (300 RPS × 2 min)
k6 run --env RPS=300 --env DURATION=120s scripts/test1-token-load.js

# TEST 2: Refresh Token Storm (300 RPS × 2 min)
k6 run --env RPS=300 --env DURATION=120s scripts/test2-refresh-storm.js

# TEST 3: Full OIDC (300 RPS × 2 min)
k6 run --env RPS=300 --env DURATION=120s scripts/test3-full-oidc.js
```

### Pre-Data Generation

```bash
# Generate seeds for 300 RPS × 120 seconds = 36,000 requests
cd load-testing/scripts

# For TEST 1: authorization codes
AUTH_CODE_COUNT=40000 REFRESH_COUNT=0 node generate-seeds.js

# For TEST 2: independent RT families (number of VUs)
AUTH_CODE_COUNT=0 REFRESH_COUNT=300 node generate-refresh-tokens-parallel.js
```

---

## Common Principles

### Principle 1: VU = Behaves as a Real User

**VU (Virtual User) must behave as an actual user.**

Without maintaining **authentication state, sessions, and Refresh Token families** per VU, you'll end up with a "meaningless load test".

```
VU 1 → user1's refresh_token family
VU 2 → user2's refresh_token family
...
VU N → userN's refresh_token family
```

> **Prohibited**: Using a common Refresh Token across all VUs is **absolutely forbidden** (differs from actual behavior)

### Principle 2: Distribution Strategy to Avoid DO Collisions

RefreshTokenRotator DO is sharded by `user_id` and `client_id`.

| Item        | Distribution Strategy              |
| ----------- | ---------------------------------- |
| `user_id`   | Use different values per VU (mandatory) |
| `client_id` | Common across all VUs is OK (closer to production) |

### Principle 3: Pre-Generate Tokens

There's **no need** to include the entire authentication flow during load testing.

Use `generate-seeds.js` etc. to prepare in advance:

- `access_token` per VU
- `refresh_token` per VU (**mandatory**)
- Sessions per VU (pre-saved in D1)
- Required number of `authorization_code` (for TEST 1)

### Principle 4: Use Correct Headers

Workers can slow down due to header mismatches, so always set these headers:

```http
Content-Type: application/x-www-form-urlencoded
Accept: application/json
Connection: keep-alive
```

---

## Endpoint Requirements

### 1. /authorize (Authentication Initiation)

#### Required Configuration

| Item           | Requirement                              | Reason                            |
| -------------- | ---------------------------------------- | --------------------------------- |
| `state`        | **Generate randomly per request**        | Varies each time in production (CSRF protection) |
| `nonce`        | **Generate randomly per request**        | Replay attack prevention          |
| `redirect_uri` | Fixed is OK                              | No need to vary per VU            |
| Cookie         | **Receive Set-Cookie and return in next request** | Session management                |

#### Request Example

```http
GET /authorize?
  response_type=code
  &client_id={client_id}
  &redirect_uri=https://localhost:3000/callback
  &scope=openid%20profile%20email
  &state={random_state}
  &nonce={random_nonce}
  &code_challenge={pkce_challenge}
  &code_challenge_method=S256
HTTP/1.1
Host: conformance.authrim.com
Accept: application/json
```

#### k6 Implementation Example

```javascript
import { randomString } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';
import { URL } from 'https://jslib.k6.io/url/1.0.0/index.js';

export default function () {
  const state = randomString(32);
  const nonce = randomString(32);
  const codeVerifier = randomString(64);
  const codeChallenge = sha256base64url(codeVerifier);

  const url = new URL(`${BASE_URL}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  const res = http.get(url.toString(), {
    headers: { Accept: 'application/json' },
  });

  // Save cookies (use in next request)
  const cookies = res.cookies;
  // Extract code (use in next /token request)
}
```

#### Prohibited Actions

- Using a fixed value for `state`
- Ignoring cookies
- Ignoring the `code` from `/authorize` → `/token` and POST

---

### 2. /token (grant_type=authorization_code)

#### Required Configuration

| Item                          | Requirement                           | Reason         |
| ----------------------------- | ------------------------------------- | -------------- |
| `code`                        | **Use code received from /authorize** | One-Time Use   |
| `redirect_uri`                | **Exact match with /authorize**       | OAuth 2.0 spec |
| `client_id` / `client_secret` | Fixed is OK                           | Credentials    |
| `code_verifier`               | **Verifier used in /authorize**       | PKCE validation|

#### Important State Handling

```
code is "one-time use"
↓
After /token success, save refresh_token locally in VU
↓
Use that RT in next refresh test
```

#### Request Example

```http
POST /token HTTP/1.1
Host: conformance.authrim.com
Content-Type: application/x-www-form-urlencoded
Authorization: Basic {base64(client_id:client_secret)}

grant_type=authorization_code
&code={pre_generated_code}
&redirect_uri=https://localhost:3000/callback
&code_verifier={pkce_verifier}
```

#### k6 Implementation Example

```javascript
export default function () {
  const vuId = __VU;
  const seed = seeds[vuId % seeds.length];

  const res = http.post(
    `${BASE_URL}/token`,
    {
      grant_type: 'authorization_code',
      code: seed.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: seed.code_verifier,
    },
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      },
    }
  );

  if (res.status === 200) {
    const data = res.json();
    // Save refresh_token locally in VU (use in next refresh test)
    vuState.refreshToken = data.refresh_token;
  }
}
```

#### Prohibited Actions

- Using the same `code` multiple times
- Setting `redirect_uri` to a different value from `/authorize`

---

### 3. /token (grant_type=refresh_token)

> **Most Important**: The most challenging endpoint load test. Incorrect configuration renders the test meaningless.

#### Required Configuration (Critical)

| Item           | Requirement                            | Reason                   |
| -------------- | -------------------------------------- | ------------------------ |
| Token Rotation | **Must be enabled**                    | Almost mandatory in production |
| RT family      | **Independent per VU**                 | Prevent DO collisions    |
| RT update      | **Use previous RT for each request**   | Essence of Rotation      |

#### Refresh Token Rotation Flow

```
Initial state: rt = seeds[VU].initialRT

for each request:
   res = POST /token (refresh_token=rt)
   rt = res.refresh_token  ← Update with new RT
```

**This is the most important. Without using a new RT each time, it won't test Token Rotation.**

#### Request Example

```http
POST /token HTTP/1.1
Host: conformance.authrim.com
Content-Type: application/x-www-form-urlencoded
Authorization: Basic {base64(client_id:client_secret)}

grant_type=refresh_token
&refresh_token={current_refresh_token}
```

#### k6 Implementation Example (Stateful)

```javascript
// State management per VU
const vuState = {};

export function setup() {
  // Load initial RT per VU from seeds
  const seeds = JSON.parse(open('./seeds/refresh_tokens.json'));
  return { seeds };
}

export default function (data) {
  const vuId = __VU;

  // First time: get RT from seeds
  if (!vuState.refreshToken) {
    vuState.refreshToken = data.seeds[vuId % data.seeds.length].refresh_token;
    vuState.userId = data.seeds[vuId % data.seeds.length].user_id;
  }

  const res = http.post(
    `${BASE_URL}/token`,
    {
      grant_type: 'refresh_token',
      refresh_token: vuState.refreshToken,
    },
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
      },
    }
  );

  if (res.status === 200) {
    const data = res.json();
    // ★ Update with new RT (most important)
    vuState.refreshToken = data.refresh_token;
  }

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has new refresh_token': (r) => r.json('refresh_token') !== undefined,
  });
}
```

#### Prohibited Actions (Absolutely Forbidden)

| NG Pattern                              | Result                             |
| --------------------------------------- | ---------------------------------- |
| All VUs reuse the same RT               | DO concentrates on one instance and dies |
| Using the same RT every time            | Not Rotation, differs from production |
| Not saving RT update result locally in VU | Test is meaningless                |

#### About Theft Detection Testing

Testing the old RT usage (Theft Detection) path should be done in a **separate test**.
First complete the normal path load test.

---

### 4. /token (grant_type=token_exchange)

#### Required Configuration

| Item                      | Requirement       | Reason           |
| ------------------------- | ----------------- | ---------------- |
| `subject_token`           | Hold per VU       | User identification |
| `actor_token`             | Hold per VU       | Delegated authentication |
| Target `client_id` for exchange | Fixed is OK       | Target service   |

#### Request Example

```http
POST /token HTTP/1.1
Host: conformance.authrim.com
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token={session_token}
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&requested_token_type=urn:ietf:params:oauth:token-type:access_token
```

#### Difference from RT

```
Token Exchange:
  - Sending the same session_token every time = OK
  - No need to update every time like RT
```

---

### 5. /userinfo

#### Required Configuration

| Item           | Requirement                     | Reason                               |
| -------------- | ------------------------------- | ------------------------------------ |
| `access_token` | Fixed per VU is OK              | AT change frequency is low in production |
| AT expiration  | **Use tokens within validity**  | Prevent authentication errors        |

#### Recommended Configuration

Best to pre-generate ATs with `exp=30m` for load testing.

#### Request Example

```http
GET /userinfo HTTP/1.1
Host: conformance.authrim.com
Authorization: Bearer {access_token}
Accept: application/json
```

---

### 6. /.well-known/openid-configuration

#### Required Configuration

**None.** Simple GET request.

#### Recommended Headers

```http
GET /.well-known/openid-configuration HTTP/1.1
Host: conformance.authrim.com
Accept: application/json
Connection: keep-alive
```

#### Use Case

Mainly used for cache load testing.

---

## State Transition Summary Table

Summary of "what needs to change" for each endpoint:

| Endpoint            | Change Every Time?       | Per VU? | Required State Management | Notes                    |
| ------------------- | ------------------------ | ------- | ------------------------- | ------------------------ |
| `/authorize`        | YES (state/nonce)        | NO      | state, cookie             | code is one-time use     |
| `/token` (code)     | YES (code)               | YES     | code, session             | Save RT when received    |
| `/token` (refresh)  | **YES (RT update)**      | **YES** | **refresh_token**         | Maintain RT family       |
| `/token` (exchange) | NO                       | YES     | session_token             | Reuse OK                 |
| `/userinfo`         | NO                       | YES     | AT only                   | AT can be used fixed     |
| `/.well-known`      | NO                       | NO      | None                      | Cache load               |

---

## Production Presets

### Preset A: Regular Web Service (Login 1x/day)

**Target Services**: Business SaaS, E-commerce, Internal portals

| Endpoint           | Requirement                          | Frequency   |
| ------------------ | ------------------------------------ | ----------- |
| `/authorize`       | Handle cookies correctly             | 1x/day      |
| `/token` (code)    | code is one-time use                 | 1x/day      |
| `/token` (refresh) | RT used only on first time           | 1-2x/day    |
| `/userinfo`        | AT fixed, called multiple times      | 5-10x/day   |

### Preset B: Mobile App

#### B-1: Low Frequency (On Launch Only)

**Target Services**: Weather apps, News apps

- RT → AT: 1-2x/day
- `/authorize` only on first time

#### B-2: Medium Frequency (Chat / Mobile Games)

**Target Services**: Messengers, Mobile games

- `/token` (refresh): 1-4x/hour
- `/userinfo` rarely called

#### B-3: High Frequency (Video Streaming / API-Heavy)

**Target Services**: Video streaming, Real-time apps

- AT rarely expires, so refresh-centric
- `/userinfo` minimal

### Preset C: IoT (POS / Home Appliances)

**Target Services**: POS terminals, Smart home devices, Sensors

| Endpoint           | Requirement                | Frequency           |
| ------------------ | -------------------------- | ------------------- |
| `/authorize`       | Only on first time         | 1x/setup            |
| `/token` (refresh) | Regular maintenance-type   | 30-minute intervals |
| `/userinfo`        | Called at regular intervals| 10-minute intervals |

---

## Test Data Generation Requirements

### Seed Generation for Refresh Token Storm

```bash
# Generate independent RT families according to number of VUs
cd load-testing/scripts

# Example: Generate 100 independent RTs for 100 VUs
AUTH_CODE_COUNT=0 \
REFRESH_COUNT=100 \
node generate-refresh-tokens-parallel.js
```

### Generated Data Structure

```json
[
  {
    "user_id": "user-loadtest-001",
    "refresh_token": "rt_xxx...",
    "client_id": "b42bdc5e-..."
  },
  {
    "user_id": "user-loadtest-002",
    "refresh_token": "rt_yyy...",
    "client_id": "b42bdc5e-..."
  }
]
```

### Important Points

- `user_id` differs per VU
- `client_id` is common across all VUs (OK)
- Each RT belongs to an independent token family

---

## Related Documentation

- [Test Scenario Details](./test-scenarios.md) - Detailed specifications for TEST 1/2/3
- [Architecture](./architecture.md) - Test environment configuration
- [Metrics Collection](./metrics-collection.md) - Data retrieval from Cloudflare Analytics
- [Load Test Results](./LOAD_TEST_RESULTS.md) - Past test results

---

## Change History

| Date       | Changes        |
| ---------- | -------------- |
| 2025-12-03 | Initial version |
