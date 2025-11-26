#!/usr/bin/env npx tsx
/**
 * Check Image Placeholders Script
 *
 * Checks which tests have image placeholders that need to be filled,
 * and provides manual upload functionality.
 *
 * Usage:
 *   CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/check-image-placeholders.ts --plan <planId>
 *   CONFORMANCE_TOKEN=xxx npx tsx conformance/scripts/check-image-placeholders.ts --module <moduleId> --upload ./screenshot.png
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ConformanceClient } from './lib/conformance-client.js';

const CONFORMANCE_SERVER = 'https://www.certification.openid.net';

interface TestLogEntry {
  _id?: string;
  src?: string;
  testId?: string;
  msg?: string;
  result?: string;
  upload?: {
    placeholder?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

async function main() {
  const args = process.argv.slice(2);
  let planId: string | undefined;
  let moduleId: string | undefined;
  let uploadPath: string | undefined;
  let placeholderName: string | undefined;
  let description: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--plan':
        planId = args[++i];
        break;
      case '--module':
        moduleId = args[++i];
        break;
      case '--upload':
        uploadPath = args[++i];
        break;
      case '--placeholder':
        placeholderName = args[++i];
        break;
      case '--description':
        description = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
Check Image Placeholders and Upload Script

Usage:
  npx tsx conformance/scripts/check-image-placeholders.ts [options]

Options:
  --plan <planId>         Check all tests in a plan for image placeholders
  --module <moduleId>     Check a specific test for image placeholders
  --upload <imagePath>    Upload an image to the specified module
  --placeholder <name>    Specify the placeholder to upload to (auto-detected if not specified)
  --description <text>    Description for the uploaded image
  --help, -h              Show this help

Examples:
  # Check placeholders in a plan
  npx tsx conformance/scripts/check-image-placeholders.ts --plan AecDYs1tbHdiD

  # Check placeholders in a specific module
  npx tsx conformance/scripts/check-image-placeholders.ts --module dgCRndFKYUThVZf

  # Upload image to a module (auto-detect placeholder)
  npx tsx conformance/scripts/check-image-placeholders.ts --module dgCRndFKYUThVZf --upload ./screenshot.png

  # Upload image to a specific placeholder
  npx tsx conformance/scripts/check-image-placeholders.ts --module dgCRndFKYUThVZf --upload ./screenshot.png --placeholder "error_screenshot"

  # Upload with description
  npx tsx conformance/scripts/check-image-placeholders.ts --module dgCRndFKYUThVZf --upload ./screenshot.png --description "Error page showing invalid_request"
`);
        process.exit(0);
    }
  }

  const token = process.env.CONFORMANCE_TOKEN;
  if (!token) {
    console.error('Error: CONFORMANCE_TOKEN environment variable is required');
    process.exit(1);
  }

  // Handle upload mode
  if (uploadPath) {
    if (!moduleId) {
      console.error('Error: --module is required when using --upload');
      process.exit(1);
    }

    const client = new ConformanceClient(CONFORMANCE_SERVER, token);
    await uploadImage(client, moduleId, uploadPath, placeholderName, description);
    return;
  }

  if (!planId && !moduleId) {
    console.error('Error: Either --plan or --module is required');
    process.exit(1);
  }

  const client = new ConformanceClient(CONFORMANCE_SERVER, token);

  try {
    if (moduleId) {
      // Check single module
      await checkModule(client, moduleId);
    } else if (planId) {
      // Check all modules in plan
      console.log(`\nChecking plan: ${planId}\n`);
      const plan = await client.getTestPlan(planId);
      console.log(`Plan: ${plan.name}`);

      const moduleInstances: Array<{ id: string; testModule: string }> = [];
      if (plan.modules) {
        for (const mod of plan.modules) {
          if (mod.instances && Array.isArray(mod.instances)) {
            for (const instance of mod.instances) {
              const id = typeof instance === 'string' ? instance : instance.id;
              moduleInstances.push({ id, testModule: mod.testModule || mod.testName || 'unknown' });
            }
          }
        }
      }

      console.log(`\nChecking ${moduleInstances.length} test modules for image placeholders...\n`);

      const testsWithPlaceholders: Array<{ testModule: string; id: string; placeholders: string[] }> = [];

      for (const mod of moduleInstances) {
        const placeholders = await checkModuleForPlaceholders(client, mod.id);
        if (placeholders.length > 0) {
          testsWithPlaceholders.push({
            testModule: mod.testModule,
            id: mod.id,
            placeholders,
          });
        }
      }

      console.log('\n' + '='.repeat(60));
      if (testsWithPlaceholders.length === 0) {
        console.log('No tests require image uploads.');
      } else {
        console.log(`Found ${testsWithPlaceholders.length} tests with image placeholders:\n`);
        for (const test of testsWithPlaceholders) {
          console.log(`  📷 ${test.testModule}`);
          console.log(`     Module ID: ${test.id}`);
          console.log(`     Placeholders: ${test.placeholders.join(', ')}`);
          console.log('');
        }
      }
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

async function checkModule(client: ConformanceClient, moduleId: string): Promise<void> {
  console.log(`\nChecking module: ${moduleId}\n`);

  const info = await client.getModuleInfo(moduleId);
  console.log(`Test: ${info.testName || 'Unknown'}`);
  console.log(`Status: ${info.status}`);
  console.log(`Result: ${info.result || 'N/A'}`);

  const placeholders = await checkModuleForPlaceholders(client, moduleId);

  console.log('\n' + '-'.repeat(40));
  if (placeholders.length === 0) {
    console.log('No image placeholders found.');
  } else {
    console.log(`Found ${placeholders.length} image placeholder(s):`);
    for (const placeholder of placeholders) {
      console.log(`  📷 ${placeholder}`);
    }
  }

  // Also check for any log entries that mention "upload" or "screenshot"
  const logs = await client.getTestLog(moduleId) as TestLogEntry[];
  const uploadLogs = logs.filter(
    (log) => log.upload || (log.msg && log.msg.toLowerCase().includes('screenshot'))
  );

  if (uploadLogs.length > 0) {
    console.log(`\nLog entries mentioning uploads/screenshots:`);
    for (const log of uploadLogs) {
      console.log(`  - ${log.msg || 'No message'}`);
      if (log.upload) {
        console.log(`    Upload info: ${JSON.stringify(log.upload)}`);
      }
    }
  }
}

async function checkModuleForPlaceholders(client: ConformanceClient, moduleId: string): Promise<string[]> {
  const logs = await client.getTestLog(moduleId) as TestLogEntry[];
  const placeholders: string[] = [];

  for (const log of logs) {
    if (log.upload && typeof log.upload === 'object') {
      if (log.upload.placeholder && typeof log.upload.placeholder === 'string') {
        placeholders.push(log.upload.placeholder);
      }
    }
  }

  return placeholders;
}

/**
 * Upload an image to a test module
 */
async function uploadImage(
  client: ConformanceClient,
  moduleId: string,
  imagePath: string,
  placeholderName?: string,
  description?: string
): Promise<void> {
  console.log(`\nUploading image to module: ${moduleId}`);
  console.log(`Image path: ${imagePath}`);

  // Verify file exists
  try {
    await fs.access(imagePath);
  } catch {
    console.error(`Error: File not found: ${imagePath}`);
    process.exit(1);
  }

  // Get module info
  const info = await client.getModuleInfo(moduleId);
  console.log(`Test: ${info.testName || 'Unknown'}`);
  console.log(`Status: ${info.status}`);
  console.log('');

  if (placeholderName) {
    // Upload to specific placeholder
    console.log(`Uploading to placeholder: ${placeholderName}`);
    try {
      await client.uploadScreenshotToPlaceholder(moduleId, placeholderName, imagePath);
      console.log(`✅ Successfully uploaded to placeholder: ${placeholderName}`);
    } catch (error) {
      console.error(`❌ Failed to upload to placeholder: ${error}`);
      process.exit(1);
    }
  } else {
    // Auto-detect placeholder or upload as new image
    const placeholders = await checkModuleForPlaceholders(client, moduleId);

    if (placeholders.length > 0) {
      console.log(`Found ${placeholders.length} placeholder(s): ${placeholders.join(', ')}`);
      console.log(`Uploading to first placeholder: ${placeholders[0]}`);

      try {
        await client.uploadScreenshotToPlaceholder(moduleId, placeholders[0], imagePath);
        console.log(`✅ Successfully uploaded to placeholder: ${placeholders[0]}`);
      } catch (error) {
        console.error(`❌ Failed to upload to placeholder: ${error}`);
        // Try uploading as new image
        console.log('Attempting to upload as new image...');
        try {
          await client.uploadScreenshot(moduleId, imagePath, description || 'Manually uploaded screenshot');
          console.log(`✅ Successfully uploaded as new image`);
        } catch (e) {
          console.error(`❌ Failed to upload as new image: ${e}`);
          process.exit(1);
        }
      }
    } else {
      // No placeholders, upload as new image
      console.log('No placeholders found, uploading as new image...');
      try {
        await client.uploadScreenshot(moduleId, imagePath, description || 'Manually uploaded screenshot');
        console.log(`✅ Successfully uploaded as new image`);
      } catch (error) {
        console.error(`❌ Failed to upload: ${error}`);
        process.exit(1);
      }
    }
  }

  console.log('');
  console.log(`View test: ${client.getModuleUrl(moduleId)}`);
}

main();
