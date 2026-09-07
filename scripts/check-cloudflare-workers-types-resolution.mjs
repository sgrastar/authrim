import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedModule = path.join(repositoryRoot, 'types', 'cloudflare-workers-imports.d.ts');

const packageConfigPaths = readdirSync(path.join(repositoryRoot, 'packages'), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join('packages', entry.name, 'tsconfig.json'))
  .filter((configPath) => existsSync(path.join(repositoryRoot, configPath)));

const candidateConfigPaths = ['tsconfig.base.json', ...packageConfigPaths];
const resolutionChecks = [];

for (const config of candidateConfigPaths) {
  const configPath = path.join(repositoryRoot, config);
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }

  const explicitlyUsesWorkersTypes = configFile.config.compilerOptions?.types?.includes(
    '@cloudflare/workers-types'
  );
  const inheritsRootCompilerOptions = configFile.config.extends === '../../tsconfig.base.json';
  if (
    config !== 'tsconfig.base.json' &&
    !explicitlyUsesWorkersTypes &&
    !inheritsRootCompilerOptions
  ) {
    continue;
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath
  );
  if (parsedConfig.errors.length > 0) {
    throw new Error(
      parsedConfig.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n')
    );
  }

  if (!parsedConfig.options.types?.includes('@cloudflare/workers-types')) {
    continue;
  }

  resolutionChecks.push({
    config,
    importer: path.join(path.dirname(config), 'src', '__workers-types-resolution-check__.ts'),
    parsedConfig,
  });
}

for (const check of resolutionChecks) {
  const resolved = ts.resolveModuleName(
    '@cloudflare/workers-types',
    path.join(repositoryRoot, check.importer),
    check.parsedConfig.options,
    ts.sys
  ).resolvedModule;
  const resolvedFile = resolved ? path.resolve(resolved.resolvedFileName) : undefined;

  if (resolvedFile !== expectedModule) {
    throw new Error(
      [
        `${check.config} resolves @cloudflare/workers-types to an unsafe target.`,
        `Expected: ${expectedModule}`,
        `Received: ${resolvedFile ?? 'unresolved'}`,
        'The v5 package source index.ts must not be compiled by Authrim typechecks or builds.',
      ].join('\n')
    );
  }
}

stdout.write(
  `Cloudflare Workers explicit type imports resolve to the lightweight Authrim shim in ${resolutionChecks.length} TypeScript configurations.\n`
);
