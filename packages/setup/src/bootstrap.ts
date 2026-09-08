#!/usr/bin/env node
/** npm launcher. Never statically import the workspace CLI from this entry. */
import { createRequire } from 'node:module';
import { Command } from 'commander';
import { launchFromSource } from './core/npm-launcher.js';
import { downloadSource, verifySourceStructure } from './core/source.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };
const args = process.argv.slice(2);

try {
  if (args[0] === 'download') {
    const command = new Command('download')
      .description('Download Authrim source code without starting setup')
      .option('-o, --output <path>', 'Output directory', './authrim')
      .option('--repo <repository>', 'GitHub repository', 'sgrastar/authrim')
      .option('--ref <gitRef>', 'Git tag or branch', `v${version}`)
      .option('--force', 'Overwrite existing directory')
      .action(async (options: { output: string; repo: string; ref: string; force?: boolean }) => {
        await downloadSource({
          targetDir: options.output,
          repository: options.repo,
          gitRef: options.ref,
          force: options.force,
        });
        const verification = await verifySourceStructure(options.output);
        if (!verification.valid) throw new Error(verification.errors.join('\n'));
        process.stdout.write(`Source downloaded to ${options.output}\n`);
      });
    await command.parseAsync(args, { from: 'user' });
  } else if (args.length === 1 && ['--version', '-V'].includes(args[0])) {
    process.stdout.write(`${version}\n`);
  } else if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(
      `Authrim setup ${version}\n\nUsage: authrim-setup [command] [options]\n\nRun without a command to start setup. Missing source is downloaded from GitHub.\n  init [--cli] [--keep <path>]  Start setup using existing or downloaded source\n  download [options]           Download source only (download --help for options)\n  --version                   Print the npm launcher version\n\nAll other commands and options are forwarded to the source CLI.\nRun pnpm run setup --help in the source repository for the full command list.\n`
    );
  } else {
    process.exitCode = await launchFromSource(args, version);
  }
} catch (error) {
  if (error instanceof Error && error.name === 'ExitPromptError') {
    process.exitCode = 0;
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
