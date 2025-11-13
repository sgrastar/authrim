# Secret Management

## Overview

Enrai uses cryptographic keys for JWT signing. These keys must be managed securely throughout their lifecycle. This document describes how to generate, store, and rotate keys safely.

## Key Types

### RSA Key Pair

Enrai uses RSA-2048 key pairs with the RS256 algorithm (RSA signature with SHA-256) for signing JWT tokens.

- **Private Key**: Used to sign JWT tokens (ID tokens and access tokens)
- **Public Key**: Distributed via JWKS endpoint for token verification

## Key Storage

### Development Environment

For local development, keys are stored in the `.keys/` directory:

```
.keys/
├── private.pem      # Private key (PEM format)
├── public.jwk.json  # Public key (JWK format)
└── metadata.json    # Key metadata (kid, creation date, etc.)
```

**⚠️ Important**: The `.keys/` directory is gitignored. Never commit private keys!

### Production Environment

In production, keys are stored as Cloudflare Workers secrets:

- **Private Key**: Stored as `PRIVATE_KEY_PEM` secret
- **Key ID**: Stored as `KEY_ID` environment variable

## Generating Keys

### Using the Key Generation Script

The project includes a script to generate RSA key pairs:

```bash
pnpm run generate-keys
```

This will:
1. Generate a new RSA-2048 key pair
2. Save the private key as `.keys/private.pem`
3. Save the public key as `.keys/public.jwk.json`
4. Save metadata as `.keys/metadata.json`
5. Display instructions for adding the key to Wrangler

### Custom Key ID

You can specify a custom key ID:

```bash
pnpm run generate-keys -- --kid=my-custom-key-1
```

### Manual Generation

If you prefer to generate keys manually:

```typescript
import { generateKeySet } from './src/utils/keys';

const { publicJWK, privatePEM } = await generateKeySet('my-key-id', 2048);
```

## Adding Keys to Wrangler

### Development (Local)

For local development, you can set environment variables:

```bash
export PRIVATE_KEY_PEM="$(cat .keys/private.pem)"
export KEY_ID="dev-key-1234567890-abc123"
```

Or create a `.dev.vars` file (gitignored):

```env
PRIVATE_KEY_PEM=-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...
-----END PRIVATE KEY-----
KEY_ID=dev-key-1234567890-abc123
```

### Production

For production, use Wrangler secrets:

```bash
# Add private key as secret
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM

# Verify the secret was added
wrangler secret list
```

Then update `wrangler.toml` with the key ID:

```toml
[env.production]
vars = {
  KEY_ID = "prod-key-1234567890-abc123",
  ISSUER_URL = "https://id.enrai.org"
}
```

## Key Rotation

### Manual Rotation (Phase 1-3)

During the initial phases, key rotation is manual:

1. **Generate new key pair**:
   ```bash
   pnpm run generate-keys -- --kid=prod-key-new
   ```

2. **Add new key to production**:
   ```bash
   cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM
   ```

3. **Update KEY_ID in wrangler.toml**:
   ```toml
   [env.production]
   vars = { KEY_ID = "prod-key-new" }
   ```

4. **Deploy**:
   ```bash
   pnpm run deploy
   ```

5. **Keep old public key available for verification** (if using Durable Objects)

### Automatic Rotation (Phase 4)

In Phase 4, Durable Objects enable automatic key rotation:

1. **KeyManager rotates keys automatically** based on rotation interval (default: 90 days)
2. **Multiple keys are active simultaneously** for verification
3. **Old keys are retained** for the retention period (default: 30 days)
4. **Zero downtime** during rotation

See [Durable Objects Architecture](../architecture/durable-objects.md) for details.

## Security Best Practices

### Key Generation

✅ **DO**:
- Use the provided script for consistent key generation
- Generate keys with sufficient entropy (system random)
- Use 2048-bit or larger RSA keys
- Generate unique key IDs with timestamps

❌ **DON'T**:
- Use weak key sizes (< 2048 bits)
- Reuse key IDs
- Generate keys on untrusted systems

### Key Storage

✅ **DO**:
- Store private keys as Wrangler secrets
- Use environment variables for key IDs
- Keep `.keys/` directory gitignored
- Encrypt backups of private keys

❌ **DON'T**:
- Commit private keys to version control
- Store private keys in plaintext files on production servers
- Share private keys via email or chat
- Log private keys

### Key Rotation

✅ **DO**:
- Rotate keys regularly (every 90 days recommended)
- Keep old public keys available for token verification
- Plan rotation windows to minimize disruption
- Document rotation procedures

❌ **DON'T**:
- Delete old keys immediately after rotation
- Rotate keys without verification
- Skip testing after rotation

## Key Backup and Recovery

### Backup Procedure

1. **Export private key from Wrangler**:
   ```bash
   wrangler secret get PRIVATE_KEY_PEM > backup-private.pem
   ```

2. **Encrypt the backup**:
   ```bash
   openssl enc -aes-256-cbc -salt -in backup-private.pem -out backup-private.pem.enc
   ```

3. **Store encrypted backup securely** (e.g., password manager, encrypted storage)

4. **Delete unencrypted file**:
   ```bash
   shred -u backup-private.pem
   ```

### Recovery Procedure

1. **Decrypt the backup**:
   ```bash
   openssl enc -aes-256-cbc -d -in backup-private.pem.enc -out private.pem
   ```

2. **Restore to Wrangler**:
   ```bash
   cat private.pem | wrangler secret put PRIVATE_KEY_PEM
   ```

3. **Verify restoration**:
   ```bash
   # Test JWT signing with restored key
   pnpm run test
   ```

4. **Delete decrypted file**:
   ```bash
   shred -u private.pem
   ```

## Monitoring and Auditing

### Key Age

Monitor the age of your active key:

```bash
# Check metadata.json
cat .keys/metadata.json | jq '.createdAt'
```

Rotate keys if they're older than 90 days.

### Key Usage

Log all key operations:
- Key generation
- Key rotation
- JWT signing operations
- Verification failures

### Security Alerts

Set up alerts for:
- Failed token verifications (potential key compromise)
- Unusual signing patterns
- Key rotation failures

## Troubleshooting

### Invalid Key Format

**Error**: `Error: Invalid key format`

**Solution**: Ensure the private key is in PKCS#8 PEM format. Regenerate if necessary.

### Signature Verification Failure

**Error**: `JWT verification failed: signature mismatch`

**Possible Causes**:
- Wrong key ID (kid) in JWT header
- Private/public key mismatch
- Key rotation without updating public key

**Solution**: Verify that the public key in JWKS matches the private key used for signing.

### Missing Secret

**Error**: `PRIVATE_KEY_PEM is not defined`

**Solution**: Ensure the secret is added to Wrangler:
```bash
cat .keys/private.pem | wrangler secret put PRIVATE_KEY_PEM
```

## References

- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [JOSE Library Documentation](https://github.com/panva/jose)
- [OpenID Connect Key Rotation](https://openid.net/specs/openid-connect-core-1_0.html#RotateSigKeys)
- [RFC 7517: JSON Web Key (JWK)](https://datatracker.ietf.org/doc/html/rfc7517)
