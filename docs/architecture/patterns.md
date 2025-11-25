# Authrim Deployment Architecture Patterns

This document describes the flexible deployment architectures supported by Authrim, ranging from simple single-domain setups to advanced multi-domain SSO configurations.

## Table of Contents

- [Overview](#overview)
- [Pattern A: Unified Domain (Default)](#pattern-a-unified-domain-default)
- [Pattern B: Hybrid with Separate Admin](#pattern-b-hybrid-with-separate-admin)
- [Pattern C: Multi-Domain SSO](#pattern-c-multi-domain-sso)
- [Pattern D: Headless](#pattern-d-headless)
- [Implementation Roadmap](#implementation-roadmap)
- [Technical Considerations](#technical-considerations)
- [Migration Guide](#migration-guide)

---

## Overview

Authrim supports **4 deployment patterns** to accommodate different use cases, from simple MVPs to enterprise-grade multi-domain SSO systems.

### Pattern Comparison

| Feature | Pattern A | Pattern B | Pattern C | Pattern D |
|---------|-----------|-----------|-----------|-----------|
| **Cookie Sharing** | ✅ Same-origin* | ✅ OIDC same-origin | ⚠️ Cross-origin | N/A |
| **CORS Required** | ⚠️ Dev only | ⚠️ Admin only | ✅ Yes | ✅ Yes |
| **Admin Security** | ⚠️ Basic | ✅ IP restriction | ✅ IP restriction | CLI/API only |
| **Multi-Domain SSO** | ❌ No | ❌ No | ✅ Yes | N/A |
| **Custom Domain Required** | ⚠️ Production only | ⚠️ Recommended | ⚠️ Recommended | ❌ No |
| **Complexity** | ⭐ Low | ⭐⭐ Medium | ⭐⭐⭐⭐ High | ⭐⭐ Medium |
| **Implementation** | ✅ Phase 1 | 🔄 Phase 2 | 🔄 Phase 3 | ✅ Phase 1 (partial) |

> **Note:** Pattern A with custom domain provides true same-origin cookie sharing. For development using `*.workers.dev` and `*.pages.dev`, the API and UI will be on separate domains, requiring CORS configuration (similar to Pattern B).

---

## Pattern A: Unified Domain (Default)

**Best for:** MVPs, startups, simple deployments, self-hosted instances

### Architecture

All components (OIDC endpoints, APIs, UI) are served from a single domain.

#### Custom Domain Deployment (Production)
```
https://id.example.com/
├── /.well-known/*                # OIDC Discovery & JWKS (Worker)
├── /authorize, /token            # OIDC Endpoints (Worker)
├── /api/auth/*                   # Authentication APIs (Worker)
├── /api/admin/*                  # Admin APIs (Worker)
├── /api/sessions/*               # Session Management (Worker)
├── /login                        # Login UI (Cloudflare Pages)
└── /admin                        # Admin UI (Cloudflare Pages)
```

**How it works:**
- Custom domain routes API requests to Workers
- Same domain serves static UI via Cloudflare Pages
- Unified domain enables same-origin cookies and no CORS

**Setup:**
1. Add custom domain to both Workers and Pages
2. Configure DNS (see [DEPLOYMENT.md](./DEPLOYMENT.md))
3. Route API paths (`/api/*`, `/.well-known/*`) to Workers
4. Route UI paths (`/login`, `/admin`) to Pages

#### Workers.dev Deployment (Development Only)

⚠️ **Note:** When using `*.workers.dev` and `*.pages.dev`, the API and UI will be on **separate domains**. This is acceptable for development/testing but requires CORS configuration.

```
# Development setup (separate domains)

https://authrim-router.your-account.workers.dev/  # API (Worker)
├── /.well-known/*
├── /authorize, /token
└── /api/*

https://authrim-ui.pages.dev/                     # UI (Pages)
├── /login
└── /admin
```

**Limitations:**
- API and UI are on **different domains** (`*.workers.dev` ≠ `*.pages.dev`)
- Requires CORS configuration (see Pattern B)
- Cookies cannot be shared between Worker and Pages
- Not a true "unified domain" deployment

**For development:**
- This setup works fine for testing
- Configure CORS to allow `*.pages.dev` to access `*.workers.dev`
- See Pattern B configuration for CORS settings

**For production:**
- Use a custom domain (see above)
- Or use Pattern B/C with proper CORS setup

### Benefits

#### ✅ Simplicity
- Single domain to manage
- No CORS configuration needed
- Straightforward DNS setup

#### ✅ Cookie Management
- Same-origin cookies work seamlessly
- No ITP (Intelligent Tracking Prevention) issues
- Session sharing between OIDC and Admin UI

#### ✅ Development Experience
- Easy local development setup
- Simple testing workflow
- Minimal configuration

#### ✅ SEO & Performance
- Single SSL certificate
- Simpler CSP (Content Security Policy)
- Reduced latency (single origin)

### Security Considerations

⚠️ **Admin UI Security:**
- Admin URL is predictable (`/admin`)
- **Mitigations:**
  - Implement robust authentication
  - Consider custom admin path (e.g., `/my-secret-admin-panel`)
  - Use Cloudflare Access for additional protection
  - Implement IP allowlisting via Cloudflare Firewall Rules

### Configuration

#### Development Setup (workers.dev + pages.dev)

For development/testing using separate domains:

```bash
# Worker environment (.dev.vars)
ISSUER_URL=https://authrim-router.your-account.workers.dev
ADMIN_UI_ORIGIN=https://authrim-ui.pages.dev,http://localhost:5173

# Pages environment
PUBLIC_API_BASE_URL=https://authrim-router.your-account.workers.dev
```

**Enable CORS in Worker:**
```typescript
// Required because API and UI are on different domains
app.use('*', cors({
  origin: ['https://authrim-ui.pages.dev', 'http://localhost:5173'],
  credentials: true,
}));
```

#### Production Setup (Custom Domain)

For production using a unified domain:

```bash
# Worker environment (.dev.vars or wrangler.toml)
ISSUER_URL=https://id.example.com
PUBLIC_API_BASE_URL=https://id.example.com

# Pages environment
PUBLIC_API_BASE_URL=https://id.example.com
```

**Custom Domain Setup:**
```bash
# 1. Deploy Worker with custom domain
cd packages/router
wrangler deploy
wrangler domains add id.example.com

# 2. Deploy Pages with custom domain
wrangler pages deploy packages/ui/.svelte-kit/cloudflare --project-name=authrim-ui
wrangler pages domain add id.example.com --project-name=authrim-ui

# 3. Configure routing (Cloudflare Dashboard)
# Dashboard → Websites → id.example.com → Rules → Page Rules
# Route /api/* and /.well-known/* to Worker
# Route /login and /admin to Pages
```

**Prerequisites:**
- ✅ A custom domain (e.g., `id.example.com`)
- ✅ Domain managed by Cloudflare (for DNS routing)
- ✅ SSL certificate (automatically provided by Cloudflare)

---

## Pattern B: Hybrid with Separate Admin

**Best for:** Small to medium enterprises, SaaS products, security-conscious deployments

### Architecture

OIDC and APIs remain on the same domain, but Admin UI is separated for enhanced security.

#### Workers.dev Deployment
```
https://authrim.your-account.workers.dev/   # OIDC + APIs + Login UI
├── /.well-known/*
├── /authorize, /token
├── /api/auth/*
├── /api/admin/*                          # Admin API (still same domain)
└── /login

https://authrim-admin.pages.dev/            # Admin UI (separate)
└── /admin
```

#### Custom Domain Deployment
```
https://id.example.com/                   # OIDC + APIs + Login UI
├── /.well-known/*
├── /authorize, /token
├── /api/auth/*
├── /api/admin/*
└── /login

https://admin.example.com/                # Admin UI (separate custom domain)
└── /admin
```

### Benefits

#### ✅ Enhanced Security
- Admin UI on separate domain
- Easy to implement IP restrictions (Cloudflare Access)
- Admin URL less predictable
- Can use different authentication mechanisms

#### ✅ Cookie Benefits Retained
- OIDC and Login UI still share cookies (same-origin)
- Seamless SSO experience for end-users
- No ITP issues for authentication flow

#### ✅ Flexible Access Control
- Admin UI protected by Cloudflare Access (email OTP, SSO, etc.)
- Different rate limits for admin vs public APIs
- Separate monitoring and logging

### CORS Configuration

Admin UI needs to call APIs on a different domain, requiring CORS setup.

#### Dynamic CORS via KV Storage

```typescript
// Store in KV: CORS_SETTINGS
{
  "admin_origins": [
    "https://authrim-admin.pages.dev",
    "https://admin.example.com",
    "http://localhost:5173"  // Development
  ]
}

// Worker Code
const corsSettings = await env.SETTINGS_KV.get('cors_settings', 'json');
const allowedOrigins = corsSettings?.admin_origins || ['*'];

app.use('*', cors({
  origin: (origin) => {
    if (allowedOrigins.includes('*')) return '*';
    return allowedOrigins.includes(origin) ? origin : false;
  },
  credentials: true,
}));
```

#### Environment Variable Approach

```bash
# wrangler.toml or wrangler secret
ADMIN_UI_ORIGIN=https://authrim-admin.pages.dev,https://admin.example.com,http://localhost:5173
```

```typescript
// Worker Code
const ADMIN_ORIGINS = env.ADMIN_UI_ORIGIN?.split(',') || ['*'];
```

### Configuration

#### Admin UI Deployment (Cloudflare Pages)
```bash
# Deploy Admin UI separately
wrangler pages deploy packages/ui --project-name=authrim-admin

# Set API base URL
PUBLIC_API_BASE_URL=https://authrim.your-account.workers.dev

# Optional: Add custom domain
wrangler pages domain add admin.example.com --project-name=authrim-admin
```

#### Cloudflare Access Setup
```bash
# Protect Admin UI with Cloudflare Access
# Dashboard: Zero Trust > Access > Applications > Add Application
Name: Authrim Admin
Domain: authrim-admin.pages.dev or admin.example.com
Policy: Require email from @example.com
```

---

## Pattern C: Multi-Domain SSO

**Best for:** Enterprise customers, white-label solutions, multi-tenant SaaS, high branding requirements

### Architecture

Complete separation of OIDC, APIs, Login UI, and Admin UI across different domains, enabling **multi-domain SSO**.

#### Workers.dev Deployment
```
https://authrim.your-account.workers.dev/   # OIDC + APIs
├── /.well-known/*
├── /authorize, /token
├── /api/auth/*
└── /api/admin/*

https://authrim-login.pages.dev/            # Login UI (branded)
└── /login, /consent

https://authrim-admin.pages.dev/            # Admin UI
└── /admin
```

#### Custom Domain (Multi-Tenant Example)
```
https://api.example.com/                  # Central OIDC + APIs
├── /.well-known/*
├── /authorize, /token
└── /api/*

https://service1.com/login                # Tenant 1 Login UI
https://service2.net/login                # Tenant 2 Login UI
https://admin.example.com/                # Central Admin UI
```

### Benefits

#### ✅ High Branding Flexibility
- Each service can have its own branded login page
- Custom domains for each tenant
- White-label solutions

#### ✅ Multi-Domain SSO
- User logs in on `service1.com`
- Automatically logged in on `service2.com` (via token exchange)
- Seamless cross-domain authentication

#### ✅ Security Isolation
- Admin UI completely isolated
- Login UI can be customized per tenant
- Fine-grained CORS control

#### ✅ Independent Scaling
- Login UI can be deployed to edge locations
- Admin UI can be restricted to specific regions
- OIDC APIs scale independently

### Challenges

#### ⚠️ Cookie Sharing Complexity
- Cookies are domain-specific
- Requires **Session Token API** or **Token Exchange**

#### ⚠️ CORS Configuration
- Must configure CORS for all domains
- Dynamic origin validation required

#### ⚠️ Increased Complexity
- More moving parts to manage
- Complex deployment workflow
- Requires careful monitoring

### Multi-Domain SSO Implementation

#### Option 1: Session Token API

```typescript
// User logs in on service1.com
POST https://api.example.com/api/sessions/issue
{
  "user_id": "user_123",
  "client_id": "service1"
}
Response: { "session_token": "sess_abc123..." }

// service1.com stores session_token in localStorage

// User navigates to service2.com
// service2.com checks for existing session
POST https://api.example.com/api/sessions/verify
{
  "session_token": "sess_abc123...",
  "client_id": "service2"
}
Response: {
  "valid": true,
  "user": { "sub": "user_123", ... }
}
```

#### Option 2: Token Exchange (RFC 8693)

```http
POST https://api.example.com/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=sess_abc123...
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&audience=service2.com
&scope=openid profile email
```

Response:
```json
{
  "access_token": "new_token_for_service2",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "openid profile email"
}
```

#### Option 3: Silent Authentication (`prompt=none`)

```http
# service2.com redirects to OIDC authorize endpoint
GET https://api.example.com/authorize?
  client_id=service2
  &redirect_uri=https://service2.com/callback
  &response_type=code
  &scope=openid profile email
  &state=xyz
  &code_challenge=abc
  &prompt=none                   # Skip login screen if already authenticated
```

If user is already authenticated (has valid session in OIDC provider):
- Immediately redirect back with authorization code
- No login UI shown

### CORS Configuration for Pattern C

```typescript
// Dynamic CORS from KV
const corsSettings = await env.SETTINGS_KV.get('cors_settings', 'json');

app.use('*', cors({
  origin: (origin) => {
    const allowedOrigins = corsSettings?.allowed_origins || [];
    if (allowedOrigins.includes('*')) return '*';

    // Support wildcard subdomains
    const allowedPatterns = corsSettings?.allowed_patterns || [];
    for (const pattern of allowedPatterns) {
      if (new RegExp(pattern).test(origin)) return origin;
    }

    return allowedOrigins.includes(origin) ? origin : false;
  },
  credentials: true,
}));
```

KV Storage:
```json
{
  "allowed_origins": [
    "https://service1.com",
    "https://service2.net",
    "https://admin.example.com",
    "http://localhost:5173"
  ],
  "allowed_patterns": [
    "^https://.*\\.service1\\.com$",
    "^https://.*\\.pages\\.dev$"
  ]
}
```

### Configuration

#### Environment Variables
```bash
# Central OIDC/API
ISSUER_URL=https://api.example.com

# Admin UI
PUBLIC_API_BASE_URL=https://api.example.com
PUBLIC_OIDC_BASE_URL=https://api.example.com

# Login UI (service1.com)
PUBLIC_API_BASE_URL=https://api.example.com
PUBLIC_OIDC_BASE_URL=https://api.example.com
PUBLIC_REDIRECT_URI=https://service1.com/callback
```

---

## Pattern D: Headless

**Best for:** Native mobile apps, desktop applications, API-only integrations, existing systems

### Architecture

No Login UI or Admin UI provided by Authrim. All operations are performed via API or CLI.

```
https://authrim.your-account.workers.dev/   # OIDC + APIs only
├── /.well-known/*
├── /authorize                            # Used by native apps (custom scheme)
├── /token
├── /api/auth/*
└── /api/admin/*

No Login UI  ❌
No Admin UI  ❌
```

### Use Cases

#### ✅ Native Mobile Apps
- Use native authentication UI
- Call `/api/auth/passkey/*` from native code
- Handle OAuth flow with custom URL schemes

#### ✅ Desktop Applications
- Electron, Tauri apps
- Embedded browser for OAuth flow
- Local server for redirect URI

#### ✅ M2M (Machine-to-Machine)
- `grant_type=client_credentials`
- Backend services authenticating directly

#### ✅ Existing Systems Integration
- Keep existing login UI
- Use Authrim as backend identity provider
- API-driven user management

### Limitations

The following features require a UI and are **not available** in headless mode:

- ❌ **Interactive Consent Screen** - `/api/auth/consent` UI
- ❌ **Magic Link Verification Page** - Requires landing page
- ❌ **Admin Dashboard** - Visual user/client management

### Workarounds

#### Admin Operations via CLI
```bash
# Install Authrim CLI (future)
npm install -g @authrim/cli

# Configure
authrim config set api-url https://authrim.your-account.workers.dev
authrim config set admin-token <your-admin-token>

# User management
authrim users list
authrim users create --email user@example.com --name "John Doe"
authrim users delete user_123

# Client management
authrim clients register --name "My App" --redirect-uri https://myapp.com/callback
authrim clients list
```

#### Admin Operations via API
```bash
# Create user
curl -X POST https://authrim.your-account.workers.dev/api/admin/users \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","name":"John Doe"}'

# List users
curl https://authrim.your-account.workers.dev/api/admin/users \
  -H "Authorization: Bearer <admin_token>"
```

### Configuration

```bash
# Disable UI deployment
# Simply don't deploy Cloudflare Pages project

# API-only deployment
pnpm --filter=router deploy
pnpm --filter=op-* deploy
```

---

## Implementation Roadmap

### Phase 1: Foundation (✅ Current)

**Goal:** Establish Pattern A (Unified Domain) as the default and enable Pattern D (Headless) basics.

**Deliverables:**
- [x] OIDC Workers implementation
- [x] Custom API endpoints (`/api/*`)
- [x] Login UI (Cloudflare Pages)
- [x] Admin UI (Cloudflare Pages)
- [x] Pattern A documentation
- [x] API naming conventions
- [ ] Pattern D documentation (API reference)

**Timeline:** Completed

---

### Phase 2: Hybrid Architecture (🔄 Next)

**Goal:** Support Pattern B (Hybrid with Separate Admin) for enhanced security.

**Deliverables:**
- [ ] CORS configuration via KV (dynamic)
- [ ] Admin UI separate deployment guide
- [ ] Cloudflare Access integration guide
- [ ] Admin CORS settings management UI
- [ ] Environment variable templates for Pattern B

**Technical Tasks:**
1. Implement dynamic CORS loading from KV
2. Create admin UI for managing CORS settings
3. Update deployment scripts to support separate Admin UI
4. Document Cloudflare Access setup

**Timeline:** 2-3 weeks

---

### Phase 3: Multi-Domain SSO (🔄 Future)

**Goal:** Enable Pattern C (Multi-Domain SSO) for enterprise customers.

**Deliverables:**
- [ ] Session Token API (`/api/sessions/issue`, `/api/sessions/verify`)
- [ ] Token Exchange (RFC 8693) implementation
- [ ] `prompt=none` support for silent authentication
- [ ] Multi-domain cookie strategy documentation
- [ ] CORS wildcard pattern support
- [ ] Multi-tenant configuration guide

**Technical Tasks:**
1. Implement Session Token API
2. Implement Token Exchange endpoint
3. Add `prompt=none` support to `/authorize`
4. Create SessionStore Durable Object enhancements for cross-domain sessions
5. Build CORS pattern matching system
6. Create multi-domain SSO example apps

**Timeline:** 4-6 weeks

---

### Phase 4: Headless & Developer Experience (🔄 Future)

**Goal:** Improve Pattern D (Headless) experience with CLI and SDKs.

**Deliverables:**
- [ ] Authrim CLI (`@authrim/cli`)
  - User management commands
  - Client management commands
  - Token inspection commands
- [ ] SDK Libraries
  - TypeScript/JavaScript SDK
  - Python SDK (optional)
  - Go SDK (optional)
- [ ] Native App Integration Guide
  - iOS (Swift) example
  - Android (Kotlin) example
  - React Native example
- [ ] Desktop App Integration Guide
  - Electron example
  - Tauri example

**Timeline:** 6-8 weeks

---

## Technical Considerations

### Cookie Strategy Comparison

| Pattern | Cookie Domain | Session Sharing | ITP Issues |
|---------|--------------|-----------------|------------|
| **A** | `id.example.com` | ✅ All components | ❌ None |
| **B** | `id.example.com` | ✅ OIDC + Login UI | ❌ None |
| **C** | Varies per domain | ⚠️ Requires Session API | ⚠️ Cross-domain |
| **D** | N/A | N/A | N/A |

### CORS Complexity Comparison

| Pattern | CORS Config | Maintenance |
|---------|-------------|-------------|
| **A** | ❌ Not needed | ⭐ Low |
| **B** | ⚠️ Admin UI only | ⭐⭐ Medium |
| **C** | ✅ Required for all | ⭐⭐⭐⭐ High |
| **D** | ✅ Required | ⭐⭐⭐ Medium-High |

### Performance Considerations

#### Pattern A: Fastest
- Single origin, minimal latency
- No CORS preflight requests
- Optimal for most use cases

#### Pattern B: Balanced
- CORS preflight for Admin API calls
- Login flow remains fast (same-origin)
- Good balance of security and performance

#### Pattern C: Complex but Scalable
- Multiple CORS preflight requests
- Token exchange adds latency
- Best for globally distributed systems

#### Pattern D: API Latency Only
- No UI rendering overhead
- Optimal for M2M communication
- Best for high-throughput scenarios

---

## Migration Guide

### From Pattern A to Pattern B

1. **Deploy Admin UI separately:**
   ```bash
   wrangler pages deploy packages/ui --project-name=authrim-admin
   ```

2. **Configure CORS:**
   ```bash
   # Add to KV: CORS_SETTINGS
   wrangler kv:key put --binding=SETTINGS_KV "cors_settings" \
     '{"admin_origins":["https://authrim-admin.pages.dev"]}'
   ```

3. **Update Admin UI environment variable:**
   ```bash
   wrangler pages secret put PUBLIC_API_BASE_URL \
     --project-name=authrim-admin
   # Enter: https://authrim.your-account.workers.dev
   ```

4. **Optional: Add Cloudflare Access protection**

---

### From Pattern B to Pattern C

1. **Deploy separate Login UI:**
   ```bash
   wrangler pages deploy packages/ui --project-name=service1-login
   ```

2. **Implement Session Token API** (Phase 3 feature)

3. **Configure CORS for all domains:**
   ```json
   {
     "allowed_origins": [
       "https://service1.com",
       "https://service2.net",
       "https://authrim-admin.pages.dev"
     ]
   }
   ```

4. **Update each service's environment variables:**
   ```bash
   PUBLIC_API_BASE_URL=https://api.example.com
   PUBLIC_OIDC_BASE_URL=https://api.example.com
   ```

---

## Summary

Authrim's flexible architecture supports various deployment patterns:

- **Pattern A (Unified):** Best for most use cases - simple, fast, no CORS
- **Pattern B (Hybrid):** Enhanced security with separate Admin UI
- **Pattern C (Multi-Domain SSO):** Enterprise-grade, white-label capable
- **Pattern D (Headless):** API-first, native app integration

Choose the pattern that best fits your requirements, and migrate as your needs evolve.

---

**Last Updated:** 2025-01-15
**Version:** 1.0.0
