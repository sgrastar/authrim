import { describe, expect, it } from 'vitest';
import type { DynamoAuthStateRestoreReceipt } from '../import/auth-state-restore';
import type { DynamoAuthStateConfig } from '../storage/auth-state-config';
import {
  selectedSyntheticDynamoState,
  type SyntheticAuthStateSelection,
} from './selected-auth-state';

const config: DynamoAuthStateConfig = {
  backend: 'dynamodb',
  region: 'ap-northeast-1',
  tableArn: 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/synthetic-state',
  namespace: '11111111-1111-4111-8111-111111111111',
};
const receipt: DynamoAuthStateRestoreReceipt = {
  formatVersion: 1,
  authState: config,
  tenantId: 'tenant-a',
  source: {
    tenantId: 'tenant-a',
    issuer: 'https://synthetic.example.test',
    productVersion: '0.4.2',
  },
  bundleId: 'synthetic-bundle',
  snapshotId: 'synthetic-snapshot',
  inventoryDigestSha256: 'a'.repeat(64),
  supplementSha256: 'b'.repeat(64),
  accountAuthStates: 1,
  passkeyCounters: 1,
  persistentNameIds: 1,
};

describe('pure synthetic auth-state selection', () => {
  it('keeps the legacy and explicit PostgreSQL selection', () => {
    expect(selectedSyntheticDynamoState(undefined)).toBeUndefined();
    expect(selectedSyntheticDynamoState({ config: { backend: 'postgresql' } })).toBeUndefined();
  });
  it('returns the exact Dynamo target and receipt for later sealed-state validation', () => {
    expect(selectedSyntheticDynamoState({ config, receipt })).toEqual({ target: config, receipt });
  });
  it.each([
    { config: { backend: 'postgresql' }, receipt },
    { config },
    { config, receipt: { ...receipt, tenantId: 'tenant-b' } },
    { config, receipt: { ...receipt, source: { ...receipt.source, tenantId: 'tenant-b' } } },
    {
      config,
      receipt: {
        ...receipt,
        authState: { ...config, namespace: '22222222-2222-4222-8222-222222222222' },
      },
    },
    { config: { ...config, region: 'us-east-1' }, receipt },
  ])('rejects a mixed, missing, cross-tenant or mismatched selection', (value) => {
    expect(() => selectedSyntheticDynamoState(value as SyntheticAuthStateSelection)).toThrow();
  });
});
