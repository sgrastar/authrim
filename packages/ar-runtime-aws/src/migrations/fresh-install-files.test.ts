import { describe, expect, it } from 'vitest';
import { freshInstallMigrationFiles } from './fresh-install-files';

describe('freshInstallMigrationFiles', () => {
  it('takes the newest baseline alone once releases are consolidated', () => {
    expect(
      freshInstallMigrationFiles([
        '002_0_5_0_core_delta.sql',
        '001_0_5_0_core_baseline.sql',
        '001_0_4_0_core_baseline.sql',
      ])
    ).toEqual(['001_0_5_0_core_baseline.sql']);
  });

  it('adds ordinary migrations that follow the newest baseline, but not bridge deltas', () => {
    expect(
      freshInstallMigrationFiles([
        '001_0_5_0_core_baseline.sql',
        '002_0_5_0_core_delta.sql',
        '003_add_column.sql',
        '004_0_5_1_core_delta.sql',
        '005_add_index.sql',
      ])
    ).toEqual(['001_0_5_0_core_baseline.sql', '003_add_column.sql', '005_add_index.sql']);
  });

  it('keeps every numbered file of a directory with no baseline and ignores other files', () => {
    expect(
      freshInstallMigrationFiles(['002_second.sql', 'README.md', '001_first.sql', 'notes.sql'])
    ).toEqual(['001_first.sql', '002_second.sql']);
  });
});
