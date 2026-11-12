import { describe, expect, it } from 'vitest';
import {
  collectBundlePlatformProfileIds,
  findUnusablePlatformProfiles,
  PLATFORM_PROFILE_CHECK_INCOMPLETE,
  PLATFORM_PROFILE_LOOKUP_LIMIT,
  PLATFORM_PROFILE_VERSION_ROW_LIMIT,
} from '../platform-profile-prerequisites';

const text = (value: string) => ['text', value];
const nul = ['null', null];
const flow = (input: {
  id: string;
  published?: string;
  deletedAt?: number;
  editor?: unknown;
  runtime?: unknown;
}) =>
  JSON.stringify({
    id: text(input.id),
    published_version_id: input.published ? text(input.published) : nul,
    deleted_at: input.deletedAt === undefined ? nul : ['integer', String(input.deletedAt)],
    draft_editor_json: input.editor ? text(JSON.stringify(input.editor)) : nul,
    draft_runtime_base_json: input.runtime ? text(JSON.stringify(input.runtime)) : nul,
  });
const version = (id: string, snapshot: unknown) =>
  JSON.stringify({ id: text(id), runtime_snapshot_json: text(JSON.stringify(snapshot)) });

function reader(datasets: Record<string, string[]>) {
  return async function* (datasetId: string) {
    for (const row of datasets[datasetId] ?? []) yield row;
  };
}

describe('collectBundlePlatformProfileIds', () => {
  it('collects platform ids per kind from live drafts and the published version only', async () => {
    const ids = await collectBundlePlatformProfileIds(
      reader({
        'core.flows': [
          flow({
            id: 'f1',
            published: 'v2',
            editor: { steps: [{ authentication_profile_ref: 'pmp_one' }] },
            runtime: { session: { session_profile_ref: 'psp_one' } },
          }),
          // deleted Flow: counts for nothing, nor does its published version
          flow({
            id: 'f2',
            published: 'v9',
            deletedAt: 5,
            editor: { authentication_profile_ref: 'pmp_deleted_flow' },
          }),
          // tenant's own / default refs are not platform ids
          flow({
            id: 'f3',
            editor: { authentication_profile_ref: 'default', x: { session_profile_ref: 'own-1' } },
          }),
        ],
        'core.flow_versions': [
          version('v1', { authentication_profile_ref: 'pmp_old_version' }),
          version('v2', { nodes: [{ authentication_profile_ref: 'pmp_published' }] }),
          version('v9', { authentication_profile_ref: 'pmp_deleted_flow_version' }),
        ],
      })
    );
    expect(ids).toEqual({
      method: ['pmp_one', 'pmp_published'],
      session: ['psp_one'],
    });
  });

  it('names nothing for a bundle without Flows', async () => {
    expect(await collectBundlePlatformProfileIds(reader({}))).toEqual({ method: [], session: [] });
  });

  it('says the list may be short for a bundle with more version rows than it will read', async () => {
    const rows = Array.from({ length: PLATFORM_PROFILE_VERSION_ROW_LIMIT + 1 }, (_, i) =>
      version(`v${i}`, {})
    );
    await expect(
      collectBundlePlatformProfileIds(
        reader({ 'core.flows': [flow({ id: 'f', published: 'v0' })], 'core.flow_versions': rows })
      )
    ).resolves.toMatchObject({ incomplete: true });
  });
});

describe('findUnusablePlatformProfiles', () => {
  const adminWith = (states: Record<string, string>) => ({
    queryOne: async (_sql: string, params: unknown[] = []) => {
      const id = String(params[0]);
      return id in states
        ? {
            id,
            name: 'secret name',
            values_json: '{}',
            version: 1,
            locked: 0,
            state: states[id],
            created_by: null,
            created_at: 1,
            updated_at: 1,
          }
        : null;
    },
  });

  it('checks up to its limit and says the rest was not checked', async () => {
    const many = Array.from(
      { length: PLATFORM_PROFILE_LOOKUP_LIMIT + 1 },
      (_, i) => `pmp_${String(i).padStart(4, '0')}`
    );
    const warnings = await findUnusablePlatformProfiles(adminWith({}), {
      method: many,
      session: [],
    });
    expect(warnings.at(-1)).toEqual(PLATFORM_PROFILE_CHECK_INCOMPLETE);
    // A short scan says so too, even with nothing to warn about.
    await expect(
      findUnusablePlatformProfiles(adminWith({}), { method: [], session: [], incomplete: true })
    ).resolves.toEqual([PLATFORM_PROFILE_CHECK_INCOMPLETE]);
  });

  it('warns for missing and not-active profiles, and lists active ones not at all', async () => {
    const warnings = await findUnusablePlatformProfiles(
      adminWith({ pmp_ok: 'active', pmp_going: 'deleting', psp_gone: 'deleted' }),
      { method: ['pmp_going', 'pmp_missing', 'pmp_ok'], session: ['psp_gone'] }
    );
    expect(warnings).toEqual([
      expect.objectContaining({ id: 'pmp_going', kind: 'platform_method_profile' }),
      expect.objectContaining({ id: 'pmp_missing', kind: 'platform_method_profile' }),
      expect.objectContaining({ id: 'psp_gone', kind: 'platform_session_profile' }),
    ]);
    for (const warning of warnings) {
      expect(warning).toEqual(
        expect.objectContaining({
          scope: 'shared',
          resolution: 'target_binding',
          status: 'unresolved',
          required: false,
        })
      );
      // nothing but id and kind of the profile reaches the preview
      expect(JSON.stringify(warning)).not.toContain('secret');
    }
  });

  it('returns nothing when every named profile is active', async () => {
    expect(
      await findUnusablePlatformProfiles(adminWith({ pmp_ok: 'active' }), {
        method: ['pmp_ok'],
        session: [],
      })
    ).toEqual([]);
  });
});
