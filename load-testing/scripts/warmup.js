#!/usr/bin/env node
/**
 * Durable Object Warmup Script
 *
 * Pre-warms AuthCodeShard DOs before load testing to avoid cold start latency spikes.
 *
 * Usage:
 *   BASE_URL=https://conformance.authrim.com \
 *   ADMIN_API_SECRET=your-secret \
 *   node scripts/warmup.js
 *
 * Environment Variables:
 *   BASE_URL         - Target URL (default: https://conformance.authrim.com)
 *   ADMIN_API_SECRET - Admin API secret (required)
 *   BATCH_SIZE       - Number of DOs to warm per batch (default: 32)
 *   TYPE             - Type of warmup: auth-code, all (default: auth-code)
 */

import process from 'node:process';

const BASE_URL = process.env.BASE_URL || 'https://conformance.authrim.com';
const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '32', 10);
const TYPE = process.env.TYPE || 'auth-code';

if (!ADMIN_API_SECRET) {
  console.error('❌ ADMIN_API_SECRET is required');
  console.error('');
  console.error('Usage:');
  console.error('  ADMIN_API_SECRET=your-secret node scripts/warmup.js');
  process.exit(1);
}

async function warmup() {
  console.log('🔥 Starting Durable Object warm-up...');
  console.log(`   Target: ${BASE_URL}`);
  console.log(`   Type: ${TYPE}`);
  console.log(`   Batch Size: ${BATCH_SIZE}`);
  console.log('');

  const startTime = Date.now();

  try {
    const url = `${BASE_URL}/internal/warmup?type=${TYPE}&batch_size=${BATCH_SIZE}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${ADMIN_API_SECRET}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Warmup failed: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    console.log('✅ Warmup completed successfully!');
    console.log('');
    console.log('📊 Results:');
    console.log(`   Auth Code Shards: ${result.warmed_up.auth_code_shards}`);
    console.log(`   Refresh Token Shards: ${result.warmed_up.refresh_token_shards}`);
    console.log(`   Duration: ${result.duration_ms}ms`);
    console.log('');

    if (result.batch_details && result.batch_details.length > 0) {
      console.log('📋 Batch Details:');
      for (const batch of result.batch_details) {
        console.log(`   Batch ${batch.batch}: ${batch.count} shards in ${batch.duration_ms}ms`);
      }
    }

    const totalTime = Date.now() - startTime;
    console.log('');
    console.log(`⏱️  Total time: ${totalTime}ms`);

    return result;
  } catch (error) {
    console.error('❌ Warmup failed:', error.message);
    throw error;
  }
}

// Run warmup
warmup()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
