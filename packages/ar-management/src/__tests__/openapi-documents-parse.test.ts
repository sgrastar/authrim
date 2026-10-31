import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// A plain scalar containing ": " (for example in a description) breaks YAML parsing, and a
// document that does not parse never reaches reviewers until the post-merge docs sync fails.
// Parse every published OpenAPI document here so the PR test run catches it.
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const packagesDir = join(repositoryRoot, 'packages');

function listOpenApiDocuments(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    const openApiDir = join(packagesDir, entry.name, 'openapi');
    if (!entry.isDirectory() || !existsSync(openApiDir)) continue;
    for (const file of readdirSync(openApiDir)) {
      if (file.endsWith('.openapi.yaml')) files.push(join(openApiDir, file));
    }
  }
  return files.sort();
}

const documents = listOpenApiDocuments().map((file) => relative(repositoryRoot, file));

describe('OpenAPI documents', () => {
  it('finds the documents under packages/*/openapi', () => {
    expect(documents).toContain('packages/ar-management/openapi/user-self-service.openapi.yaml');
    expect(documents.length).toBeGreaterThanOrEqual(15);
  });

  it.each(documents)('%s parses as YAML with openapi and paths', (path) => {
    const document = parse(readFileSync(join(repositoryRoot, path), 'utf8')) as {
      openapi?: unknown;
      paths?: unknown;
    };

    expect(typeof document.openapi).toBe('string');
    expect(document.paths).toBeTypeOf('object');
    expect(Object.keys(document.paths as object).length).toBeGreaterThan(0);
  });
});
