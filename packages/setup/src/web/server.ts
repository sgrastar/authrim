/**
 * Web UI Server for Authrim Setup
 *
 * Provides a web-based interface for configuring and deploying Authrim.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const WEB_ASSETS_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_FONTS_DIR = join(WEB_ASSETS_DIR, 'fonts');

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

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function isAllowedSetupOrigin(origin: string, port: number): boolean {
  try {
    const url = new URL(origin);
    return url.port === String(port) && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function buildSetupUiUrl(baseUrl: string, options: { lang?: string; token?: string } = {}) {
  const url = new URL(baseUrl);
  if (options.lang) {
    url.searchParams.set('lang', options.lang);
  }
  if (options.token) {
    url.searchParams.set('setup_token', options.token);
  }
  return url.toString();
}

export interface WebRequestDrainController {
  beginRequest: () => boolean;
  finishRequest: () => void;
  beginDrain: () => void;
  waitForIdle: () => Promise<void>;
  activeRequests: () => number;
}

/** Track complete Hono request lifetimes so route-level async cleanup finishes before shutdown. */
export function createWebRequestDrainController(): WebRequestDrainController {
  let acceptingRequests = true;
  let activeRequests = 0;
  const idleWaiters = new Set<() => void>();

  const resolveIdleWaiters = (): void => {
    if (activeRequests !== 0) return;
    for (const resolveIdle of idleWaiters) resolveIdle();
    idleWaiters.clear();
  };

  return {
    beginRequest: () => {
      if (!acceptingRequests) return false;
      activeRequests += 1;
      return true;
    },
    finishRequest: () => {
      if (activeRequests <= 0) {
        throw new Error('web_request_drain_counter_underflow');
      }
      activeRequests -= 1;
      resolveIdleWaiters();
    },
    beginDrain: () => {
      acceptingRequests = false;
      resolveIdleWaiters();
    },
    waitForIdle: () => {
      if (activeRequests === 0) return Promise.resolve();
      return new Promise<void>((resolveIdle) => idleWaiters.add(resolveIdle));
    },
    activeRequests: () => activeRequests,
  };
}

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface WebShutdownController {
  handleSignal: (signal: ShutdownSignal) => Promise<void>;
}

export interface WebShutdownControllerOptions {
  stopAccepting: () => void | Promise<void>;
  waitForDrain: () => Promise<void>;
  exit: (code: number) => void;
  gracePeriodMs?: number;
  scheduleTimeout?: (callback: () => void, milliseconds: number) => () => void;
  onStopping?: (signal: ShutdownSignal) => void;
  onStopped?: () => void;
  onWarning?: (message: string) => void;
}

const DEFAULT_WEB_SHUTDOWN_GRACE_PERIOD_MS = 60_000;

/**
 * Coordinate signal shutdown without making tests terminate their own process.
 *
 * The first signal closes admission and waits for every tracked request, including route-level
 * `finally` cleanup. A second signal is an explicit force-exit request.
 */
export function createWebShutdownController(
  options: WebShutdownControllerOptions
): WebShutdownController {
  const scheduleTimeout =
    options.scheduleTimeout ??
    ((callback: () => void, milliseconds: number) => {
      const timer = setTimeout(callback, milliseconds);
      timer.unref();
      return () => clearTimeout(timer);
    });
  const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_WEB_SHUTDOWN_GRACE_PERIOD_MS;
  let shutdown: Promise<void> | null = null;
  let exitRequested = false;

  const requestExit = (code: number): void => {
    if (exitRequested) return;
    exitRequested = true;
    options.exit(code);
  };

  const startShutdown = async (signal: ShutdownSignal): Promise<void> => {
    options.onStopping?.(signal);
    let cancelTimeout = (): void => undefined;
    const timeout = new Promise<'timeout'>((resolveTimeout) => {
      cancelTimeout = scheduleTimeout(() => {
        resolveTimeout('timeout');
      }, gracePeriodMs);
    });

    try {
      const drain = (async () => {
        await options.stopAccepting();
        await options.waitForDrain();
      })();
      const outcome = await Promise.race([drain.then(() => 'drained' as const), timeout]);
      cancelTimeout();

      if (exitRequested) return;
      if (outcome === 'timeout') {
        options.onWarning?.(
          `Setup shutdown exceeded the ${Math.ceil(gracePeriodMs / 1000)}s grace period; forcing exit before all cleanup completed.`
        );
        requestExit(1);
        return;
      }

      // Observe a rejection that could otherwise arrive just after the race winner was selected.
      await drain;
      options.onStopped?.();
      requestExit(0);
    } catch (error) {
      cancelTimeout();
      if (exitRequested) return;
      options.onWarning?.(
        `Setup shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      );
      requestExit(1);
    }
  };

  return {
    handleSignal: (signal) => {
      if (shutdown) {
        options.onWarning?.(`Received ${signal} again; forcing setup shutdown.`);
        requestExit(1);
        return Promise.resolve();
      }
      shutdown = startShutdown(signal);
      return shutdown;
    },
  };
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
  const sessionToken = getSessionToken();

  const app = new Hono();
  const requestDrain = createWebRequestDrainController();

  app.use('*', async (c, next) => {
    if (!requestDrain.beginRequest()) {
      return c.json({ error: 'Setup server is shutting down' }, 503);
    }
    try {
      await next();
    } finally {
      requestDrain.finishRequest();
    }
  });

  // CORS for API requests. Even when binding to 0.0.0.0 for WSL, restrict
  // browser origins to loopback hosts so LAN pages cannot call privileged APIs.
  const corsOrigins =
    host === '0.0.0.0'
      ? (origin: string): string | null => {
          return isAllowedSetupOrigin(origin, port) ? origin : null;
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
    if (host === '0.0.0.0' && c.req.query('setup_token') !== sessionToken) {
      return c.html(
        '<!DOCTYPE html><html><body><h1>Unauthorized</h1><p>Use the setup URL printed by the CLI.</p></body></html>',
        401
      );
    }

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
  app.get('/assets/fonts/:file', async (c) => {
    const file = c.req.param('file');
    if (file !== basename(file) || !file.endsWith('.woff2')) {
      return c.notFound();
    }

    try {
      const font = await readFile(join(WEB_FONTS_DIR, file));
      return new Response(font, {
        headers: {
          'Content-Type': 'font/woff2',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch {
      return c.notFound();
    }
  });

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
  const url = buildSetupUiUrl(baseUrl, {
    lang: options.lang,
    token: host === '0.0.0.0' ? sessionToken : undefined,
  });

  console.log(chalk.bold('\n🌐 Authrim Setup Web UI\n'));

  if (port !== preferredPort) {
    console.log(chalk.gray(`(Port ${preferredPort} was in use, using ${port} instead)\n`));
  }

  console.log('Open at:');
  console.log(chalk.cyan(`  ${url}\n`));

  // Show additional hint for WSL users accessing from Windows
  if (host === '0.0.0.0') {
    console.log(chalk.gray(`  (From Windows browser, use the full URL above.)\n`));
  }

  // Open browser if requested - wait for ENTER first
  if (options.openBrowser !== false) {
    await waitForEnterAndOpenBrowser(url);
  }

  console.log(chalk.gray('Press Ctrl+C to stop\n'));

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });
  let serverClosed: Promise<void> | null = null;
  const shutdown = createWebShutdownController({
    stopAccepting: () => {
      requestDrain.beginDrain();
      serverClosed ??= new Promise<void>((resolveClosed, rejectClosed) => {
        server.close((error?: Error) => {
          if (error) rejectClosed(error);
          else resolveClosed();
        });
      });
    },
    waitForDrain: async () => {
      await requestDrain.waitForIdle();
      await serverClosed;
    },
    exit: (code) => process.exit(code),
    onStopping: (signal) => {
      console.log(
        chalk.gray(
          `\nReceived ${signal}. Stopping new setup requests and waiting for active cleanup...`
        )
      );
    },
    onStopped: () => console.log(chalk.gray('Stopped.')),
    onWarning: (message) => console.warn(chalk.yellow(message)),
  });
  process.on('SIGINT', () => void shutdown.handleSignal('SIGINT'));
  process.on('SIGTERM', () => void shutdown.handleSignal('SIGTERM'));
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
    // Handle Ctrl+C while the readline prompt is active
    rl.on('SIGINT', () => {
      rl.close();
      console.log(chalk.gray('\nStopped.'));
      process.exit(0);
    });

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
