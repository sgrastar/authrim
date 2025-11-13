# Phase 3 Quick Start Guide 🚀

**Estimated Time:** Approximately 30 minutes
**Target Audience:** Enrai Phase 3 Test Implementers
**Last Updated:** 2025-11-11

---

## Overview

This guide explains the quickest way to start Phase 3 OpenID Conformance Testing.

**Prerequisites:**
- Node.js 18+ installed
- Cloudflare account created
- wrangler CLI authenticated (`wrangler login`)

---

## Step 1: Local Verification (5 minutes)

```bash
# Navigate to project root
cd /path/to/enrai

# Install dependencies (first time only)
pnpm install

# Generate and configure RSA keys
./scripts/setup-dev.sh

# Start development server
pnpm run dev
```

Verify in another terminal:

```bash
# Discovery endpoint
curl http://localhost:8787/.well-known/openid-configuration | jq .issuer

# JWKS endpoint
curl http://localhost:8787/.well-known/jwks.json | jq '.keys | length'
# Output should be "1" or higher for OK
```

**✓ Expected Results:**
- Discovery: Returns `"http://localhost:8787"`
- JWKS: Returns a number (1 or higher)

---

## Step 2: Deploy to Production Environment (10 minutes)

### 2.1 Generate Production Keys

```bash
# Stop development server (Ctrl+C)

# Backup existing keys
cp -r .keys .keys.dev

# Generate new keys
pnpm run generate-keys

# Verify generated KEY_ID
jq -r '.kid' .keys/metadata.json
```

### 2.2 Configure wrangler.toml

Open `wrangler.toml` and configure the following:

```toml
[vars]
ISSUER = "https://enrai.YOUR_SUBDOMAIN.workers.dev"
KEY_ID = "Paste the KEY_ID copied above here"
ALLOW_HTTP_REDIRECT = "false"
```

**Verify YOUR_SUBDOMAIN:**

```bash
wrangler whoami
# Account: Your Account Name
# Account ID: xxxxxxxxxxxxxxxxxxxx
```

Usually it will be `enrai.YOUR_USERNAME.workers.dev`.

### 2.3 Configure Secrets

```bash
# Configure PRIVATE_KEY_PEM
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM

# Configure PUBLIC_JWK_JSON
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON
```

**Note:** After running each command, press Enter then Ctrl+D to complete the input.

### 2.4 Build and Deploy

```bash
# Build TypeScript
pnpm run build

# Deploy to Cloudflare Workers
pnpm run deploy
```

**✓ Expected Output:**

```
Published enrai (X.XX sec)
  https://enrai.YOUR_SUBDOMAIN.workers.dev
```

Copy and note this URL.

### 2.5 Verify Deployment

```bash
# Set environment variable
export ENRAI_URL="https://enrai.YOUR_SUBDOMAIN.workers.dev"

# Discovery endpoint
curl $ENRAI_URL/.well-known/openid-configuration | jq .issuer
# Output should match $ENRAI_URL

# JWKS endpoint
curl $ENRAI_URL/.well-known/jwks.json | jq '.keys[0].kty'
# Output should be "RSA"
```

**Troubleshooting:**
- If JWKS is empty → Reconfigure Secrets and redeploy
- If Issuer doesn't match → Fix ISSUER in wrangler.toml and redeploy

---

## Step 3: Testing with OpenID Conformance Suite (15 minutes)

### 3.1 Create Account

1. Access https://www.certification.openid.net/
2. Click "Sign up"
3. Enter email address and password
4. Verify email and login

### 3.2 Create Test Plan

1. Click "Create a new test plan"
2. Select the following:
   - Test Type: **OpenID Connect Provider**
   - Profile: **Basic OP**
   - Client Type: **Public Client**
   - Response Type: **code**
3. Click "Continue"

### 3.3 Configure Enrai

Enter the following in **Issuer URL**:

```
https://enrai.YOUR_SUBDOMAIN.workers.dev
```

Click the "Discover" button to automatically load metadata.

### 3.4 Run Tests

1. Click "Start Test"
2. Click when Authorization URL is displayed in browser
3. You'll be redirected to Enrai's authorization endpoint
4. Automatically redirected to test suite and tests continue

### 3.5 Verify Results

After test completion, verify:

- **Passed Tests:** Number of passed tests
- **Failed Tests:** Number of failed tests (target: 0)
- **Conformance Score:** Conformance rate (target: ≥85%)

**✓ Success Criteria:**
- Passed Tests: ≥85%
- Critical Failures: 0
- Discovery & JWKS: All passing

---

## Step 4: Record Results

### 4.1 Export Test Results

1. Click "Export" on test results screen
2. Download JSON file

### 4.2 Save Results

```bash
# Create test-results directory
mkdir -p docs/conformance/test-results

# Move downloaded file
mv ~/Downloads/conformance-test-result-*.json docs/conformance/test-results/

# Rename with date
cd docs/conformance/test-results
mv conformance-test-result-*.json result-$(date +%Y%m%d-%H%M).json
```

### 4.3 Commit Results

```bash
# Add to Git
git add docs/conformance/test-results/

# Commit
git commit -m "test: add OpenID Conformance test results for Phase 3"

# Push
git push origin claude/phase3-test-documentation-011CV2461YR1rAMaAnJdqK1v
```

---

## Troubleshooting

### Issue: "Unable to connect to issuer"

**Solution:**
```bash
# Verify HTTPS access
curl -I $ENRAI_URL/.well-known/openid-configuration

# Verify 200 OK is returned
```

### Issue: "JWKS endpoint returns empty keys"

**Solution:**
```bash
# Reconfigure Secrets
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON

# Redeploy
pnpm run deploy

# Verify
curl $ENRAI_URL/.well-known/jwks.json | jq
```

### Issue: "Token endpoint error (500)"

**Solution:**
```bash
# Reconfigure PRIVATE_KEY_PEM
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM

# Redeploy
pnpm run deploy
```

---

## Checklist

Checklist for Phase 3 completion:

### Pre-deployment
- [ ] Discovery endpoint working in local environment
- [ ] JWKS endpoint working in local environment
- [ ] All unit tests passing (`npm test`)

### Post-deployment
- [ ] Discovery endpoint working in production environment
- [ ] JWKS endpoint working in production environment
- [ ] Issuer URL is consistent

### Post-testing
- [ ] OpenID Conformance Suite tests completed
- [ ] Conformance Score ≥ 85%
- [ ] Critical Failures = 0
- [ ] Test results exported and saved
- [ ] Results committed to Git

### Documentation
- [ ] Create test results report
- [ ] Analyze failed tests (if any)
- [ ] Document next steps

---

## Next Steps

### If Tests Succeeded (≥85%)

1. **Declare Phase 3 Complete**
   ```bash
   # Update ROADMAP.md
   # Change Phase 3 status from ⏳ → ✅
   ```

2. **Prepare for Phase 4**
   - Design Dynamic Client Registration
   - Plan Key Rotation implementation

### If Tests Failed (<85%)

1. **Analyze Failure Causes**
   - Check error logs
   - Identify which tests failed

2. **Fix Code**
   - Fix relevant handlers
   - Add unit tests

3. **Retest**
   - Deploy
   - Re-run in Conformance Suite

---

## Resources

**Detailed Documentation:**
- [Complete Testing Guide](./testing-guide.md) - Detailed procedures
- [Manual Checklist](./manual-checklist.md) - Manual testing methods
- [Test Plan](./test-plan.md) - Detailed test requirements

**External Links:**
- [OpenID Conformance Suite](https://www.certification.openid.net/)
- [OpenID Connect Core Spec](https://openid.net/specs/openid-connect-core-1_0.html)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)

**Support:**
- GitHub Issues: https://github.com/sgrastar/enrai/issues
- TASKS.md: Phase 3 task list

---

> 💥 **Enrai Phase 3** - Start Conformance Testing in 30 minutes
>
> **Last Updated:** 2025-11-11
> **Estimated Time:** Approximately 30 minutes
> **Target:** ≥85% conformance score
>
> Follow this guide to quickly start Phase 3 testing.
