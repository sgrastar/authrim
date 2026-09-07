import path from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedModule = path.join(repositoryRoot, 'types', 'cloudflare-workers-imports.d.ts');

const resolutionChecks = [
  {
    config: 'tsconfig.base.json',
    importer: 'packages/ar-control/src/storage-topology.ts',
  },
  {
    config: 'packages/ar-lib-core/tsconfig.json',
    importer: 'packages/ar-lib-core/src/services/webhook-sender.ts',
  },
];

for (const check of resolutionChecks) {
  const configPath = path.join(repositoryRoot, check.config);
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
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

  const resolved = ts.resolveModuleName(
    '@cloudflare/workers-types',
    path.join(repositoryRoot, check.importer),
    parsedConfig.options,
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

stdout.write('Cloudflare Workers explicit type imports resolve to the lightweight Authrim shim.\n');
