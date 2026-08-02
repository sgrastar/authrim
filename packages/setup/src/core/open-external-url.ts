import { execa } from 'execa';

export async function openExternalHttpsUrl(
  value: string,
  options: {
    platform?: NodeJS.Platform;
    runner?: (command: string, args: readonly string[]) => Promise<void>;
  } = {}
): Promise<boolean> {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('external_url_must_be_https');
  const platform = options.platform ?? process.platform;
  const runner =
    options.runner ??
    (async (command: string, args: readonly string[]) => {
      await execa(command, [...args]);
    });
  try {
    if (platform === 'darwin') await runner('open', [url.toString()]);
    else if (platform === 'win32') await runner('cmd', ['/c', 'start', '', url.toString()]);
    else await runner('xdg-open', [url.toString()]);
    return true;
  } catch {
    return false;
  }
}
