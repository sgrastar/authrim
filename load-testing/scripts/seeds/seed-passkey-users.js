
/**
 * Passkey User Seed Generation Script
 *
 * Pre-create users with registered passkeys and generate data for load testing.
 * Generates ECDSA P-256 key pairs for each user and executes WebAuthn registration flow.
 *
 * Environment variables:
 *   BASE_URL             Target Authrim Worker URL (default: https://your-authrim.example.com)
 *   ADMIN_API_SECRET     Admin API secret (required)
 *   PASSKEY_USER_COUNT   Number of users to generate (default: 100)
 *   CONCURRENCY          Parallel requests (default: 10)
 *   OUTPUT_DIR           Output directory (default: ../seeds)
 *   USER_ID_PREFIX       User ID prefix (default: pk-user)
 *
 * Usage:
 *   BASE_URL=https://your-authrim.example.com \
 *   ADMIN_API_SECRET=xxx \
 *   PASSKEY_USER_COUNT=500 \
 *   node scripts/seed-passkey-users.js
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Environment variables
const BASE_URL = process.env.BASE_URL || '';
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';
const PASSKEY_USER_COUNT = Number.parseInt(process.env.PASSKEY_USER_COUNT || '100', 10);
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '10', 10);
const USER_ID_PREFIX = process.env.USER_ID_PREFIX || 'pk-user';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(SCRIPT_DIR, '..', 'seeds');

// RP ID (used for WebAuthn signature verification)
const RP_ID = new URL(BASE_URL).hostname;
const ORIGIN = BASE_URL.replace(/^http:/, 'https:');

if (!ADMIN_API_SECRET) {
  console.error('❌ ADMIN_API_SECRET is required. Set environment variable.');
  process.exit(1);
}

const adminAuthHeader = { Authorization: `Bearer ${ADMIN_API_SECRET}` };

/**
 * Base64URL encode (without padding)
 */
function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/[=]+$/, '');
}

/**
 * Generate ECDSA P-256 key pair
 */
async function generateKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, // extractable
    ['sign', 'verify']
  );

  // Export in JWK format (including private key)
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

  return { privateKeyJwk, publicKeyJwk, keyPair };
}

/**
 * Encode public key in COSE format (ES256 / P-256)
 * Format used in WebAuthn attestation
 */
function encodeCOSEPublicKey(publicKeyJwk) {
  // COSE Key format for EC2 (ES256)
  // https://www.iana.org/assignments/cose/cose.xhtml
  //
  // {
  //   1: 2,           // kty: EC2
  //   3: -7,          // alg: ES256
  //   -1: 1,          // crv: P-256
  //   -2: x,          // x coordinate
  //   -3: y,          // y coordinate
  // }

  const x = Buffer.from(publicKeyJwk.x, 'base64url');
  const y = Buffer.from(publicKeyJwk.y, 'base64url');

  // Simple CBOR encoding for this fixed structure
  // Map with 5 entries
  const cborMap = Buffer.concat([
    Buffer.from([0xa5]), // map(5)
    // 1: 2 (kty: EC2)
    Buffer.from([0x01, 0x02]),
    // 3: -7 (alg: ES256)
    Buffer.from([0x03, 0x26]),
    // -1: 1 (crv: P-256)
    Buffer.from([0x20, 0x01]),
    // -2: x (bstr)
    Buffer.from([0x21, 0x58, 0x20]), // -2, bstr(32)
    x,
    // -3: y (bstr)
    Buffer.from([0x22, 0x58, 0x20]), // -3, bstr(32)
    y,
  ]);

  return cborMap;
}

/**
 * Build WebAuthn attestationObject (none attestation)
 */
function buildAttestationObject(authenticatorData) {
  // Simple CBOR encoding for attestation object
  // {
  //   "fmt": "none",
  //   "attStmt": {},
  //   "authData": <authenticatorData>
  // }

  const fmt = Buffer.from('none', 'utf8');
  const authData = Buffer.from(authenticatorData);

  // CBOR map with 3 entries
  const cbor = Buffer.concat([
    Buffer.from([0xa3]), // map(3)
    // "fmt": "none"
    Buffer.from([0x63]), // text(3)
    Buffer.from('fmt', 'utf8'),
    Buffer.from([0x64]), // text(4)
    fmt,
    // "attStmt": {}
    Buffer.from([0x67]), // text(7)
    Buffer.from('attStmt', 'utf8'),
    Buffer.from([0xa0]), // map(0)
    // "authData": <bytes>
    Buffer.from([0x68]), // text(8)
    Buffer.from('authData', 'utf8'),
    // bstr header for authData
    authData.length < 24
      ? Buffer.from([0x40 + authData.length])
      : authData.length < 256
        ? Buffer.from([0x58, authData.length])
        : Buffer.from([0x59, (authData.length >> 8) & 0xff, authData.length & 0xff]),
    authData,
  ]);

  return cbor;
}

/**
 * Build WebAuthn authenticatorData (for registration)
 */
async function buildRegistrationAuthenticatorData(rpId, credentialId, publicKeyJwk) {
  // rpIdHash (32 bytes)
  const rpIdHash = await crypto.subtle.digest('SHA-256', Buffer.from(rpId, 'utf8'));

  // flags (1 byte): UP=1, UV=1, AT=1 (attested credential data present)
  const flags = 0x45; // 0b01000101 = UP + UV + AT

  // signCount (4 bytes, big-endian)
  const signCount = Buffer.alloc(4);
  signCount.writeUInt32BE(0, 0);

  // Attested Credential Data
  // - aaguid (16 bytes, all zeros for software authenticator)
  const aaguid = Buffer.alloc(16);

  // - credentialIdLength (2 bytes, big-endian)
  const credentialIdBuffer = Buffer.from(credentialId);
  const credentialIdLength = Buffer.alloc(2);
  credentialIdLength.writeUInt16BE(credentialIdBuffer.length, 0);

  // - credentialId
  // - credentialPublicKey (COSE format)
  const cosePublicKey = encodeCOSEPublicKey(publicKeyJwk);

  return Buffer.concat([
    Buffer.from(rpIdHash),
    Buffer.from([flags]),
    signCount,
    aaguid,
    credentialIdLength,
    credentialIdBuffer,
    cosePublicKey,
  ]);
}

/**
 * Build WebAuthn clientDataJSON (for registration)
 */
function buildRegistrationClientDataJSON(challenge, origin) {
  return JSON.stringify({
    type: 'webauthn.create',
    challenge: challenge,
    origin: origin,
    crossOrigin: false,
  });
}

/**
 * Create user via Admin API
 */
async function createUser(index) {
  const timestamp = Date.now();
  const email = `${USER_ID_PREFIX}-${timestamp}-${index}@test.authrim.internal`;

  const res = await fetch(`${BASE_URL}/api/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...adminAuthHeader,
    },
    body: JSON.stringify({
      email,
      name: `Passkey Test User ${index}`,
      email_verified: true,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to create user: ${res.status} - ${error}`);
  }

  const data = await res.json();
  return {
    userId: data.user.id,
    email,
  };
}

/**
 * Get Passkey registration options
 */
async function getRegisterOptions(email, userId) {
  const res = await fetch(`${BASE_URL}/api/auth/passkey/register/options`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
    },
    body: JSON.stringify({ email, userId }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to get register options: ${res.status} - ${error}`);
  }

  return res.json();
}

/**
 * Verify Passkey registration
 */
async function verifyRegistration(userId, credential, deviceName) {
  const res = await fetch(`${BASE_URL}/api/auth/passkey/register/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
    },
    body: JSON.stringify({ userId, credential, deviceName }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to verify registration: ${res.status} - ${error}`);
  }

  return res.json();
}

/**
 * Passkey registration flow for a single user
 */
async function registerPasskeyUser(index) {
  // Step 1: Create user
  const { userId, email } = await createUser(index);

  // Step 2: Generate key pair
  const { privateKeyJwk, publicKeyJwk } = await generateKeyPair();

  // Step 3: Get registration options
  const { options } = await getRegisterOptions(email, userId);
  const challenge = options.challenge;

  // Step 4: Generate credentialId (random)
  const credentialIdBytes = crypto.randomBytes(32);
  const credentialId = base64UrlEncode(credentialIdBytes);

  // Step 5: Build WebAuthn registration response
  const clientDataJSON = buildRegistrationClientDataJSON(challenge, ORIGIN);
  const authenticatorData = await buildRegistrationAuthenticatorData(
    RP_ID,
    credentialIdBytes,
    publicKeyJwk
  );
  const attestationObject = buildAttestationObject(authenticatorData);

  const credential = {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: {
      clientDataJSON: base64UrlEncode(Buffer.from(clientDataJSON, 'utf8')),
      attestationObject: base64UrlEncode(attestationObject),
      transports: ['internal'],
    },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  };

  // Step 6: Verify registration
  await verifyRegistration(userId, credential, `Load Test Device ${index}`);

  return {
    userId,
    email,
    credentialId,
    privateKeyJwk,
    counter: 0,
    rpId: RP_ID,
  };
}

/**
 * Register users in batch
 */
async function registerBatch(startIndex, batchSize) {
  const promises = [];
  for (let i = 0; i < batchSize; i++) {
    const index = startIndex + i;
    promises.push(
      registerPasskeyUser(index).catch((err) => ({
        error: err.message,
        index,
      }))
    );
  }
  return Promise.all(promises);
}

async function main() {
  console.log("🚀 Passkey User Seed Generator");
  console.log(`   BASE_URL           : ${BASE_URL}`);
  console.log(`   RP_ID              : ${RP_ID}`);
  console.log(`   PASSKEY_USER_COUNT : ${PASSKEY_USER_COUNT}`);
  console.log(`   CONCURRENCY        : ${CONCURRENCY}`);
  console.log(`   OUTPUT_DIR         : ${OUTPUT_DIR}`);
  console.log('');

  const users = [];
  let errorCount = 0;
  const startTime = Date.now();

  const totalBatches = Math.ceil(PASSKEY_USER_COUNT / CONCURRENCY);
  let currentIndex = 0;

  for (let batch = 0; batch < totalBatches; batch++) {
    const remaining = PASSKEY_USER_COUNT - currentIndex;
    const batchSize = Math.min(CONCURRENCY, remaining);

    const results = await registerBatch(currentIndex, batchSize);
    currentIndex += batchSize;

    for (const result of results) {
      if (result.error) {
        errorCount++;
        console.error(`   ❌ User ${result.index}: ${result.error}`);
      } else {
        users.push(result);
      }
    }

    const progress = users.length;
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = progress / elapsed;

    if ((batch + 1) % 5 === 0 || batch === totalBatches - 1) {
      console.log(
        `   [${progress}/${PASSKEY_USER_COUNT}] ${rate.toFixed(1)}/s, errors: ${errorCount}, elapsed: ${elapsed.toFixed(1)}s`
      );
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;

  if (users.length === 0) {
    throw new Error('No users registered. Aborting.');
  }

  // Output
  const output = {
    users,
    metadata: {
      generated_at: new Date().toISOString(),
      base_url: BASE_URL,
      rp_id: RP_ID,
      total: users.length,
    },
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, 'passkey_users.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log('');
  console.log(`✅ Registered ${users.length} passkey users in ${totalTime.toFixed(2)}s`);
  console.log(`   Rate: ${(users.length / totalTime).toFixed(1)} users/sec`);
  console.log(`   Errors: ${errorCount}`);
  console.log(`📁 Saved to: ${outputPath}`);
  console.log('🎉 done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
