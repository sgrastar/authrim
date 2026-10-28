import { afterEach, describe, expect, it, vi } from 'vitest';
import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import { IdentityMappingControlPlaneRepository } from '../identity-mapping-control-plane';
import type { Env } from '@authrim/ar-lib-core';
const close: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  close.splice(0).forEach((f) => f());
});
async function fixture(mode: 'scheduled' | 'pipeline') {
  const f = await logProducerFixture(mode, { separateAdmin: true });
  close.push(f.close);
  f.db
    .exec(`INSERT INTO identity_subjects(id,tenant_id,subject_type,lifecycle_state,created_at,updated_at) VALUES('subject','tenant-a','person','active',1,1);
 INSERT INTO "groups"(id,tenant_id,group_key,display_name,lifecycle_state,created_at,updated_at) VALUES('group','tenant-a','group','Group','active',1,1);`);
  const repo = new IdentityMappingControlPlaneRepository(
    f.adminAdapter,
    () => f.now,
    f.adapter,
    undefined,
    f.env as Env,
    f.publicationSource
  );
  const rule = await repo.createProvisioningAssignmentRule('tenant-a', {
    ruleType: 'event',
    targetType: 'group',
    targetId: 'group',
    condition: { eventTypes: ['jit'] },
  });
  return { ...f, repo, rule };
}
const input = { eventType: 'jit', subjectId: 'subject' } as const;
describe.each(['scheduled', 'pipeline'] as const)('Mapping producer storage (%s)', (mode) => {
  it('commits assignment and ownership in tenant Core with only its browsing log in Admin', async () => {
    const f = await fixture(mode);
    await expect(
      f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, input)
    ).resolves.toMatchObject({ outcome: 'assigned' });
    expect(
      f.db.prepare('SELECT lifecycle_state FROM group_memberships').get()?.lifecycle_state
    ).toBe('active');
    expect(f.db.prepare('SELECT count(*) n FROM provisioning_assignment_ownership').get()?.n).toBe(
      1
    );
    expect(f.db.prepare('SELECT count(*) n FROM provisioning_assignment_events').get()?.n).toBe(0);
    expect(
      f.adminDb.prepare("SELECT name FROM sqlite_master WHERE name='group_memberships'").get()
    ).toBeUndefined();
    expect(await f.rows('core.provisioning_assignment_events')).toEqual([
      expect.objectContaining({ rule_id: f.rule.id, outcome: 'assigned', subject_id: 'subject' }),
    ]);
    if (mode === 'pipeline')
      expect(f.adminDb.prepare('SELECT count(*) n FROM log_iceberg_records').get()?.n).toBe(0);
  });
  it('keeps failed business batches and losing rule predicates unpublished', async () => {
    const f = await fixture(mode);
    f.db.exec(
      "CREATE TRIGGER fail_ownership BEFORE INSERT ON provisioning_assignment_ownership BEGIN SELECT RAISE(ABORT,'ownership failed'); END"
    );
    await expect(
      f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, input)
    ).rejects.toThrow('ownership failed');
    expect(f.db.prepare('SELECT count(*) n FROM group_memberships').get()?.n).toBe(0);
    expect(await f.rows('core.provisioning_assignment_events')).toHaveLength(0);
    f.db.exec('DROP TRIGGER fail_ownership');
    const writer = f.env.LOG_ARCHIVE_WRITER!;
    const original = writer.prepareCorePublication.bind(writer);
    vi.spyOn(writer, 'prepareCorePublication').mockImplementationOnce(async (request) => {
      await original(request);
      f.db
        .prepare("UPDATE provisioning_assignment_rules SET lifecycle_state='retired' WHERE id=?")
        .run(f.rule.id);
    });
    await expect(
      f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, input)
    ).rejects.toThrow('business state changed');
    expect(f.db.prepare('SELECT count(*) n FROM group_memberships').get()?.n).toBe(0);
    expect(await f.rows('core.provisioning_assignment_events')).toHaveLength(0);
  });
  it('retains source commit after a dispatch failure and publishes through metadata-only recovery', async () => {
    const f = await fixture(mode);
    const writer = f.env.LOG_ARCHIVE_WRITER!;
    vi.spyOn(writer, 'publishCorePublication').mockRejectedValueOnce(new Error('response lost'));
    await expect(
      f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, input)
    ).rejects.toThrow('response lost');
    expect(f.db.prepare('SELECT count(*) n FROM group_memberships').get()?.n).toBe(1);
    expect(await f.rows('core.provisioning_assignment_events')).toHaveLength(0);
    const pub = f.db
      .prepare("SELECT id FROM log_iceberg_core_publications WHERE state='committed'")
      .get();
    await writer.publishCorePublication({ tenantId: 'tenant-a', publicationId: String(pub?.id) });
    expect(await f.rows('core.provisioning_assignment_events')).toHaveLength(1);
  });
  it('records dry runs without granting and commits source-owned revocation with its audit', async () => {
    const f = await fixture(mode);
    await f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, {
      ...input,
      dryRun: true,
    });
    expect(f.db.prepare('SELECT count(*) n FROM group_memberships').get()?.n).toBe(0);
    await f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, input);
    const membership = f.db.prepare('SELECT id FROM group_memberships').get();
    f.db.exec("UPDATE provisioning_assignment_ownership SET revoke_policy='auto'");
    const signal = {
      sourceType: 'scim',
      sourceId: 'source',
      sourceEventId: 'remote-event',
      signalType: 'scim_group_removed' as const,
      targetType: 'group_membership' as const,
      targetId: String(membership?.id),
      subjectId: 'subject',
    };
    await expect(f.repo.recordExternalLifecycleSignal('tenant-a', signal)).resolves.toMatchObject({
      decision: 'revoke',
    });
    expect(
      f.db.prepare('SELECT lifecycle_state FROM group_memberships').get()?.lifecycle_state
    ).toBe('revoked');
    expect(
      f.db.prepare('SELECT processing_state FROM external_lifecycle_signal_events').get()
        ?.processing_state
    ).toBe('processed');
    expect(f.db.prepare('SELECT count(*) n FROM provisioning_revocation_events').get()?.n).toBe(0);
    expect(await f.rows('core.provisioning_revocation_events')).toEqual([
      expect.objectContaining({ decision: 'revoke', target_id: membership?.id }),
    ]);
    await expect(f.repo.recordExternalLifecycleSignal('tenant-a', signal)).resolves.toMatchObject({
      idempotent: true,
    });
    expect(await f.rows('core.provisioning_revocation_events')).toHaveLength(1);
  });
  it('refuses an ownership change made while the log body is prepared', async () => {
    const f = await fixture(mode);
    await f.repo.evaluateProvisioningAssignmentRule('tenant-a', f.rule.id, input);
    const membership = f.db.prepare('SELECT id FROM group_memberships').get();
    f.db.exec("UPDATE provisioning_assignment_ownership SET revoke_policy='auto'");
    const writer = f.env.LOG_ARCHIVE_WRITER!,
      original = writer.prepareCorePublication.bind(writer);
    vi.spyOn(writer, 'prepareCorePublication').mockImplementationOnce(async (request) => {
      await original(request);
      f.db.exec(
        "UPDATE provisioning_assignment_ownership SET ownership_policy='manual',updated_at=updated_at+1"
      );
    });
    await expect(
      f.repo.recordExternalLifecycleSignal('tenant-a', {
        sourceType: 'scim',
        sourceId: 'source',
        sourceEventId: 'remote-event',
        signalType: 'scim_group_removed',
        targetType: 'group_membership',
        targetId: String(membership?.id),
      })
    ).rejects.toThrow('business state changed');
    expect(
      f.db.prepare('SELECT lifecycle_state FROM group_memberships').get()?.lifecycle_state
    ).toBe('active');
    expect(f.db.prepare('SELECT count(*) n FROM external_lifecycle_signal_events').get()?.n).toBe(
      0
    );
    expect(await f.rows('core.provisioning_revocation_events')).toHaveLength(0);
  });
  it('commits Admin key mutations and encrypted audit in the same actual SQL batch', async () => {
    const f = await fixture(mode);
    const created = await f.repo.createKeyRegistry('tenant-a', {
      keyPurpose: 'test',
      scope: { tenant: true },
      algorithm: 'A256GCM',
      backendType: 'external_kms',
      materialRef: 'kms://test/key',
    });
    expect(f.adminDb.prepare('SELECT count(*) n FROM key_registries').get()?.n).toBe(1);
    expect(f.adminDb.prepare('SELECT count(*) n FROM key_access_events').get()?.n).toBe(0);
    expect(await f.rows('admin.key_access_events')).toEqual([
      expect.objectContaining({ key_registry_id: created.id, access_type: 'registry.create' }),
    ]);
    const batch = f.adminAdapter.batch.bind(f.adminAdapter);
    vi.spyOn(f.adminAdapter, 'batch').mockImplementationOnce(async (statements) =>
      batch([...statements, { sql: 'INSERT INTO missing_table VALUES(1)', params: [] }])
    );
    await expect(
      f.repo.createKeyRegistry('tenant-a', {
        keyPurpose: 'other',
        scope: { tenant: true },
        algorithm: 'A256GCM',
        backendType: 'external_kms',
        materialRef: 'kms://test/key2',
      })
    ).rejects.toThrow('missing_table');
    expect(f.adminDb.prepare('SELECT count(*) n FROM key_registries').get()?.n).toBe(1);
    expect(await f.rows('admin.key_access_events')).toHaveLength(1);
  });
});
