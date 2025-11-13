# Enrai Development Setup Guide

This guide explains how to set up Enrai for local development and testing.

## Prerequisites

- Node.js 18.0.0 or higher
- npm
- jq (for JSON processing in setup script)

## Quick Setup

Run the automated setup script:

```bash
./scripts/setup-dev.sh
```

This script will:
1. Generate RSA key pairs for JWT signing (if not already present)
2. Create `.dev.vars` file with necessary environment variables
3. Update `wrangler.toml` with the generated KEY_ID

## Manual Setup

If you prefer to set up manually:

### 1. Generate RSA Keys

```bash
pnpm run generate-keys
```

This creates:
- `.keys/private.pem` - Private key for signing tokens
- `.keys/public.jwk.json` - Public key in JWK format
- `.keys/metadata.json` - Key metadata (kid, algorithm, etc.)

### 2. Create `.dev.vars` File

Create a `.dev.vars` file in the project root:

```bash
PRIVATE_KEY_PEM="<content of .keys/private.pem>"
PUBLIC_JWK_JSON='<compact JSON from .keys/public.jwk.json>'
ALLOW_HTTP_REDIRECT="true"
```

**Important**:
- The `PRIVATE_KEY_PEM` should include the full PEM content with newlines
- The `PUBLIC_JWK_JSON` should be a compact JSON string (single line, no spaces)
- Both values should be quoted as shown above

### 3. Update `wrangler.toml`

Update the `KEY_ID` in `wrangler.toml` to match the `kid` from `.keys/metadata.json`:

```toml
[vars]
KEY_ID = "dev-key-1234567890-xxxxx"
```

## Running the Server

Start the development server:

```bash
pnpm run dev
```

The server will be available at `http://localhost:8787`.

## Testing the Setup

### 1. Test Discovery Endpoint

```bash
curl http://localhost:8787/.well-known/openid-configuration | jq
```

Expected: JSON response with OpenID configuration

### 2. Test JWKS Endpoint

```bash
curl http://localhost:8787/.well-known/jwks.json | jq
```

Expected: JSON response with public key in JWK format

### 3. Test Authorization Flow

Get an authorization code:

```bash
curl -i "http://localhost:8787/authorize?response_type=code&client_id=test-client&redirect_uri=https://example.com/callback&scope=openid%20profile&state=test-state&nonce=test-nonce"
```

Expected: 302 redirect with authorization code

### 4. Test Token Exchange

Extract the code from the redirect URL and exchange it for tokens:

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

### 5. Test UserInfo Endpoint

Use the access token from the previous step:

```bash
ACCESS_TOKEN="<access-token>"
curl http://localhost:8787/userinfo \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq
```

Expected: JSON response with user claims

## Running Tests

```bash
npm test
```

To run tests with coverage:

```bash
pnpm run test:coverage
```

## Troubleshooting

### Issue: JWKS endpoint returns empty keys

**Cause**: `PUBLIC_JWK_JSON` not set in `.dev.vars`

**Solution**: Run `./scripts/setup-dev.sh` or manually add `PUBLIC_JWK_JSON` to `.dev.vars`

### Issue: Token endpoint returns "Server configuration error"

**Cause**: `PRIVATE_KEY_PEM` not set in `.dev.vars`

**Solution**: Run `./scripts/setup-dev.sh` or manually add `PRIVATE_KEY_PEM` to `.dev.vars`

### Issue: UserInfo endpoint returns "Failed to load verification key"

**Cause**: `PUBLIC_JWK_JSON` not set in `.dev.vars`

**Solution**: Run `./scripts/setup-dev.sh` or manually add `PUBLIC_JWK_JSON` to `.dev.vars`

### Issue: Invalid token signatures

**Cause**: Mismatch between `PRIVATE_KEY_PEM`, `PUBLIC_JWK_JSON`, and `KEY_ID`

**Solution**:
1. Delete `.keys/` directory
2. Run `./scripts/setup-dev.sh` to regenerate all keys
3. Restart the development server

## Security Notes

- The `.keys/` directory is gitignored by default
- Never commit private keys to version control
- `.dev.vars` is also gitignored and contains sensitive data
- For production deployment, use Wrangler secrets instead of `.dev.vars`

## Production Deployment

For production:

```bash
# Add private key as secret
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM

# Add public JWK as secret
cat .keys/public.jwk.json | jq -c . | wrangler secret put PUBLIC_JWK_JSON

# Deploy
pnpm run deploy
```

## Additional Resources

- [OpenID Connect Core Specification](https://openid.net/specs/openid-connect-core-1_0.html)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Wrangler Documentation](https://developers.cloudflare.com/workers/wrangler/)
