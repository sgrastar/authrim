import { describe, expect, it } from 'vitest';
import { DocumentAcknowledgmentRepository } from '../identity';
import { MockDatabaseAdapter } from './mock-adapter';

function createRepository() {
  const adapter = new MockDatabaseAdapter();
  adapter.initTable('document_acknowledgments_current', 'latest_evidence_record_id');
  return { adapter, repository: new DocumentAcknowledgmentRepository(adapter) };
}

const acknowledgment = {
  tenant_id: 'tenant-a',
  subject_user_id: 'user-a',
  consent_kind: 'terms',
  statement_id: 'tos-a',
  statement_version: '1',
  accepted_at: 1_000,
  evidence_record_id: 'evidence-a',
};

describe('DocumentAcknowledgmentRepository', () => {
  it('reuses a statement/version acknowledgment across Client evidence contexts', async () => {
    const { repository } = createRepository();
    await repository.accept(acknowledgment);
    await expect(repository.findActive({ ...acknowledgment, now: 1_001 })).resolves.toMatchObject({
      status: 'accepted',
      latest_evidence_record_id: 'evidence-a',
    });
  });

  it('does not cross tenant, subject, statement, or version boundaries', async () => {
    const { repository } = createRepository();
    await repository.accept(acknowledgment);
    for (const overrides of [
      { tenant_id: 'tenant-b' },
      { subject_user_id: 'user-b' },
      { statement_id: 'privacy-a' },
      { statement_version: '2' },
    ]) {
      await expect(
        repository.findActive({ ...acknowledgment, ...overrides, now: 1_001 })
      ).resolves.toBeNull();
    }
  });

  it('treats expired and withdrawn acknowledgments as inactive', async () => {
    const { repository } = createRepository();
    await repository.accept({ ...acknowledgment, expires_at: 1_100 });
    await expect(repository.findActive({ ...acknowledgment, now: 1_100 })).resolves.toBeNull();
    await repository.accept({ ...acknowledgment, expires_at: null });
    await expect(
      repository.withdraw({
        ...acknowledgment,
        evidence_record_id: 'withdrawal-a',
        withdrawn_at: 1_200,
      })
    ).resolves.toBe(true);
    await expect(repository.findActive({ ...acknowledgment, now: 1_201 })).resolves.toBeNull();
  });

  it('uses epoch seconds when the active lookup time is omitted', async () => {
    const { repository } = createRepository();
    const now = Math.floor(Date.now() / 1000);
    await repository.accept({ ...acknowledgment, expires_at: now + 60 });
    await expect(repository.findActive(acknowledgment)).resolves.toMatchObject({
      status: 'accepted',
    });
  });

  it('updates the current projection without creating another current row', async () => {
    const { adapter, repository } = createRepository();
    await repository.accept(acknowledgment);
    await repository.accept({
      ...acknowledgment,
      evidence_record_id: 'evidence-b',
      accepted_at: 2_000,
    });
    expect(adapter.getAll('document_acknowledgments_current')).toHaveLength(1);
    await expect(repository.findActive({ ...acknowledgment, now: 2_001 })).resolves.toMatchObject({
      latest_evidence_record_id: 'evidence-b',
      accepted_at: 2_000,
    });
  });
});
