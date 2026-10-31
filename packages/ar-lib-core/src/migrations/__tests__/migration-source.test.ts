import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readMigrationSource,
  listMigrationSourceFiles,
} from '../../../../../test/helpers/migration-source.mjs';
import { renderPortableMigrationSql, type MigrationSqlDialect } from '../sql-portability';

const root = new URL('../../../../../migrations/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('releases/0.5.0.json', root), 'utf8')) as {
  upgradePaths: Array<{
    streams: Array<{
      id: string;
      dialect: 'sqlite' | 'postgresql';
      files: Array<{ supersedes: Array<{ path: string; checksum: string }> }>;
    }>;
  }>;
};

describe('consolidated migration sources', () => {
  for (const stream of manifest.upgradePaths[0].streams) {
    const directory = new URL(stream.id.replace(/-(d1|postgresql)$/u, '/$1') + '/', root);
    for (const source of stream.files.flatMap((file) => file.supersedes)) {
      it(`preserves the rendered checksum of ${stream.id}/${source.path}`, () => {
        const sql = readMigrationSource(directory, source.path);
        const dialect: MigrationSqlDialect =
          stream.dialect === 'postgresql' ? 'postgres' : 'sqlite';
        expect(
          createHash('sha256').update(renderPortableMigrationSql(sql, dialect)).digest('hex')
        ).toBe(source.checksum);
        expect(listMigrationSourceFiles(directory)).toContain(source.path);
      });
    }
  }

  it('reads a source that still exists directly', () => {
    const directory = new URL('core/d1/', root);
    const filename = '001_0_4_0_core_baseline.sql';
    expect(readMigrationSource(directory, filename)).toBe(
      readFileSync(new URL(filename, directory), 'utf8')
    );
  });

  it('keeps the published predecessor baseline before expanded bridge sources', () => {
    const files = listMigrationSourceFiles(new URL('core/d1/', root));
    expect(files[0]).toBe('001_0_4_0_core_baseline.sql');
    expect(files).not.toContain('001_0_5_0_core_baseline.sql');
    expect(files).not.toContain('002_0_5_0_core_delta.sql');
  });

  it('rejects a missing source', () => {
    expect(() => readMigrationSource(new URL('core/d1/', root), '999_missing.sql')).toThrow(
      'Migration source not found'
    );
  });

  it('rejects an altered section even when its marker and manifest entry exist', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'authrim-migration-source-'));
    try {
      const directory = join(temporary, 'core/d1');
      mkdirSync(directory, { recursive: true });
      mkdirSync(join(temporary, 'releases'));
      copyFileSync(new URL('releases/0.5.0.json', root), join(temporary, 'releases/0.5.0.json'));
      const bundleName = '002_0_5_0_core_delta.sql';
      const bundle = readFileSync(new URL(`core/d1/${bundleName}`, root), 'utf8');
      const filename = '037_statement_consent_enforcement.sql';
      const marker = `-- Consolidated from ${filename}\n-- =============================================================================\n`;
      expect(bundle).toContain(marker);
      writeFileSync(join(directory, bundleName), bundle.replace(marker, marker + '-- altered\n'));
      expect(() => readMigrationSource(directory, filename)).toThrow(
        'Consolidated migration checksum mismatch'
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
