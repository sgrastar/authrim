# Authrim Load Test Reports - December 2025

This folder contains comprehensive load test reports for the Authrim OIDC Provider, conducted in December 2025 using K6 Cloud distributed load testing and Cloudflare Analytics monitoring.

## Test Reports

| Report | Endpoint | Max Throughput | Key Findings |
|--------|----------|----------------|--------------|
| [Silent Authentication](./silent-auth.md) | `GET /authorize?prompt=none` | 3,500-4,000 RPS | DO sharding (64→128) eliminates errors |
| [UserInfo](./userinfo.md) | `GET /userinfo` | 2,000-3,000 RPS | JWT validation stable at 1-4ms CPU |
| [Token Exchange](./token-exchange.md) | `POST /token` (RFC 8693) | 2,500 RPS | 100% token validation accuracy |
| [Token Introspection](./token-introspection.md) | `POST /introspect` (RFC 7662) | 300-750 RPS | Region-aware JTI sharding effective |
| [Full Login (Mail OTP)](./full-login-otp.md) | 5-step OAuth flow | 150 LPS | 32 shards: 91% P95 latency reduction |

## Infrastructure

All tests were conducted against:
- **Platform**: Cloudflare Workers + Durable Objects + D1
- **Load Generator**: K6 Cloud (Amazon US regions)
- **Monitoring**: Cloudflare Analytics API

## Key Metrics Across Tests

### Requests Per Second (RPS) Capacity

| Endpoint | Recommended | Peak | Hard Limit |
|----------|-------------|------|------------|
| Silent Auth (128 shards) | 2,500 RPS | 3,500 RPS | 4,500 RPS |
| UserInfo | 2,000 RPS | 2,500 RPS | 3,000 RPS |
| Token Exchange | 1,500 RPS | 2,500 RPS | 2,700 RPS |
| Token Introspection (32 shards) | 300 RPS | 500 RPS | 750 RPS |
| Full Login Flow (32 shards) | 100 LPS | 150 LPS | 150+ LPS |

### Common Findings

1. **Durable Objects are the bottleneck**: Wall Time increases at high RPS due to queueing
2. **CPU is NOT the bottleneck**: Worker CPU time stable at 2-4ms across all endpoints
3. **Sharding is effective**: Increasing shard count improves throughput and eliminates errors
4. **Zero error rates achievable**: All endpoints can achieve 0% error rate within capacity limits
5. **JWT validation is fast**: RS256 signature verification adds minimal overhead

## Report Structure

Each report follows a standardized format:
1. **Test Purpose**: What was tested and why
2. **Test Configuration**: K6 settings, infrastructure, shard configuration
3. **Test Execution**: Test matrix with timing and parameters
4. **Results**: Performance summary and key metrics
5. **Data**: Detailed latency, CPU, DO, and D1 metrics
6. **Conclusion**: Performance evaluation and key findings

---

*Reports generated: December 2025*
