import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  initLocalEnvironment,
  rebuildLocalEnvironment,
  resetLocalEnvironment,
} from '../core/local/init.js';
import { getLocalEnvironmentPaths } from '../core/local/paths.js';
import {
  assertSupportedLocalPlatform,
  UnsupportedLocalPlatformError,
} from '../core/local/platform.js';
import { runLocalEnvironment } from '../core/local/runtime.js';

describe('supported platforms', () => {
  it('accepts macOS, Linux and WSL (which reports linux)', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(() => assertSupportedLocalPlatform(platform), platform).not.toThrow();
    }
  });

  it('refuses native Windows and points to WSL', () => {
    expect(() => assertSupportedLocalPlatform('win32')).toThrow(UnsupportedLocalPlatformError);
    expect(() => assertSupportedLocalPlatform('win32')).toThrow(/WSL/);
  });
});

describe('every entry point refuses native Windows before touching anything', () => {
  const root = join(process.cwd(), `.test-local-win-${Date.now()}`);
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  afterEach(() => Object.defineProperty(process, 'platform', original));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('init, reset, rebuild and up', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const base = { rootDir: root, env: 'local' };
    await expect(initLocalEnvironment(base)).rejects.toThrow(UnsupportedLocalPlatformError);
    await expect(resetLocalEnvironment(base)).rejects.toThrow(UnsupportedLocalPlatformError);
    await expect(rebuildLocalEnvironment(base)).rejects.toThrow(UnsupportedLocalPlatformError);
    await expect(runLocalEnvironment({ ...base, withUi: false })).rejects.toThrow(
      UnsupportedLocalPlatformError
    );
    // No lock, state or generated file was created.
    expect(existsSync(getLocalEnvironmentPaths(root, 'local').lock)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });
});
