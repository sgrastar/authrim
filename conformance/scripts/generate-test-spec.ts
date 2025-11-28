#!/usr/bin/env npx tsx
/**
 * Generate Test Specification Script
 *
 * Generates a JSON test specification from the Plan API.
 * The specification includes information about which tests require screenshots.
 *
 * Usage:
 *   CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/generate-test-spec.ts --plan-name basic-op --output ./test-spec.json
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ConformanceClient } from './lib/conformance-client.js';
import type { TestPlanName, TestPlanConfig } from './lib/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFORMANCE_SERVER = 'https://www.certification.openid.net';

// Keywords that indicate screenshot upload is required
const SCREENSHOT_KEYWORDS = ['screenshot', 'uploaded', 'image should be'];

// Screenshot timing type - all possible values
type ScreenshotTiming =
  | 'on_error_page'
  | 'on_error_redirect'
  | 'on_login'
  | 'on_login_2nd'
  | 'on_login_3rd'
  | 'on_reauth'
  | 'on_consent'
  | 'on_consent_2nd'
  | 'on_logout'
  | 'on_logout_confirm'
  | 'on_session_check'
  | 'on_interaction'
  | 'on_account_selection'
  | 'on_mfa'
  | 'manual'
  | null;

interface TestSpecEntry {
  testModule: string;
  testSummary: string;
  variant: Record<string, string>;
  requiresScreenshot: boolean;
  screenshotTiming: ScreenshotTiming | string;  // string allows comma-separated values
  expectedError: string | null;
  notes: string;
}

interface TestSpec {
  planKey: string;
  planName: string;
  generatedAt: string;
  configFile: string;
  tests: TestSpecEntry[];
}

interface TestPlansConfig {
  plans: Record<string, {
    name: TestPlanName;
    displayName: string;
    configFile: string;
    variants?: Record<string, string>;
  }>;
}

/**
 * Analyze testModule name and testSummary to determine if screenshot is required
 * and what timing to use
 */
function analyzeTestSummary(
  testModule: string,
  testSummary: string | undefined
): {
  requiresScreenshot: boolean;
  screenshotTiming: ScreenshotTiming | string;
  expectedError: string | null;
} {
  const lowerModule = testModule.toLowerCase();
  const lowerSummary = (testSummary || '').toLowerCase();

  // Check if screenshot is required based on testSummary keywords
  const requiresScreenshot = SCREENSHOT_KEYWORDS.some((kw) =>
    lowerSummary.includes(kw.toLowerCase())
  );

  if (!requiresScreenshot) {
    return { requiresScreenshot: false, screenshotTiming: null, expectedError: null };
  }

  // Determine screenshot timing based on test module name and summary
  const timings: string[] = [];

  // ===== Error cases =====
  if (
    lowerSummary.includes('error') ||
    lowerSummary.includes('display') ||
    lowerModule.includes('missing') ||
    lowerModule.includes('invalid') ||
    lowerModule.includes('mismatch')
  ) {
    timings.push('on_error_page');
  }

  // ===== Login cases =====
  // prompt=login requires re-authentication (2nd login)
  if (lowerModule.includes('prompt-login') || lowerSummary.includes('prompt=login')) {
    timings.push('on_login_2nd');
  }

  // max_age requires re-authentication
  if (lowerModule.includes('max-age') || lowerSummary.includes('max_age')) {
    timings.push('on_reauth');
  }

  // id_token_hint tests may require multiple logins
  if (lowerModule.includes('id-token-hint') || lowerModule.includes('idtokenhint')) {
    timings.push('on_login_2nd');
  }

  // ===== Consent cases =====
  // prompt=consent requires re-consent (2nd consent)
  if (lowerModule.includes('prompt-consent') || lowerSummary.includes('prompt=consent')) {
    timings.push('on_consent_2nd');
  }

  // ===== Session/Logout cases =====
  if (lowerModule.includes('logout') || lowerSummary.includes('logout')) {
    timings.push('on_logout');
  }

  if (lowerModule.includes('session') || lowerSummary.includes('session')) {
    timings.push('on_session_check');
  }

  // ===== Account selection =====
  if (lowerModule.includes('select-account') || lowerSummary.includes('select_account')) {
    timings.push('on_account_selection');
  }

  // ===== Interaction required =====
  if (lowerModule.includes('interaction') || lowerSummary.includes('interaction_required')) {
    timings.push('on_interaction');
  }

  // ===== Prompt=none not logged in (special case - error expected) =====
  if (lowerModule.includes('prompt-none-not-logged-in')) {
    timings.push('on_error_page');
  }

  // Default to manual if no specific timing detected
  let screenshotTiming: ScreenshotTiming | string = 'manual';
  if (timings.length === 1) {
    screenshotTiming = timings[0] as ScreenshotTiming;
  } else if (timings.length > 1) {
    // Multiple timings - join with comma
    screenshotTiming = timings.join(',');
  }

  // Extract expected error codes from testSummary
  let expectedError: string | null = null;
  const errorPatterns = [
    /(?:unsupported_response_type|invalid_request|access_denied|login_required|interaction_required|consent_required|invalid_scope|invalid_grant|unauthorized_client|invalid_client)/gi,
  ];

  for (const pattern of errorPatterns) {
    const matches = testSummary?.match(pattern);
    if (matches) {
      expectedError = [...new Set(matches.map((m) => m.toLowerCase()))].join('|');
      break;
    }
  }

  return { requiresScreenshot, screenshotTiming, expectedError };
}

/**
 * Generate notes based on screenshotTiming
 */
function generateNotes(screenshotTiming: ScreenshotTiming | string | null): string {
  if (!screenshotTiming) {
    return '';
  }

  // Handle comma-separated timings
  const timings = String(screenshotTiming).split(',');

  const timingDescriptions: Record<string, string> = {
    on_error_page: 'エラーページ',
    on_error_redirect: 'エラーリダイレクト',
    on_login: 'ログイン画面',
    on_login_2nd: '2回目のログイン画面',
    on_login_3rd: '3回目のログイン画面',
    on_reauth: '再認証画面',
    on_consent: '同意画面',
    on_consent_2nd: '2回目の同意画面',
    on_logout: 'ログアウト画面',
    on_logout_confirm: 'ログアウト確認',
    on_session_check: 'セッションチェック',
    on_interaction: 'ユーザー操作画面',
    on_account_selection: 'アカウント選択画面',
    on_mfa: 'MFA認証画面',
    manual: '手動取得',
  };

  const descriptions = timings
    .map((t) => timingDescriptions[t.trim()] || t)
    .join('、');

  return `${descriptions}のスクリーンショットが必要`;
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      'plan-name': { type: 'string', short: 'p' },
      output: { type: 'string', short: 'o', default: './test-spec.json' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (args.help) {
    console.log(`
Generate Test Specification Script

Usage:
  npx tsx conformance/scripts/generate-test-spec.ts [options]

Options:
  -p, --plan-name <name>  Test plan name (e.g., basic-op, dynamic-op, fapi-2)
  -o, --output <path>     Output file path (default: ./test-spec.json)
  -h, --help              Show this help

Examples:
  npx tsx conformance/scripts/generate-test-spec.ts --plan-name basic-op
  npx tsx conformance/scripts/generate-test-spec.ts --plan-name dynamic-op --output ./specs/dynamic-op.json
`);
    process.exit(0);
  }

  const token = process.env.CONFORMANCE_TOKEN;
  if (!token) {
    console.error('Error: CONFORMANCE_TOKEN environment variable is required');
    process.exit(1);
  }

  const planKey = args['plan-name'];
  if (!planKey) {
    console.error('Error: --plan-name is required');
    process.exit(1);
  }

  // Load test plans configuration
  const configPath = path.join(__dirname, 'config', 'test-plans.json');
  const configContent = await fs.readFile(configPath, 'utf-8');
  const testPlansConfig = JSON.parse(configContent) as TestPlansConfig;

  const planDef = testPlansConfig.plans[planKey];
  if (!planDef) {
    console.error(`Error: Unknown plan "${planKey}"`);
    console.log(`Available plans: ${Object.keys(testPlansConfig.plans).join(', ')}`);
    process.exit(1);
  }

  console.log(`\nGenerating test specification for: ${planDef.displayName}`);
  console.log(`Plan name: ${planDef.name}`);
  console.log('');

  // Load plan configuration
  const planConfigPath = path.join(__dirname, 'config', planDef.configFile);
  const planConfigContent = await fs.readFile(planConfigPath, 'utf-8');
  const planConfig = JSON.parse(planConfigContent) as TestPlanConfig;

  // Create conformance client
  const client = new ConformanceClient(CONFORMANCE_SERVER, token);

  // Create a temporary test plan to get module information
  console.log('Creating temporary test plan to retrieve module information...');
  const createdPlan = await client.createTestPlan(planDef.name, planConfig, planDef.variants);

  console.log(`Plan ID: ${createdPlan.id}`);
  console.log(`Plan URL: ${client.getPlanUrl(createdPlan.id)}`);
  console.log('');

  // Fetch full plan details (POST response doesn't include testSummary, GET does)
  console.log('Fetching full plan details...');
  const testPlan = await client.getTestPlan(createdPlan.id);

  // Extract test modules with their testSummary
  const modules = testPlan.modules || [];
  console.log(`Found ${modules.length} test modules`);
  console.log('');

  // Generate test specification entries
  const testEntries: TestSpecEntry[] = [];
  let screenshotCount = 0;

  for (const module of modules) {
    const moduleDef = module as unknown as Record<string, unknown>;
    const testModule = moduleDef.testModule as string;
    const testSummary = (moduleDef.testSummary as string) || '';
    const variant = (moduleDef.variant as Record<string, string>) || {};

    const analysis = analyzeTestSummary(testModule, testSummary);
    const notes = generateNotes(analysis.screenshotTiming);

    if (analysis.requiresScreenshot) {
      screenshotCount++;
    }

    testEntries.push({
      testModule,
      testSummary,
      variant,
      requiresScreenshot: analysis.requiresScreenshot,
      screenshotTiming: analysis.screenshotTiming,
      expectedError: analysis.expectedError,
      notes,
    });
  }

  // Create test specification
  const testSpec: TestSpec = {
    planKey: planKey,
    planName: planDef.name,
    generatedAt: new Date().toISOString(),
    configFile: planDef.configFile,
    tests: testEntries,
  };

  // Write output file
  const outputPath = args.output as string;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(testSpec, null, 2), 'utf-8');

  console.log('='.repeat(60));
  console.log('Test Specification Generated');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Total tests: ${testEntries.length}`);
  console.log(`Tests requiring screenshot: ${screenshotCount}`);
  console.log('');
  console.log(`Output: ${outputPath}`);
  console.log('');

  if (screenshotCount > 0) {
    console.log('Tests requiring screenshot upload:');
    for (const entry of testEntries) {
      if (entry.requiresScreenshot) {
        console.log(`  - ${entry.testModule}`);
        console.log(`    Timing: ${entry.screenshotTiming}`);
        if (entry.expectedError) {
          console.log(`    Expected error: ${entry.expectedError}`);
        }
      }
    }
    console.log('');
  }

  console.log('Next steps:');
  console.log(`  1. Review and edit ${outputPath} as needed`);
  console.log(`  2. Run tests with: npx tsx run-conformance.ts --plan ${planKey} --spec ${outputPath}`);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
