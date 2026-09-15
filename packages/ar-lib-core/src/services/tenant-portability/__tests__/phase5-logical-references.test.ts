import { expect, it, vi } from 'vitest';
import { verifyPhase5LogicalReferences } from '../phase5-logical-references';

function database(rows: unknown[][]) {
  const query = vi.fn();
  for (const result of rows) query.mockResolvedValueOnce(result);
  return { query };
}

const flow = { id: 'flow-issue', status: 'published', published_version_id: 'fv-issue' };
const version = { id: 'fv-issue', flow_id: 'flow-issue' };
const credential = {
  lifecycle_state: 'published',
  issuance_flow_id: 'flow-issue',
  issuance_flow_version_id: 'fv-issue',
  verification_flow_id: null,
  verification_flow_version_id: null,
};

it('accepts restored published Flow and credential version links', async () => {
  const core = database([[flow], [version]]);
  const admin = database([[credential]]);
  await expect(
    verifyPhase5LogicalReferences({ tenantId: 'tenant-a', core, admin })
  ).resolves.toBeUndefined();
});

it.each([
  [
    'published Flow without version',
    [{ ...flow, published_version_id: null }],
    [version],
    credential,
  ],
  ['Flow version owned by another Flow', [flow], [{ ...version, flow_id: 'other' }], credential],
  [
    'published credential without pinned issuance version',
    [flow],
    [version],
    { ...credential, issuance_flow_version_id: null },
  ],
  [
    'credential version pinned to another Flow',
    [flow],
    [version, { id: 'fv-other', flow_id: 'other' }],
    { ...credential, issuance_flow_version_id: 'fv-other' },
  ],
  [
    'verification version without verification Flow',
    [flow],
    [version],
    { ...credential, verification_flow_version_id: 'fv-issue' },
  ],
])('rejects %s', async (_label, flows, versions, reference) => {
  await expect(
    verifyPhase5LogicalReferences({
      tenantId: 'tenant-a',
      core: database([flows, versions]),
      admin: database([[reference]]),
    })
  ).rejects.toThrow('backup_phase5_logical_reference_missing');
});

it('bounds every restored reference scan', async () => {
  const overflow = Array.from({ length: 10_001 }, (_, index) => ({
    id: `flow-${index}`,
    status: 'draft',
    published_version_id: null,
  }));
  await expect(
    verifyPhase5LogicalReferences({
      tenantId: 'tenant-a',
      core: database([overflow, []]),
      admin: database([[]]),
    })
  ).rejects.toThrow('backup_phase5_logical_reference_limit');
});
