import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from './synthetic-fixture';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function migrationDirectory(files: Record<string, string>): Promise<URL> {
  const directory = await mkdtemp(join(tmpdir(), 'authrim-migrate-'));
  directories.push(directory);
  for (const [name, sql] of Object.entries(files))
    await writeFile(join(directory, name), `${sql}\n`);
  return pathToFileURL(`${directory}/`);
}

async function appliedSql(directory: URL): Promise<string[]> {
  const applied: string[] = [];
  await migrate(
    { query: async (sql: string) => void applied.push(sql) } as unknown as Client,
    directory
  );
  return applied.filter((sql) => sql.startsWith('CREATE'));
}

describe('rehearsal migrate', () => {
  it('applies only the newest fresh-install baseline of a release directory', async () => {
    const directory = await migrationDirectory({
      '001_0_4_0_core_baseline.sql': 'CREATE TABLE old_schema (id TEXT);',
      '001_0_5_0_core_baseline.sql': 'CREATE TABLE new_schema (id TEXT);',
      '002_0_5_0_core_delta.sql': 'CREATE TABLE upgrade_only (id TEXT);',
    });
    expect(await appliedSql(directory)).toEqual(['CREATE TABLE new_schema (id TEXT);\n']);
  });

  it('still applies every numbered migration of a directory that has no baseline', async () => {
    const directory = await migrationDirectory({
      '001_first.sql': 'CREATE TABLE first_table (id TEXT);',
      '002_second.sql': 'CREATE TABLE second_table (id TEXT);',
    });
    expect(await appliedSql(directory)).toEqual([
      'CREATE TABLE first_table (id TEXT);\n',
      'CREATE TABLE second_table (id TEXT);\n',
    ]);
  });
});
