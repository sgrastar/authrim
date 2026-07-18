import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAutomaticWranglerSyncAction, getDeployKeysDirHint } from '../cli/commands/deploy';

describe('deploy prompt policy', () => {
  it('overwrites the generated target environment section in --yes mode', () => {
    expect(getAutomaticWranglerSyncAction({ yes: true })).toBe('overwrite');
  });

  it('keeps interactive choice enabled without --yes', () => {
    expect(getAutomaticWranglerSyncAction({ yes: false })).toBeNull();
    expect(getAutomaticWranglerSyncAction({})).toBeNull();
  });

  it('falls back from a stale configured key path but preserves an explicit override', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'authrim-deploy-keys-'));
    mkdirSync(join(baseDir, 'existing-keys'));

    expect(
      getDeployKeysDirHint({ baseDir, configuredKeysDir: './missing-legacy-keys/' })
    ).toBeUndefined();
    expect(getDeployKeysDirHint({ baseDir, configuredKeysDir: './existing-keys/' })).toBe(
      './existing-keys/'
    );
    expect(
      getDeployKeysDirHint({
        baseDir,
        explicitKeysDir: './intentional-missing-path/',
        configuredKeysDir: './existing-keys/',
      })
    ).toBe('./intentional-missing-path/');
  });
});
