import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listD1MigrationSqlFiles } from '../core/cloudflare.js';
import { renderPortableMigrationSql } from '../core/sql-portability.js';

const migrationsDir = fileURLToPath(new URL('../../../../migrations', import.meta.url));
const d1Migration = '001_0_4_0_core_baseline.sql';
const postgresMigration = 'external/postgres/001_0_4_0_external_postgres_core_baseline.sql';

function findSqlite3(): string | null {
  try {
    return execFileSync('which', ['sqlite3'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function readMigration(relativePath: string): string {
  return readFileSync(join(migrationsDir, relativePath), 'utf8');
}

describe('SAML SP/OIDC RP Flow migrations', () => {
  it('installs one published, unassigned no-consent preset', () => {
    const sqlite3 = findSqlite3();
    if (!sqlite3) return;
    const directory = mkdtempSync(join(tmpdir(), 'authrim-saml-oidc-flow-'));
    const database = join(directory, 'core.db');
    try {
      const migrations = listD1MigrationSqlFiles(migrationsDir, {
        excludeTopLevelDirectories: new Set([
          'admin',
          'archive',
          'control',
          'external',
          'lookup',
          'pii',
          'plugin-runner',
          'releases',
        ]),
      });
      for (const migration of migrations) {
        execFileSync(sqlite3, [database], {
          input: `PRAGMA foreign_keys = ON;\n${renderPortableMigrationSql(
            readMigration(migration),
            'sqlite'
          )}`,
          encoding: 'utf8',
        });
      }
      const flowState = execFileSync(
        sqlite3,
        [
          database,
          `SELECT status || ':' || is_builtin || ':' || template_id || ':' || published_version_id
             FROM flows
            WHERE tenant_id = 'default' AND id = 'flow-saml-sp-oidc-rp';`,
        ],
        { encoding: 'utf8' }
      ).trim();
      expect(flowState).toBe('published:0:saml-sp-oidc-rp:flow-version-saml-sp-oidc-rp-v1');

      const editorJson = execFileSync(
        sqlite3,
        [
          database,
          `SELECT editor_snapshot_json FROM flow_versions
            WHERE tenant_id = 'default' AND id = 'flow-version-saml-sp-oidc-rp-v1';`,
        ],
        { encoding: 'utf8' }
      ).trim();
      const editor = JSON.parse(editorJson) as {
        nodes: Array<{ id: string; type: string; config?: Record<string, unknown> }>;
        edges: Array<{ source: string; source_handle?: string; target: string }>;
      };

      expect(editor.nodes.some((node) => node.type === 'consent')).toBe(false);
      expect(editor.nodes.find((node) => node.id === 'protocol-condition')).toMatchObject({
        type: 'condition',
        config: {
          conditions: {
            rows: [
              { condition: { type: 'protocol', value: 'saml' }, output_handle: 'saml' },
              { condition: { type: 'protocol', value: 'oidc' }, output_handle: 'oidc' },
            ],
          },
        },
      });
      expect(editor.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'session-check',
            source_handle: 'continue',
            target: 'protocol-condition',
          }),
          expect.objectContaining({
            source: 'protocol-condition',
            source_handle: 'saml',
            target: 'saml-complete',
          }),
          expect.objectContaining({
            source: 'protocol-condition',
            source_handle: 'oidc',
            target: 'oidc-complete',
          }),
        ])
      );

      const counts = execFileSync(
        sqlite3,
        [
          database,
          `SELECT
             (SELECT COUNT(*) FROM flows
               WHERE tenant_id = 'default' AND id = 'flow-saml-sp-oidc-rp') || ':' ||
             (SELECT COUNT(*) FROM flow_versions
               WHERE tenant_id = 'default' AND id = 'flow-version-saml-sp-oidc-rp-v1') || ':' ||
             (SELECT COUNT(*) FROM flow_assignments
               WHERE tenant_id = 'default' AND flow_id = 'flow-saml-sp-oidc-rp');`,
        ],
        { encoding: 'utf8' }
      ).trim();
      expect(counts).toBe('1:1:0');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps D1 and PostgreSQL identifiers and protocol topology in parity', () => {
    const d1 = readMigration(d1Migration);
    const postgres = readMigration(postgresMigration);
    for (const marker of [
      'flow-saml-sp-oidc-rp',
      'flow-version-saml-sp-oidc-rp-v1',
      'session-check:continue->protocol-condition',
      'protocol-condition:saml->saml-complete',
      'protocol-condition:oidc->oidc-complete',
    ]) {
      expect(d1).toContain(marker);
      expect(postgres).toContain(marker);
    }
  });
});
