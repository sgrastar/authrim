/**
 * Web UI Server for Authrim Setup
 *
 * Provides a web-based interface for configuring and deploying Authrim.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import chalk from 'chalk';
import { createApiRoutes, generateSessionToken, getSessionToken } from './api.js';
import { getHtmlTemplate } from './ui.js';
import {
  initI18n,
  detectBrowserLocale,
  getTranslationsForWeb,
  getAvailableLocales,
  loadTranslations,
  t,
  type Locale,
  DEFAULT_LOCALE,
} from '../i18n/index.js';

// =============================================================================
// Types
// =============================================================================

export interface WebServerOptions {
  port?: number;
  host?: string;
  openBrowser?: boolean;
  /** Start in manage-only mode (skip to environment management) */
  manageOnly?: boolean;
  /** Initial language (passed from CLI selection) */
  lang?: string;
}

// =============================================================================
// Server
// =============================================================================

export async function startWebServer(options: WebServerOptions = {}): Promise<void> {
  const { port: preferredPort = 3456, manageOnly = false } = options;

  // Initialize i18n early (for WSL prompt messages)
  const initialLocale = (options.lang as Locale) || DEFAULT_LOCALE;
  await initI18n(initialLocale);

  // Determine host - check for WSL environment
  let host = options.host || 'localhost';
  if (!options.host && (await isWSLEnvironment())) {
    host = await promptWSLHostBinding();
  }

  // Try to find an available port
  const port = await findAvailablePort(preferredPort, host);

  // Generate session token for this server instance
  generateSessionToken();

  const app = new Hono();

  // CORS for API requests
  // When binding to 0.0.0.0 (WSL), allow requests from any origin on the same port
  // Security is maintained through session token validation
  const corsOrigins =
    host === '0.0.0.0'
      ? (origin: string): string | null => {
          // Allow localhost variants and any IP on the same port
          try {
            const url = new URL(origin);
            return url.port === String(port) ? origin : null;
          } catch {
            return null;
          }
        }
      : [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

  app.use(
    '/api/*',
    cors({
      origin: corsOrigins,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowHeaders: ['Content-Type', 'X-Session-Token'],
    })
  );

  // API routes
  const apiRoutes = createApiRoutes();
  app.route('/api', apiRoutes);

  // Serve UI with embedded session token and locale-aware translations
  app.get('/', async (c) => {
    // Detect locale from query param, then Accept-Language header
    const queryLang = c.req.query('lang');
    let locale: Locale = DEFAULT_LOCALE;

    if (queryLang) {
      const availableLocales = getAvailableLocales();
      if (availableLocales.some((l) => l.code === queryLang)) {
        locale = queryLang as Locale;
      }
    } else {
      const acceptLanguage = c.req.header('Accept-Language');
      locale = detectBrowserLocale(acceptLanguage);
    }

    // Load translations for the detected locale (if not already cached)
    await loadTranslations(locale);

    // Get translations for the detected locale
    const translations = getTranslationsForWeb(locale);
    const availableLocales = getAvailableLocales();

    return c.html(
      getHtmlTemplate(getSessionToken(), manageOnly, locale, translations, availableLocales)
    );
  });

  // Static assets (if needed in the future)
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Translations API - for client-side language switching without reload
  app.get('/api/translations/:locale', async (c) => {
    const requestedLocale = c.req.param('locale');
    const availableLocales = getAvailableLocales();

    // Validate requested locale
    if (!availableLocales.some((l) => l.code === requestedLocale)) {
      return c.json({ error: 'Invalid locale' }, 400);
    }

    // Load translations if not already cached
    await loadTranslations(requestedLocale as Locale);

    const translations = getTranslationsForWeb(requestedLocale as Locale);
    return c.json({ locale: requestedLocale, translations });
  });

  // Start server
  // When binding to 0.0.0.0, use localhost for browser URL (0.0.0.0 is not a valid browser address)
  const browserHost = host === '0.0.0.0' ? 'localhost' : host;
  const baseUrl = `http://${browserHost}:${port}`;
  // Add language parameter if specified (from CLI selection)
  const url = options.lang ? `${baseUrl}?lang=${options.lang}` : baseUrl;

  console.log(chalk.bold('\n🌐 Authrim Setup Web UI\n'));

  if (port !== preferredPort) {
    console.log(chalk.gray(`(Port ${preferredPort} was in use, using ${port} instead)\n`));
  }

  console.log('Open at:');
  console.log(chalk.cyan(`  ${baseUrl}\n`));

  // Show additional hint for WSL users accessing from Windows
  if (host === '0.0.0.0') {
    console.log(chalk.gray(`  (From Windows browser, also try: http://localhost:${port})\n`));
  }

  // Open browser if requested - wait for ENTER first
  if (options.openBrowser !== false) {
    await waitForEnterAndOpenBrowser(url);
  }

  console.log(chalk.gray('Press Ctrl+C to stop\n'));

  serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });
}

/**
 * Check if a port is available
 */
async function isPortAvailable(port: number, host: string): Promise<boolean> {
  const net = await import('node:net');

  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false);
      } else {
        resolve(false);
      }
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port, host);
  });
}

/**
 * Find an available port, starting from the preferred port
 */
async function findAvailablePort(preferredPort: number, host: string): Promise<number> {
  const maxAttempts = 10;

  for (let i = 0; i < maxAttempts; i++) {
    const port = preferredPort + i;
    if (await isPortAvailable(port, host)) {
      return port;
    }
  }

  // If no port found after maxAttempts, throw a helpful error
  console.log(chalk.red('\n❌ Could not find an available port'));
  console.log('');
  console.log(
    chalk.yellow(`  Ports ${preferredPort}-${preferredPort + maxAttempts - 1} are all in use.`)
  );
  console.log('');
  console.log(chalk.gray('  To free up the port, you can:'));
  console.log('');
  console.log(chalk.cyan(`    lsof -i :${preferredPort}      # Find process using the port`));
  console.log(chalk.cyan('    kill <PID>                # Kill the process'));
  console.log('');
  process.exit(1);
}

// =============================================================================
// Browser Opening
// =============================================================================

/**
 * Validate that the URL is a safe localhost URL
 * Only allows http://localhost:PORT or http://127.0.0.1:PORT
 */
function validateLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Only allow http protocol (not https for local dev server)
    if (parsed.protocol !== 'http:') {
      return false;
    }
    // Only allow localhost or 127.0.0.1
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      return false;
    }
    // Port must be a valid number
    const port = parseInt(parsed.port || '80', 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return false;
    }
    // Path should only be simple (no shell metacharacters)
    if (/[;&|`$(){}[\]<>!#*?'"]/.test(parsed.pathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for user to press ENTER, then open the browser
 */
async function waitForEnterAndOpenBrowser(url: string): Promise<void> {
  const readline = await import('node:readline');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await new Promise<void>((resolve) => {
    rl.question('Press ENTER to open in the browser...', () => {
      rl.close();
      resolve();
    });
  });

  await openBrowser(url);
}

async function openBrowser(url: string): Promise<void> {
  // Security: Validate URL to prevent command injection
  if (!validateLocalhostUrl(url)) {
    console.log(chalk.yellow(`\nInvalid URL for browser opening: ${url}`));
    console.log(chalk.gray('Only localhost URLs are allowed for automatic browser opening.'));
    return;
  }

  const { platform } = process;

  try {
    const { execa } = await import('execa');

    switch (platform) {
      case 'darwin':
        await execa('open', [url]);
        break;
      case 'win32':
        // On Windows, use 'start' command with empty title to avoid shell expansion issues
        await execa('cmd', ['/c', 'start', '""', url]);
        break;
      default:
        // Linux and others
        await execa('xdg-open', [url]);
        break;
    }
  } catch {
    console.log(chalk.yellow('\nCould not open browser automatically.'));
    console.log(`Please open ${chalk.cyan(url)} in your browser.\n`);
  }
}

// =============================================================================
// WSL Environment Detection
// =============================================================================

/**
 * Detect if running in WSL (Windows Subsystem for Linux) environment
 */
async function isWSLEnvironment(): Promise<boolean> {
  try {
    const fs = await import('node:fs/promises');
    const procVersion = await fs.readFile('/proc/version', 'utf-8');
    return /microsoft|wsl/i.test(procVersion);
  } catch {
    return false;
  }
}

/**
 * Prompt user to choose host binding in WSL environment
 */
async function promptWSLHostBinding(): Promise<string> {
  const readline = await import('node:readline');

  console.log('');
  console.log(chalk.yellow(`⚠️  ${t('wsl.detected')}`));
  console.log('');
  console.log(chalk.gray(t('wsl.explanation')));
  console.log(chalk.gray(t('wsl.explanationCont')));
  console.log('');
  console.log(chalk.yellow(t('wsl.securityNote')));
  console.log(chalk.gray(`  ${t('wsl.securityWarning')}`));
  console.log(chalk.gray(`  ${t('wsl.trustedNetworkOnly')}`));
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<string>((resolve) => {
    rl.question(t('wsl.bindPrompt') + ' ', (answer) => {
      rl.close();
      const yes = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
      if (yes) {
        console.log(chalk.green(`✓ ${t('wsl.bindingToAll')}`));
        resolve('0.0.0.0');
      } else {
        console.log(chalk.gray(t('wsl.usingLocalhost')));
        resolve('localhost');
      }
    });
  });
}
