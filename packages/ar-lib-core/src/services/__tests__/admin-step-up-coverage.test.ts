import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_STEP_UP_OPERATIONS } from '../admin-step-up';

/** The workers that serve the Admin API, whose routes call the step-up gate. */
const SOURCES = ['../../../../ar-management/src', '../../../../ar-saml/src'].map((path) =>
  fileURLToPath(new URL(path, import.meta.url))
);

/**
 * Operations in the catalog with no route yet. Adding one here needs a reason: an operation in
 * the catalog that no route checks is protected by nothing.
 */
const NO_ROUTE_YET = new Set(['admin.grace.extend', 'admin.recovery.settings.update']);

function sources(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      files.push(...sources(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

describe('admin step-up catalog coverage', () => {
  const text = SOURCES.flatMap(sources)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  it.each(Object.keys(ADMIN_STEP_UP_OPERATIONS).filter((op) => !NO_ROUTE_YET.has(op)))(
    'has a route that asks for %s',
    (operation) => {
      expect(text).toContain(`operation: '${operation}'`);
    }
  );

  it('lists only operations of the catalog as having no route yet', () => {
    for (const operation of NO_ROUTE_YET) {
      expect(Object.keys(ADMIN_STEP_UP_OPERATIONS)).toContain(operation);
      // Once a route asks for it, it leaves this list.
      expect(text).not.toContain(`operation: '${operation}'`);
    }
  });
});
