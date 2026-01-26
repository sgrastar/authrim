/**
 * Info Command
 *
 * Displays detailed information about Authrim resources.
 * Designed for both interactive and CI use.
 */

import chalk from 'chalk';
import ora from 'ora';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { t } from '../../i18n/index.js';
import {
  isWranglerInstalled,
  checkAuth,
  detectEnvironments,
  getD1Info,
  getWorkerDeployments,
  type EnvironmentInfo,
} from '../../core/cloudflare.js';
import { resolvePaths, findAuthrimBaseDir, type EnvironmentPaths } from '../../core/paths.js';
import { AuthrimConfigSchema } from '../../core/config.js';

// =============================================================================
// Types
// =============================================================================

export interface InfoCommandOptions {
  env?: string;
  json?: boolean;
  d1?: boolean;
  workers?: boolean;
}

interface UiEnvInfo {
  exists: boolean;
  apiUrl?: string;
  configApiUrl?: string;
  inSync: boolean;
}

interface InfoOutput {
  environment: string;
  uiEnv?: UiEnvInfo;
  d1?: Array<{
    name: string;
    id: string;
    databaseSize?: string | null;
    numTables?: number | null;
    region?: string | null;
  }>;
  workers?: Array<{
    name: string;
    exists: boolean;
    versionId?: string | null;
    lastDeployedAt?: string | null;
    author?: string | null;
  }>;
}

// =============================================================================
// Info Command
// =============================================================================

export async function infoCommand(options: InfoCommandOptions): Promise<void> {
  if (!options.json) {
    console.log(chalk.bold('\n📊 Authrim Resource Info\n'));
  }

  // Check prerequisites
  const spinner = ora('Checking prerequisites...').start();

  if (!(await isWranglerInstalled())) {
    spinner.fail('Wrangler is not installed');
    if (!options.json) {
      console.log(chalk.yellow('\nInstall wrangler:'));
      console.log('  npm install -g wrangler');
    }
    process.exit(1);
  }

  const auth = await checkAuth();
  if (!auth.isLoggedIn) {
    spinner.fail('Not logged in to Cloudflare');
    if (!options.json) {
      console.log(chalk.yellow('\nLogin with:'));
      console.log('  wrangler login');
    }
    process.exit(1);
  }

  spinner.succeed(`Logged in as ${auth.email || 'unknown'}`);

  // Get environment
  let env = options.env;
  let envInfo: EnvironmentInfo | undefined;

  if (!env) {
    // Detect environments
    const detectSpinner = ora('Detecting environments...').start();
    const environments = await detectEnvironments();
    detectSpinner.stop();

    if (environments.length === 0) {
      if (options.json) {
        console.log(JSON.stringify({ error: 'No environments found' }));
      } else {
        console.log(chalk.yellow('\nNo Authrim environments found.'));
      }
      process.exit(0);
    }

    if (environments.length === 1) {
      env = environments[0].env;
      envInfo = environments[0];
    } else {
      // Interactive mode: ask which environment
      const { select } = await import('@inquirer/prompts');
      env = await select({
        message: t('manage.selectEnv'),
        choices: environments.map((e) => ({
          name: `${e.env} (${e.workers.length} workers, ${e.d1.length} D1, ${e.kv.length} KV)`,
          value: e.env,
        })),
      });
      envInfo = environments.find((e) => e.env === env);
    }
  } else {
    // Find environment info
    const detectSpinner = ora('Detecting environments...').start();
    const environments = await detectEnvironments();
    detectSpinner.stop();
    envInfo = environments.find((e) => e.env === env);

    if (!envInfo) {
      if (options.json) {
        console.log(JSON.stringify({ error: `Environment not found: ${env}` }));
      } else {
        console.error(chalk.red(`\nEnvironment not found: ${env}`));
      }
      process.exit(1);
    }
  }

  const output: InfoOutput = { environment: env };

  // Determine what to show (default: both)
  const showD1 = options.d1 || (!options.d1 && !options.workers);
  const showWorkers = options.workers || (!options.d1 && !options.workers);

  // UI Environment Information (always show if new structure)
  // Find actual base directory (searches common subdirectories like authrim/)
  const baseDir = findAuthrimBaseDir(process.cwd());
  const resolved = resolvePaths({ baseDir, env });

  if (resolved.type === 'new') {
    const envPaths = resolved.paths as EnvironmentPaths;
    const uiEnvPath = envPaths.uiEnv;
    const configPath = envPaths.config;

    let uiEnvInfo: UiEnvInfo = { exists: false, inSync: false };

    // Read ui.env
    let uiEnvApiUrl: string | undefined;
    if (existsSync(uiEnvPath)) {
      try {
        const uiEnvContent = await readFile(uiEnvPath, 'utf-8');
        // Handle both quoted and unquoted values:
        // - Double-quoted: PUBLIC_API_BASE_URL="value"
        // - Single-quoted: PUBLIC_API_BASE_URL='value'
        // - Unquoted: PUBLIC_API_BASE_URL=value
        const match = uiEnvContent.match(
          /PUBLIC_API_BASE_URL=(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s\n#]+))/
        );
        uiEnvApiUrl = match?.[1] ?? match?.[2] ?? match?.[3];
        // Unescape if needed (handle \" and \\)
        if (uiEnvApiUrl) {
          uiEnvApiUrl = uiEnvApiUrl.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        uiEnvInfo.exists = true;
        uiEnvInfo.apiUrl = uiEnvApiUrl;
      } catch {
        // Ignore read errors
      }
    }

    // Read config.json API URL
    let configApiUrl: string | undefined;
    if (existsSync(configPath)) {
      try {
        const configContent = await readFile(configPath, 'utf-8');
        const configData = JSON.parse(configContent);
        const config = AuthrimConfigSchema.parse(configData);
        configApiUrl = config.urls?.api?.custom || config.urls?.api?.auto;
        uiEnvInfo.configApiUrl = configApiUrl;
      } catch {
        // Ignore read/parse errors
      }
    }

    // Check if in sync (both must have values and match)
    uiEnvInfo.inSync = !!(uiEnvApiUrl && configApiUrl && uiEnvApiUrl === configApiUrl);
    output.uiEnv = uiEnvInfo;

    if (!options.json) {
      console.log(chalk.bold(`\n🔧 UI Environment`));

      if (uiEnvInfo.exists) {
        console.log(chalk.green(`  ✓ ui.env exists`));
        console.log(chalk.gray(`    API URL: ${uiEnvInfo.apiUrl || 'not set'}`));

        if (uiEnvInfo.inSync) {
          console.log(chalk.green(`    ✓ In sync with config.json`));
        } else {
          console.log(chalk.yellow(`    ⚠️  Out of sync with config.json`));
          console.log(
            chalk.gray(`    config.json API URL: ${uiEnvInfo.configApiUrl || 'not set'}`)
          );
          console.log(chalk.yellow(`    Tip: Run 'authrim-setup deploy' to sync`));
        }
      } else {
        console.log(chalk.yellow(`  ⚠️  ui.env not found`));
        console.log(chalk.gray(`    Expected at: ${uiEnvPath}`));
        if (configApiUrl) {
          console.log(chalk.gray(`    config.json API URL: ${configApiUrl}`));
        }
        console.log(chalk.yellow(`    Tip: Run 'authrim-setup deploy' to generate`));
      }
    }
  }

  // D1 Information
  if (showD1 && envInfo && envInfo.d1.length > 0) {
    if (!options.json) {
      console.log(chalk.bold(`\n📊 D1 Databases (${envInfo.d1.length})`));
    }

    output.d1 = [];

    for (const db of envInfo.d1) {
      const infoSpinner = options.json ? null : ora(`Fetching info for ${db.name}...`).start();

      try {
        const info = await getD1Info(db.name);
        infoSpinner?.succeed(db.name);

        output.d1.push({
          name: db.name,
          id: db.id,
          databaseSize: info.databaseSize,
          numTables: info.numTables,
          region: info.region,
        });

        if (!options.json) {
          console.log(chalk.gray(`    ID: ${db.id}`));
          if (info.databaseSize) {
            console.log(chalk.gray(`    Size: ${info.databaseSize}`));
          }
          if (info.numTables !== null && info.numTables !== undefined) {
            console.log(chalk.gray(`    Tables: ${info.numTables}`));
          }
          if (info.region) {
            console.log(chalk.gray(`    Region: ${info.region}`));
          }
        }
      } catch {
        infoSpinner?.fail(db.name);
        output.d1.push({
          name: db.name,
          id: db.id,
        });
      }
    }
  }

  // Worker Information
  if (showWorkers && envInfo && envInfo.workers.length > 0) {
    if (!options.json) {
      console.log(chalk.bold(`\n🔧 Workers (${envInfo.workers.length})`));
    }

    output.workers = [];

    for (const worker of envInfo.workers) {
      const infoSpinner = options.json ? null : ora(`Fetching info for ${worker.name}...`).start();

      try {
        const info = await getWorkerDeployments(worker.name);
        infoSpinner?.succeed(worker.name);

        output.workers.push({
          name: worker.name,
          exists: info.exists,
          versionId: info.versionId,
          lastDeployedAt: info.lastDeployedAt,
          author: info.author,
        });

        if (!options.json) {
          if (info.exists) {
            if (info.versionId) {
              console.log(chalk.gray(`    Version: ${info.versionId}`));
            }
            if (info.lastDeployedAt) {
              console.log(chalk.gray(`    Deployed: ${info.lastDeployedAt}`));
            }
            if (info.author) {
              console.log(chalk.gray(`    Author: ${info.author}`));
            }
          } else {
            console.log(chalk.yellow('    Status: Not deployed'));
          }
        }
      } catch {
        infoSpinner?.fail(worker.name);
        output.workers.push({
          name: worker.name,
          exists: false,
        });
      }
    }
  }

  // JSON output
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log('');
  }
}
