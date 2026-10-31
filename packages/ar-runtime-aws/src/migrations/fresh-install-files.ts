/**
 * Which numbered SQL files of a stream directory build a NEW database.
 *
 * A release directory holds one fresh-install baseline per minor release, the upgrade-only bridge
 * deltas (`*_delta.sql`) that carry an older release to the new one, and ordinary migrations added
 * after the newest baseline. A new database takes the newest baseline and the ordinary migrations
 * after it. Older baselines describe the same schema and bridge deltas upgrade from it, so
 * applying them would fail on objects the baseline already created. A directory with no baseline
 * keeps every file, as before the baselines existed.
 */
export function freshInstallMigrationFiles(names: readonly string[]): string[] {
  const files = names.filter((name) => /^\d+.*\.sql$/u.test(name)).sort();
  const baselines = files.filter((name) => /_baseline\.sql$/u.test(name));
  const newest = baselines[baselines.length - 1];
  if (newest === undefined) return files;
  return [
    newest,
    ...files
      .slice(files.indexOf(newest) + 1)
      .filter((name) => !/_baseline\.sql$/u.test(name) && !/_delta\.sql$/u.test(name)),
  ];
}
