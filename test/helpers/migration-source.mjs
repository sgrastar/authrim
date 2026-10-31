import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPortableMigrationSql } from '../../packages/ar-lib-core/dist/migrations/sql-portability.js';

function releaseSources(directory) {
  const streamDirectory = directory instanceof URL ? fileURLToPath(directory) : resolve(directory);
  const streamId = `${basename(dirname(streamDirectory))}-${basename(streamDirectory)}`;
  const releases = join(streamDirectory, '../../releases');
  const bundles = new Map();
  const freshBaselines = new Set();
  if (existsSync(releases)) {
    for (const file of readdirSync(releases)
      .filter((name) => name.endsWith('.json'))
      .sort()) {
      const manifest = JSON.parse(readFileSync(join(releases, file), 'utf8'));
      for (const upgrade of manifest.upgradePaths ?? []) {
        for (const stream of upgrade.streams.filter((item) => item.id === streamId)) {
          for (const bundle of stream.files) {
            if (bundle.supersedes?.length) {
              bundles.set(bundle.path, { ...bundle, dialect: stream.dialect });
            }
          }
        }
      }
      if (
        manifest.freshInstallBaseline?.productVersion === manifest.productVersion &&
        manifest.upgradePaths?.some((upgrade) =>
          upgrade.streams.some(
            (stream) =>
              stream.id === streamId && stream.files.some((file) => file.supersedes?.length)
          )
        )
      ) {
        for (const stream of manifest.streams.filter((item) => item.id === streamId)) {
          for (const baseline of stream.files) freshBaselines.add(baseline.path);
        }
      }
    }
  }
  return { streamDirectory, bundles, freshBaselines };
}

/** Read historical SQL without keeping a second copy of a consolidated migration. */
export function readMigrationSource(directory, filename) {
  const streamDirectory = directory instanceof URL ? fileURLToPath(directory) : resolve(directory);
  const original = join(streamDirectory, filename);
  if (existsSync(original)) return readFileSync(original, 'utf8');

  const { bundles } = releaseSources(streamDirectory);
  for (const [bundlePath, bundle] of bundles) {
    const source = bundle.supersedes.find((item) => item.path === filename);
    if (!source) continue;
    const sql = readFileSync(join(streamDirectory, bundlePath), 'utf8');
    const markers = [...sql.matchAll(/^-- =+\n-- Consolidated from (.+)\n-- =+\n/gmu)];
    const index = markers.findIndex((marker) => marker[1] === filename);
    if (index < 0) throw new Error(`Missing consolidated migration marker: ${filename}`);
    const marker = markers[index];
    // mergeSqlFiles trims each source's trailing whitespace. Source SQL uses one final newline;
    // restore it, then verify the exact rendered bytes against the original manifest checksum.
    const section =
      sql.slice(marker.index + marker[0].length, markers[index + 1]?.index).trimEnd() + '\n';
    const dialect = bundle.dialect === 'postgresql' ? 'postgres' : bundle.dialect;
    const checksum = createHash('sha256')
      .update(renderPortableMigrationSql(section, dialect))
      .digest('hex');
    if (checksum !== source.checksum) {
      throw new Error(`Consolidated migration checksum mismatch: ${filename} in ${bundlePath}`);
    }
    return section;
  }
  throw new Error(`Migration source not found: ${filename} in ${streamDirectory}`);
}

/** Render a release artifact for the database dialect of its stream directory. */
export function readRenderedMigrationSql(directory, filename) {
  const path = directory instanceof URL ? fileURLToPath(directory) : resolve(directory);
  return renderPortableMigrationSql(
    readMigrationSource(directory, filename),
    basename(path) === 'postgresql' ? 'postgres' : 'sqlite'
  );
}

/** Expand bridge bundles for tests that inspect historical order or reviewed source DDL. */
export function listMigrationSourceFiles(directory) {
  const { streamDirectory, bundles, freshBaselines } = releaseSources(directory);
  return [
    ...new Set(
      readdirSync(streamDirectory)
        .filter((file) => file.endsWith('.sql') && !freshBaselines.has(file))
        .flatMap((file) => bundles.get(file)?.supersedes.map((source) => source.path) ?? [file])
    ),
  ].sort();
}
