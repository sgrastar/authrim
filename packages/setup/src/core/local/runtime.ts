/**
 * `authrim-setup local up`: run the Workers under one `wrangler dev` session (so Service Bindings
 * and cross-Worker Durable Objects resolve) and the Login/Admin UIs under Vite.
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthrimConfig } from '../config.js';
import { buildInitialControlPlaneResourcePlans } from '../control-plane-bootstrap.js';
import { runLocalAdminSession } from './admin-session.js';
import { resolveUiDeploymentSettings, resolveUiPackageDir } from '../ui-deployment.js';
import type { WorkerComponent } from '../naming.js';
import { buildLocalLock, selectLocalComponents, LOCAL_DEFAULT_PORTS } from './environment.js';
import { loadLocalConfig, writeLocalWranglerFiles } from './init.js';
import {
  ensureLocalSetupToken,
  loadLocalRelease,
  localSignedStateNeedsRefresh,
  refreshLocalSignedState,
} from './data.js';
import { acquireLocalEnvironmentLock, findLocalLockOwner } from './lock.js';
import { assertSupportedLocalPlatform } from './platform.js';
import { ChildSession, SessionStoppedError } from './session.js';
import {
  getLocalEnvironmentPaths,
  getLocalWorkerConfigPath,
  type LocalEnvironmentPaths,
} from './paths.js';

const READY_TIMEOUT_MS = 180_000;

interface ManagedProcess {
  /** Resolves with the exit code once the process has ended (never rejects). */
  done: Promise<number | undefined>;
  hasExited: () => boolean;
  stop: () => Promise<void>;
}

/** Signal a child's whole process group; `pnpm exec` and `wrangler` spawn grandchildren. */
function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * Start a long-running child with output appended to a log file. Each child leads its own
 * process group so that stopping it also stops wrangler, workerd and Vite behind `pnpm exec`.
 */
function spawnLogged(
  file: string,
  args: readonly string[],
  options: { cwd: string; logPath: string; env?: Record<string, string> }
): ManagedProcess {
  const child = execa(file, [...args], {
    cwd: options.cwd,
    reject: false,
    detached: true,
    stdout: { file: options.logPath },
    stderr: { file: options.logPath, append: true },
    env: options.env,
    extendEnv: true,
  });
  let exited = false;
  const done = child.then(
    (result) => {
      exited = true;
      return result.exitCode;
    },
    () => {
      exited = true;
      return undefined;
    }
  );
  return {
    done,
    hasExited: () => exited,
    stop: async () => {
      signalGroup(child.pid, 'SIGTERM');
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      // Even after the direct child exits, stragglers in the group must not outlive the session.
      signalGroup(child.pid, 'SIGKILL');
    },
  };
}

/** PID of a live `local up` for this environment, if any (read from its lock). */
export async function findRunningLocalSession(
  paths: Pick<LocalEnvironmentPaths, 'lock'>
): Promise<number | null> {
  const owner = await findLocalLockOwner(paths);
  return owner?.operation === 'up' ? owner.pid : null;
}

/** Build the `wrangler dev` argument list: router first, every Worker, one shared state dir. */
export function buildWranglerDevArgs(input: {
  rootDir: string;
  env: string;
  running: readonly WorkerComponent[];
  persistTo: string;
  port: number;
}): string[] {
  const args = ['exec', 'wrangler', 'dev'];
  for (const component of input.running) {
    args.push('-c', getLocalWorkerConfigPath(input.rootDir, component, input.env));
  }
  args.push('-e', input.env, '--persist-to', input.persistTo, '--port', String(input.port));
  return args;
}

export function turboBuildFilters(running: readonly WorkerComponent[]): string[] {
  // `pkg^...` selects a package's dependencies without the package itself.
  return running.flatMap((component) => ['--filter', `@authrim/${component}^...`]);
}

function routerPort(config: AuthrimConfig): number {
  const origin = config.urls?.api?.auto;
  return origin
    ? Number.parseInt(new URL(origin).port, 10) || LOCAL_DEFAULT_PORTS.router
    : LOCAL_DEFAULT_PORTS.router;
}

function uiPort(config: AuthrimConfig, which: 'loginUi' | 'adminUi'): number {
  const origin = config.urls?.[which]?.auto;
  const fallback = LOCAL_DEFAULT_PORTS[which];
  return origin ? Number.parseInt(new URL(origin).port, 10) || fallback : fallback;
}

/** Wait `ms`, or less when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Poll until `url` answers. Gives up with SessionStoppedError the moment the session stops. */
export async function waitForReady(input: {
  /** What is being waited for, for error messages. */
  label: string;
  url: string;
  /** Accept any HTTP answer (the router is up) instead of insisting on 200. */
  anyResponse?: boolean;
  process: ManagedProcess;
  logPath: string;
  signal: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastStatus = 'no response';
  while (Date.now() < deadline) {
    if (input.signal.aborted) throw new SessionStoppedError();
    if (input.process.hasExited()) {
      throw new Error(`${input.label} exited before becoming ready. See ${input.logPath}`);
    }
    try {
      const response = await fetch(input.url, {
        signal: AbortSignal.any([AbortSignal.timeout(5_000), input.signal]),
      });
      lastStatus = `HTTP ${response.status}`;
      if (response.status === 200 || input.anyResponse) return;
    } catch (error) {
      if (input.signal.aborted) throw new SessionStoppedError();
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await sleep(1_000, input.signal);
  }
  throw new Error(
    `Timed out waiting for ${input.label} at ${input.url} (${lastStatus}). See ${input.logPath}`
  );
}

/** Whether something already listens on `port` (checked on the IPv4 and IPv6 loopback). */
export async function isPortInUse(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1']) {
    const inUse = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once('error', (error: NodeJS.ErrnoException) => {
        // An IPv6 loopback that does not exist is not a conflict.
        resolve(error.code === 'EADDRINUSE' || error.code === 'EACCES');
      });
      server.listen({ port, host }, () => server.close(() => resolve(false)));
    });
    if (inUse) return true;
  }
  return false;
}

/** The ports a session needs, and the first problem with them (duplicates, already in use). */
export async function findLocalPortProblem(input: {
  router: number;
  loginUi?: number;
  adminUi?: number;
}): Promise<string | null> {
  const wanted: Array<[string, number]> = [['router', input.router]];
  if (input.loginUi !== undefined) wanted.push(['Login UI', input.loginUi]);
  if (input.adminUi !== undefined) wanted.push(['Admin UI', input.adminUi]);
  for (const [index, [name, port]] of wanted.entries()) {
    const duplicate = wanted.slice(0, index).find(([, other]) => other === port);
    if (duplicate) return `${name} and ${duplicate[0]} are both configured for port ${port}.`;
  }
  for (const [name, port] of wanted) {
    if (await isPortInUse(port)) return `Port ${port} (${name}) is already in use.`;
  }
  return null;
}

export interface RunLocalOptions {
  rootDir: string;
  env: string;
  only?: readonly string[];
  withUi: boolean;
  onProgress?: (message: string) => void;
}

export async function runLocalEnvironment(options: RunLocalOptions): Promise<void> {
  const { rootDir, env, onProgress } = options;
  assertSupportedLocalPlatform();
  const paths = getLocalEnvironmentPaths(rootDir, env);
  // First thing: nothing below may run twice for one environment, and `reset` must see us.
  const sessionLock = await acquireLocalEnvironmentLock(paths, env, 'up');
  const session = new ChildSession<ManagedProcess>();
  let flowFinished!: () => void;
  const flowEnded = new Promise<void>((resolve) => {
    flowFinished = resolve;
  });
  const requestStop = (): Promise<void> => {
    if (!session.isStopping) onProgress?.('Stopping...');
    return session.stop();
  };
  // A signal stops the children and aborts every wait; the start sequence then unwinds on its own
  // and releases the lock. The process exits once it has, or after a grace period.
  const onSignal = (): void => {
    void requestStop()
      .then(() => Promise.race([flowEnded, new Promise((resolve) => setTimeout(resolve, 10_000))]))
      .then(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const config = await loadLocalConfig(paths);
    const selection = selectLocalComponents(options.only);
    const lock = buildLocalLock(env);
    const port = routerPort(config);

    const hasAdminApi =
      selection.running.includes('ar-management') && selection.running.includes('ar-auth');
    const startUis = options.withUi && hasAdminApi;
    session.assertRunning();
    const portProblem = await findLocalPortProblem({
      router: port,
      ...(startUis
        ? { loginUi: uiPort(config, 'loginUi'), adminUi: uiPort(config, 'adminUi') }
        : {}),
    });
    if (portProblem) {
      throw new Error(
        `${portProblem} Stop what is using it, or create the environment on other ports with \`local init --port/--login-ui-port/--admin-ui-port\`.`
      );
    }

    onProgress?.('Regenerating Wrangler configs...');
    await writeLocalWranglerFiles({ paths, config, selection });
    await mkdir(paths.logs, { recursive: true });

    onProgress?.('Building workspace dependencies (cached builds are skipped)...');
    const buildLogPath = join(paths.logs, 'build.log');
    const build = await execa(
      'pnpm',
      ['exec', 'turbo', 'run', 'build', ...turboBuildFilters(selection.running)],
      {
        cwd: rootDir,
        reject: false,
        cancelSignal: session.signal,
        stdout: { file: buildLogPath },
        stderr: { file: buildLogPath, append: true },
      }
    );
    session.assertRunning();
    if (build.exitCode !== 0) {
      throw new Error(`Building workspace dependencies failed. See ${buildLogPath}`);
    }

    const release = await loadLocalRelease(rootDir);
    const plans = buildInitialControlPlaneResourcePlans({
      env,
      lock,
      release: release.manifest,
      releaseDraft: release.draft,
    });
    session.assertRunning();
    if (await localSignedStateNeedsRefresh(paths)) {
      await refreshLocalSignedState({ env, config, lock, paths, release, plans, onProgress });
    }
    const { token } = await ensureLocalSetupToken({ lock, paths });
    session.assertRunning();

    const workersLogPath = join(paths.logs, 'workers.log');
    onProgress?.(`Starting ${selection.running.length} Workers (log: ${workersLogPath})...`);
    const workers = session.start(() =>
      spawnLogged(
        'pnpm',
        buildWranglerDevArgs({
          rootDir,
          env,
          running: selection.running,
          persistTo: paths.state,
          port,
        }),
        {
          cwd: rootDir,
          logPath: workersLogPath,
          env: { WRANGLER_SEND_METRICS: 'false', CI: '1' },
        }
      )
    );
    const issuer = config.urls!.api!.auto!;
    const hasDiscovery = selection.running.includes('ar-discovery');
    await waitForReady({
      label: 'wrangler dev',
      url: hasDiscovery ? `${issuer}/.well-known/openid-configuration` : `${issuer}/`,
      anyResponse: !hasDiscovery,
      process: workers,
      logPath: workersLogPath,
      signal: session.signal,
    });

    // Client registration and settings go through the Admin API (ar-management behind the router,
    // sign-in handled by ar-auth). A narrowed session without them has neither the UIs nor the
    // email-code sign-in setup.
    let loginUiClientId: string | undefined;
    if (hasAdminApi) {
      ({ loginUiClientId } = await runLocalAdminSession({
        env,
        config,
        paths,
        issuer,
        onProgress,
      }));
      session.assertRunning();
    } else {
      onProgress?.(
        'ar-management and ar-auth are not both running: skipping the Login UI client, email-code setup and the UIs.'
      );
    }

    const watched: Array<{ name: string; process: ManagedProcess; logPath: string }> = [
      { name: 'wrangler dev', process: workers, logPath: workersLogPath },
    ];
    const uiUrls: Array<[string, string]> = [];
    if (startUis) {
      for (const ui of ['ar-login-ui', 'ar-admin-ui'] as const) {
        const which = ui === 'ar-login-ui' ? 'loginUi' : 'adminUi';
        const uiLogPath = join(paths.logs, `${ui}.log`);
        const child = startUiDevServer({
          session,
          rootDir,
          logPath: uiLogPath,
          config,
          ui,
          loginUiClientId,
          issuer,
        });
        watched.push({ name: ui, process: child, logPath: uiLogPath });
        const origin = config.urls![which]!.auto!.replace(/\/$/u, '');
        await waitForReady({
          label: ui,
          url: `${origin}/`,
          anyResponse: true,
          process: child,
          logPath: uiLogPath,
          signal: session.signal,
        });
        uiUrls.push([ui, origin]);
      }
    }

    console.log('');
    console.log(`  Issuer:    ${issuer}`);
    console.log(
      `  Workers:   ${selection.running.map((name) => name.replace('ar-', '')).join(', ')}`
    );
    if (hasDiscovery) console.log(`  Discovery: ${issuer}/.well-known/openid-configuration`);
    for (const [ui, origin] of uiUrls) {
      console.log(
        ui === 'ar-login-ui' ? `  Login UI:  ${origin}/login` : `  Admin UI:  ${origin}/admin/info`
      );
    }
    if (token) {
      console.log(`  Admin setup: ${issuer}/admin-init-setup?token=${token}`);
    } else {
      console.log('  Admin setup: already completed');
    }
    console.log(`  Logs:      ${paths.logs}`);
    console.log('\nPress Ctrl+C to stop.');

    // Any child ending on its own (a UI that lost its port, a crashed dev server) ends the session
    // with an error instead of leaving a half-working environment behind.
    const first = await Promise.race(
      watched.map(async (entry) => ({ entry, code: await entry.process.done }))
    );
    if (!session.isStopping) {
      throw new Error(
        `${first.entry.name} stopped unexpectedly (exit ${first.code ?? 'unknown'}). See ${first.entry.logPath}`
      );
    }
  } catch (error) {
    // A stop request interrupted the start; that is a normal end, not a failure.
    if (!(error instanceof SessionStoppedError)) throw error;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await session.stop();
    await sessionLock.release();
    flowFinished();
  }
}

function startUiDevServer(input: {
  session: ChildSession<ManagedProcess>;
  rootDir: string;
  logPath: string;
  config: AuthrimConfig;
  ui: 'ar-login-ui' | 'ar-admin-ui';
  loginUiClientId?: string;
  issuer: string;
}): ManagedProcess {
  const settings = resolveUiDeploymentSettings({
    component: input.ui,
    config: input.config,
    apiBaseUrl: input.issuer,
    loginUiClientId: input.loginUiClientId,
    allowLocalhostSameSite: true,
  });
  const packageDir = resolveUiPackageDir(
    input.rootDir,
    input.ui,
    input.config.components.adminUiVariant
  );
  if (!existsSync(packageDir)) throw new Error(`UI package not found: ${packageDir}`);
  const port = uiPort(input.config, input.ui === 'ar-login-ui' ? 'loginUi' : 'adminUi');
  const uiEnv = Object.fromEntries(
    Object.entries(settings.uiEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
  return input.session.start(() =>
    spawnLogged(
      'pnpm',
      ['exec', 'vite', 'dev', '--port', String(port), '--strictPort', '--host', 'localhost'],
      { cwd: packageDir, logPath: input.logPath, env: uiEnv }
    )
  );
}
