import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const ROOT_MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');
const BUNDLED_MIGRATIONS_DIR = join(REPO_ROOT, 'packages', 'setup', 'migrations');

function readRelativeFile(baseDir: string, relativePath: string): string {
  return readFileSync(join(baseDir, relativePath), 'utf-8');
}

function listSqlFiles(relativeDir = ''): string[] {
  return readdirSync(join(ROOT_MIGRATIONS_DIR, relativeDir))
    .filter((entry) => entry.endsWith('.sql'))
    .sort();
}

describe('setup migration bundle', () => {
  it('keeps the bundled fresh core schema in sync with the repository schema', () => {
    expect(readRelativeFile(BUNDLED_MIGRATIONS_DIR, '000_fresh_schema.sql')).toBe(
      readRelativeFile(ROOT_MIGRATIONS_DIR, '000_fresh_schema.sql')
    );
  });

  it('keeps bundled admin migrations in sync with the repository migrations', () => {
    const adminFiles = listSqlFiles('admin');
    const bundledAdminFiles = readdirSync(join(BUNDLED_MIGRATIONS_DIR, 'admin'))
      .filter((entry) => entry.endsWith('.sql'))
      .sort();

    expect(bundledAdminFiles).toEqual(adminFiles);

    for (const file of adminFiles) {
      expect(readRelativeFile(join(BUNDLED_MIGRATIONS_DIR, 'admin'), file)).toBe(
        readRelativeFile(join(ROOT_MIGRATIONS_DIR, 'admin'), file)
      );
    }
  });

  it('keeps bundled pii migrations in sync with the repository migrations', () => {
    const piiFiles = listSqlFiles('pii');
    const bundledPiiFiles = readdirSync(join(BUNDLED_MIGRATIONS_DIR, 'pii'))
      .filter((entry) => entry.endsWith('.sql'))
      .sort();

    expect(bundledPiiFiles).toEqual(piiFiles);

    for (const file of piiFiles) {
      expect(readRelativeFile(join(BUNDLED_MIGRATIONS_DIR, 'pii'), file)).toBe(
        readRelativeFile(join(ROOT_MIGRATIONS_DIR, 'pii'), file)
      );
    }
  });
});
