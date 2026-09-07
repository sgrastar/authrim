/** Standalone npm entry: prepare source before loading the workspace-only CLI. */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execa } from 'execa';
import { confirm } from '@inquirer/prompts';
import { downloadSource } from './source.js';
import { isRunningFromSource } from './source-context.js';

const PATH_OPTIONS = new Set([
  '--source',
  '--keep',
  '--config',
  '--keys-dir',
  '--cloudflare-bootstrap-token-file',
]);

export function resolveLauncherPaths(args: string[], cwd: string): string[] {
  const result = [...args];
  for (let i = 0; i < result.length; i++) {
    if (result[i] === '--') break;
    const [option, ...value] = result[i].split('=');
    if (!PATH_OPTIONS.has(option)) continue;
    if (value.length) {
      if (!value.join('=')) throw new Error(`Missing value for ${option}`);
      result[i] = `${option}=${resolve(cwd, value.join('='))}`;
    } else {
      if (!result[i + 1] || result[i + 1].startsWith('-')) {
        throw new Error(`Missing value for ${option}`);
      }
      i++;
      result[i] = resolve(cwd, result[i]);
    }
  }
  return result;
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0
    ? args[index + 1]
    : args.find((arg) => arg.startsWith(`${option}=`))?.slice(option.length + 1);
}

export function findLauncherSource(cwd: string): string | undefined {
  let candidate = resolve(cwd);
  while (true) {
    if (isRunningFromSource(candidate)) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

export interface LauncherDependencies {
  confirmDownload: (target: string) => Promise<boolean>;
  download: (target: string, gitRef: string) => Promise<unknown>;
  run: (args: string[], cwd: string) => Promise<number>;
}

const dependencies: LauncherDependencies = {
  confirmDownload: (target) =>
    confirm({ message: `Download Authrim source to ${target}?`, default: true }),
  download: (targetDir, gitRef) => downloadSource({ targetDir, gitRef }),
  run: async (args, cwd) => {
    const result = await execa('pnpm', args, { cwd, stdio: 'inherit', reject: false });
    return result.exitCode ?? 1;
  },
};

export async function launchFromSource(
  args: string[],
  version: string,
  cwd = process.cwd(),
  deps: LauncherDependencies = dependencies
): Promise<number> {
  const forwarded = resolveLauncherPaths(args, cwd);
  const explicitSource = optionValue(forwarded, '--source');
  const keep = optionValue(forwarded, '--keep');
  const source = explicitSource ?? findLauncherSource(cwd) ?? keep ?? resolve(cwd, 'authrim');
  if (!isRunningFromSource(source)) {
    if (explicitSource || existsSync(source)) {
      throw new Error(
        `Not an Authrim source repository: ${source}. Choose an empty directory with --keep or an existing repository with --source.`
      );
    }
    // Operational commands must use an existing environment, not a fresh download.
    if (args[0] && !args[0].startsWith('-') && args[0] !== 'init') {
      throw new Error(
        'Run this command inside your Authrim source repository, or use --source where supported.'
      );
    }
    if (!(await deps.confirmDownload(source))) return 0;
    await deps.download(source, `v${version}`);
    if (!isRunningFromSource(source))
      throw new Error('Downloaded source does not contain the Authrim setup workspace.');
  }
  const install = await deps.run(['install', '--frozen-lockfile'], source);
  if (install !== 0) return install;
  const build = await deps.run(['--filter', '@authrim/setup^...', 'build'], source);
  if (build !== 0) return build;
  return deps.run(['run', 'setup', ...forwarded], source);
}
