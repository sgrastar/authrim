# Enrai Vision 🔥

**Enrai** is an enterprise-grade OpenID Connect Provider that deploys in minutes, not days.

---

## 🎯 The Problem

Setting up identity infrastructure is complex:
- Traditional IdPs require extensive server configuration
- Self-hosted solutions need maintenance and scaling
- Cloud IdPs lock you into their ecosystem
- Developer experience is often poor

**Result:** Teams spend weeks on authentication instead of building their product.

---

## 💡 Our Solution

Enrai provides a **lightweight, serverless OpenID Connect Provider** that:

1. **Deploys in one command** - No complex setup
2. **Runs on Cloudflare Workers** - Global edge network, zero cold starts
3. **OpenID Certified** - Standards-compliant, battle-tested
4. **Fully customizable** - Your brand, your rules
5. **Developer-friendly** - Great DX from start to finish

---

## 🚀 The Vision: One-Command Identity Infrastructure

```bash
npx create-enrai my-identity-provider
```

### The Experience

```
🔥 Enrai - OpenID Connect Provider Setup

We'll set up your identity provider in a few steps.

? Cloudflare Account ID: abc123def456
? Email for admin account: admin@example.com
? Password policy:
  ❯ Strong (12+ chars, mixed case, numbers, symbols)
    Medium (8+ chars, mixed case, numbers)
    Basic (8+ chars)

? User data storage:
  ❯ D1 (SQLite - Recommended for production)
    KV (Key-Value - Simple, fast)
    Durable Objects (Advanced use cases)

? Deploy region:
  ❯ Auto (Cloudflare's global network)
    Specify regions (Advanced)

? Enable features:
  ✓ Social login (Google, GitHub, etc.)
  ✓ Multi-factor authentication (MFA)
  ✓ Email verification
  ✓ Password reset

⚙️  Creating Cloudflare resources...
  ✓ Workers created
  ✓ KV namespaces provisioned
  ✓ D1 database initialized
  ✓ Durable Objects deployed
  ✓ DNS configured

🔐 Generating cryptographic keys...
  ✓ RSA-2048 key pair generated
  ✓ Keys stored securely

📧 Sending admin credentials...
  ✓ Email sent to admin@example.com

✅ Deployment complete!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎉 Your OpenID Provider is ready!

   Production URL:     https://id.example.com
   Admin Dashboard:    https://id.example.com/admin

   OpenID Discovery:   https://id.example.com/.well-known/openid-configuration
   JWKS Endpoint:      https://id.example.com/.well-known/jwks.json

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Next steps:
  1. Visit the admin dashboard and log in
  2. Customize your branding and email templates
  3. Register your first OAuth client
  4. Test the login flow

Documentation: https://enrai.org/docs
Support: https://github.com/enrai/enrai/issues
```

---

## 🎨 User Experience

### For End Users

**Login Experience:**
```
┌─────────────────────────────────────┐
│   🔥 Welcome to Acme Corp           │
│                                     │
│   Sign in to continue               │
│                                     │
│   Email:    [________________]      │
│   Password: [________________]      │
│                                     │
│   [ ] Remember me                   │
│                                     │
│   [    Sign In    ]                 │
│                                     │
│   Forgot password? • Sign up        │
│                                     │
│   ─── Or sign in with ───          │
│                                     │
│   [ Google ]  [ GitHub ]            │
└─────────────────────────────────────┘
```

**Consent Screen:**
```
┌─────────────────────────────────────┐
│   Acme App wants to access your    │
│   Acme Corp account                 │
│                                     │
│   This will allow Acme App to:     │
│                                     │
│   ✓ View your profile information  │
│   ✓ View your email address        │
│                                     │
│   [ ] Remember this choice          │
│                                     │
│   [ Cancel ]    [ Allow ]           │
└─────────────────────────────────────┘
```

### For Administrators

**Dashboard:**
```
┌─────────────────────────────────────────────────────┐
│  🔥 Enrai Admin                    admin@acme.com ▼│
├─────────────────────────────────────────────────────┤
│                                                     │
│  Overview                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────┐ │
│  │ Active Users │  │  Total Logins│  │ Clients  │ │
│  │    1,234     │  │    45,678    │  │    12    │ │
│  └──────────────┘  └──────────────┘  └──────────┘ │
│                                                     │
│  Recent Activity                                    │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  • user@example.com logged in           2 min ago  │
│  • New user registered                  5 min ago  │
│  • Password reset requested            12 min ago  │
│                                                     │
│  Quick Actions                                      │
│  [ + New User ]  [ + New Client ]  [ View Logs ]   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**User Management:**
```
┌─────────────────────────────────────────────────────┐
│  Users                                 [ + Add User ]│
│  ┌───────────────────────────────────────────────┐ │
│  │ Search: [_______________]  🔍                 │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  Name              Email              Status  MFA  │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│  John Doe         john@example.com    ● On   ✓    │
│  Jane Smith       jane@example.com    ● On   ✗    │
│  Bob Johnson      bob@example.com     ○ Off  ✗    │
│                                                     │
│  ← Prev    1 2 3 ... 10    Next →                  │
└─────────────────────────────────────────────────────┘
```

**Customization:**
```
┌─────────────────────────────────────────────────────┐
│  Branding & Customization                           │
│                                                     │
│  Logo                                               │
│  ┌─────────────┐                                   │
│  │   [Logo]    │  [ Upload New Logo ]              │
│  └─────────────┘                                   │
│                                                     │
│  Colors                                             │
│  Primary:   [#3B82F6] ▮                            │
│  Secondary: [#8B5CF6] ▮                            │
│  Background:[#FFFFFF] ▮                            │
│                                                     │
│  Email Templates                                    │
│  Welcome Email        [ Edit ]                      │
│  Password Reset       [ Edit ]                      │
│  Verification         [ Edit ]                      │
│                                                     │
│  [ Preview ]                     [ Save Changes ]   │
└─────────────────────────────────────────────────────┘
```

### For Developers

**Simple Integration:**

```javascript
// 1. Install client library
pnpm install @enrai/client

// 2. Configure
import { EnraiClient } from '@enrai/client';

const auth = new EnraiClient({
  issuer: 'https://id.example.com',
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  redirectUri: 'https://yourapp.com/callback'
});

// 3. Start login flow
app.get('/login', (req, res) => {
  const authUrl = auth.getAuthorizationUrl({
    scope: 'openid profile email',
    state: generateState()
  });
  res.redirect(authUrl);
});

// 4. Handle callback
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  const tokens = await auth.exchangeCode(code);
  const user = await auth.getUserInfo(tokens.accessToken);

  // User is authenticated!
  req.session.user = user;
  res.redirect('/dashboard');
});
```

---

## 🏗️ Architecture

### Serverless-First Design

```
                     Cloudflare Global Network
                    ┌─────────────────────────┐
                    │   Edge Locations        │
┌─────────┐         │  (290+ cities)          │         ┌─────────┐
│ User    │────────▶│                         │────────▶│ Your    │
│ Browser │         │  ┌──────────────────┐  │         │ App     │
└─────────┘         │  │ Enrai Workers   │  │         └─────────┘
                    │  │ - Auth endpoints │  │
                    │  │ - Token issuance │  │
                    │  │ - User validation│  │
                    │  └──────────────────┘  │
                    │         ↓               │
                    │  ┌──────────────────┐  │
                    │  │ Storage Layer    │  │
                    │  │ - D1 (SQLite)    │  │
                    │  │ - KV (Cache)     │  │
                    │  │ - Durable Objects│  │
                    │  └──────────────────┘  │
                    └─────────────────────────┘
```

**Key Benefits:**
- **Global distribution** - <50ms latency worldwide
- **Zero cold starts** - Instant response times
- **Infinite scale** - Handles traffic spikes automatically
- **Cost-effective** - Pay only for what you use
- **High availability** - 99.99% uptime SLA

---

## 📦 Feature Roadmap

### ✅ Phase 1-2: Foundation + Core API (Complete)
- OpenID Connect Core 1.0 implementation
- Authorization Code Flow with PKCE
- Discovery & JWKS endpoints
- ID Token & Access Token generation
- UserInfo endpoint
- Comprehensive test suite (158 tests)

### ⏳ Phase 3: Conformance Testing (Mar 2026)
- OpenID Foundation Conformance Suite
- Security & compliance validation
- Performance benchmarking

### ⏳ Phase 4: Extensions (Apr 2026)
- Dynamic Client Registration
- Key rotation
- Extended claims support
- Rate limiting

### ⏳ Phase 5: Certification (May 2026)
- Official OpenID Certification
- Production deployment
- Documentation finalization

### 🆕 Phase 6: UI/UX (Jun 2026)
- Login screen
- User registration
- Consent screen
- Admin dashboard
- User management interface
- Client management interface
- Branding customization
- Email template editor

### 🆕 Phase 7: CLI & Automation (Aug 2026)
- `create-enrai` CLI tool
- One-command deployment
- Interactive setup wizard
- Cloudflare integration
- Database migrations
- Backup/restore utilities

### 🔮 Future Phases
- Social login providers (Google, GitHub, etc.)
- SAML bridge
- WebAuthn/Passkeys support
- Advanced analytics
- Audit logs & compliance reporting
- Mobile SDKs (iOS, Android)
- Terraform provider

---

## 🎯 Success Metrics

### Developer Experience
- ⏱️ **<5 minutes** from `npx create-enrai` to working IdP
- 📚 **<30 minutes** to integrate first application
- 🎨 **<1 hour** to fully customize branding

### Performance
- ⚡ **<50ms** p95 latency globally
- 🚀 **0ms** cold start time
- 📈 **Unlimited** concurrent users

### Reliability
- ✅ **99.99%** uptime SLA
- 🔒 **SOC 2** compliance ready
- 🛡️ **OpenID Certified**

### Cost
- 💰 **Free tier** for <1,000 active users/month
- 📊 **$0.50/1,000** requests after free tier
- 🎁 **No hidden fees**

---

## 🌟 Competitive Advantages

| Feature | Enrai | Auth0 | Keycloak | Cognito |
|---------|--------|-------|----------|---------|
| **Setup Time** | 5 min | 30 min | 2+ hours | 1+ hour |
| **Cold Starts** | 0ms | N/A | N/A | 100-500ms |
| **Global Edge** | ✅ | ✅ | ❌ | ❌ |
| **Self-Hosted** | ✅ | ❌ | ✅ | ❌ |
| **OpenID Certified** | ✅ | ✅ | ✅ | ✅ |
| **Custom UI** | ✅ Full | ⚠️ Limited | ✅ Full | ⚠️ Limited |
| **Free Tier** | 1K users | 7K users | Unlimited | 50K users |
| **Vendor Lock-in** | ❌ | ✅ | ❌ | ✅ |
| **Infrastructure** | Serverless | Managed | Self-host | Managed |

---

## 🔐 Security First

### Built-in Security Features
- ✅ PKCE enforcement for public clients
- ✅ JWT signature verification (RS256)
- ✅ Token expiration & rotation
- ✅ HTTPS-only in production
- ✅ CSRF protection
- ✅ Rate limiting
- ✅ Replay attack prevention
- ✅ SQL injection protection
- ✅ XSS prevention

### Compliance
- 📋 OpenID Connect Core 1.0
- 📋 OAuth 2.0 (RFC 6749)
- 📋 PKCE (RFC 7636)
- 📋 JWT (RFC 7519)
- 📋 GDPR ready
- 📋 SOC 2 Type II (roadmap)

---

## 🤝 Open Source Philosophy

Enrai is **open source** (Apache License 2.0):
- ✅ Full source code available
- ✅ Community-driven development
- ✅ No vendor lock-in
- ✅ Self-hostable
- ✅ Commercial use allowed

**We believe identity infrastructure should be:**
- Transparent
- Auditable
- Extensible
- Owned by you

---

## 📚 Documentation Strategy

### For Users
- Quick Start Guide (5 min setup)
- Integration tutorials (Next.js, React, Vue, etc.)
- Video walkthroughs
- FAQ & troubleshooting

### For Developers
- API reference (OpenAPI spec)
- SDK documentation
- Architecture deep-dives
- Contributing guide

### For Admins
- Deployment guide
- Configuration reference
- Security best practices
- Monitoring & observability

---

## 🎓 Learning from the Best

**Inspired by:**
- **Stripe** - Developer experience
- **Vercel** - Deployment simplicity
- **Supabase** - Open source approach
- **Clerk** - Modern auth UX
- **Keycloak** - Enterprise features

**But better:**
- Serverless-first (no infrastructure to manage)
- Global edge deployment (faster anywhere)
- One-command setup (truly instant)
- Fully customizable (your brand, your way)

---

## 🚀 Get Started

```bash
# Install Enrai
npx create-enrai my-identity-provider

# Or clone and deploy manually
git clone https://github.com/sgrastar/enrai.git
cd enrai
pnpm install
pnpm run deploy
```

---

## 💬 Community

- 💼 **GitHub**: https://github.com/sgrastar/enrai
- 💬 **Discord**: https://discord.gg/enrai
- 🐦 **Twitter**: @enrai_dev
- 📧 **Email**: hello@enrai.org

---

## 📄 License

Apache License 2.0 - Use it however you want!

---

> **Enrai** 🔥 — Identity infrastructure that sparks joy.
>
> *From zero to production-ready OpenID Provider in under 5 minutes.*
