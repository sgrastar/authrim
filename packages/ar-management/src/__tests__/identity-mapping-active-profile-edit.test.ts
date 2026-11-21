import { beforeEach, describe, expect, it } from 'vitest';
import { IdentityMappingControlPlaneRepository } from '../identity-mapping-control-plane';
import {
  openAdminDatabase,
  sqliteAdapter,
  type AdapterHooks,
} from './helpers/admin-authority-fixture';
import type { SQLiteDatabase } from './test-sqlite';

/**
 * Editing a Destination or Source Profile that is already active: the profile row and the active
 * version keep serving what uses them, and only a new draft version is added. Real Admin schema on
 * SQLite, so the state the runtime reads (`lifecycle_state`, `active_version_id`, the version's
 * state) is the state asserted here.
 */

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';

const csvSchema = (column: string) => ({
  destinationType: 'csv',
  columns: [{ columnName: column, label: column, order: 1, valueType: 'string' }],
});

let db: SQLiteDatabase;
let repository: IdentityMappingControlPlaneRepository;
let tick: number;
let hooks: AdapterHooks;

beforeEach(() => {
  db = openAdminDatabase();
  tick = 1000;
  hooks = {};
  repository = new IdentityMappingControlPlaneRepository(
    sqliteAdapter(db, hooks),
    () => (tick += 10)
  );
});

async function activeProfile(tenantId = TENANT) {
  const created = await repository.createDestinationProfile(tenantId, {
    destinationType: 'csv',
    profileKey: 'export',
    displayName: 'Export',
    versionLabel: 'v1',
    schema: csvSchema('email'),
  });
  await repository.reviewDestinationProfileVersion(tenantId, created.id, created.version.id);
  await repository.activateDestinationProfileVersion(tenantId, created.id, created.version.id);
  return { profileId: created.id, firstVersionId: created.version.id };
}

function profileRow(profileId: string, tenantId = TENANT) {
  return db
    .prepare(
      'SELECT lifecycle_state, active_version_id FROM destination_profiles WHERE tenant_id = ? AND id = ?'
    )
    .get(tenantId, profileId) as { lifecycle_state: string; active_version_id: string | null };
}

function versionState(versionId: string) {
  return (
    db
      .prepare('SELECT lifecycle_state FROM destination_profile_versions WHERE id = ?')
      .get(versionId) as { lifecycle_state: string }
  ).lifecycle_state;
}

describe('editing an active destination profile', () => {
  it('keeps the row active and the old version serving while the new version is a draft', async () => {
    const { profileId, firstVersionId } = await activeProfile();

    const updated = await repository.updateDestinationProfile(TENANT, profileId, {
      versionLabel: 'v2',
      schema: csvSchema('mail'),
    });

    expect(updated.lifecycleState).toBe('active');
    expect(updated.activeVersionId).toBe(firstVersionId);
    expect(updated.version.lifecycleState).toBe('draft');
    expect(profileRow(profileId)).toEqual({
      lifecycle_state: 'active',
      active_version_id: firstVersionId,
    });
    expect(versionState(firstVersionId)).toBe('active');
    expect(versionState(updated.version.id)).toBe('draft');
  });

  it('lists the pending draft as the version while the profile stays active', async () => {
    const { profileId, firstVersionId } = await activeProfile();
    const updated = await repository.updateDestinationProfile(TENANT, profileId, {
      schema: csvSchema('mail'),
    });

    const listed = (await repository.listDestinationProfiles(TENANT)).find(
      (profile) => profile.id === profileId
    );

    expect(listed).toMatchObject({
      lifecycleState: 'active',
      activeVersionId: firstVersionId,
      version: { id: updated.version.id, lifecycleState: 'draft' },
    });
  });

  it('leaves the old version active when the review of the edit fails', async () => {
    const { profileId, firstVersionId } = await activeProfile();
    const updated = await repository.updateDestinationProfile(TENANT, profileId, {
      schema: csvSchema('mail'),
      warningSummary: { blockingWarningCount: 1, confirmedBlockingWarningCount: 0 },
    });

    await expect(
      repository.reviewDestinationProfileVersion(TENANT, profileId, updated.version.id)
    ).rejects.toMatchObject({ status: 400 });

    expect(profileRow(profileId)).toEqual({
      lifecycle_state: 'active',
      active_version_id: firstVersionId,
    });
    expect(versionState(firstVersionId)).toBe('active');
    expect(versionState(updated.version.id)).toBe('draft');
  });

  it('refuses to activate a version that was not reviewed and changes nothing', async () => {
    const { profileId, firstVersionId } = await activeProfile();
    const updated = await repository.updateDestinationProfile(TENANT, profileId, {
      schema: csvSchema('mail'),
    });

    await expect(
      repository.activateDestinationProfileVersion(TENANT, profileId, updated.version.id)
    ).rejects.toMatchObject({ status: 400 });

    expect(profileRow(profileId).active_version_id).toBe(firstVersionId);
    expect(versionState(firstVersionId)).toBe('active');
  });

  it('switches to the new version in one step when the edit is reviewed and activated', async () => {
    const { profileId, firstVersionId } = await activeProfile();
    const updated = await repository.updateDestinationProfile(TENANT, profileId, {
      schema: csvSchema('mail'),
    });

    await repository.reviewDestinationProfileVersion(TENANT, profileId, updated.version.id);
    expect(profileRow(profileId).active_version_id).toBe(firstVersionId);
    expect(versionState(firstVersionId)).toBe('active');

    await repository.activateDestinationProfileVersion(TENANT, profileId, updated.version.id);

    expect(profileRow(profileId)).toEqual({
      lifecycle_state: 'active',
      active_version_id: updated.version.id,
    });
    expect(versionState(updated.version.id)).toBe('active');
    expect(versionState(firstVersionId)).toBe('reviewed');
  });

  it('does not let a review demote the version that is serving', async () => {
    const { profileId, firstVersionId } = await activeProfile();

    await expect(
      repository.reviewDestinationProfileVersion(TENANT, profileId, firstVersionId)
    ).rejects.toMatchObject({ status: 409 });

    expect(versionState(firstVersionId)).toBe('active');
  });

  it('refuses to change the key of an active profile', async () => {
    const { profileId, firstVersionId } = await activeProfile();

    await expect(
      repository.updateDestinationProfile(TENANT, profileId, {
        profileKey: 'renamed',
        schema: csvSchema('mail'),
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(profileRow(profileId).active_version_id).toBe(firstVersionId);
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM destination_profile_versions WHERE profile_id = ?')
        .get(profileId)
    ).toEqual({ n: 1 });
  });

  it('refuses to change the destination type of an active profile', async () => {
    const { profileId, firstVersionId } = await activeProfile();

    await expect(
      repository.updateDestinationProfile(TENANT, profileId, {
        destinationType: 'saml',
        schema: csvSchema('mail'),
      })
    ).rejects.toMatchObject({ status: 409 });

    expect(profileRow(profileId).active_version_id).toBe(firstVersionId);
  });

  it('lists the serving version next to the newest one', async () => {
    const { profileId, firstVersionId } = await activeProfile();
    await repository.updateDestinationProfile(TENANT, profileId, { schema: csvSchema('mail') });

    const listed = (await repository.listDestinationProfiles(TENANT)).find(
      (profile) => profile.id === profileId
    );

    expect(listed?.activeVersion).toMatchObject({ id: firstVersionId, lifecycleState: 'active' });
    expect(listed?.version?.lifecycleState).toBe('draft');
  });

  it('does not demote the serving version when its activation lands during a review', async () => {
    const { profileId } = await activeProfile();
    const updated = await repository.updateDestinationProfile(TENANT, profileId, {
      schema: csvSchema('mail'),
    });
    await repository.reviewDestinationProfileVersion(TENANT, profileId, updated.version.id);
    // The review passed its checks on a reviewed version; the activation finishes before its write.
    hooks.beforeExecute = {
      match: /UPDATE destination_profile_versions\s+SET lifecycle_state = \?, reviewed_at/,
      run: async () => {
        await repository.activateDestinationProfileVersion(TENANT, profileId, updated.version.id);
      },
    };

    await expect(
      repository.reviewDestinationProfileVersion(TENANT, profileId, updated.version.id)
    ).rejects.toMatchObject({ status: 409 });

    expect(versionState(updated.version.id)).toBe('active');
    expect(profileRow(profileId).active_version_id).toBe(updated.version.id);
  });

  it('does not put a first activation back to draft when an edit races it', async () => {
    const created = await repository.createDestinationProfile(TENANT, {
      destinationType: 'csv',
      profileKey: 'export',
      displayName: 'Export',
      schema: csvSchema('email'),
    });
    await repository.reviewDestinationProfileVersion(TENANT, created.id, created.version.id);
    hooks.beforeExecute = {
      match: /UPDATE destination_profiles\s+SET tenant_id/,
      run: async () => {
        await repository.activateDestinationProfileVersion(TENANT, created.id, created.version.id);
      },
    };

    await expect(
      repository.updateDestinationProfile(TENANT, created.id, { schema: csvSchema('mail') })
    ).rejects.toMatchObject({ status: 409 });

    expect(profileRow(created.id)).toEqual({
      lifecycle_state: 'active',
      active_version_id: created.version.id,
    });
    expect(versionState(created.version.id)).toBe('active');
  });

  it('still lets the display name change while active', async () => {
    const { profileId } = await activeProfile();

    const updated = await repository.updateDestinationProfile(TENANT, profileId, {
      displayName: 'Export (renamed)',
      schema: csvSchema('mail'),
    });

    expect(updated.displayName).toBe('Export (renamed)');
    expect(profileRow(profileId).lifecycle_state).toBe('active');
  });

  it('still deletes an active profile with its versions', async () => {
    const { profileId } = await activeProfile();
    await repository.updateDestinationProfile(TENANT, profileId, { schema: csvSchema('mail') });

    await repository.deleteDestinationProfile(TENANT, profileId);

    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM destination_profile_versions WHERE profile_id = ?')
        .get(profileId)
    ).toEqual({ n: 0 });
  });

  it('keeps tenants apart: another tenant cannot edit or activate over the profile', async () => {
    const { profileId, firstVersionId } = await activeProfile();

    await expect(
      repository.updateDestinationProfile(OTHER_TENANT, profileId, { schema: csvSchema('mail') })
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      repository.activateDestinationProfileVersion(OTHER_TENANT, profileId, firstVersionId)
    ).rejects.toMatchObject({ status: 404 });

    expect(profileRow(profileId)).toEqual({
      lifecycle_state: 'active',
      active_version_id: firstVersionId,
    });
  });
});

describe('editing a destination profile that is not active yet', () => {
  it('stays a draft with a new draft version', async () => {
    const created = await repository.createDestinationProfile(TENANT, {
      destinationType: 'csv',
      profileKey: 'export',
      displayName: 'Export',
      schema: csvSchema('email'),
    });

    const updated = await repository.updateDestinationProfile(TENANT, created.id, {
      profileKey: 'export_v2',
      schema: csvSchema('mail'),
    });

    expect(updated.lifecycleState).toBe('draft');
    expect(updated.activeVersionId).toBeNull();
    expect(profileRow(created.id)).toEqual({ lifecycle_state: 'draft', active_version_id: null });
  });
});

describe('editing an active source profile', () => {
  const sourceSchema = (column: string) => ({
    sourceType: 'csv',
    columns: [{ columnName: column, valueType: 'string' }],
  });

  it('keeps the row active and the old version serving', async () => {
    const created = await repository.createSourceProfile(TENANT, {
      sourceType: 'csv',
      profileKey: 'people',
      displayName: 'People',
      schema: sourceSchema('email'),
    });
    await repository.reviewSourceProfileVersion(TENANT, created.id, created.version.id);
    await repository.activateSourceProfileVersion(TENANT, created.id, created.version.id);

    const updated = await repository.updateSourceProfile(TENANT, created.id, {
      schema: sourceSchema('mail'),
    });

    expect(updated.lifecycleState).toBe('active');
    expect(updated.version.lifecycleState).toBe('draft');
    expect(
      db
        .prepare('SELECT lifecycle_state, active_version_id FROM source_profiles WHERE id = ?')
        .get(created.id)
    ).toEqual({ lifecycle_state: 'active', active_version_id: created.version.id });
    await expect(
      repository.reviewSourceProfileVersion(TENANT, created.id, created.version.id)
    ).rejects.toMatchObject({ status: 409 });
  });
});
