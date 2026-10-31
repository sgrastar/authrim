import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { inlineD1Params } from '../core/local/d1-batch.js';
import {
  buildWranglerDevArgs,
  findLocalPortProblem,
  findRunningLocalSession,
  isPortInUse,
  turboBuildFilters,
} from '../core/local/runtime.js';
import { localLockEntryName } from '../core/local/lock.js';
import { getLocalEnvironmentPaths } from '../core/local/paths.js';
import { LOCAL_AUTHENTICATION_METHOD_SETTINGS } from '../core/local/admin-session.js';
import { selectLocalComponents } from '../core/local/environment.js';

describe('wrangler dev invocation', () => {
  it('puts the router first and shares one state directory and port', () => {
    const { running } = selectLocalComponents(['auth']);
    const args = buildWranglerDevArgs({
      rootDir: '/repo',
      env: 'local',
      running,
      persistTo: '/repo/.authrim-local/local/state',
      port: 8787,
    });
    expect(args.slice(0, 5)).toEqual([
      'exec',
      'wrangler',
      'dev',
      '-c',
      '/repo/packages/ar-router/wrangler.local.local.toml',
    ]);
    expect(args.filter((arg) => arg === '-c')).toHaveLength(running.length);
    expect(args.slice(-6)).toEqual([
      '-e',
      'local',
      '--persist-to',
      '/repo/.authrim-local/local/state',
      '--port',
      '8787',
    ]);
  });

  it('builds the dependencies of exactly the Workers that run', () => {
    expect(turboBuildFilters(['ar-router', 'ar-auth'])).toEqual([
      '--filter',
      '@authrim/ar-router^...',
      '--filter',
      '@authrim/ar-auth^...',
    ]);
  });
});

describe('inlining D1 batch parameters', () => {
  it('quotes strings, keeps numbers and maps null and booleans', () => {
    expect(
      inlineD1Params('INSERT INTO t VALUES (?, ?, ?, ?, ?)', ["o'brien", 3, null, true, false])
    ).toBe("INSERT INTO t VALUES ('o''brien', 3, NULL, 1, 0)");
  });

  it('leaves question marks inside string literals alone', () => {
    expect(inlineD1Params("SELECT '?' AS q, ? AS v", [1])).toBe("SELECT '?' AS q, 1 AS v");
  });

  it('rejects a mismatch between placeholders and parameters', () => {
    expect(() => inlineD1Params('SELECT ?, ?', [1])).toThrow('local_d1_batch_param_missing');
    expect(() => inlineD1Params('SELECT ?', [1, 2])).toThrow('local_d1_batch_param_unused');
    expect(() => inlineD1Params('SELECT ?', [Number.NaN])).toThrow();
  });
});

describe('local sign-in methods', () => {
  it('enables email codes for every use, since the log notifier can deliver them', () => {
    expect(LOCAL_AUTHENTICATION_METHOD_SETTINGS).toEqual({
      'authentication-methods.email_otp.login_enabled': true,
      'authentication-methods.email_otp.signup_enabled': true,
      'authentication-methods.email_otp.reauth_enabled': true,
      'authentication-methods.email_otp.account_link_enabled': true,
    });
  });
});

describe('running session detection', () => {
  const root = join(process.cwd(), `.test-local-session-${Date.now()}`);
  const paths = getLocalEnvironmentPaths(root, 'local');
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => rmSync(paths.lock, { recursive: true, force: true }));
  const writeEntry = (pid: number, operation: 'init' | 'up' | 'reset') => {
    mkdirSync(paths.lock, { recursive: true });
    const owner = {
      pid,
      token: randomUUID(),
      operation,
      startedAt: new Date().toISOString(),
      processStart: 0,
    } as const;
    writeFileSync(join(paths.lock, localLockEntryName(owner)), '');
  };

  it('reports a live `up` and ignores other operations and processes that are gone', async () => {
    expect(await findRunningLocalSession(paths)).toBeNull();
    writeEntry(process.pid, 'up');
    expect(await findRunningLocalSession(paths)).toBe(process.pid);
    rmSync(paths.lock, { recursive: true, force: true });
    writeEntry(process.pid, 'init');
    expect(await findRunningLocalSession(paths)).toBeNull();
    rmSync(paths.lock, { recursive: true, force: true });
    writeEntry(2147483646, 'up');
    expect(await findRunningLocalSession(paths)).toBeNull();
  });
});

describe('port checks', () => {
  it('reports servers configured for the same port', async () => {
    expect(await findLocalPortProblem({ router: 18787, loginUi: 18787 })).toMatch(
      /Login UI and router are both configured for port 18787/
    );
    expect(await findLocalPortProblem({ router: 18787, loginUi: 18788, adminUi: 18788 })).toMatch(
      /Admin UI and Login UI/
    );
  });

  it('reports a port that something already listens on', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await isPortInUse(port)).toBe(true);
      expect(await findLocalPortProblem({ router: 18787, loginUi: port })).toBe(
        `Port ${port} (Login UI) is already in use.`
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await isPortInUse(port)).toBe(false);
  });

  it('accepts distinct free ports', async () => {
    expect(await findLocalPortProblem({ router: 18790, loginUi: 18791, adminUi: 18792 })).toBe(
      null
    );
  });
});
