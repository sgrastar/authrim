# Authrim - OpenID Conformance Testing Guide ⚡️

**Purpose:** Complete guide for OpenID Connect conformance testing without Docker
**Target:** Phase 3 - Testing & Validation
**Last Updated:** 2025-11-18

---

## Quick Start (30 Minutes) 🚀

Follow these steps to quickly start OpenID Conformance Testing:

### Prerequisites
- Node.js 18+ installed
- Cloudflare account created
- wrangler CLI authenticated (`wrangler login`)

### Step 1: Local Verification (5 minutes)

```bash
# Navigate to project root
cd /path/to/authrim

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

### Step 2: Deploy to Production (10 minutes)

```bash
# Generate production keys
pnpm run generate-keys

# Configure wrangler.toml
# Set ISSUER = "https://authrim.YOUR_SUBDOMAIN.workers.dev"
# Set KEY_ID from: jq -r '.kid' .keys/metadata.json

# Configure secrets
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON

# Build and deploy
pnpm run build
pnpm run deploy
```

### Step 3: Run Conformance Tests (15 minutes)

1. Access https://www.certification.openid.net/
2. Create account and login
3. Create test plan: **OpenID Connect Provider** → **Basic OP**
4. Enter your issuer URL: `https://authrim.YOUR_SUBDOMAIN.workers.dev`
5. Click "Discover" to load metadata
6. Start tests and follow browser instructions

### Success Criteria

- ✅ Conformance Score: ≥85%
- ✅ Critical Failures: 0
- ✅ Discovery & JWKS: All passing

---

## Table of Contents

1. [Local Development Setup](#1-local-development-setup)
2. [Prepare Test Environment](#2-prepare-test-environment)
3. [Deploy to Cloudflare Workers](#3-deploy-to-cloudflare-workers)
4. [Use OpenID Conformance Suite](#4-use-openid-conformance-suite)
5. [Execute Tests](#5-execute-tests)
6. [Verify and Record Results](#6-verify-and-record-results)
7. [Troubleshooting](#7-troubleshooting)
8. [Next Steps](#8-next-steps)

---

## 1. Local Development Setup

This section explains how to set up Authrim for local development and testing.

### 1.1 Prerequisites

- Node.js 18.0.0 or higher
- pnpm (or npm)
- jq (for JSON processing in setup script)

### 1.2 Quick Setup

Run the automated setup script:

```bash
./scripts/setup-dev.sh
```

This script will:
1. Generate RSA key pairs for JWT signing (if not already present)
2. Create `.dev.vars` file with necessary environment variables
3. Update `wrangler.toml` with the generated KEY_ID

### 1.3 Manual Setup (Optional)

If you prefer to set up manually:

#### Generate RSA Keys

```bash
pnpm run generate-keys
```

This creates:
- `.keys/private.pem` - Private key for signing tokens
- `.keys/public.jwk.json` - Public key in JWK format
- `.keys/metadata.json` - Key metadata (kid, algorithm, etc.)

#### Create `.dev.vars` File

Create a `.dev.vars` file in the project root:

```bash
PRIVATE_KEY_PEM="<content of .keys/private.pem>"
PUBLIC_JWK_JSON='<compact JSON from .keys/public.jwk.json>'
ALLOW_HTTP_REDIRECT="true"
```

**Important:**
- The `PRIVATE_KEY_PEM` should include the full PEM content with newlines
- The `PUBLIC_JWK_JSON` should be a compact JSON string (single line, no spaces)
- Both values should be quoted as shown above

#### Update `wrangler.toml`

Update the `KEY_ID` in `wrangler.toml` to match the `kid` from `.keys/metadata.json`:

```toml
[vars]
KEY_ID = "dev-key-1234567890-xxxxx"
```

### 1.4 Running the Server

Start the development server:

```bash
pnpm run dev
```

The server will be available at `http://localhost:8787`.

### 1.5 Testing the Local Setup

#### Test Discovery Endpoint

```bash
curl http://localhost:8787/.well-known/openid-configuration | jq
```

Expected: JSON response with OpenID configuration

#### Test JWKS Endpoint

```bash
curl http://localhost:8787/.well-known/jwks.json | jq
```

Expected: JSON response with public key in JWK format

#### Test Authorization Flow

```bash
curl -i "http://localhost:8787/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid%20profile&state=test-state&nonce=test-nonce"
```

Expected: 302 redirect with authorization code

#### Test Token Exchange

```bash
CODE="<authorization-code>"
curl -X POST http://localhost:8787/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=$CODE" \
  -d "client_id=test-client" \
  -d "redirect_uri=https://example.com/callback" | jq
```

Expected: JSON response with `access_token`, `id_token`, and other token fields

#### Test UserInfo Endpoint

```bash
ACCESS_TOKEN="<access-token>"
curl http://localhost:8787/userinfo \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq
```

Expected: JSON response with user claims

### 1.6 Running Tests

```bash
pnpm test
```

To run tests with coverage:

```bash
pnpm run test:coverage
```

### 1.7 Security Notes

- The `.keys/` directory is gitignored by default
- Never commit private keys to version control
- `.dev.vars` is also gitignored and contains sensitive data
- For production deployment, use Wrangler secrets instead of `.dev.vars`

---

## 2. Prepare Test Environment

### 2.1 Overview

Before public deployment, verify that Authrim works correctly in your local environment. This has been covered in detail in [Section 1: Local Development Setup](#1-local-development-setup).

If you've already completed the local setup, you can skip to [Section 3: Deploy to Cloudflare Workers](#3-deploy-to-cloudflare-workers).

---

## 3. Deploy to Cloudflare Workers

The OpenID Conformance Suite requires an internet-accessible URL. Deploy to Cloudflare Workers to obtain a public URL.

### 3.1 Generate Production RSA Keys

Generate a new RSA key pair for the production environment:

```bash
# Backup existing development keys (optional)
cp -r .keys .keys.dev

# Generate new keys
pnpm run generate-keys
```

### 3.2 Configure Wrangler Secrets

Set the generated keys as Cloudflare Workers secrets:

```bash
# Configure PRIVATE_KEY_PEM
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM

# Configure PUBLIC_JWK_JSON
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON
```

**Important:** Secrets are stored encrypted and only accessible in the Workers runtime.

### 3.3 Verify wrangler.toml Configuration

Open `wrangler.toml` and verify the following:

```toml
name = "authrim"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
ISSUER = "https://authrim.YOUR_SUBDOMAIN.workers.dev"
KEY_ID = "edge-key-1"  # Match the kid from .keys/metadata.json
TOKEN_TTL = "3600"
CODE_TTL = "120"
ALLOW_HTTP_REDIRECT = "false"  # false for production environment

# KV Namespace (automatically created on first deployment)
[[kv_namespaces]]
binding = "KV"
id = ""
```

**Verify KEY_ID:**

```bash
# Get kid from .keys/metadata.json
jq -r '.kid' .keys/metadata.json
```

Set this value to `KEY_ID` in `wrangler.toml`.

### 3.4 Build TypeScript

Build TypeScript before deployment:

```bash
pnpm run build
```

Verify there are no errors.

### 3.5 Deploy

Deploy to Cloudflare Workers:

```bash
pnpm run deploy
```

**Expected output:**

```
Total Upload: XX.XX KiB / gzip: XX.XX KiB
Uploaded authrim (X.XX sec)
Published authrim (X.XX sec)
  https://authrim.YOUR_SUBDOMAIN.workers.dev
Current Deployment ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Note the deployed URL.

### 3.6 Verify Deployment

Test the deployed endpoints:

```bash
AUTHRIM_URL="https://authrim.YOUR_SUBDOMAIN.workers.dev"

# Discovery endpoint
curl $AUTHRIM_URL/.well-known/openid-configuration | jq

# JWKS endpoint
curl $AUTHRIM_URL/.well-known/jwks.json | jq
```

**Verification points:**
- The issuer field in the Discovery endpoint matches the deployment URL
- The JWKS endpoint returns a non-empty public key
- All endpoint URLs use HTTPS

---

## 4. Using OpenID Conformance Suite

### 4.1 Account Registration

1. Access OpenID Conformance Suite:
   https://www.certification.openid.net/

2. Click "Sign up" to create a new account

3. Verify your email address and log in

### 4.2 Create Test Plan

1. After logging in, click "Create a new test plan"

2. Select the following settings:

   | Item | Value |
   |------|--------|
   | **Test Type** | OpenID Connect Provider |
   | **Profile** | Basic OP (Authorization Code Flow) |
   | **Client Type** | Public Client |
   | **Response Type** | code |
   | **Response Mode** | default (query) |

3. Click "Continue"

### 4.3 Enter OP (OpenID Provider) Information

On the test plan configuration screen, enter your Authrim information:

| Field | Value | Example |
|-----------|-----|-----|
| **Issuer** | Your deployed Worker URL | `https://authrim.YOUR_SUBDOMAIN.workers.dev` |
| **Discovery URL** | `{ISSUER}/.well-known/openid-configuration` | `https://authrim.YOUR_SUBDOMAIN.workers.dev/.well-known/openid-configuration` |

Click the "Discover" button to automatically load Authrim's metadata.

### 4.4 Client Registration

Record the test client information used by the OpenID Conformance Suite.

**✅ Implemented:** Authrim fully supports Dynamic Client Registration (DCR).

The test suite can automatically register clients using the following procedure:

```bash
curl -X POST $AUTHRIM_URL/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "OpenID Conformance Test Client",
    "redirect_uris": [
      "https://www.certification.openid.net/test/a/authrim/callback",
      "https://www.certification.openid.net/test/a/authrim/callback?dummy1=lorem",
      "https://www.certification.openid.net/test/a/authrim/callback?dummy2=ipsum"
    ],
    "response_types": ["code"],
    "grant_types": ["authorization_code", "refresh_token"],
    "token_endpoint_auth_method": "client_secret_basic",
    "subject_type": "public"
  }'
```

Response example:
```json
{
  "client_id": "client_xxxxxxxxxxxxx",
  "client_secret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "client_id_issued_at": 1234567890,
  "client_secret_expires_at": 0,
  "redirect_uris": [...],
  "token_endpoint_auth_method": "client_secret_basic",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "application_type": "web",
  "subject_type": "public"
}
```

### 4.5 Supported Advanced Features

Authrim supports the following OIDC extension features:

**RFC 9101: JWT Secured Authorization Request (JAR)**
- JWT-based authorization requests via the `request` parameter
- Support for both signed (RS256) and unsigned (alg=none) request objects
- Request parameter override (request object parameters take precedence)

**OIDC Core 3.1.2.1: Authentication Parameters**
- `prompt`: none, login, consent, select_account
- `max_age`: Re-authentication time constraint
- `id_token_hint`: ID Token for session hint
- `acr_values`: Authentication Context Class Reference

**RFC 6749: Refresh Token**
- Refresh Token issuance and rotation
- Support for scope downgrading

**OIDC Core 8: Subject Types**
- Public subject identifiers
- Pairwise subject identifiers (with sector_identifier_uri support)

---

## 5. Test Execution

### 5.1 Select Basic OP Profile Tests

Select the following test modules in the OpenID Conformance Suite:

#### Required Tests (Core Tests)

1. **oidcc-basic-certification-test-plan**
   - Discovery endpoint test
   - Authorization Code Flow test
   - Token endpoint test
   - UserInfo endpoint test
   - ID Token validation test

2. **oidcc-test-plan-jwks**
   - JWKS endpoint test
   - Key format validation
   - Signature verification

3. **oidcc-test-rp-discovery**
   - Metadata format validation
   - Endpoint URL validation
   - Supported features validation

### 5.2 Start Tests

1. After selecting test modules, click "Start Test"

2. Follow the instructions displayed in the browser:
   - When the Authorization URL is displayed, click to access Authrim's authorization endpoint
   - After redirect, the test suite will automatically continue

3. Check the logs displayed during each test execution

### 5.3 Test Case Details

**Discovery Tests:**
- `.well-known/openid-configuration` format validation
- Required field existence check
- Issuer URL consistency check

**Authorization Tests:**
- Authorization code generation
- State parameter validation
- Nonce parameter validation
- PKCE support verification

**Token Tests:**
- Authorization code exchange
- ID Token format verification
- Access Token issuance
- Token expiration verification

**UserInfo Tests:**
- Bearer Token authentication
- Claims return verification
- `sub` claim consistency check

**JWKS Tests:**
- JWK Set format verification
- RS256 public key validation
- Signature verification

**Request Object (JAR) Tests:**
- `request` parameter processing
- Unsigned (alg=none) request object validation
- Signed (RS256) request object validation
- Parameter override verification

**Authentication Parameter Tests:**
- `prompt=none` existing session requirement verification
- `prompt=login` forced re-authentication
- `max_age` time constraint application
- Session extraction from `id_token_hint`
- `acr_values` selection and inclusion in ID Token

**Refresh Token Tests:**
- Refresh Token issuance
- New Access Token acquisition via Refresh Token
- Scope downgrading
- Refresh Token rotation

**Dynamic Client Registration Tests:**
- POST /register endpoint
- Metadata validation
- client_id and client_secret issuance
- Pairwise subject type support

---

## 6. Verify and Record Results

### 6.1 Check Test Results

After test completion, verify the following information:

- **Passed Tests:** Number of passed tests
- **Failed Tests:** Number of failed tests
- **Warnings:** Number of warnings (passed but improvement recommended)
- **Skipped Tests:** Number of skipped tests

### 6.2 Passing Criteria

**Basic OP Profile certification requirements:**
- Core tests: 100% pass
- Discovery tests: 100% pass
- JWKS tests: 100% pass
- Optional tests: Recommended

**Authrim goals:**
- 100% overall conformance score (all required features implemented)
- 0 critical failures
- Pass all OIDC OP Basic Profile tests

### 6.3 Export Results

1. Click "Export" on the test results screen
2. Download in JSON format
3. Save to `docs/conformance/test-results/`

```bash
# Create test-results directory
mkdir -p docs/conformance/test-results

# Move downloaded file
mv ~/Downloads/conformance-test-result-*.json docs/conformance/test-results/

# Rename result file (with date)
cd docs/conformance/test-results
mv conformance-test-result-*.json result-$(date +%Y%m%d).json
```

### 6.4 Create Test Report

Compile test results into a report using the following template:

```markdown
# Authrim - OpenID Conformance Test Report

**Test Date:** YYYY-MM-DD
**Tester:** Your Name
**Authrim Version:** vX.Y.Z
**Environment:** Cloudflare Workers
**Test Suite:** OpenID Connect Basic OP Profile

## Test Results Summary

| Category | Passed | Failed | Warnings | Total |
|----------|--------|--------|----------|-------|
| Core     | X      | X      | X        | X     |
| Discovery| X      | X      | X        | X     |
| JWKS     | X      | X      | X        | X     |
| **Total**| **X**  | **X**  | **X**    | **X** |

**Overall Conformance Score:** XX.X%

## Detailed Results

### Passed Tests
- [List of passed tests]

### Failed Tests
- [List of failed tests with reasons]

### Warnings
- [List of warnings and recommendations]

## Issues Identified

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | ... | High | Open |

## Next Steps
- [Action items based on test results]
```

---

## 7. Troubleshooting

### 7.1 Common Issues

#### Issue: Discovery endpoint not found (404)

**Cause:**
- Deployment not completed
- Routing configuration incorrect

**Solution:**
```bash
# Check deployment status
wrangler deployments list

# Verify latest deployment is active
# Redeploy if necessary
pnpm run deploy
```

#### Issue: JWKS endpoint returns empty keys array

**Cause:**
- `PUBLIC_JWK_JSON` secret not set
- Environment variable format incorrect

**Solution:**
```bash
# Reconfigure PUBLIC_JWK_JSON
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON

# Verify configuration
wrangler secret list
```

#### Issue: Server error at Token endpoint (500)

**Cause:**
- `PRIVATE_KEY_PEM` secret not set
- Key format incorrect

**Solution:**
```bash
# Reconfigure PRIVATE_KEY_PEM
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM

# Redeploy
pnpm run deploy
```

#### Issue: Issuer URL mismatch

**Cause:**
- `ISSUER` environment variable in `wrangler.toml` doesn't match deployment URL

**Solution:**
```toml
# Edit wrangler.toml
[vars]
ISSUER = "https://authrim.YOUR_SUBDOMAIN.workers.dev"
```

```bash
# Redeploy
pnpm run deploy
```

#### Issue: Conformance Suite displays "Unable to connect" error

**Cause:**
- Authrim not accessible via HTTPS
- CORS configuration incorrect
- Firewall blocking access

**Solution:**
```bash
# Verify HTTPS access
curl -I https://authrim.YOUR_SUBDOMAIN.workers.dev/.well-known/openid-configuration

# Check CORS configuration (src/index.ts)
# Add CORS middleware if necessary
```

### 7.2 Debugging Methods

#### Check Cloudflare Workers Logs

```bash
# Check logs in real-time
wrangler tail

# Save logs to file
wrangler tail > logs.txt
```

#### Local Reproduction Testing

```bash
# Start development server
pnpm run dev

# Send same request in another terminal
curl -v http://localhost:8787/.well-known/openid-configuration
```

#### Using Test Scripts

```bash
# Run integration tests
pnpm test

# Test specific endpoints
pnpm test -- --grep "discovery"
pnpm test -- --grep "token"
```

### 7.3 Support and Resources

**Documentation:**
- [OpenID Connect Core Specification](https://openid.net/specs/openid-connect-core-1_0.html)
- [OpenID Conformance Testing](https://openid.net/certification/testing/)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)

**Community:**
- Authrim GitHub Issues: https://github.com/sgrastar/authrim/issues
- OpenID Foundation: https://openid.net/

**Reference Materials:**
- [Manual Conformance Checklist](./manual-checklist.md) - Manual test checklist
- [Test Plan](./test-plan.md) - Detailed test plan

---

## 8. Next Steps

### 8.1 Immediate Actions

1. **Execute Deployment**
   ```bash
   pnpm run deploy
   ```

2. **Create Account on OpenID Conformance Suite**
   - https://www.certification.openid.net/

3. **Run Initial Tests**
   - Select Basic OP Profile tests
   - Record results

### 8.2 Post-Test Actions

1. **Analyze Failed Tests**
   - Check error messages
   - Investigate logs
   - Identify causes

2. **Fix Code**
   - Fix relevant handlers
   - Add unit tests
   - Verify with integration tests

3. **Re-run Tests**
   - Deploy fixes
   - Re-test in Conformance Suite
   - Verify pass rate

### 8.3 Verify Implemented Features

The following features are all implemented:

1. ✅ `/register` endpoint (Dynamic Client Registration)
2. ✅ Client metadata validation
3. ✅ Client storage (KV)
4. ✅ Refresh Token support
5. ✅ Request Object (JAR) support
6. ✅ Authentication parameters (prompt, max_age, id_token_hint, acr_values)
7. ✅ Subject Type (public, pairwise) support

**Next Step:** Run all tests in Conformance Suite and verify 100% pass

---

> ⚡️ **Authrim** - Complete OpenID Conformance Testing Guide
>
> **Last Updated:** 2025-11-18
> **Status:** Phase 5 Complete - All Required Features Implemented
> **Goal:** 100% conformance score (expected to achieve)
>
> Use this guide for complete support from local development to Conformance Testing.
