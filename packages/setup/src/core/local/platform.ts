/**
 * Where local mode runs: macOS, Linux and WSL.
 *
 * Each child (wrangler, Vite) leads its own process group so that stopping it also stops the
 * grandchildren behind `pnpm exec`, and the environment lock reads process start times with `ps`.
 * Both are POSIX behaviour. On native Windows the group signal fails and children would be left
 * running, so local mode refuses to start there instead of half working.
 */

export class UnsupportedLocalPlatformError extends Error {
  constructor(readonly platform: NodeJS.Platform) {
    super(
      'Local development mode supports macOS, Linux and WSL, not native Windows (it relies on ' +
        'POSIX process groups to stop wrangler and Vite cleanly). Run it inside WSL: install a ' +
        'distribution with `wsl --install`, clone Authrim inside the WSL file system, and run ' +
        '`pnpm install` and `pnpm setup:local ...` from the WSL shell.'
    );
    this.name = 'UnsupportedLocalPlatformError';
  }
}

export function assertSupportedLocalPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') throw new UnsupportedLocalPlatformError(platform);
}
