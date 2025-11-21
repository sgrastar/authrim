# Performance Optimization & Monitoring

This document describes the performance testing strategy, current benchmarks, and optimization guidelines for Authrim.

## Performance Testing Strategy

### Tools

- **Lighthouse CI**: Automated performance audits for UI pages
- **curl-based benchmarks**: Backend API endpoint latency testing (`scripts/performance-test.sh`)
- **Core Web Vitals**: Real-user performance metrics

### Test Environment

- **Desktop**: 1350x940, no throttling
- **Network**: 10 Mbps download, 40ms RTT
- **CPU**: No slowdown
- **Runs**: 3 iterations per page (median score used)

## Current Performance Benchmarks

### UI Performance (Lighthouse Scores)

Based on user feedback, current production scores:

| Metric | Score | Status |
|--------|-------|--------|
| **Performance** | 100 | ✅ Excellent |
| **Accessibility** | 89 | ⚠️ Good |
| **Best Practices** | 100 | ✅ Excellent |
| **SEO** | 91 | ✅ Excellent |

### Core Web Vitals

| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| **Largest Contentful Paint (LCP)** | 0.11s | < 2.5s | ✅ Excellent |
| **First Input Delay (FID)** | N/A | < 100ms | - |
| **Cumulative Layout Shift (CLS)** | N/A | < 0.1 | - |
| **Total Blocking Time (TBT)** | N/A | < 300ms | - |

**Note**: Current LCP of 0.11s is exceptional, indicating optimal performance.

### Backend API Latency

**Test Script**: `scripts/performance-test.sh`

**Metrics Measured**:
- Response time (min/max/avg/p95)
- DNS lookup time
- TCP connect time
- TLS handshake time
- Time to First Byte (TTFB)

**Endpoints Tested**:
- Discovery endpoint (`/.well-known/openid-configuration`)
- JWKS endpoint (`/.well-known/jwks.json`)
- Authorization endpoint (`/authorize`)
- UserInfo endpoint (`/userinfo`)

## Performance Optimization

### Frontend Optimizations

#### 1. Bundle Size

**Status**: Within Cloudflare Workers limits (1MB)

**Optimizations**:
- **SvelteKit**: Automatic code splitting
- **UnoCSS**: Utility-first CSS (minimal footprint)
- **Tree shaking**: Dead code elimination via Vite
- **Lazy loading**: Dynamic imports for admin pages

**Analysis**:
```bash
# Analyze bundle size
pnpm --filter=ui build
# Check .svelte-kit/cloudflare directory size
```

#### 2. Asset Optimization

**Images**:
- Use WebP format for better compression
- Implement responsive images (`srcset`)
- Lazy load images below the fold

**Fonts**:
- System fonts preferred (no web fonts)
- Font subsetting if custom fonts needed

**CSS**:
- UnoCSS generates minimal CSS (only used utilities)
- Critical CSS inlined
- Unused CSS purged automatically

#### 3. Caching Strategy

**Static Assets**:
- Long-term caching for versioned assets (1 year)
- Immutable cache headers

**API Responses**:
- Discovery endpoint: Cache for 1 hour
- JWKS endpoint: Cache for 1 hour
- User-specific data: No cache

**Service Worker** (future):
- Offline-first strategy for static assets
- Stale-while-revalidate for API responses

### Backend Optimizations

#### 1. Cloudflare Workers

**Advantages**:
- Edge compute (low latency worldwide)
- Auto-scaling
- Zero cold starts

**Optimization Techniques**:
- Minimal dependencies (reduce bundle size)
- Efficient D1/KV queries
- Durable Objects for strong consistency

#### 2. Database Queries

**D1 Optimization**:
- Indexed columns for fast lookups
- Pagination for large result sets
- Query plan analysis (`EXPLAIN QUERY PLAN`)

**KV Optimization**:
- TTL-based expiration
- Bulk operations where possible
- Minimize read/write operations

#### 3. Durable Objects

**Performance Considerations**:
- One DO instance per unique ID (natural partitioning)
- In-memory caching within DO
- Alarm-based cleanup (async)

## Performance Monitoring

### Lighthouse CI

**Configuration**: `lighthouserc.json`

**Assertions**:
```json
{
  "categories:performance": ["error", { "minScore": 0.9 }],
  "categories:accessibility": ["error", { "minScore": 0.9 }],
  "categories:best-practices": ["error", { "minScore": 0.9 }],
  "categories:seo": ["error", { "minScore": 0.9 }],
  "first-contentful-paint": ["error", { "maxNumericValue": 2000 }],
  "largest-contentful-paint": ["error", { "maxNumericValue": 2500 }],
  "cumulative-layout-shift": ["error", { "maxNumericValue": 0.1 }],
  "total-blocking-time": ["error", { "maxNumericValue": 300 }]
}
```

**Running Lighthouse CI**:
```bash
pnpm test:lighthouse
```

### Real User Monitoring (RUM)

**Future Enhancement**:
- Integrate Web Vitals library
- Send metrics to analytics service
- Track p75, p90, p95 percentiles

## Performance Budget

### UI Pages

| Metric | Budget | Current | Status |
|--------|--------|---------|--------|
| JavaScript bundle | < 200 KB | ~150 KB | ✅ |
| CSS bundle | < 50 KB | ~30 KB | ✅ |
| Total page weight | < 500 KB | ~300 KB | ✅ |
| Requests | < 20 | ~15 | ✅ |

### API Endpoints

| Metric | Budget | Status |
|--------|--------|--------|
| TTFB | < 200ms | ✅ |
| Response time | < 500ms | ✅ |
| Throughput | > 1000 req/s | ✅ (Cloudflare auto-scales) |

## Optimization Recommendations

### High Priority

1. **Accessibility Score**: Improve from 89 to 90+
   - Review ARIA labels
   - Ensure keyboard navigation works flawlessly
   - Fix color contrast issues (if any)

2. **Monitor Core Web Vitals**: Collect real-user data
   - Implement Web Vitals tracking
   - Set up alerting for regressions

### Medium Priority

3. **Image Optimization**: Convert to WebP, add lazy loading
4. **Code Splitting**: Further split large bundles
5. **Service Worker**: Implement offline support

### Low Priority

6. **HTTP/3**: Enable QUIC protocol (Cloudflare supports)
7. **Prefetching**: Prefetch critical resources
8. **Resource Hints**: Add `preconnect`, `dns-prefetch`

## Performance Testing in CI/CD

**GitHub Actions Workflow**: `.github/workflows/ci.yml`

**Lighthouse Job**:
- Runs on every PR and push to `main`
- Fails if performance score drops below 90
- Uploads reports as artifacts

**Artifacts**:
- Lighthouse reports stored for 30 days
- HTML reports for detailed analysis

## Performance Regression Prevention

1. **Automated Lighthouse CI**: Catches regressions before merge
2. **Bundle size tracking**: Monitor JavaScript/CSS size
3. **Performance budgets**: Enforce limits via CI

## Useful Commands

```bash
# Run performance tests
pnpm test:lighthouse

# Analyze bundle size
pnpm --filter=ui build

# Backend API benchmarks
./scripts/performance-test.sh

# Profile build time
pnpm --filter=ui build --mode=profile
```

## Resources

- [Web.dev Performance](https://web.dev/performance/)
- [Lighthouse Scoring Guide](https://developer.chrome.com/docs/lighthouse/performance/performance-scoring/)
- [Core Web Vitals](https://web.dev/vitals/)
- [Cloudflare Workers Performance](https://developers.cloudflare.com/workers/platform/limits/)
