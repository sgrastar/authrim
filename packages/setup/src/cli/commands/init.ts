/**
 * Init Command - Setup wizard for Authrim
 *
 * Provides both CLI and Web UI modes for setting up Authrim.
 */

import { input, select, confirm, password } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createDefaultConfig, parseConfig, type AuthrimConfig } from '../../core/config.js';
import { generateAllSecrets, saveKeysToDirectory, generateKeyId } from '../../core/keys.js';
import { generateWranglerConfig, toToml } from '../../core/wrangler.js';
import {
  getEnabledComponents,
  CORE_WORKER_COMPONENTS,
  type WorkerComponent,
} from '../../core/naming.js';
import {
  isWranglerInstalled,
  checkAuth,
  provisionResources,
  toResourceIds,
  uploadSecret,
  getAccountId,
} from '../../core/cloudflare.js';
import {
  createLockFile,
  saveLockFile,
  loadLockFile,
  lockToResourceIds,
  getLockFileSummary,
} from '../../core/lock.js';

// =============================================================================
// Types
// =============================================================================

interface InitOptions {
  cli?: boolean;
  config?: string;
  keep?: string;
  env?: string;
}

// =============================================================================
// Banner
// =============================================================================

function printBanner(): void {
  console.log('');
  console.log(chalk.blue('╔═══════════════════════════════════════════════════════════╗'));
  console.log(
    chalk.blue('║') +
      chalk.bold.white('           🔐 Authrim Setup v0.1.0                        ') +
      chalk.blue('║')
  );
  console.log(
    chalk.blue('║') +
      chalk.gray('     OIDC Provider on Cloudflare Workers                  ') +
      chalk.blue('║')
  );
  console.log(chalk.blue('╚═══════════════════════════════════════════════════════════╝'));
  console.log('');
}

// =============================================================================
// Main Command
// =============================================================================

export async function initCommand(options: InitOptions): Promise<void> {
  printBanner();

  // Load existing config if provided
  if (options.config) {
    await handleExistingConfig(options.config);
    return;
  }

  // CLI mode or Web UI mode
  if (options.cli) {
    await runCliSetup(options);
  } else {
    // Start Web UI
    console.log(chalk.cyan('ℹ️  Web UIモードを起動します...'));
    console.log(chalk.gray('   CLIモードを使用する場合は --cli オプションを追加してください'));
    console.log('');

    const { startWebServer } = await import('../../web/server.js');
    await startWebServer({ openBrowser: true });
  }
}

// =============================================================================
// CLI Setup Flow
// =============================================================================

async function runCliSetup(options: InitOptions): Promise<void> {
  // Step 1: Choose setup mode
  const setupMode = await select({
    message: 'セットアップモードを選択してください',
    choices: [
      {
        value: 'quick',
        name: '⚡ クイックセットアップ (5分で完了)',
        description: '最小限の設定でAuthrimをデプロイします',
      },
      {
        value: 'normal',
        name: '🔧 通常セットアップ (カスタマイズ)',
        description: '詳細な設定を行いながらセットアップします',
      },
    ],
  });

  if (setupMode === 'quick') {
    await runQuickSetup(options);
  } else {
    await runNormalSetup(options);
  }
}

// =============================================================================
// Quick Setup
// =============================================================================

async function runQuickSetup(options: InitOptions): Promise<void> {
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('⚡ クイックセットアップ'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Step 1: Environment prefix
  const envPrefix = await select({
    message: '環境を選択してください',
    choices: [
      { value: 'prod', name: 'prod (本番環境)' },
      { value: 'staging', name: 'staging (ステージング環境)' },
      { value: 'dev', name: 'dev (開発環境)' },
    ],
    default: options.env || 'prod',
  });

  // Step 2: Cloudflare API Token
  const cfApiToken = await password({
    message: 'Cloudflare API Token を入力してください',
    mask: '*',
    validate: (value) => {
      if (!value || value.length < 10) {
        return 'API Token を入力してください';
      }
      return true;
    },
  });

  // Step 3: Domain configuration
  const useCustomDomain = await confirm({
    message: 'カスタムドメインを設定しますか？',
    default: false,
  });

  let apiDomain: string | null = null;
  let loginUiDomain: string | null = null;
  let adminUiDomain: string | null = null;

  if (useCustomDomain) {
    apiDomain = await input({
      message: 'API（issuer）ドメイン',
      validate: (value) => {
        if (!value) return true; // Allow empty for workers.dev fallback
        if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value)) {
          return '有効なドメイン名を入力してください (例: auth.example.com)';
        }
        return true;
      },
    });

    loginUiDomain = await input({
      message: 'Login UIドメイン (Enterでスキップ)',
      default: '',
    });

    adminUiDomain = await input({
      message: 'Admin UIドメイン (Enterでスキップ)',
      default: '',
    });
  }

  // Create configuration
  const config = createDefaultConfig(envPrefix);
  config.urls = {
    api: {
      custom: apiDomain || null,
      auto: `https://${envPrefix}-ar-router.workers.dev`, // Placeholder
    },
    loginUi: {
      custom: loginUiDomain || null,
      auto: `https://${envPrefix}-ar-ui.pages.dev`,
    },
    adminUi: {
      custom: adminUiDomain || null,
      auto: `https://${envPrefix}-ar-ui.pages.dev/admin`,
    },
  };

  // Show summary
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('📋 設定内容'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');
  console.log(`  環境:        ${chalk.cyan(envPrefix)}`);
  console.log(`  API URL:     ${chalk.cyan(config.urls.api.custom || config.urls.api.auto)}`);
  console.log(
    `  Login UI:    ${chalk.cyan(config.urls.loginUi.custom || config.urls.loginUi.auto)}`
  );
  console.log(
    `  Admin UI:    ${chalk.cyan(config.urls.adminUi.custom || config.urls.adminUi.auto)}`
  );
  console.log('');

  const proceed = await confirm({
    message: 'この設定でセットアップを開始しますか？',
    default: true,
  });

  if (!proceed) {
    console.log(chalk.yellow('セットアップをキャンセルしました。'));
    return;
  }

  // Run setup
  await executeSetup(config, cfApiToken, options.keep);
}

// =============================================================================
// Normal Setup
// =============================================================================

async function runNormalSetup(options: InitOptions): Promise<void> {
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('🔧 通常セットアップ'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Step 1: Environment prefix
  const envPrefix = await input({
    message: '環境識別子を入力してください',
    default: options.env || 'prod',
    validate: (value) => {
      if (!/^[a-z][a-z0-9-]*$/.test(value)) {
        return '小文字英数字とハイフンのみ使用できます（例: prod, staging, dev）';
      }
      return true;
    },
  });

  // Step 2: Cloudflare API Token
  const cfApiToken = await password({
    message: 'Cloudflare API Token を入力してください',
    mask: '*',
    validate: (value) => {
      if (!value || value.length < 10) {
        return 'API Token を入力してください';
      }
      return true;
    },
  });

  // Step 3: Profile selection
  const profile = await select({
    message: 'OIDCプロファイルを選択してください',
    choices: [
      {
        value: 'basic-op',
        name: 'Basic OP (基本的なOIDCプロバイダ)',
        description: '標準的なOIDC機能を提供します',
      },
      {
        value: 'fapi-rw',
        name: 'FAPI Read-Write (金融グレード)',
        description: 'FAPI 1.0 Read-Write Security Profile準拠',
      },
      {
        value: 'fapi2-security',
        name: 'FAPI 2.0 Security Profile',
        description: 'FAPI 2.0 Security Profile準拠（最高セキュリティ）',
      },
    ],
    default: 'basic-op',
  });

  // Step 4: Domain configuration
  const useCustomDomain = await confirm({
    message: 'カスタムドメインを設定しますか？',
    default: false,
  });

  let apiDomain: string | null = null;
  let loginUiDomain: string | null = null;
  let adminUiDomain: string | null = null;

  if (useCustomDomain) {
    apiDomain = await input({
      message: 'API（issuer）ドメイン',
      validate: (value) => {
        if (!value) return true;
        if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value)) {
          return '有効なドメイン名を入力してください';
        }
        return true;
      },
    });

    loginUiDomain = await input({
      message: 'Login UIドメイン (Enterでスキップ)',
      default: '',
    });

    adminUiDomain = await input({
      message: 'Admin UIドメイン (Enterでスキップ)',
      default: '',
    });
  }

  // Step 5: Optional components
  console.log('');
  console.log(chalk.blue('━━━ オプションコンポーネント ━━━'));
  console.log('');

  const enableSaml = await confirm({
    message: 'SAMLサポートを有効にしますか？',
    default: false,
  });

  const enableVc = await confirm({
    message: 'Verifiable Credentialsを有効にしますか？',
    default: false,
  });

  const enableBridge = await confirm({
    message: 'External IdP Bridgeを有効にしますか？',
    default: false,
  });

  const enablePolicy = await confirm({
    message: 'ReBAC Policyサービスを有効にしますか？',
    default: false,
  });

  // Step 6: Feature flags
  console.log('');
  console.log(chalk.blue('━━━ 機能フラグ ━━━'));
  console.log('');

  const enableQueue = await confirm({
    message: 'Cloudflare Queuesを有効にしますか？（監査ログ等）',
    default: false,
  });

  const enableR2 = await confirm({
    message: 'Cloudflare R2を有効にしますか？（アバター等）',
    default: false,
  });

  const emailProvider = await select({
    message: 'メールプロバイダーを選択してください',
    choices: [
      { value: 'none', name: 'なし（メール機能無効）' },
      { value: 'resend', name: 'Resend' },
      { value: 'sendgrid', name: 'SendGrid' },
      { value: 'ses', name: 'AWS SES' },
    ],
    default: 'none',
  });

  // Step 7: Advanced OIDC settings
  const configureOidc = await confirm({
    message: 'OIDC詳細設定を行いますか？（トークンTTL等）',
    default: false,
  });

  let accessTokenTtl = 3600; // 1 hour
  let refreshTokenTtl = 604800; // 7 days
  let authCodeTtl = 600; // 10 minutes
  let pkceRequired = true;

  if (configureOidc) {
    console.log('');
    console.log(chalk.blue('━━━ OIDC設定 ━━━'));
    console.log('');

    const accessTokenTtlStr = await input({
      message: 'Access Token TTL (秒)',
      default: '3600',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return '正の整数を入力してください';
        return true;
      },
    });
    accessTokenTtl = parseInt(accessTokenTtlStr, 10);

    const refreshTokenTtlStr = await input({
      message: 'Refresh Token TTL (秒)',
      default: '604800',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return '正の整数を入力してください';
        return true;
      },
    });
    refreshTokenTtl = parseInt(refreshTokenTtlStr, 10);

    const authCodeTtlStr = await input({
      message: 'Authorization Code TTL (秒)',
      default: '600',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return '正の整数を入力してください';
        return true;
      },
    });
    authCodeTtl = parseInt(authCodeTtlStr, 10);

    pkceRequired = await confirm({
      message: 'PKCEを必須にしますか？',
      default: true,
    });
  }

  // Step 8: Sharding settings
  const configureSharding = await confirm({
    message: 'シャーディング設定を行いますか？（高負荷環境向け）',
    default: false,
  });

  let authCodeShards = 64;
  let refreshTokenShards = 8;

  if (configureSharding) {
    console.log('');
    console.log(chalk.blue('━━━ シャーディング設定 ━━━'));
    console.log(chalk.gray('  ※ シャード数は2のべき乗を推奨 (8, 16, 32, 64, 128)'));
    console.log('');

    const authCodeShardsStr = await input({
      message: 'Auth Code シャード数',
      default: '64',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return '正の整数を入力してください';
        return true;
      },
    });
    authCodeShards = parseInt(authCodeShardsStr, 10);

    const refreshTokenShardsStr = await input({
      message: 'Refresh Token シャード数',
      default: '8',
      validate: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return '正の整数を入力してください';
        return true;
      },
    });
    refreshTokenShards = parseInt(refreshTokenShardsStr, 10);
  }

  // Create configuration
  const config = createDefaultConfig(envPrefix);
  config.profile = profile as 'basic-op' | 'fapi-rw' | 'fapi2-security';
  config.components = {
    ...config.components,
    saml: enableSaml,
    async: enableQueue, // async is tied to queue
    vc: enableVc,
    bridge: enableBridge,
    policy: enablePolicy,
  };
  config.urls = {
    api: {
      custom: apiDomain || null,
      auto: `https://${envPrefix}-ar-router.workers.dev`,
    },
    loginUi: {
      custom: loginUiDomain || null,
      auto: `https://${envPrefix}-ar-ui.pages.dev`,
    },
    adminUi: {
      custom: adminUiDomain || null,
      auto: `https://${envPrefix}-ar-ui.pages.dev/admin`,
    },
  };
  config.oidc = {
    ...config.oidc,
    accessTokenTtl,
    refreshTokenTtl,
    authCodeTtl,
    pkceRequired,
  };
  config.sharding = {
    authCodeShards,
    refreshTokenShards,
  };
  config.features = {
    queue: { enabled: enableQueue },
    r2: { enabled: enableR2 },
    email: { provider: emailProvider as 'none' | 'resend' | 'sendgrid' | 'ses' },
  };

  // Show summary
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('📋 設定内容'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');
  console.log(chalk.bold('基本設定:'));
  console.log(`  環境:          ${chalk.cyan(envPrefix)}`);
  console.log(`  プロファイル:   ${chalk.cyan(profile)}`);
  console.log('');
  console.log(chalk.bold('URL設定:'));
  console.log(`  API URL:       ${chalk.cyan(config.urls.api.custom || config.urls.api.auto)}`);
  console.log(
    `  Login UI:      ${chalk.cyan(config.urls.loginUi.custom || config.urls.loginUi.auto)}`
  );
  console.log(
    `  Admin UI:      ${chalk.cyan(config.urls.adminUi.custom || config.urls.adminUi.auto)}`
  );
  console.log('');
  console.log(chalk.bold('コンポーネント:'));
  console.log(`  SAML:          ${enableSaml ? chalk.green('有効') : chalk.gray('無効')}`);
  console.log(`  VC:            ${enableVc ? chalk.green('有効') : chalk.gray('無効')}`);
  console.log(`  Bridge:        ${enableBridge ? chalk.green('有効') : chalk.gray('無効')}`);
  console.log(`  Policy:        ${enablePolicy ? chalk.green('有効') : chalk.gray('無効')}`);
  console.log('');
  console.log(chalk.bold('機能フラグ:'));
  console.log(`  Queue:         ${enableQueue ? chalk.green('有効') : chalk.gray('無効')}`);
  console.log(`  R2:            ${enableR2 ? chalk.green('有効') : chalk.gray('無効')}`);
  console.log(`  Email:         ${chalk.cyan(emailProvider)}`);
  console.log('');
  console.log(chalk.bold('OIDC設定:'));
  console.log(`  Access TTL:    ${chalk.cyan(accessTokenTtl + '秒')}`);
  console.log(`  Refresh TTL:   ${chalk.cyan(refreshTokenTtl + '秒')}`);
  console.log(`  Auth Code TTL: ${chalk.cyan(authCodeTtl + '秒')}`);
  console.log(`  PKCE必須:      ${pkceRequired ? chalk.green('Yes') : chalk.yellow('No')}`);
  console.log('');
  console.log(chalk.bold('シャーディング:'));
  console.log(`  Auth Code:     ${chalk.cyan(authCodeShards)} シャード`);
  console.log(`  Refresh Token: ${chalk.cyan(refreshTokenShards)} シャード`);
  console.log('');

  const proceed = await confirm({
    message: 'この設定でセットアップを開始しますか？',
    default: true,
  });

  if (!proceed) {
    console.log(chalk.yellow('セットアップをキャンセルしました。'));
    return;
  }

  await executeSetup(config, cfApiToken, options.keep);
}

// =============================================================================
// Execute Setup
// =============================================================================

async function executeSetup(
  config: AuthrimConfig,
  cfApiToken: string,
  keepPath?: string
): Promise<void> {
  const outputDir = keepPath || '.';
  const env = config.environment.prefix;
  let secrets: ReturnType<typeof generateAllSecrets> | null = null;

  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('🚀 セットアップを実行中...'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Step 0: Check wrangler and auth
  const wranglerCheck = ora('wranglerの状態を確認中...').start();
  try {
    const installed = await isWranglerInstalled();
    if (!installed) {
      wranglerCheck.fail('wranglerがインストールされていません');
      console.log(chalk.yellow('  npm install -g wrangler を実行してください'));
      return;
    }

    const auth = await checkAuth();
    if (!auth.isLoggedIn) {
      wranglerCheck.fail('Cloudflareにログインしていません');
      console.log(chalk.yellow('  wrangler login を実行してください'));
      return;
    }

    wranglerCheck.succeed(`Cloudflareに接続しました (${auth.email || 'authenticated'})`);

    // Get account ID and update auto URLs
    const accountId = await getAccountId();
    if (accountId) {
      config.cloudflare = { accountId };
    }
  } catch (error) {
    wranglerCheck.fail('wranglerの確認に失敗しました');
    console.error(error);
    return;
  }

  // Step 1: Generate keys
  const keysSpinner = ora('暗号鍵を生成中...').start();
  try {
    const keyId = generateKeyId(env);
    secrets = generateAllSecrets(keyId);
    const keysDir = join(outputDir, '.keys');
    await saveKeysToDirectory(secrets, keysDir);

    config.keys = {
      keyId: secrets.keyPair.keyId,
      publicKeyJwk: secrets.keyPair.publicKeyJwk as Record<string, unknown>,
      secretsPath: './.keys/',
      includeSecrets: false,
    };

    keysSpinner.succeed(`暗号鍵を生成しました (${keysDir})`);
  } catch (error) {
    keysSpinner.fail('暗号鍵の生成に失敗しました');
    throw error;
  }

  // Step 2: Provision Cloudflare resources
  console.log('');
  console.log(chalk.blue('⏳ Cloudflareリソースを作成中...'));
  console.log('');

  let provisionedResources;
  try {
    provisionedResources = await provisionResources({
      env,
      createD1: true,
      createKV: true,
      createQueues: config.features.queue?.enabled,
      createR2: config.features.r2?.enabled,
      onProgress: (msg) => console.log(`  ${msg}`),
    });
  } catch (error) {
    console.log(chalk.red('  ✗ リソースの作成に失敗しました'));
    console.error(error);

    // Ask if user wants to continue without provisioning
    const continueWithoutProvisioning = await confirm({
      message: 'プロビジョニングなしで続行しますか？（手動でリソースを作成する必要があります）',
      default: false,
    });

    if (!continueWithoutProvisioning) {
      return;
    }

    // Create empty resources
    provisionedResources = { d1: [], kv: [], queues: [], r2: [] };
  }

  // Step 3: Create lock file
  const lockSpinner = ora('authrim-lock.json を生成中...').start();
  try {
    const lockFile = createLockFile(env, provisionedResources);
    const lockPath = join(outputDir, 'authrim-lock.json');
    await saveLockFile(lockFile, lockPath);
    lockSpinner.succeed(`authrim-lock.json を保存しました (${lockPath})`);
  } catch (error) {
    lockSpinner.fail('authrim-lock.json の保存に失敗しました');
    console.error(error);
  }

  // Step 4: Save configuration
  const configSpinner = ora('設定ファイルを保存中...').start();
  try {
    const configPath = join(outputDir, 'authrim-config.json');
    config.updatedAt = new Date().toISOString();
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    configSpinner.succeed(`設定を保存しました (${configPath})`);
  } catch (error) {
    configSpinner.fail('設定ファイルの保存に失敗しました');
    throw error;
  }

  // Step 5: Generate wrangler.toml files (if keeping source or in existing repo)
  const resourceIds = toResourceIds(provisionedResources);
  const packagesDir = join(outputDir, 'packages');

  if (existsSync(packagesDir)) {
    const wranglerSpinner = ora('wrangler.toml ファイルを生成中...').start();
    try {
      for (const component of CORE_WORKER_COMPONENTS) {
        const componentDir = join(packagesDir, component);
        if (!existsSync(componentDir)) {
          continue; // Skip if component directory doesn't exist
        }

        const wranglerConfig = generateWranglerConfig(component, config, resourceIds);
        const tomlContent = toToml(wranglerConfig);
        const tomlPath = join(componentDir, `wrangler.${env}.toml`);
        await writeFile(tomlPath, tomlContent, 'utf-8');
      }

      wranglerSpinner.succeed('wrangler.toml ファイルを生成しました');
    } catch (error) {
      wranglerSpinner.fail('wrangler.toml の生成に失敗しました');
      console.error(error);
    }
  }

  // Summary
  console.log('');
  console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold.green('🎉 セットアップが完了しました！'));
  console.log(chalk.green('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Show provisioned resources
  if (provisionedResources.d1.length > 0 || provisionedResources.kv.length > 0) {
    console.log(chalk.bold('📦 作成されたリソース:'));
    console.log('');

    if (provisionedResources.d1.length > 0) {
      console.log('  D1 Databases:');
      for (const db of provisionedResources.d1) {
        console.log(`    ✓ ${db.name} (${db.id.slice(0, 8)}...)`);
      }
    }

    if (provisionedResources.kv.length > 0) {
      console.log('  KV Namespaces:');
      for (const kv of provisionedResources.kv) {
        console.log(`    ✓ ${kv.name} (${kv.id.slice(0, 8)}...)`);
      }
    }

    console.log('');
  }

  console.log(chalk.bold('📁 生成されたファイル:'));
  console.log(`  - ${join(outputDir, 'authrim-config.json')}`);
  console.log(`  - ${join(outputDir, 'authrim-lock.json')}`);
  console.log(`  - ${join(outputDir, '.keys/')} ${chalk.gray('(秘密鍵 - gitignoreに追加)')}`);
  console.log('');

  // Show URLs
  console.log(chalk.bold('🌐 エンドポイント:'));
  const apiUrl = config.urls?.api?.custom || config.urls?.api?.auto || '';
  const loginUrl = config.urls?.loginUi?.custom || config.urls?.loginUi?.auto || '';
  const adminUrl = config.urls?.adminUi?.custom || config.urls?.adminUi?.auto || '';
  console.log(`  OIDC Provider: ${chalk.cyan(apiUrl)}`);
  console.log(`  Login UI:      ${chalk.cyan(loginUrl)}`);
  console.log(`  Admin UI:      ${chalk.cyan(adminUrl)}`);
  console.log('');

  // Next steps
  console.log(chalk.bold('📋 次のステップ:'));
  console.log('');
  console.log(`  1. シークレットをCloudflareにアップロード:`);
  console.log(chalk.cyan(`     npx @authrim/setup secrets --env=${env}`));
  console.log('');
  console.log(`  2. Workersをデプロイ:`);
  console.log(chalk.cyan(`     pnpm deploy --env=${env}`));
  console.log('');
}

// =============================================================================
// Handle Existing Config
// =============================================================================

async function handleExistingConfig(configPath: string): Promise<void> {
  const spinner = ora(`設定ファイルを読み込み中: ${configPath}`).start();

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = parseConfig(JSON.parse(content));
    spinner.succeed('設定を読み込みました');

    console.log('');
    console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.bold('📋 設定内容'));
    console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');
    console.log(`  環境:        ${chalk.cyan(config.environment.prefix)}`);
    console.log(`  プロファイル: ${chalk.cyan(config.profile)}`);
    console.log(`  バージョン:   ${chalk.cyan(config.version)}`);
    if (config.urls?.api) {
      const apiUrl = config.urls.api.custom || config.urls.api.auto;
      console.log(`  API URL:     ${chalk.cyan(apiUrl || 'Not configured')}`);
    }
    console.log('');

    const action = await select({
      message: '操作を選択してください',
      choices: [
        { value: 'deploy', name: '🚀 再デプロイ' },
        { value: 'edit', name: '✏️  設定を編集' },
        { value: 'show', name: '📋 設定を表示' },
        { value: 'cancel', name: '❌ キャンセル' },
      ],
    });

    switch (action) {
      case 'deploy':
        await handleRedeploy(config, configPath);
        break;
      case 'edit':
        await handleEditConfig(config, configPath);
        break;
      case 'show':
        console.log('');
        console.log(JSON.stringify(config, null, 2));
        break;
      case 'cancel':
        console.log(chalk.yellow('キャンセルしました。'));
        break;
    }
  } catch (error) {
    spinner.fail('設定ファイルの読み込みに失敗しました');
    console.error(error);
  }
}

// =============================================================================
// Redeploy from Existing Config
// =============================================================================

async function handleRedeploy(config: AuthrimConfig, configPath: string): Promise<void> {
  const env = config.environment.prefix;
  const lockPath = configPath.replace('authrim-config.json', 'authrim-lock.json');

  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('🚀 再デプロイ'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  // Check prerequisites
  const wranglerCheck = ora('wranglerの状態を確認中...').start();
  try {
    const installed = await isWranglerInstalled();
    if (!installed) {
      wranglerCheck.fail('wranglerがインストールされていません');
      console.log(chalk.yellow('  npm install -g wrangler を実行してください'));
      return;
    }

    const auth = await checkAuth();
    if (!auth.isLoggedIn) {
      wranglerCheck.fail('Cloudflareにログインしていません');
      console.log(chalk.yellow('  wrangler login を実行してください'));
      return;
    }

    wranglerCheck.succeed(`Cloudflareに接続しました (${auth.email || 'authenticated'})`);
  } catch (error) {
    wranglerCheck.fail('wranglerの確認に失敗しました');
    console.error(error);
    return;
  }

  // Load lock file
  const lock = await loadLockFile(lockPath);
  const hasLock = lock !== null;

  if (!hasLock) {
    console.log(chalk.yellow('\n⚠️  authrim-lock.json が見つかりません'));
    const createResources = await confirm({
      message: 'Cloudflareリソースを新規作成しますか？',
      default: true,
    });

    if (!createResources) {
      console.log(chalk.yellow('キャンセルしました。'));
      return;
    }

    // Provision new resources
    console.log('');
    console.log(chalk.blue('⏳ Cloudflareリソースを作成中...'));
    console.log('');

    try {
      const provisionedResources = await provisionResources({
        env,
        createD1: true,
        createKV: true,
        createQueues: config.features.queue?.enabled,
        createR2: config.features.r2?.enabled,
        onProgress: (msg) => console.log(`  ${msg}`),
      });

      // Create and save lock file
      const newLock = createLockFile(env, provisionedResources);
      await saveLockFile(newLock, lockPath);
      console.log(chalk.green(`\n✓ authrim-lock.json を保存しました`));
    } catch (error) {
      console.log(chalk.red('  ✗ リソースの作成に失敗しました'));
      console.error(error);
      return;
    }
  } else {
    // Show existing resources summary
    console.log(chalk.bold('\n📦 既存リソース:'));
    console.log(`  D1 Databases:  ${chalk.cyan(Object.keys(lock.d1).length)}`);
    console.log(`  KV Namespaces: ${chalk.cyan(Object.keys(lock.kv).length)}`);
    if (lock.workers) {
      const deployedCount = Object.values(lock.workers).filter((w) => w.deployedAt).length;
      console.log(`  Workers:       ${chalk.cyan(deployedCount)} deployed`);
    }
  }

  // Determine components to deploy
  const enabledComponents: string[] = ['ar-lib-core', 'ar-discovery'];
  enabledComponents.push('ar-auth', 'ar-token', 'ar-userinfo', 'ar-management');

  if (config.components.saml) enabledComponents.push('ar-saml');
  if (config.components.async) enabledComponents.push('ar-async');
  if (config.components.vc) enabledComponents.push('ar-vc');
  if (config.components.bridge) enabledComponents.push('ar-bridge');
  if (config.components.policy) enabledComponents.push('ar-policy');

  enabledComponents.push('ar-router');

  console.log(chalk.bold('\n📋 デプロイ対象コンポーネント:'));
  for (const comp of enabledComponents) {
    console.log(chalk.cyan(`  • ${comp}`));
  }
  console.log('');

  // Confirm deployment
  const proceed = await confirm({
    message: 'デプロイを開始しますか？',
    default: true,
  });

  if (!proceed) {
    console.log(chalk.yellow('キャンセルしました。'));
    return;
  }

  // Run deploy using the deploy command
  console.log('');
  const { deployCommand } = await import('./deploy.js');
  await deployCommand({
    config: configPath,
    env,
    yes: true,
  });
}

// =============================================================================
// Edit Existing Config
// =============================================================================

async function handleEditConfig(config: AuthrimConfig, configPath: string): Promise<void> {
  console.log('');
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(chalk.bold('✏️  設定の編集'));
  console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  const editSection = await select({
    message: '編集するセクションを選択してください',
    choices: [
      { value: 'urls', name: '🌐 URL設定' },
      { value: 'components', name: '📦 コンポーネント' },
      { value: 'profile', name: '🔐 OIDCプロファイル' },
      { value: 'oidc', name: '⚙️  OIDC設定 (TTL等)' },
      { value: 'features', name: '🎛️  機能フラグ' },
      { value: 'sharding', name: '⚡ シャーディング設定' },
      { value: 'cancel', name: '❌ キャンセル' },
    ],
  });

  if (editSection === 'cancel') {
    console.log(chalk.yellow('キャンセルしました。'));
    return;
  }

  let configModified = false;

  switch (editSection) {
    case 'urls':
      configModified = await editUrls(config);
      break;
    case 'components':
      configModified = await editComponents(config);
      break;
    case 'profile':
      configModified = await editProfile(config);
      break;
    case 'oidc':
      configModified = await editOidcSettings(config);
      break;
    case 'features':
      configModified = await editFeatures(config);
      break;
    case 'sharding':
      configModified = await editSharding(config);
      break;
  }

  if (configModified) {
    config.updatedAt = new Date().toISOString();

    const saveChanges = await confirm({
      message: '変更を保存しますか？',
      default: true,
    });

    if (saveChanges) {
      await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
      console.log(chalk.green(`\n✓ 設定を保存しました: ${configPath}`));

      const redeploy = await confirm({
        message: '変更を反映するために再デプロイしますか？',
        default: false,
      });

      if (redeploy) {
        await handleRedeploy(config, configPath);
      }
    } else {
      console.log(chalk.yellow('変更は保存されませんでした。'));
    }
  }
}

// =============================================================================
// Edit URL Configuration
// =============================================================================

async function editUrls(config: AuthrimConfig): Promise<boolean> {
  const env = config.environment.prefix;

  // Ensure urls object exists
  if (!config.urls) {
    config.urls = {
      api: { custom: null, auto: `https://${env}-ar-router.workers.dev` },
      loginUi: { custom: null, auto: `https://${env}-ar-ui.pages.dev` },
      adminUi: { custom: null, auto: `https://${env}-ar-ui.pages.dev/admin` },
    };
  }

  console.log(chalk.bold('\n現在のURL設定:'));
  console.log(
    `  API:      ${chalk.cyan(config.urls.api?.custom || config.urls.api?.auto || 'Not set')}`
  );
  console.log(
    `  Login UI: ${chalk.cyan(config.urls.loginUi?.custom || config.urls.loginUi?.auto || 'Not set')}`
  );
  console.log(
    `  Admin UI: ${chalk.cyan(config.urls.adminUi?.custom || config.urls.adminUi?.auto || 'Not set')}`
  );
  console.log('');

  const apiDomain = await input({
    message: 'API（issuer）ドメイン (空欄でworkers.devを使用)',
    default: config.urls.api?.custom || '',
    validate: (value) => {
      if (!value) return true;
      if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value)) {
        return '有効なドメイン名を入力してください';
      }
      return true;
    },
  });

  const loginUiDomain = await input({
    message: 'Login UIドメイン (空欄でpages.devを使用)',
    default: config.urls.loginUi?.custom || '',
  });

  const adminUiDomain = await input({
    message: 'Admin UIドメイン (空欄でpages.devを使用)',
    default: config.urls.adminUi?.custom || '',
  });

  config.urls.api = {
    custom: apiDomain || null,
    auto: config.urls.api?.auto || `https://${env}-ar-router.workers.dev`,
  };
  config.urls.loginUi = {
    custom: loginUiDomain || null,
    auto: config.urls.loginUi?.auto || `https://${env}-ar-ui.pages.dev`,
  };
  config.urls.adminUi = {
    custom: adminUiDomain || null,
    auto: config.urls.adminUi?.auto || `https://${env}-ar-ui.pages.dev/admin`,
  };

  return true;
}

// =============================================================================
// Edit Components
// =============================================================================

async function editComponents(config: AuthrimConfig): Promise<boolean> {
  console.log(chalk.bold('\n現在のコンポーネント設定:'));
  console.log(`  SAML:    ${config.components.saml ? chalk.green('有効') : chalk.gray('無効')}`);
  console.log(`  Async:   ${config.components.async ? chalk.green('有効') : chalk.gray('無効')}`);
  console.log(`  VC:      ${config.components.vc ? chalk.green('有効') : chalk.gray('無効')}`);
  console.log(`  Bridge:  ${config.components.bridge ? chalk.green('有効') : chalk.gray('無効')}`);
  console.log(`  Policy:  ${config.components.policy ? chalk.green('有効') : chalk.gray('無効')}`);
  console.log('');

  config.components.saml = await confirm({
    message: 'SAMLサポートを有効にしますか？',
    default: config.components.saml,
  });

  config.components.async = await confirm({
    message: '非同期処理（Queue）を有効にしますか？',
    default: config.components.async,
  });

  config.components.vc = await confirm({
    message: 'Verifiable Credentialsを有効にしますか？',
    default: config.components.vc,
  });

  config.components.bridge = await confirm({
    message: 'External IdP Bridgeを有効にしますか？',
    default: config.components.bridge,
  });

  config.components.policy = await confirm({
    message: 'ReBAC Policyサービスを有効にしますか？',
    default: config.components.policy,
  });

  return true;
}

// =============================================================================
// Edit Profile
// =============================================================================

async function editProfile(config: AuthrimConfig): Promise<boolean> {
  console.log(`\n現在のプロファイル: ${chalk.cyan(config.profile)}`);
  console.log('');

  const profile = await select({
    message: 'OIDCプロファイルを選択してください',
    choices: [
      {
        value: 'basic-op',
        name: 'Basic OP (基本的なOIDCプロバイダ)',
        description: '標準的なOIDC機能を提供します',
      },
      {
        value: 'fapi-rw',
        name: 'FAPI Read-Write (金融グレード)',
        description: 'FAPI 1.0 Read-Write Security Profile準拠',
      },
      {
        value: 'fapi2-security',
        name: 'FAPI 2.0 Security Profile',
        description: 'FAPI 2.0 Security Profile準拠（最高セキュリティ）',
      },
    ],
    default: config.profile,
  });

  config.profile = profile as 'basic-op' | 'fapi-rw' | 'fapi2-security';
  return true;
}

// =============================================================================
// Edit OIDC Settings
// =============================================================================

async function editOidcSettings(config: AuthrimConfig): Promise<boolean> {
  console.log(chalk.bold('\n現在のOIDC設定:'));
  console.log(`  Access Token TTL:  ${chalk.cyan(config.oidc.accessTokenTtl)}秒`);
  console.log(`  Refresh Token TTL: ${chalk.cyan(config.oidc.refreshTokenTtl)}秒`);
  console.log(`  Auth Code TTL:     ${chalk.cyan(config.oidc.authCodeTtl)}秒`);
  console.log(
    `  PKCE Required:     ${config.oidc.pkceRequired ? chalk.green('Yes') : chalk.yellow('No')}`
  );
  console.log('');

  const accessTokenTtl = await input({
    message: 'Access Token TTL (秒)',
    default: String(config.oidc.accessTokenTtl),
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) return '正の整数を入力してください';
      return true;
    },
  });

  const refreshTokenTtl = await input({
    message: 'Refresh Token TTL (秒)',
    default: String(config.oidc.refreshTokenTtl),
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) return '正の整数を入力してください';
      return true;
    },
  });

  const authCodeTtl = await input({
    message: 'Authorization Code TTL (秒)',
    default: String(config.oidc.authCodeTtl),
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) return '正の整数を入力してください';
      return true;
    },
  });

  const pkceRequired = await confirm({
    message: 'PKCEを必須にしますか？',
    default: config.oidc.pkceRequired,
  });

  config.oidc.accessTokenTtl = parseInt(accessTokenTtl, 10);
  config.oidc.refreshTokenTtl = parseInt(refreshTokenTtl, 10);
  config.oidc.authCodeTtl = parseInt(authCodeTtl, 10);
  config.oidc.pkceRequired = pkceRequired;

  return true;
}

// =============================================================================
// Edit Features
// =============================================================================

async function editFeatures(config: AuthrimConfig): Promise<boolean> {
  console.log(chalk.bold('\n現在の機能フラグ:'));
  console.log(
    `  Queue:  ${config.features.queue?.enabled ? chalk.green('有効') : chalk.gray('無効')}`
  );
  console.log(
    `  R2:     ${config.features.r2?.enabled ? chalk.green('有効') : chalk.gray('無効')}`
  );
  console.log(`  Email:  ${chalk.cyan(config.features.email?.provider || 'none')}`);
  console.log('');

  const queueEnabled = await confirm({
    message: 'Cloudflare Queuesを有効にしますか？（監査ログ等）',
    default: config.features.queue?.enabled || false,
  });

  const r2Enabled = await confirm({
    message: 'Cloudflare R2を有効にしますか？（アバター等）',
    default: config.features.r2?.enabled || false,
  });

  const emailProvider = await select({
    message: 'メールプロバイダーを選択してください',
    choices: [
      { value: 'none', name: 'なし（メール機能無効）' },
      { value: 'resend', name: 'Resend' },
      { value: 'sendgrid', name: 'SendGrid' },
      { value: 'ses', name: 'AWS SES' },
    ],
    default: config.features.email?.provider || 'none',
  });

  config.features.queue = { enabled: queueEnabled };
  config.features.r2 = { enabled: r2Enabled };
  config.features.email = { provider: emailProvider as 'none' | 'resend' | 'sendgrid' | 'ses' };

  return true;
}

// =============================================================================
// Edit Sharding
// =============================================================================

async function editSharding(config: AuthrimConfig): Promise<boolean> {
  console.log(chalk.bold('\n現在のシャーディング設定:'));
  console.log(`  Auth Code Shards:    ${chalk.cyan(config.sharding.authCodeShards)}`);
  console.log(`  Refresh Token Shards: ${chalk.cyan(config.sharding.refreshTokenShards)}`);
  console.log('');
  console.log(chalk.gray('  ※ シャード数は2のべき乗を推奨 (8, 16, 32, 64, 128)'));
  console.log('');

  const authCodeShards = await input({
    message: 'Auth Code シャード数',
    default: String(config.sharding.authCodeShards),
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) return '正の整数を入力してください';
      return true;
    },
  });

  const refreshTokenShards = await input({
    message: 'Refresh Token シャード数',
    default: String(config.sharding.refreshTokenShards),
    validate: (value) => {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) return '正の整数を入力してください';
      return true;
    },
  });

  config.sharding.authCodeShards = parseInt(authCodeShards, 10);
  config.sharding.refreshTokenShards = parseInt(refreshTokenShards, 10);

  return true;
}
