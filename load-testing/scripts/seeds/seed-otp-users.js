/**
 * OTP User Seed Generation Script
 *
 * Pre-create users for Mail OTP login benchmark.
 * Register users in D1 and output email list to file.
 *
 * Environment variables:
 *   BASE_URL           Target Authrim Worker URL (default: https://your-authrim.example.com)
 *   ADMIN_API_SECRET   Admin API secret (required)
 *   OTP_USER_COUNT     Number of users to generate (default: 500)
 *   CONCURRENCY        Parallel requests (default: 20)
 *   OUTPUT_DIR         Output directory (default: ../seeds)
 *   USER_PREFIX        User email prefix (default: otp-bench)
 *
 * Usage:
 *   BASE_URL=https://your-authrim.example.com \
 *   ADMIN_API_SECRET=xxx \
 *   OTP_USER_COUNT=1000 \
 *   node scripts/seed-otp-users.js
 *
 * Output files:
 *   seeds/otp_users.json    - User info (email, userId) as JSON array
 *   seeds/otp_user_list.txt - Email list (one email per line)
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Environment variables
const BASE_URL = process.env.BASE_URL || '';
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || '';
const OTP_USER_COUNT = Number.parseInt(process.env.OTP_USER_COUNT || '500', 10);
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || '20', 10);
const USER_PREFIX = process.env.USER_PREFIX || 'otp-bench';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(SCRIPT_DIR, '..', 'seeds');

// Request settings
const REQUEST_TIMEOUT = 15000;
const MAX_RETRIES = 3;

if (!ADMIN_API_SECRET) {
  console.error('❌ ADMIN_API_SECRET is required. Set environment variable.');
  process.exit(1);
}

const adminAuthHeader = { Authorization: `Bearer ${ADMIN_API_SECRET}` };

/**
 * Fetch with timeout
 */
async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Create user with retry
 */
async function createUserWithRetry(index, retryCount = 0) {
  const email = `${USER_PREFIX}-${String(index).padStart(5, '0')}@test.authrim.internal`;

  try {
    // First search for existing user
    // Note: Admin API search is partial match, so filter for exact email match
    const listRes = await fetchWithTimeout(
      `${BASE_URL}/api/admin/users?email=${encodeURIComponent(email)}`,
      { headers: adminAuthHeader }
    );

    if (listRes.ok) {
      const data = await listRes.json();
      if (data.users && data.users.length > 0) {
        // Find user with exact email match
        const exactMatch = data.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
        if (exactMatch) {
          return { email, userId: exactMatch.id, created: false };
        }
      }
    }

    // Create new user
    const createRes = await fetchWithTimeout(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: {
        ...adminAuthHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email,
        name: `OTP Benchmark User ${index}`,
        email_verified: true,
      }),
    });

    if (!createRes.ok) {
      // 409 Conflict = User already exists (not found in search but actually exists)
      if (createRes.status === 409) {
        return { email, userId: 'existing-conflict', created: false };
      }
      const error = await createRes.text();
      throw new Error(`HTTP ${createRes.status}: ${error}`);
    }

    const { user } = await createRes.json();
    return { email, userId: user.id, created: true };
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      // Exponential backoff
      await new Promise((r) => setTimeout(r, 100 * Math.pow(2, retryCount)));
      return createUserWithRetry(index, retryCount + 1);
    }
    throw err;
  }
}

/**
 * Create users in batch
 */
async function createUsersBatch(startIndex, batchSize) {
  const promises = [];
  for (let i = 0; i < batchSize; i++) {
    const index = startIndex + i;
    promises.push(
      createUserWithRetry(index).catch((err) => ({
        error: err.message,
        index,
      }))
    );
  }
  return Promise.all(promises);
}

/**
 * Main process
 */
async function main() {
  console.log('🚀 OTP User Seed Generator');
  console.log(`   BASE_URL       : ${BASE_URL}`);
  console.log(`   OTP_USER_COUNT : ${OTP_USER_COUNT}`);
  console.log(`   CONCURRENCY    : ${CONCURRENCY}`);
  console.log(`   USER_PREFIX    : ${USER_PREFIX}`);
  console.log(`   OUTPUT_DIR     : ${OUTPUT_DIR}`);
  console.log('');

  const users = [];
  let createdCount = 0;
  let existingCount = 0;
  let errorCount = 0;
  const startTime = Date.now();

  const totalBatches = Math.ceil(OTP_USER_COUNT / CONCURRENCY);

  console.log(`📋 Creating ${OTP_USER_COUNT} users in ${totalBatches} batches...`);
  console.log('');

  for (let batch = 0; batch < totalBatches; batch++) {
    const startIndex = batch * CONCURRENCY;
    const remaining = OTP_USER_COUNT - users.length - errorCount;
    const batchSize = Math.min(CONCURRENCY, remaining);

    const results = await createUsersBatch(startIndex, batchSize);

    for (const result of results) {
      if (result.error) {
        errorCount++;
        console.error(`   ❌ User ${result.index}: ${result.error}`);
      } else {
        users.push({ email: result.email, userId: result.userId });
        if (result.created) {
          createdCount++;
        } else {
          existingCount++;
        }
      }
    }

    // Progress display (every 10 batches or at the end)
    if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = users.length / elapsed;
      console.log(
        `   [${users.length}/${OTP_USER_COUNT}] ${rate.toFixed(1)}/s, ` +
          `created: ${createdCount}, existing: ${existingCount}, errors: ${errorCount}`
      );
    }
  }

  const totalTime = (Date.now() - startTime) / 1000;
  console.log('');
  console.log('✅ Seed generation complete:');
  console.log(`   Total users: ${users.length}`);
  console.log(`   New created: ${createdCount}`);
  console.log(`   Already existing: ${existingCount}`);
  console.log(`   Errors: ${errorCount}`);
  console.log(`   Time: ${totalTime.toFixed(1)}s`);
  console.log(`   Rate: ${(users.length / totalTime).toFixed(1)} users/sec`);

  if (users.length === 0) {
    console.error('❌ No users created. Aborting.');
    process.exit(1);
  }

  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Output JSON file (detailed info)
  const jsonPath = path.join(OUTPUT_DIR, 'otp_users.json');
  fs.writeFileSync(jsonPath, JSON.stringify(users, null, 2));
  console.log(`\n📁 Saved ${users.length} users to ${jsonPath}`);

  // Output text file (email addresses only, for k6)
  const txtPath = path.join(OUTPUT_DIR, 'otp_user_list.txt');
  fs.writeFileSync(txtPath, users.map((u) => u.email).join('\n') + '\n');
  console.log(`📁 Saved email list to ${txtPath}`);

  console.log('');
  console.log('💡 Usage with k6 benchmark:');
  console.log('   k6 run -e USER_LIST_PATH=../seeds/otp_user_list.txt \\');
  console.log('     -e PRESET=rps30 \\');
  console.log('     scripts/test-mail-otp-full-login-benchmark.js');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
