import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbiddenPlatformPackages = [
  'agents',
  'cloudflare:',
  '@cloudflare/',
  '@aws-sdk/',
  'aws-sdk',
] as const;

interface SourceAnalysis {
  source: string;
  imports: string[];
}

let allSourceFiles: string[] = [];
const sourceAnalysisByFile = new Map<string, SourceAnalysis>();

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
      return entry.isFile() && /\.(?:ts|tsx|mts|cts)$/u.test(entry.name) ? [fullPath] : [];
    })
  );
  return nested.flat();
}

function importedSpecifiers(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'dependency-boundary-input.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function filesUnder(area: string): string[] {
  const prefix = `${path.join(sourceRoot, area)}${path.sep}`;
  return allSourceFiles.filter((file) => file.startsWith(prefix));
}

function sourceAnalysis(file: string): SourceAnalysis {
  const analysis = sourceAnalysisByFile.get(file);
  if (!analysis) throw new Error(`Source analysis is unavailable for ${file}`);
  return analysis;
}

describe('ar-agent-access dependency boundaries', () => {
  beforeAll(async () => {
    allSourceFiles = await listTypeScriptFiles(sourceRoot);
    await Promise.all(
      allSourceFiles.map(async (file) => {
        const source = await readFile(file, 'utf8');
        sourceAnalysisByFile.set(file, { source, imports: importedSpecifiers(source) });
      })
    );
  }, 30_000);

  it('detects static, side-effect, dynamic, and re-export module specifiers', () => {
    expect(
      importedSpecifiers(`
        import type { Agent } from 'agents';
        import 'cloudflare:test';
        export * from '@cloudflare/workers-types';
        export { S3Client } from '@aws-sdk/client-s3';
        void import('aws-sdk');
        import WorkersTypes = require('@cloudflare/workers-types');
        void require('agents/mcp');
      `)
    ).toEqual([
      'agents',
      'cloudflare:test',
      '@cloudflare/workers-types',
      '@aws-sdk/client-s3',
      'aws-sdk',
      '@cloudflare/workers-types',
      'agents/mcp',
    ]);
  });

  it.each(['core', 'protocol/mcp'])(
    '%s contains no Cloudflare, Agents SDK, or AWS imports',
    async (area) => {
      const files = filesUnder(area);
      for (const file of files) {
        const { imports } = sourceAnalysis(file);
        for (const specifier of imports) {
          expect(
            forbiddenPlatformPackages.some(
              (prefix) => specifier === prefix || specifier.startsWith(prefix)
            ),
            `${path.relative(sourceRoot, file)} imports platform package ${specifier}`
          ).toBe(false);
        }
      }
    }
  );

  it('core does not import protocol or platform modules', async () => {
    const files = filesUnder('core');
    for (const file of files) {
      const { imports } = sourceAnalysis(file);
      expect(
        imports.filter(
          (specifier) => specifier.includes('/platform') || specifier.includes('/protocol')
        ),
        path.relative(sourceRoot, file)
      ).toEqual([]);
    }
  });

  it('protocol/mcp does not import a concrete platform adapter', async () => {
    const files = filesUnder('protocol/mcp');
    for (const file of files) {
      const { imports } = sourceAnalysis(file);
      expect(
        imports.filter(
          (specifier) =>
            specifier.includes('platform/cloudflare') || specifier.includes('platform/aws')
        ),
        path.relative(sourceRoot, file)
      ).toEqual([]);
    }
  });

  it.each(['core', 'protocol/mcp'])(
    '%s does not load the platform-aggregating ar-lib-core root entrypoint',
    async (area) => {
      const files = filesUnder(area);
      for (const file of files) {
        const { imports } = sourceAnalysis(file);
        expect(
          imports.filter((specifier) => specifier === '@authrim/ar-lib-core'),
          path.relative(sourceRoot, file)
        ).toEqual([]);
      }
    }
  );

  it('does not pull a concrete runtime adapter into the package root entrypoint', async () => {
    const { imports } = sourceAnalysis(path.join(sourceRoot, 'index.ts'));
    expect(
      imports.filter(
        (specifier) =>
          specifier.includes('platform/cloudflare') || specifier.includes('platform/aws')
      )
    ).toEqual([]);
  });

  it('keeps MCP Tool, Resource, and Prompt handler registration out of platform adapters', async () => {
    const files = filesUnder('platform');
    for (const file of files) {
      const relative = path.relative(sourceRoot, file);
      if (relative.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const { source } = sourceAnalysis(file);
      expect(source, relative).not.toMatch(
        /\.(?:setRequestHandler|registerTool|registerResource|registerPrompt|tool|resource|prompt)\s*\(/u
      );
      expect(source, relative).not.toMatch(/\bnew\s+(?:McpServer|Server)\s*\(/u);
    }
  });

  it('keeps concrete platform package imports under platform adapters only', async () => {
    for (const file of allSourceFiles) {
      const { imports } = sourceAnalysis(file);
      const concrete = imports.filter((specifier) =>
        forbiddenPlatformPackages.some(
          (prefix) => specifier === prefix || specifier.startsWith(prefix)
        )
      );
      for (const specifier of concrete) {
        const relative = path.relative(sourceRoot, file);
        const isCloudflare =
          specifier === 'agents' ||
          specifier.startsWith('agents/') ||
          specifier.startsWith('cloudflare:') ||
          specifier.startsWith('@cloudflare/');
        expect(
          relative.startsWith(
            isCloudflare
              ? `platform${path.sep}cloudflare${path.sep}`
              : `platform${path.sep}aws${path.sep}`
          ),
          `${relative} imports concrete platform package ${specifier}`
        ).toBe(true);
      }
    }
  });

  it('isolates the Cloudflare Agents SDK import to the McpAgent transport shell', async () => {
    for (const file of allSourceFiles) {
      const { imports } = sourceAnalysis(file);
      if (!imports.some((specifier) => specifier === 'agents' || specifier.startsWith('agents/'))) {
        continue;
      }
      expect(path.relative(sourceRoot, file)).toBe(
        `platform${path.sep}cloudflare${path.sep}mcp-agent.ts`
      );
    }
  });

  it('keeps Tool authorization contracts out of the McpAgent runtime class', async () => {
    const { source } = sourceAnalysis(
      path.join(sourceRoot, 'platform', 'cloudflare', 'mcp-agent.ts')
    );
    expect(source).not.toMatch(/\brequiredPermissions\s*:/u);
    expect(source).not.toMatch(/\binputSchema\s*:/u);
    expect(source).not.toMatch(/\boutputSchema\s*:/u);
    expect(source).not.toMatch(/\briskLevel\s*:/u);
  });

  it('uses atomic DatabaseAdapter batches instead of D1 transaction callbacks for control-plane writes', async () => {
    const { source } = sourceAnalysis(
      path.join(sourceRoot, 'core', 'repositories', 'admin-agent-access-repository.ts')
    );
    expect(source).not.toContain('adapter.transaction(');
    expect(source).toContain('adapter.batch(');
  });
});
