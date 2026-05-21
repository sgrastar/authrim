import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readRouteSource(relativePath: string): string {
  const candidates = [
    join(process.cwd(), relativePath),
    join(process.cwd(), '..', '..', relativePath),
  ];
  const sourcePath = candidates.find((candidate) => existsSync(candidate));
  if (!sourcePath) {
    throw new Error(`route_source_not_found:${relativePath}`);
  }
  return readFileSync(sourcePath, 'utf8');
}

function extractJsonResponses(source: string): string[] {
  return Array.from(source.matchAll(/return c\.json\(([\s\S]*?)\n\s*\);/g), (match) =>
    match[1].trim()
  );
}

describe('logging/storage admin response envelopes', () => {
  const routeSources = [
    'packages/ar-management/src/routes/admin-management/logging-control.ts',
    'packages/ar-management/src/routes/admin-management/storage-destinations.ts',
  ];

  it('keeps logging/storage route responses on the shared admin envelope helpers', () => {
    const responses = routeSources.flatMap((path) => extractJsonResponses(readRouteSource(path)));

    expect(responses.length).toBeGreaterThan(0);
    for (const response of responses) {
      expect(response).toMatch(
        /admin(?:List|Detail|Mutation|Action)Envelope\(|createErrorResponse\(|createAdmin/
      );
      expect(response).not.toMatch(/^\{/);
    }
  });
});
