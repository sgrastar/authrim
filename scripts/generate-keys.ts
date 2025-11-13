#!/usr/bin/env node

/**
 * Generate RSA Key Pair for Development
 *
 * This script generates an RSA key pair for JWT signing and saves:
 * - Private key as PEM (for Wrangler secrets)
 * - Public key as JWK (for JWKS endpoint)
 * - Key metadata (kid, created timestamp)
 *
 * Usage:
 *   npx tsx scripts/generate-keys.ts [--kid=custom-key-id]
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { generateKeySet } from '../packages/shared/src/utils/keys';

async function main() {
  const args = process.argv.slice(2);
  const kidArg = args.find((arg) => arg.startsWith('--kid='));
  const kid = kidArg ? kidArg.split('=')[1] : generateDefaultKeyId();

  console.log('🔐 Generating RSA key pair...');
  console.log(`   Key ID: ${kid}`);

  const { publicJWK, privatePEM } = await generateKeySet(kid, 2048);

  console.log('✅ Key pair generated successfully!');
  console.log();

  // Create .keys directory if it doesn't exist
  const keysDir = join(process.cwd(), '.keys');
  try {
    mkdirSync(keysDir);
  } catch (error) {
    // Directory already exists
  }

  // Save private key (PEM format)
  const privatePath = join(keysDir, 'private.pem');
  writeFileSync(privatePath, privatePEM, 'utf-8');
  console.log(`📝 Private key saved to: ${privatePath}`);

  // Save public key (JWK format)
  const publicPath = join(keysDir, 'public.jwk.json');
  writeFileSync(publicPath, JSON.stringify(publicJWK, null, 2), 'utf-8');
  console.log(`📝 Public key saved to: ${publicPath}`);

  // Save metadata
  const metadata = {
    kid,
    algorithm: 'RS256',
    keySize: 2048,
    createdAt: new Date().toISOString(),
    files: {
      privateKey: privatePath,
      publicKey: publicPath,
    },
  };

  const metadataPath = join(keysDir, 'metadata.json');
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
  console.log(`📝 Metadata saved to: ${metadataPath}`);

  console.log();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 Next Steps:');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log();
  console.log('1. Add private key to Wrangler secrets:');
  console.log();
  console.log(`   cat ${privatePath} | wrangler secret put PRIVATE_KEY_PEM`);
  console.log();
  console.log('2. Add key ID to environment variables in wrangler.toml:');
  console.log();
  console.log(`   KEY_ID = "${kid}"`);
  console.log();
  console.log('3. (Optional) For local development, you can also set:');
  console.log();
  console.log(`   export PRIVATE_KEY_PEM="$(cat ${privatePath})"`);
  console.log(`   export KEY_ID="${kid}"`);
  console.log();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log();
  console.log('⚠️  Security Note:');
  console.log('   The .keys directory is gitignored by default.');
  console.log('   Never commit private keys to version control!');
  console.log();

  // Display JWK (without private components)
  console.log('📊 Public JWK (for JWKS endpoint):');
  console.log();
  console.log(JSON.stringify(publicJWK, null, 2));
  console.log();
}

function generateDefaultKeyId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `dev-key-${timestamp}-${random}`;
}

main().catch((error) => {
  console.error('❌ Error generating keys:', error);
  process.exit(1);
});
