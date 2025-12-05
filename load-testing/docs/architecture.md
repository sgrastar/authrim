# Test Environment Architecture

## Overview

This document defines the standard architecture for Authrim's load testing.

## Test Execution Environment (Local)

### Hardware Requirements

| Item         | Recommended Specs        | Minimum Specs       |
| ------------ | ------------------------ | ------------------- |
| CPU          | Apple Silicon (M1/M2/M3) | Intel Core i5 or higher  |
| Memory       | 16GB or higher           | 8GB or higher       |
| Storage      | SSD 100GB+ available     | SSD 50GB+ available |
| Network      | Upload 100Mbps or higher | Upload 50Mbps or higher |

### Software Requirements

#### Required Tools

1. **k6 OSS**
   - Version: v0.45.0 or higher
   - Installation:

     ```bash
     # macOS
     brew install k6

     # Linux (Debian/Ubuntu)
     sudo gpg -k
     sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
       --keyserver hkp://keyserver.ubuntu.com:80 \
       --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
     echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
       sudo tee /etc/apt/sources.list.d/k6.list
     sudo apt-get update
     sudo apt-get install k6
     ```

2. **wrangler**
   - Version: v3.0.0 or higher
   - Installation:
     ```bash
     npm install -g wrangler
     wrangler login
     ```

3. **Node.js**
   - Version: v18.0.0 or higher
   - Purpose: Running wrangler, result processing scripts

#### Optional Tools

1. **jq**
   - Purpose: JSON result formatting and filtering
   - Installation:
     ```bash
     brew install jq
     ```

2. **curl**
   - Purpose: Manual API testing, debugging
   - Usually pre-installed with OS

## Authrim Infrastructure

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                  Local Test Environment                       │
│                                                               │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐             │
│  │   k6     │     │ wrangler │     │   jq     │             │
│  │  (load)  │     │(metrics) │     │ (format) │             │
│  └────┬─────┘     └──────────┘     └──────────┘             │
│       │                                                       │
└───────┼───────────────────────────────────────────────────────┘
        │
        │ HTTPS
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│                  Cloudflare Edge Network                      │
│                                                               │
│  ┌───────────────────────────────────────────────────────┐   │
│  │  Edge Cache / WAF / DDoS Protection / Rate Limiting   │   │
│  └─────────────────────┬─────────────────────────────────┘   │
│                        │                                      │
└────────────────────────┼──────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Authrim Workers Layer                      │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Authrim Worker                                      │    │
│  │  ├─ /authorize (authorization endpoint)              │    │
│  │  ├─ /token (token issuance)                          │    │
│  │  ├─ /userinfo (user information)                     │    │
│  │  └─ /.well-known/openid-configuration                │    │
│  └────┬────────────────────────────────────────┬─────────┘    │
│       │                                        │              │
│       │                                        │              │
└───────┼────────────────────────────────────────┼──────────────┘
        │                                        │
        │                                        │
        ▼                                        ▼
┌─────────────────┐                    ┌─────────────────┐
│  KeyManager DO  │                    │   Other DOs     │
│                 │                    │                 │
│  ├─ JWK Cache   │                    │ ├─ AuthzCode   │
│  ├─ Key Rotate  │                    │ ├─ TokenStore  │
│  └─ Sign/Verify │                    │ └─ Session     │
└────┬────────────┘                    └────┬────────────┘
     │                                      │
     │                                      │
     ▼                                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Storage Layer                   │
│                                                               │
│  ┌──────────┐      ┌──────────┐      ┌──────────┐           │
│  │    KV    │      │    D1    │      │    R2    │           │
│  │          │      │          │      │          │           │
│  │ • JWK    │      │• Refresh │      │ • Logs   │           │
│  │ • Config │      │• Session │      │ (Optional)│           │
│  └──────────┘      └──────────┘      └──────────┘           │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Component Roles

#### 1. Cloudflare Edge Network

- **Role**:
  - Frontline request reception
  - DDoS protection
  - Rate Limiting
  - Edge cache (static content)

- **Impact on Load Testing**:
  - Tests may be limited by Rate Limiting settings
  - Workers Unlimited plan recommended

#### 2. Authrim Worker

- **Role**:
  - OIDC protocol implementation
  - Request routing
  - Distribution to DO / KV / D1

- **Metrics to Measure in Load Testing**:
  - CPU time (ms)
  - Request count
  - Error rate
  - Response time (p50/p90/p99)

#### 3. Durable Objects (DO)

##### KeyManager DO

- **Role**:
  - JWK caching
  - JWT signing and verification
  - Key rotation

- **Metrics to Measure in Load Testing**:
  - DO execution count
  - Signature processing time
  - Cache hit rate

##### AuthorizationCodeStore DO

- **Role**:
  - Temporary authorization code storage
  - PKCE verification data retention

- **Metrics to Measure in Load Testing**:
  - Write/read contention
  - Code issuance rate

##### TokenStore DO

- **Role**:
  - Access token management
  - Refresh Token rotation

- **Metrics to Measure in Load Testing**:
  - Refresh contention
  - Rotation processing time

#### 4. Cloudflare Storage

##### KV (Key-Value Store)

- **Role**:
  - JWK public key storage
  - Configuration information cache

- **Characteristics**:
  - Eventually Consistent
  - Fast reads, write latency

##### D1 (SQLite Database)

- **Role**:
  - Refresh Token persistence
  - Session data storage

- **Metrics to Measure in Load Testing**:
  - Write speed
  - Read speed
  - Transaction contention

##### R2 (Object Storage)

- **Role** (Optional):
  - Audit log storage
  - Long-term test result storage

## Test Traffic Flow

### TEST 1: /token Endpoint Only

```
k6
 ↓
 POST /token
 ↓
Authrim Worker
 ↓
KeyManager DO (JWT signing)
 ↓
KV (JWK read)
 ↓
Response (JWT)
```

### TEST 2: Refresh Token Storm

```
k6
 ↓
 POST /token (grant_type=refresh_token)
 ↓
Authrim Worker
 ↓
TokenStore DO (rotation)
 ↓
D1 (Refresh Token update)
 ↓
KeyManager DO (JWT signing)
 ↓
Response (new Access Token + Refresh Token)
```

### TEST 3: Full OIDC Flow

```
k6
 ↓
 GET /authorize
 ↓
Authrim Worker
 ↓
AuthorizationCodeStore DO (code issuance)
 ↓
Response (code)
 ↓
k6 (receive code)
 ↓
 POST /token
 ↓
Authrim Worker
 ↓
AuthorizationCodeStore DO (code validation/deletion)
 ↓
TokenStore DO (token issuance)
 ↓
D1 (Session storage)
 ↓
KeyManager DO (JWT signing)
 ↓
Response (Access Token + Refresh Token)
```

## Network Requirements

### Bandwidth Calculation

#### Minimum Bandwidth (Light Preset)

- RPS: 20
- Request size: approx 2KB
- Response size: approx 5KB
- **Required bandwidth**: 20 × (2 + 5) KB = 140 KB/s ≈ **1.1 Mbps**

#### Recommended Bandwidth (Standard Preset)

- RPS: 100
- **Required bandwidth**: 100 × 7 KB = 700 KB/s ≈ **5.6 Mbps**

#### Heavy Preset

- RPS: 600
- **Required bandwidth**: 600 × 7 KB = 4,200 KB/s ≈ **33.6 Mbps**

### Latency Requirements

- **RTT (Round Trip Time)**: Typically 50-100ms (from Japan to Cloudflare Edge)
- **Worker processing time**: Typically 10-50ms
- **DO processing time**: Typically 5-20ms
- **D1 writes**: Typically 10-30ms

**Total expected response time**: 75-200ms (normal conditions)

## Cloudflare Analytics Configuration

### Required Permissions

Cloudflare API Token needs the following permissions:

- **Workers Scripts: Read**
- **Analytics: Read**
- **Logs: Read**

### Enable Analytics Engine

Add the following to `wrangler.toml`:

```toml
[observability]
enabled = true
head_sampling_rate = 1.0  # 100% sampling during testing

[analytics_engine_datasets]
# Define custom datasets as needed
```

### Graph API Endpoint

```
https://api.cloudflare.com/client/v4/graphql
```

## Security Considerations

### Test Environment Isolation

- Complete separation of production and test environments
- Use dedicated Worker, DO, D1 for testing
- Use only dummy data for testing

### Rate Limiting

- Relax or disable Rate Limiting during testing
- Always restore after testing

### Credential Management

- Add `.env` files to `.gitignore`
- Follow principle of least privilege for API tokens
- Delete unnecessary tokens after testing

## Monitoring

### Real-time Monitoring

Monitor the following during test execution:

1. **Cloudflare Dashboard**
   - Workers Analytics
   - Real-time request count
   - Error rate

2. **k6 Output**
   - Real-time RPS
   - Response time
   - VU status

### Post-Test Analysis

Collect the following after test completion:

1. **Cloudflare Graph API**
   - CPU usage
   - Memory usage
   - DO execution count
   - D1 query count

2. **k6 Results**
   - Summary report
   - Timeline graph
   - Error logs

## Troubleshooting

### Common Issues

#### 1. 429 Too Many Requests

**Cause**: Hitting Rate Limiting

**Solution**:

- Switch to Workers Unlimited plan
- Relax Rate Limiting settings
- Lower test RPS

#### 2. Sudden Increase in 500 Internal Server Error

**Cause**: DO lock contention, D1 write contention

**Solution**:

- Lower preset
- Review DO design (avoid contention)
- Optimize D1 transactions

#### 3. Timeout Errors

**Cause**: Worker processing time exceeding CPU Time Limit

**Solution**:

- Reduce unnecessary processing
- Utilize caching
- Make processing asynchronous

## Related Documentation

- [endpoint-requirements.md](./endpoint-requirements.md) - Required configuration and state management rules per endpoint
- [test-scenarios.md](./test-scenarios.md) - Detailed test scenarios
- [metrics-collection.md](./metrics-collection.md) - Metrics collection procedures

## References

- [Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Objects Best Practices](https://developers.cloudflare.com/durable-objects/best-practices/)
- [D1 Database Limits](https://developers.cloudflare.com/d1/platform/limits/)
- [k6 Documentation](https://k6.io/docs/)
