#!/usr/bin/env npx tsx

/**
 * OIDC Conformance Test Runner
 *
 * Main entry point for running OIDC conformance tests against Authrim
 *
 * Usage:
 *   npx tsx conformance/scripts/run-conformance.ts --plan basic-op
 *   npx tsx conformance/scripts/run-conformance.ts --plan all --environment conformance
 */

import { parseArgs } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConformanceClient } from './lib/conformance-client.js';
import { BrowserAutomator } from './lib/browser-automator.js';
import { ProfileManager } from './lib/profile-manager.js';
import { ResultProcessor } from './lib/result-processor.js';
import { Logger, type OutputContext } from './lib/logger.js';
import type {
  TestPlanName,
  CertificationProfileName,
  TestPlanConfig,
  TestUser,
  ExpectedFailure,
  ModuleInfo,
} from './lib/types.js';

// Test specification types
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
  planName: string;
  generatedAt: string;
  configFile: string;
  tests: TestSpecEntry[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// Configuration
// ============================================================

interface TestPlanDefinition {
  name: TestPlanName;
  displayName: string;
  outputDir: string;
  profile: CertificationProfileName;
  configFile: string;
  requiresBrowser: boolean;
  variants?: Record<string, string>;
  description?: string;
}

interface TestPlansConfig {
  plans: Record<string, TestPlanDefinition>;
  environments: Record<string, { issuer: string; adminApiUrl: string }>;
}

/**
 * Load test plans configuration from JSON file
 */
async function loadTestPlansConfig(): Promise<TestPlansConfig> {
  const configPath = path.join(__dirname, 'config', 'test-plans.json');
  const configContent = await fs.readFile(configPath, 'utf-8');
  return JSON.parse(configContent) as TestPlansConfig;
}

// ============================================================
// Main Runner
// ============================================================

async function main() {
  const { values: args } = parseArgs({
    options: {
      plan: { type: 'string', short: 'p', default: 'basic-op' },
      environment: { type: 'string', short: 'e', default: 'conformance' },
      'show-browser': { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      'export-dir': { type: 'string', default: './conformance' },
      'skip-profile-switch': { type: 'boolean', default: false },
      'report-only': { type: 'boolean', default: false },
      spec: { type: 'string', short: 's' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  Authrim OIDC Conformance Test Runner                     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');

  // Load configuration from JSON file
  const config = await loadTestPlansConfig();
  const TEST_PLANS = config.plans;
  const ENVIRONMENTS = config.environments;

  // Validate environment variables
  const conformanceServer = process.env.CONFORMANCE_SERVER || 'https://www.certification.openid.net';
  const conformanceToken = process.env.CONFORMANCE_TOKEN;

  if (!conformanceToken) {
    console.error('Error: CONFORMANCE_TOKEN environment variable is required');
    console.log('');
    console.log('To get a token:');
    console.log('1. Login to https://www.certification.openid.net');
    console.log('2. Go to your account settings');
    console.log('3. Generate an API token');
    process.exit(1);
  }

  // Get environment configuration
  const envConfig = ENVIRONMENTS[args.environment as string];
  if (!envConfig) {
    console.error(`Error: Unknown environment "${args.environment}"`);
    console.log(`Available environments: ${Object.keys(ENVIRONMENTS).join(', ')}`);
    process.exit(1);
  }

  // Get test user configuration
  const testUser: TestUser = {
    email: process.env.CONFORMANCE_TEST_EMAIL || 'test@example.com',
    password: process.env.CONFORMANCE_TEST_PASSWORD || 'testpassword123',
  };

  console.log(`Environment: ${args.environment}`);
  console.log(`Issuer: ${envConfig.issuer}`);
  console.log(`Conformance Server: ${conformanceServer}`);
  console.log(`Test User: ${testUser.email}`);
  console.log('');

  // Determine which plans to run
  const plansToRun: string[] = args.plan === 'all'
    ? Object.keys(TEST_PLANS)
    : [args.plan as string];

  // Validate plans
  for (const planKey of plansToRun) {
    if (!TEST_PLANS[planKey]) {
      console.error(`Error: Unknown test plan "${planKey}"`);
      console.log(`Available plans: ${Object.keys(TEST_PLANS).join(', ')}`);
      process.exit(1);
    }
  }

  // Load test specification if provided
  let testSpec: TestSpec | null = null;
  if (args.spec) {
    try {
      const specContent = await fs.readFile(args.spec as string, 'utf-8');
      testSpec = JSON.parse(specContent) as TestSpec;
      console.log(`Test specification loaded: ${args.spec}`);
      const screenshotTests = testSpec.tests.filter((t) => t.requiresScreenshot);
      console.log(`  Tests requiring screenshot: ${screenshotTests.length}`);
      console.log('');
    } catch (error) {
      console.error(`Error loading test specification: ${error}`);
      process.exit(1);
    }
  }

  // Initialize components
  const conformanceClient = new ConformanceClient(conformanceServer, conformanceToken);
  const profileManager = new ProfileManager({
    adminApiUrl: envConfig.adminApiUrl,
    issuer: envConfig.issuer,
  });
  const resultProcessor = new ResultProcessor();
  const logger = new Logger();

  // Browser will be initialized per-plan with the correct output directory
  let browserAutomator: BrowserAutomator | null = null;
  const requiresBrowser = plansToRun.some((p) => TEST_PLANS[p].requiresBrowser);

  // Run each test plan
  const allResults = [];

  try {
    for (const planKey of plansToRun) {
      // Initialize logger for this plan
      // Use outputDir from config for the directory structure (e.g., "OIDC Basic OP")
      const outputContext = await logger.initialize(
        TEST_PLANS[planKey].outputDir,
        args['export-dir'] as string,
        args.verbose as boolean
      );

      logger.log('');
      logger.log('═'.repeat(60));
      logger.log(`Running: ${TEST_PLANS[planKey].displayName}`);
      logger.log('═'.repeat(60));
      logger.log('');
      logger.log(`Output directory: ${outputContext.outputDir}`);
      logger.log('');

      // Initialize browser for this plan with the correct screenshot dir
      if (TEST_PLANS[planKey].requiresBrowser && !args['report-only']) {
        const showBrowser = args['show-browser'] as boolean;
        logger.log(`Initializing browser... (headless: ${!showBrowser})`);
        browserAutomator = new BrowserAutomator({
          headless: !showBrowser,
          screenshotDir: outputContext.screenshotDir,
        });
        await browserAutomator.initialize();
      }

      try {
        const result = await runTestPlan(
          planKey,
          TEST_PLANS[planKey],
          {
            conformanceClient,
            profileManager,
            browserAutomator,
            resultProcessor,
            logger,
            outputContext,
            envConfig,
            testUser,
            testSpec,
            args: {
              skipProfileSwitch: args['skip-profile-switch'] as boolean,
              reportOnly: args['report-only'] as boolean,
              verbose: args.verbose as boolean,
              exportDir: args['export-dir'] as string,
            },
          }
        );
        allResults.push({ planKey, result, success: true });
      } catch (error) {
        logger.error(`Error running ${planKey}:`, error);
        allResults.push({ planKey, result: null, success: false, error });
      } finally {
        // Close browser after each plan
        if (browserAutomator) {
          logger.log('Closing browser...');
          await browserAutomator.close();
          browserAutomator = null;
        }
        // Close logger for this plan
        await logger.close();
      }
    }
  } finally {
    // Ensure browser is closed
    if (browserAutomator) {
      console.log('Closing browser...');
      await browserAutomator.close();
    }
  }

  // Print final summary
  console.log('');
  console.log('═'.repeat(60));
  console.log('Final Summary');
  console.log('═'.repeat(60));
  console.log('');

  let hasFailures = false;
  for (const { planKey, result, success, error } of allResults) {
    if (success && result) {
      const status = resultProcessor.isSuccessful(result) ? '✅ PASSED' : '❌ FAILED';
      console.log(`${status} ${TEST_PLANS[planKey].displayName}`);
      console.log(`   Pass Rate: ${result.summary.passRate}%`);
      console.log(`   Tests: ${result.summary.passed}/${result.summary.total} passed`);
      if (result.unexpectedFailures.length > 0) {
        console.log(`   Unexpected Failures: ${result.unexpectedFailures.length}`);
        hasFailures = true;
      }
    } else {
      console.log(`❌ ERROR ${TEST_PLANS[planKey].displayName}`);
      console.log(`   ${error}`);
      hasFailures = true;
    }
    console.log('');
  }

  process.exit(hasFailures ? 1 : 0);
}

// ============================================================
// Test Plan Runner
// ============================================================

interface RunContext {
  conformanceClient: ConformanceClient;
  profileManager: ProfileManager;
  browserAutomator: BrowserAutomator | null;
  resultProcessor: ResultProcessor;
  logger: Logger;
  outputContext: OutputContext;
  envConfig: { issuer: string; adminApiUrl: string };
  testUser: TestUser;
  testSpec: TestSpec | null;
  args: {
    skipProfileSwitch: boolean;
    reportOnly: boolean;
    verbose: boolean;
    exportDir: string;
  };
}

async function runTestPlan(
  planKey: string,
  planDef: TestPlanDefinition,
  context: RunContext
) {
  const {
    conformanceClient,
    profileManager,
    resultProcessor,
    browserAutomator,
    logger,
    outputContext,
    envConfig,
    testUser,
    testSpec,
    args,
  } = context;

  // Helper function to check if a test requires screenshot
  const getTestSpecEntry = (testModuleName: string): TestSpecEntry | undefined => {
    if (!testSpec) return undefined;
    return testSpec.tests.find((t) => t.testModule === testModuleName);
  };

  // Step 1: Switch profile (if not skipped)
  if (!args.skipProfileSwitch) {
    logger.log(`[1/5] Switching to profile: ${planDef.profile}`);
    await profileManager.switchProfileAndVerify(planDef.profile);
  } else {
    logger.log('[1/5] Skipping profile switch');
  }

  // Step 2: Load test configuration
  logger.log('[2/5] Loading test configuration...');
  const configPath = path.join(__dirname, 'config', planDef.configFile);
  const configContent = await fs.readFile(configPath, 'utf-8');
  let config: TestPlanConfig = JSON.parse(configContent);

  // Replace placeholders in config
  config = replaceConfigPlaceholders(config, {
    ISSUER: envConfig.issuer,
  });

  logger.debug('Config:', JSON.stringify(config, null, 2));

  // Step 3: Create test plan
  logger.log(`[3/5] Creating test plan: ${planDef.name}`);
  const testPlan = await conformanceClient.createTestPlan(
    planDef.name,
    config,
    planDef.variants
  );
  logger.log(`   Plan ID: ${testPlan.id}`);
  logger.log(`   Plan URL: ${conformanceClient.getPlanUrl(testPlan.id)}`);

  logger.debug('Test Plan Response:', JSON.stringify(testPlan, null, 2));

  // Step 4: Run test modules
  logger.log('[4/5] Running test modules...');
  const moduleInfos: ModuleInfo[] = [];

  // The API returns test module definitions, not instances
  // We need to create each test instance using createTestFromPlan
  const moduleDefinitions = testPlan.modules || [];
  if (moduleDefinitions.length > 0) {
    logger.debug('First module structure:', JSON.stringify(moduleDefinitions[0], null, 2));
  }

  logger.log(`   Total tests to run: ${moduleDefinitions.length}`);

  for (const moduleDef of moduleDefinitions) {
    // Get test name from the module definition
    const testModuleName = (moduleDef as unknown as Record<string, unknown>).testModule as string;
    const moduleVariant = (moduleDef as unknown as Record<string, unknown>).variant as Record<string, string> | undefined;

    if (!testModuleName) {
      logger.log(`   ⚠️ Skipping module with no testModule name`);
      continue;
    }

    logger.log(`   Creating test: ${testModuleName}`);

    // Some tests require a fresh session (no cookies)
    // These tests verify behavior when user is not logged in
    // Note: oidcc-prompt-login is NOT in this list because it needs an existing
    // session to test that prompt=login forces re-authentication
    const testsRequiringFreshSession = [
      'oidcc-prompt-none-not-logged-in',
    ];

    if (testsRequiringFreshSession.includes(testModuleName) && browserAutomator) {
      logger.log(`      Clearing session cookies for ${testModuleName}`);
      await browserAutomator.createFreshContext();
    }

    try {
      // Create the test instance from the plan
      const createdModule = await conformanceClient.createTestFromPlan(
        testPlan.id,
        testModuleName,
        moduleVariant
      );

      logger.debug(`Created module response:`, JSON.stringify(createdModule, null, 2));

      const moduleId = createdModule.id || (createdModule as unknown as Record<string, unknown>)._id as string;
      logger.debug(`Module ID: ${moduleId}`);

      if (!moduleId) {
        logger.log(`   ⚠️ Failed to create test instance for ${testModuleName}`);
        moduleInfos.push({
          testId: testModuleName,
          testName: testModuleName,
          status: 'INTERRUPTED',
          result: 'FAILED',
          logs: [],  // Empty logs for failed module creation
        });
        continue;
      }

      // Wait for test to be ready
      let status = await conformanceClient.waitForState(moduleId, ['CONFIGURED', 'WAITING', 'FINISHED'], {
        onPoll: (s) => logger.debug(`Status: ${s}`),
      });

      // Handle browser interactions (may require multiple rounds for tests like prompt=login)
      // Some tests require multiple authorization requests (e.g., prompt=login, max_age, id_token_hint)
      let browserInteractionCount = 0;
      const maxBrowserInteractions = 5; // Safety limit
      let processedLogIds = new Set<string>(); // Track already processed auth URLs

      while (status === 'WAITING' && planDef.requiresBrowser && browserAutomator && browserInteractionCount < maxBrowserInteractions) {
        browserInteractionCount++;

        // Get test logs to find the authorization URL
        const logs = await conformanceClient.getTestLog(moduleId);

        // Look for the authorization URL in the logs
        // The Conformance Suite logs the redirect URL in BuildPlainRedirectToAuthorizationEndpoint
        let authUrl: string | undefined;
        let authLogId: string | undefined;
        for (const log of logs) {
          const logAny = log as unknown as Record<string, unknown>;
          const logId = logAny._id as string;

          // Skip already processed logs
          if (logId && processedLogIds.has(logId)) {
            continue;
          }

          // Check for BuildPlainRedirectToAuthorizationEndpoint - this contains the auth URL
          if (log.src?.includes('BuildPlainRedirectToAuthorizationEndpoint') ||
              log.src?.includes('RedirectToAuthorizationEndpoint')) {
            logger.debug(`Found redirect log entry: src=${log.src}, msg=${log.msg}`);
            logger.debug(`Full log:`, JSON.stringify(logAny, null, 2));

            // The URL might be in the msg or in a separate field
            const urlMatch = log.msg?.match(/https?:\/\/[^\s"'<>\]]+/);
            if (urlMatch) {
              authUrl = urlMatch[0];
              authLogId = logId;
              logger.log(`      Found auth URL in log (src: ${log.src})`);
              break;
            }
            // Check if the log has a 'redirect_to_authorization_endpoint' or 'redirect_to' field
            if (logAny.redirect_to_authorization_endpoint) {
              authUrl = logAny.redirect_to_authorization_endpoint as string;
              authLogId = logId;
              logger.log(`      Found auth URL in redirect_to_authorization_endpoint field`);
              break;
            }
            if (logAny.redirect_to) {
              authUrl = logAny.redirect_to as string;
              authLogId = logId;
              logger.log(`      Found auth URL in redirect_to field`);
              break;
            }
          }

          // Also check for logs that contain the actual URL
          if (log.msg?.includes('conformance.authrim.com/authorize') ||
              log.msg?.includes('conformance.authrim.com/oauth/authorize')) {
            const urlMatch = log.msg?.match(/https?:\/\/conformance\.authrim\.com[^\s"'<>\]]+/);
            if (urlMatch) {
              authUrl = urlMatch[0];
              authLogId = logId;
              logger.log(`      Found auth URL in message`);
              break;
            }
          }
        }

        // If still no URL, dump all logs for debugging
        if (!authUrl) {
          logger.debug(`⚠️ No auth URL found. Dumping relevant log entries...`);
          for (const log of logs) {
            const logAny = log as unknown as Record<string, unknown>;
            // Show full log structure for logs related to authorization
            if (log.src?.toLowerCase().includes('redirect') ||
                log.src?.toLowerCase().includes('authorization') ||
                log.msg?.toLowerCase().includes('redirect')) {
              logger.debug(`Log entry:`, JSON.stringify(logAny, null, 2));
            }
          }
          break; // No more auth URLs to process
        }

        // Mark this log as processed
        if (authLogId) {
          processedLogIds.add(authLogId);
        }

        logger.log(`      Browser action required (round ${browserInteractionCount}): ${authUrl}`);

        // Check if this test requires screenshot capture
        const specEntry = getTestSpecEntry(testModuleName);
        const timings = specEntry?.screenshotTiming ? String(specEntry.screenshotTiming).split(',') : [];

        // Determine if we should capture on error page
        const captureOnError = specEntry?.requiresScreenshot && (
          timings.includes('on_error_page') ||
          timings.includes('on_error_redirect') ||
          timings.includes('on_interaction')
        );

        // Determine if we should capture on login/reauth (2nd, 3rd login)
        const captureOnLogin = specEntry?.requiresScreenshot && (
          timings.includes('on_login') ||
          timings.includes('on_login_2nd') ||
          timings.includes('on_login_3rd') ||
          timings.includes('on_reauth')
        );

        // Determine if we should capture on consent
        const captureOnConsent = specEntry?.requiresScreenshot && (
          timings.includes('on_consent') ||
          timings.includes('on_consent_2nd')
        );

        // Helper function to upload screenshot
        const uploadScreenshot = async (screenshotPath: string) => {
          logger.log(`      📷 Evidence screenshot captured: ${screenshotPath}`);

          const placeholders = await conformanceClient.findImagePlaceholders(moduleId);
          if (placeholders.length > 0) {
            try {
              await conformanceClient.uploadScreenshotToPlaceholder(
                moduleId,
                placeholders[0],
                screenshotPath
              );
              logger.log(`      ✅ Screenshot uploaded to placeholder: ${placeholders[0]}`);
            } catch (uploadError) {
              logger.log(`      ⚠️ Failed to upload to placeholder: ${uploadError}`);
              try {
                await conformanceClient.uploadScreenshot(
                  moduleId,
                  screenshotPath,
                  `Evidence screenshot for ${testModuleName}`
                );
                logger.log(`      ✅ Screenshot uploaded as new image`);
              } catch (e) {
                logger.log(`      ❌ Failed to upload screenshot: ${e}`);
              }
            }
          } else {
            try {
              await conformanceClient.uploadScreenshot(
                moduleId,
                screenshotPath,
                `Evidence screenshot for ${testModuleName}`
              );
              logger.log(`      ✅ Screenshot uploaded as new image`);
            } catch (e) {
              logger.log(`      ⚠️ Failed to upload screenshot: ${e}`);
            }
          }
        };

        try {
          if (captureOnError) {
            // Use evidence capture method for error-related screenshots
            const result = await browserAutomator.handleUserInteractionWithEvidence(authUrl, testUser, {
              testName: testModuleName,
              captureOnError: true,
            });

            if (result.screenshotPath) {
              await uploadScreenshot(result.screenshotPath);
            } else {
              // Fallback: Force screenshot capture if none was taken
              // This ensures we always have evidence for error-related tests
              logger.log(`      ⚠️ No screenshot captured, forcing capture...`);
              try {
                const page = await browserAutomator.getNewPage();
                try {
                  await page.goto(authUrl, { waitUntil: 'networkidle', timeout: 15000 });
                  const forcedScreenshotPath = await browserAutomator.takeScreenshot(page, 'evidence');
                  await uploadScreenshot(forcedScreenshotPath);
                  logger.log(`      ✅ Forced screenshot captured and uploaded`);
                } finally {
                  await page.close();
                }
              } catch (forceError) {
                logger.log(`      ⚠️ Forced screenshot capture failed: ${forceError}`);
              }
            }
          } else if (captureOnLogin || captureOnConsent) {
            // For login/consent captures, we need to take screenshot during specific interactions
            // Currently using standard method but capturing specific screens
            // Note: For 2nd login (on_login_2nd), this is round 2 or later
            const shouldCapture = (captureOnLogin && browserInteractionCount >= 2) ||
                                  (captureOnConsent && browserInteractionCount >= 1);

            if (shouldCapture) {
              const result = await browserAutomator.handleUserInteractionWithEvidence(authUrl, testUser, {
                testName: testModuleName,
                captureOnError: true,  // Also capture if error occurs
                captureOnInteraction: true, // Capture login/consent screen as evidence
              });

              if (result.screenshotPath) {
                await uploadScreenshot(result.screenshotPath);
              }
            } else {
              await browserAutomator.handleUserInteraction(authUrl, testUser, { testName: testModuleName });
            }
          } else {
            // Use standard method for tests that don't need screenshots
            await browserAutomator.handleUserInteraction(authUrl, testUser, { testName: testModuleName });
          }
        } catch (browserError) {
          logger.log(`      Browser error: ${browserError}`);
        }

        // Wait for test to reach next state (WAITING for more interaction, or FINISHED)
        status = await conformanceClient.waitForState(moduleId, ['WAITING', 'FINISHED'], {
          timeoutMs: 60000,
        });
      }

      // Get final module info
      const info = await conformanceClient.getModuleInfo(moduleId);
      const finalLogs = await conformanceClient.getTestLog(moduleId);
      moduleInfos.push({ ...info, logs: finalLogs });

      const resultEmoji = info.result === 'PASSED' ? '✅' : info.result === 'FAILED' ? '❌' : '⚠️';
      logger.log(`   ${resultEmoji} ${testModuleName}: ${info.result || 'UNKNOWN'}`);
    } catch (error) {
      logger.log(`   ❌ ${testModuleName}: ERROR - ${error}`);
      moduleInfos.push({
        testId: testModuleName,
        testName: testModuleName,
        status: 'INTERRUPTED',
        result: 'FAILED',
        logs: [],  // Empty logs for error during test execution
      });
    }

    // Add delay between tests to prevent alias conflict on conformance server
    // This ensures the previous test is fully completed before starting the next one
    // Increased to 3000ms as 1500ms was not enough when screenshot upload is involved
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  // Step 5: Process and export results
  logger.log('[5/5] Processing results...');

  // Load expected failures
  const expectedFailuresPath = path.join(__dirname, 'expected', 'expected-failures.json');
  let expectedFailures: ExpectedFailure[] = [];
  try {
    const efContent = await fs.readFile(expectedFailuresPath, 'utf-8');
    const efData = JSON.parse(efContent);
    const efPlanData = efData[planKey];
    expectedFailures = Array.isArray(efPlanData) ? efPlanData : [];
  } catch {
    // No expected failures file
  }

  const result = resultProcessor.processResults(
    testPlan.id,
    planDef.displayName,
    moduleInfos,
    expectedFailures
  );

  // Export results to the output directory
  const exportDir = outputContext.outputDir;

  // Save Markdown report
  const mdReport = resultProcessor.generateMarkdownReport(result);
  const mdPath = path.join(exportDir, 'report.md');
  await fs.writeFile(mdPath, mdReport);
  logger.log(`   Report saved: ${mdPath}`);

  // Save JSON summary
  const jsonSummary = resultProcessor.generateJsonSummary(result);
  const jsonPath = path.join(exportDir, 'summary.json');
  await fs.writeFile(jsonPath, jsonSummary);
  logger.log(`   Summary saved: ${jsonPath}`);

  // Export HTML from conformance suite
  try {
    const htmlPath = await conformanceClient.exportHtml(testPlan.id, exportDir);
    logger.log(`   HTML exported: ${htmlPath}`);
  } catch (error) {
    logger.log(`   HTML export failed: ${error}`);
  }

  return result;
}

// ============================================================
// Utilities
// ============================================================

function replaceConfigPlaceholders(
  config: TestPlanConfig,
  replacements: Record<string, string>
): TestPlanConfig {
  let configStr = JSON.stringify(config);

  for (const [key, value] of Object.entries(replacements)) {
    configStr = configStr.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }

  return JSON.parse(configStr);
}

function printHelp() {
  console.log(`
Authrim OIDC Conformance Test Runner

Usage:
  npx tsx conformance/scripts/run-conformance.ts [options]

Options:
  -p, --plan <name>        Test plan to run (default: basic-op)
                           Available: basic-op, config-op, dynamic-op, fapi-2, hybrid-op, all
  -e, --environment <name> Target environment (default: conformance)
                           Available: conformance, staging, local
  -s, --spec <path>        Path to test specification JSON file
                           Generated by generate-test-spec.ts
                           Enables automatic screenshot capture for specified tests
  --show-browser           Show browser window (for debugging, default: headless)
  --skip-profile-switch    Skip switching the certification profile
  --report-only            Only generate reports from previous results
  --export-dir <path>      Base directory for exporting results (default: ./conformance)
                           Results are saved to: <export-dir>/<display-name>/results/<timestamp>/
  -v, --verbose            Enable verbose output
  -h, --help               Show this help message

Environment Variables:
  CONFORMANCE_TOKEN        Required. API token for OpenID Conformance Suite
  CONFORMANCE_SERVER       Conformance Suite URL (default: https://www.certification.openid.net)
  CONFORMANCE_TEST_EMAIL   Test user email (default: test@example.com)
  CONFORMANCE_TEST_PASSWORD Test user password (default: testpassword123)

Examples:
  # Run Basic OP tests (headless)
  CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/run-conformance.ts --plan basic-op

  # Generate test specification first, then run with it
  CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/generate-test-spec.ts --plan-name basic-op --output ./test-spec.json
  # Review and edit test-spec.json as needed
  CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/run-conformance.ts --plan basic-op --spec ./test-spec.json

  # Run all tests with visible browser (for debugging)
  CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/run-conformance.ts --plan all --show-browser

  # Run against local environment
  CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/run-conformance.ts --plan basic-op --environment local
`);
}

// ============================================================
// Entry Point
// ============================================================

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
