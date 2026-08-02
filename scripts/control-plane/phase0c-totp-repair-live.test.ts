import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  isPhase0cTotpRepairEntrypoint,
  parsePhase0cTotpRepairArgs,
} from './phase0c-totp-repair-live.js';

describe('Phase 0c interrupted TOTP repair', () => {
  it('is test-only and requires explicit data authorization', () => {
    expect(parsePhase0cTotpRepairArgs(['--', '--env', 'test', '--confirm-test-data'])).toEqual({
      environment: 'test',
      confirmTestData: true,
    });
    expect(() => parsePhase0cTotpRepairArgs(['--env', 'test'])).toThrow(
      'phase0c_totp_repair_confirmation_required'
    );
    expect(() =>
      parsePhase0cTotpRepairArgs(['--env', 'production', '--confirm-test-data'])
    ).toThrow('phase0c_totp_repair_test_environment_required');
  });

  it('uses Admin deletion and fails closed before clearing non-exact settings', async () => {
    const source = await readFile(
      new URL('./phase0c-totp-repair-live.ts', import.meta.url),
      'utf8'
    );
    expect(source).toContain('path: `/api/admin/users/${encodeURIComponent(userId)}`');
    expect(source).toContain("method: 'DELETE'");
    expect(source).toContain('phase0c_totp_repair_settings_not_exact_temporary_state');
    expect(source).toContain('phase0c_totp_repair_stage_${repairStage}_failed');
    expect(source).toContain('const MAX_REPAIR_USERS = 1_200');
    expect(source).toContain('const REPAIR_DELETE_CONCURRENCY = 8');
    expect(source).not.toContain('DELETE FROM identity_sensitive_values');
    expect(source).not.toContain('console.log');
  });

  it('recognizes only its repository path as the entrypoint', () => {
    expect(
      isPhase0cTotpRepairEntrypoint(
        '/private/tmp/repository/scripts/control-plane/phase0c-totp-repair-live.ts',
        '/private/tmp/repository'
      )
    ).toBe(true);
    expect(isPhase0cTotpRepairEntrypoint('/private/tmp/vitest.mjs')).toBe(false);
  });
});
