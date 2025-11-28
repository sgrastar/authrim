#!/usr/bin/env npx tsx
/**
 * Conformance Suite - Plan Cleanup Tool
 *
 * Usage:
 *   CONFORMANCE_TOKEN=xxx npx tsx cleanup.ts
 *
 * Interactive CLI to delete test plans with 10-second intervals
 */

import * as readline from 'readline';

const API_BASE = 'https://www.certification.openid.net';
const DELETE_INTERVAL_MS = 10000; // 10 seconds

interface TestModule {
  testModule: string;
  instances?: string[];
  variant?: Record<string, string>;
}

interface Plan {
  _id: string;
  planName: string;
  started: string;
  modules?: TestModule[];
  config?: { alias?: string };
}

interface ApiResponse {
  data: Plan[];
  recordsTotal: number;
}

// Format date as YYYY-MM-DD
function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toISOString().split('T')[0];
}

// Check if any test in the plan has been executed (has instances means test was run)
function hasExecutedTests(plan: Plan): boolean {
  if (!plan.modules || plan.modules.length === 0) return false;
  return plan.modules.some(m => m.instances && m.instances.length > 0);
}

// Count executed tests (modules with at least one instance)
function countExecutedTests(plan: Plan): number {
  if (!plan.modules) return 0;
  return plan.modules.filter(m => m.instances && m.instances.length > 0).length;
}

async function fetchPlans(token: string): Promise<Plan[]> {
  const allPlans: Plan[] = [];
  let start = 0;
  const length = 100;

  console.log('Fetching plans...');

  while (true) {
    // DataTables format pagination
    const url = `${API_BASE}/api/plan?start=${start}&length=${length}`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data: ApiResponse = await response.json();
    if (!data.data || data.data.length === 0) break;

    allPlans.push(...data.data);
    console.log(`  Fetched ${allPlans.length} plans...`);

    if (data.data.length < length) break;
    start += length;

    // Safety limit
    if (allPlans.length >= 1000) break;
  }

  return allPlans;
}

async function deletePlan(token: string, planId: string): Promise<{ success: boolean; message: string }> {
  const response = await fetch(`${API_BASE}/api/plan/${planId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (response.status === 204) {
    return { success: true, message: 'Deleted successfully' };
  } else if (response.status === 405) {
    return { success: false, message: 'Plan is immutable (published)' };
  } else if (response.status === 404) {
    return { success: false, message: 'Plan not found' };
  } else {
    return { success: false, message: `HTTP ${response.status}` };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

async function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  const token = process.env.CONFORMANCE_TOKEN;

  if (!token) {
    console.error('Error: CONFORMANCE_TOKEN environment variable is required');
    console.error('Usage: CONFORMANCE_TOKEN=xxx npx tsx cleanup.ts');
    process.exit(1);
  }

  const rl = createReadlineInterface();

  try {
    // Fetch plans
    const plans = await fetchPlans(token);
    console.log(`\nFound ${plans.length} plans total\n`);

    if (plans.length === 0) {
      console.log('No plans found.');
      rl.close();
      return;
    }

    // Group by executed tests
    const notExecutedPlans = plans.filter(p => !hasExecutedTests(p));
    const executedPlans = plans.filter(p => hasExecutedTests(p));

    console.log(`  Not executed (0 runs): ${notExecutedPlans.length}`);
    console.log(`  Has executed tests: ${executedPlans.length}\n`);

    // Show plans
    console.log('=== Plans List ===');
    plans.forEach((plan, index) => {
      const totalTests = plan.modules?.length || 0;
      const executedTests = countExecutedTests(plan);
      const alias = plan.config?.alias || plan._id;
      const created = formatDate(plan.started);
      const status = executedTests === 0 ? 'NOT RUN' : 'RAN';
      const testCount = `[${executedTests}/${totalTests}]`.padEnd(10);
      console.log(`${(index + 1).toString().padStart(3)}. ${created}  ${testCount} ${status.padEnd(7)} ${plan.planName} (${alias})`);
    });
    console.log('==================\n');

    // Selection prompt
    console.log('Selection options:');
    console.log('  "all"    - Select all plans');
    console.log('  "notrun" - Select only plans with no executed tests');
    console.log('  "1,2,5"  - Select specific plans by number');
    console.log('  "1-10"   - Select range of plans');
    console.log('  "q"      - Quit\n');

    const selection = await question(rl, 'Enter selection: ');

    if (selection.toLowerCase() === 'q') {
      console.log('Cancelled.');
      rl.close();
      return;
    }

    let selectedPlans: Plan[] = [];

    if (selection.toLowerCase() === 'all') {
      selectedPlans = plans;
    } else if (selection.toLowerCase() === 'notrun') {
      selectedPlans = notExecutedPlans;
    } else if (selection.includes('-') && !selection.includes(',')) {
      // Range selection like "1-10"
      const [startStr, endStr] = selection.split('-');
      const start = parseInt(startStr) - 1;
      const end = parseInt(endStr);
      selectedPlans = plans.slice(start, end);
    } else {
      // Comma-separated selection like "1,2,5"
      const indices = selection.split(',').map(s => parseInt(s.trim()) - 1);
      selectedPlans = indices.filter(i => i >= 0 && i < plans.length).map(i => plans[i]);
    }

    if (selectedPlans.length === 0) {
      console.log('No plans selected.');
      rl.close();
      return;
    }

    console.log(`\nSelected ${selectedPlans.length} plans for deletion.`);
    console.log(`Estimated time: ${Math.ceil(selectedPlans.length * 10 / 60)} minutes\n`);

    const confirm = await question(rl, 'Proceed with deletion? (yes/no): ');

    if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      rl.close();
      return;
    }

    // Delete plans
    console.log('\n=== Starting Deletion ===\n');

    let deleted = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < selectedPlans.length; i++) {
      const plan = selectedPlans[i];
      const alias = plan.config?.alias || plan._id;

      process.stdout.write(`[${i + 1}/${selectedPlans.length}] Deleting ${plan.planName} (${alias})... `);

      const result = await deletePlan(token, plan._id);

      if (result.success) {
        console.log('\x1b[32m✓\x1b[0m ' + result.message);
        deleted++;
      } else {
        console.log('\x1b[33m⚠\x1b[0m ' + result.message);
        if (result.message.includes('immutable')) {
          skipped++;
        } else {
          errors++;
        }
      }

      // Wait 10 seconds before next deletion (except for last one)
      if (i < selectedPlans.length - 1) {
        process.stdout.write(`  Waiting 10 seconds...`);
        for (let s = 10; s > 0; s--) {
          process.stdout.write(`\r  Waiting ${s} seconds... `);
          await sleep(1000);
        }
        process.stdout.write('\r                          \r');
      }
    }

    console.log('\n=== Deletion Complete ===');
    console.log(`  Deleted: ${deleted}`);
    console.log(`  Skipped (immutable): ${skipped}`);
    console.log(`  Errors: ${errors}`);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
