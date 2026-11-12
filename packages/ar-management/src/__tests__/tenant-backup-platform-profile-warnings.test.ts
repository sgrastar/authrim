import { describe, expect, it } from 'vitest';
import { loadBundlePlatformProfileWarnings } from '../tenant-backup-platform-profile-warnings';

const flowRow = JSON.stringify({
  id: ['text', 'f1'],
  published_version_id: ['null', null],
  deleted_at: ['null', null],
  draft_editor_json: [
    'text',
    JSON.stringify({
      a: { authentication_profile_ref: 'pmp_gone' },
      b: { session_profile_ref: 'psp_fine' },
    }),
  ],
  draft_runtime_base_json: ['null', null],
});

function validatedInput(rows: Record<string, string[]>) {
  return {
    isDatasetSelected: async (_c: unknown, _d: string, datasetId: string) => datasetId in rows,
    loadValidatedDatasetById: async (_c: unknown, _d: string, datasetId: string) => ({
      readNextValidatedRow: async ({ sourceCursor }: { sourceCursor: string | null }) => {
        const index = sourceCursor === null ? 0 : Number(sourceCursor);
        const rowJson = rows[datasetId]?.[index];
        return rowJson === undefined ? null : { rowJson, nextCursor: String(index + 1) };
      },
    }),
  };
}

const context = { signal: new AbortController().signal } as never;
const admin = {
  queryOne: async (_sql: string, params: unknown[] = []) =>
    params[0] === 'psp_fine'
      ? { id: 'psp_fine', name: 'n', values_json: '{}', version: 1, locked: 0, state: 'active' }
      : null,
};

describe('loadBundlePlatformProfileWarnings', () => {
  it('reads the validated Flow rows and reports the profiles the target cannot use', async () => {
    const warnings = await loadBundlePlatformProfileWarnings({
      validatedInput: validatedInput({ 'core.flows': [flowRow] }) as never,
      admin: admin as never,
      context,
      planDigest: 'a'.repeat(64),
    });
    expect(warnings).toEqual([
      {
        id: 'pmp_gone',
        kind: 'platform_method_profile',
        scope: 'shared',
        resolution: 'target_binding',
        status: 'unresolved',
        required: false,
      },
    ]);
  });

  it('has nothing to say when the bundle carries no Flows', async () => {
    expect(
      await loadBundlePlatformProfileWarnings({
        validatedInput: validatedInput({}) as never,
        admin: admin as never,
        context,
        planDigest: 'a'.repeat(64),
      })
    ).toEqual([]);
  });
});
