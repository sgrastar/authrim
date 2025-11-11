# Deployment Guide

This guide walks you through deploying Hibana to Cloudflare Workers, resulting in a production-ready OpenID Connect Provider accessible via a public URL.

## 📋 Table of Contents

- [Prerequisites](#prerequisites)
- [Deployment Overview](#deployment-overview)
- [Step-by-Step Deployment](#step-by-step-deployment)
- [Production Configuration](#production-configuration)
- [GitHub Actions CI/CD](#github-actions-cicd)
- [Post-Deployment](#post-deployment)
- [Custom Domain Setup](#custom-domain-setup)
- [Security Considerations](#security-considerations)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before deploying Hibana, ensure you have:

1. **Cloudflare Account** (free tier works)
   - Sign up at [cloudflare.com](https://dash.cloudflare.com/sign-up)

2. **Wrangler CLI** installed globally
   ```bash
   npm install -g wrangler
   ```

3. **Cloudflare API Token**
   - Go to [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
   - Create token with "Edit Cloudflare Workers" template
   - Save the token securely

4. **Node.js 18+** and npm installed

---

## Deployment Overview

When you deploy Hibana, you'll get:

### 🌍 Public URL
Your OpenID Provider will be accessible at:
```
https://hibana.{your-subdomain}.workers.dev
```

Or with a custom domain:
```
https://id.yourdomain.com
```

### ✅ Live OpenID Connect Endpoints

| Endpoint | URL | Description |
|----------|-----|-------------|
| **Discovery** | `/.well-known/openid-configuration` | OpenID Provider metadata |
| **JWKS** | `/.well-known/jwks.json` | Public keys for token verification |
| **Authorization** | `/authorize` | OAuth 2.0 authorization endpoint |
| **Token** | `/token` | Token exchange endpoint |
| **UserInfo** | `/userinfo` | User claims endpoint |

### 🚀 Global Edge Deployment
- Deployed to 300+ Cloudflare data centers worldwide
- <50ms latency for most users globally
- 0ms cold starts
- Automatic HTTPS

---

## Step-by-Step Deployment

### 1. Clone and Install

```bash
# Clone the repository
git clone https://github.com/sgrastar/hibana.git
cd hibana

# Install dependencies
npm install
```

### 2. Authenticate with Cloudflare

```bash
# Login to Cloudflare
wrangler login
```

This will open a browser window for authentication.

### 3. Create KV Namespaces

Create the required KV namespaces for storing authorization codes, state, and nonces:

```bash
# Create production KV namespaces
wrangler kv:namespace create "AUTH_CODES"
wrangler kv:namespace create "STATE_STORE"
wrangler kv:namespace create "NONCE_STORE"
wrangler kv:namespace create "CLIENTS"

# Create preview KV namespaces (for development)
wrangler kv:namespace create "AUTH_CODES" --preview
wrangler kv:namespace create "STATE_STORE" --preview
wrangler kv:namespace create "NONCE_STORE" --preview
wrangler kv:namespace create "CLIENTS" --preview
```

Each command will output an ID. Save these IDs - you'll need them in the next step.

### 4. Update wrangler.toml

Update `wrangler.toml` with the KV namespace IDs from step 3:

```toml
# KV Namespaces for state, nonce, and authorization code storage
[[kv_namespaces]]
binding = "AUTH_CODES"
id = "YOUR_AUTH_CODES_ID"
preview_id = "YOUR_AUTH_CODES_PREVIEW_ID"

[[kv_namespaces]]
binding = "STATE_STORE"
id = "YOUR_STATE_STORE_ID"
preview_id = "YOUR_STATE_STORE_PREVIEW_ID"

[[kv_namespaces]]
binding = "NONCE_STORE"
id = "YOUR_NONCE_STORE_ID"
preview_id = "YOUR_NONCE_STORE_PREVIEW_ID"

[[kv_namespaces]]
binding = "CLIENTS"
id = "YOUR_CLIENTS_ID"
preview_id = "YOUR_CLIENTS_PREVIEW_ID"
```

Also update the production issuer URL:

```toml
[env.production]
name = "hibana-prod"
vars = { ISSUER_URL = "https://hibana.YOUR_SUBDOMAIN.workers.dev" }
```

Replace `YOUR_SUBDOMAIN` with your Cloudflare Workers subdomain.

### 5. Generate RSA Keys

Generate cryptographic keys for signing JWT tokens:

```bash
# Run the setup script
./scripts/setup-dev.sh
```

This creates:
- `.keys/private.pem` - Private key for signing tokens
- `.keys/public.jwk.json` - Public key in JWK format
- `.keys/metadata.json` - Key metadata (kid, algorithm)

### 6. Set Production Secrets

Upload your private and public keys as Cloudflare secrets:

```bash
# Upload private key
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM --env production

# Upload public JWK (as compact JSON)
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON --env production
```

**⚠️ IMPORTANT:** Never commit these keys to version control!

### 7. Build the Project

```bash
npm run build
```

### 8. Deploy to Cloudflare Workers

```bash
# Deploy to production
npm run deploy

# Or use wrangler directly
wrangler deploy --env production
```

### 9. Verify Deployment

After deployment, Wrangler will output your Worker's URL. Test the deployment:

```bash
# Replace with your actual Worker URL
WORKER_URL="https://hibana.YOUR_SUBDOMAIN.workers.dev"

# Test discovery endpoint
curl "$WORKER_URL/.well-known/openid-configuration" | jq

# Test JWKS endpoint
curl "$WORKER_URL/.well-known/jwks.json" | jq
```

**Expected results:**
- Discovery returns OpenID configuration JSON
- JWKS returns public keys array with RS256 keys
- Both endpoints return HTTP 200

---

## Production Configuration

### Environment Variables

Configure these in `wrangler.toml`:

```toml
[vars]
ISSUER_URL = "https://your-domain.com"  # Your OP's public URL
TOKEN_EXPIRY = "3600"                    # Access token lifetime (seconds)
CODE_EXPIRY = "120"                      # Authorization code lifetime (seconds)
STATE_EXPIRY = "300"                     # State parameter lifetime (seconds)
NONCE_EXPIRY = "300"                     # Nonce parameter lifetime (seconds)
KEY_ID = "prod-key-TIMESTAMP"            # Key identifier
```

### Secrets (via Wrangler)

These should NEVER be in `wrangler.toml`:

```bash
# Private key for JWT signing
wrangler secret put PRIVATE_KEY_PEM --env production

# Public JWK for token verification
wrangler secret put PUBLIC_JWK_JSON --env production
```

---

## GitHub Actions CI/CD

Hibana includes pre-configured GitHub Actions workflows for automated testing and deployment.

### Setup GitHub Secrets

Add these secrets to your GitHub repository:
- Go to **Settings** → **Secrets and variables** → **Actions**
- Add new repository secrets:

| Secret Name | Value | Where to Get It |
|-------------|-------|-----------------|
| `CLOUDFLARE_API_TOKEN` | Your API token | [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens) |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID | [Cloudflare Dashboard](https://dash.cloudflare.com/) (right sidebar) |

### Workflows

#### 1. CI Workflow (`.github/workflows/ci.yml`)

**Triggers:** Push to `main` or `claude/**` branches, pull requests

**Actions:**
- Runs linter
- Performs type checking
- Executes test suite
- Builds project
- Checks code formatting

#### 2. Deploy Workflow (`.github/workflows/deploy.yml`)

**Triggers:** Push to `main` branch only

**Actions:**
- Runs tests
- Builds project
- **Deploys to Cloudflare Workers production**

### Automatic Deployment Flow

```
Push to main → Run tests → Build → Deploy to Cloudflare Workers → Live OP at public URL
```

**Note:** The deploy workflow requires the `PRIVATE_KEY_PEM` and `PUBLIC_JWK_JSON` secrets to be set in Cloudflare (see step 6 above). GitHub Actions uses the API token to deploy, but the keys must be in Cloudflare's secret store.

---

## Post-Deployment

### 1. Update Issuer URL

Ensure your `ISSUER_URL` in production matches your actual deployment URL:

```toml
[env.production]
vars = { ISSUER_URL = "https://hibana.YOUR_SUBDOMAIN.workers.dev" }
```

Then redeploy:
```bash
wrangler deploy --env production
```

### 2. Test Full OAuth Flow

Use the deployed OP with a test client application:

```bash
# Example authorization URL
https://hibana.YOUR_SUBDOMAIN.workers.dev/authorize?
  response_type=code&
  client_id=test-client&
  redirect_uri=https://your-app.com/callback&
  scope=openid%20profile%20email&
  state=random-state&
  nonce=random-nonce
```

### 3. Monitor Logs

View logs in Cloudflare Dashboard or via Wrangler:

```bash
# Stream real-time logs
wrangler tail --env production

# View logs in dashboard
# https://dash.cloudflare.com → Workers → hibana-prod → Logs
```

---

## Custom Domain Setup

### Using Cloudflare-Managed Domain

If your domain is managed by Cloudflare:

1. Go to **Workers & Pages** → **hibana-prod** → **Settings** → **Domains & Routes**
2. Click **Add Custom Domain**
3. Enter your domain (e.g., `id.yourdomain.com`)
4. Cloudflare will automatically provision SSL certificate

### Using External Domain

1. Add a CNAME record pointing to your Worker:
   ```
   id.yourdomain.com CNAME hibana.YOUR_SUBDOMAIN.workers.dev
   ```

2. Add the custom domain in Cloudflare Dashboard (same as above)

3. Update `ISSUER_URL` in `wrangler.toml`:
   ```toml
   [env.production]
   vars = { ISSUER_URL = "https://id.yourdomain.com" }
   ```

4. Redeploy:
   ```bash
   wrangler deploy --env production
   ```

---

## Security Considerations

### 🔐 Production Security Checklist

- ✅ **HTTPS Only**: Cloudflare Workers enforce HTTPS automatically
- ✅ **Secure Secrets**: Use Wrangler secrets, never commit keys
- ✅ **Key Rotation**: Plan to rotate RSA keys periodically (Phase 4)
- ✅ **PKCE**: Enabled by default for public clients
- ✅ **Short-lived Codes**: Authorization codes expire in 120 seconds
- ⚠️ **Rate Limiting**: Not yet implemented (planned for Phase 4)

### Private Key Protection

**NEVER:**
- Commit `.keys/` directory to Git (it's in `.gitignore`)
- Share private keys via email, Slack, etc.
- Use the same keys in development and production

**ALWAYS:**
- Generate new keys for production
- Store keys in Cloudflare secrets
- Rotate keys periodically

### Recommended Key Rotation

```bash
# 1. Generate new key pair
npm run generate-keys

# 2. Deploy with new KEY_ID
# Update KEY_ID in wrangler.toml
wrangler deploy --env production

# 3. Upload new secrets
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM --env production
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON --env production

# 4. Old tokens remain valid until they expire
# 5. JWKS endpoint automatically returns new public key
```

---

## Troubleshooting

### Issue: "Error: Missing required KV namespace"

**Cause:** KV namespaces not created or IDs not updated in `wrangler.toml`

**Solution:**
1. Run the KV namespace creation commands (step 3)
2. Update `wrangler.toml` with the correct IDs
3. Redeploy

### Issue: "Error: No such secret: PRIVATE_KEY_PEM"

**Cause:** Secrets not uploaded to Cloudflare

**Solution:**
```bash
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM --env production
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON --env production
```

### Issue: JWKS Endpoint Returns Empty Array

**Cause:** `PUBLIC_JWK_JSON` secret not set

**Solution:**
```bash
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON --env production
```

### Issue: Token Endpoint Returns "Server configuration error"

**Cause:** `PRIVATE_KEY_PEM` secret not set or invalid

**Solution:**
1. Verify key format:
   ```bash
   cat .keys/private.pem
   # Should start with: -----BEGIN PRIVATE KEY-----
   ```
2. Re-upload secret:
   ```bash
   cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM --env production
   ```

### Issue: GitHub Actions Deployment Fails

**Possible causes:**
- `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` secrets not set
- API token lacks necessary permissions
- Secrets not uploaded to Cloudflare

**Solution:**
1. Verify GitHub secrets are set correctly
2. Ensure API token has "Edit Cloudflare Workers" permission
3. Upload keys to Cloudflare via Wrangler (step 6)

### Issue: "Invalid issuer" Error in Tokens

**Cause:** `ISSUER_URL` mismatch between configuration and actual deployment URL

**Solution:**
1. Check your Worker's actual URL in Cloudflare Dashboard
2. Update `ISSUER_URL` in `wrangler.toml`:
   ```toml
   [env.production]
   vars = { ISSUER_URL = "https://your-actual-url.workers.dev" }
   ```
3. Redeploy

---

## Next Steps

After successful deployment:

1. **Integrate with Your Application**
   - Use the discovery endpoint to configure your OAuth client
   - Test the full authorization code flow

2. **Set Up Client Registration**
   - Currently static clients only (MVP)
   - Dynamic client registration coming in Phase 4

3. **Monitor Performance**
   - Check Cloudflare Analytics dashboard
   - Set up alerts for errors

4. **Plan for Scale**
   - Cloudflare Workers free tier: 100,000 requests/day
   - Paid tier: 10M+ requests/month

---

## Additional Resources

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Wrangler CLI Documentation](https://developers.cloudflare.com/workers/wrangler/)
- [OpenID Connect Specification](https://openid.net/specs/openid-connect-core-1_0.html)
- [Hibana Development Setup](./conformance/SETUP.md)

---

## Support

If you encounter issues:

1. Check the [Troubleshooting](#troubleshooting) section
2. Review [GitHub Issues](https://github.com/sgrastar/hibana/issues)
3. Create a new issue with:
   - Deployment logs
   - Error messages
   - Steps to reproduce

---

**Deployment Complete!** 🎉

Your OpenID Connect Provider is now live at:
```
https://hibana.YOUR_SUBDOMAIN.workers.dev
```

Start integrating with your applications and enjoy global edge authentication!
