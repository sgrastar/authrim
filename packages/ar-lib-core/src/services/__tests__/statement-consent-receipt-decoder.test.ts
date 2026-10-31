import { describe, expect, it } from 'vitest';
import type { StatementConsentAtomicCapability } from '../../db/statement-consent-atomic';
import {
  applyStatementConsentTransition,
  prepareStatementConsentTransition,
} from '../statement-consent-transitions';
import { transitionInput } from './statement-consent-transition-fixture';

async function receiptHarness(input = transitionInput()) {
  let stored: unknown = null;
  let writes = 0;
  const capability: StatementConsentAtomicCapability = {
    dialect: 'postgres',
    async readOperation() {
      return stored;
    },
    async executeStatementConsentBatch() {
      writes++;
      throw new Error('unexpected-receipt-reapply');
    },
  };
  const plan = await prepareStatementConsentTransition(capability, input, 'decoder-test-attempt');
  const row: Record<string, unknown> = {
    tenant_id: input.owner.tenantId,
    operation_id: input.operationId,
    payload_sha256: plan.payloadHash,
    status: 'applied',
    is_terminal: 1,
    is_noop: input.noop ? 1 : 0,
    expected_revision: String(input.expected.revision),
    expected_withdrawal_generation: String(input.expected.withdrawalGeneration),
    action: input.action,
    physical_id: input.owner.physicalId,
    restore_epoch: input.owner.restoreEpoch,
  };
  stored = row;
  return {
    input,
    capability,
    row,
    setStored(value: unknown) {
      stored = value;
    },
    writes: () => writes,
  };
}

describe('narrow receipt decoder: unknown DB values, no global pg parser change', () => {
  it.each(['decimal-string', 'number'] as const)(
    'normalizes %s revisions before arithmetic and never reapplies a receipt',
    async (encoding) => {
      const input = transitionInput();
      input.expected.revision = 1;
      input.expected.withdrawalGeneration = 2;
      const f = await receiptHarness(input);
      if (encoding === 'number') {
        f.row.expected_revision = 1;
        f.row.expected_withdrawal_generation = 2;
      }
      const result = await applyStatementConsentTransition(f.capability, input);
      expect(result).toEqual({ outcome: 'applied', revision: 2, withdrawalGeneration: 2 });
      if (result.outcome === 'rejected') throw new Error('fixture-outcome');
      expect(typeof result.revision).toBe('number');
      expect(typeof result.withdrawalGeneration).toBe('number');
      expect(f.writes()).toBe(0);
    }
  );

  const malformed = [
    { label: 'junk suffix', value: '1x' },
    { label: 'negative string', value: '-1' },
    { label: 'negative number', value: -1 },
    { label: 'unsafe string', value: '9007199254740992' },
    { label: 'unsafe number', value: Number.MAX_SAFE_INTEGER + 1 },
    { label: 'NaN', value: Number.NaN },
    { label: 'fraction string', value: '1.5' },
    { label: 'fraction number', value: 1.5 },
    { label: 'infinity', value: Number.POSITIVE_INFINITY },
    { label: 'missing', value: undefined },
    { label: 'null', value: null },
    { label: 'leading whitespace', value: ' 1' },
    { label: 'leading zero', value: '01' },
    { label: 'exponent', value: '1e1' },
  ];
  for (const field of ['expected_revision', 'expected_withdrawal_generation'] as const) {
    it.each(malformed)(
      `rejects ${field}: $label without treating it as an absent receipt`,
      async ({ value }) => {
        const f = await receiptHarness();
        f.row[field] = value;
        await expect(applyStatementConsentTransition(f.capability, f.input)).rejects.toThrow(
          'statement_consent_receipt_invalid'
        );
        expect(f.writes()).toBe(0);
      }
    );
  }

  it.each(['revision', 'withdrawal'] as const)(
    'rejects safe-integer %s addition overflow',
    async (field) => {
      const f = await receiptHarness();
      if (field === 'revision') f.row.expected_revision = String(Number.MAX_SAFE_INTEGER);
      else {
        f.row.expected_withdrawal_generation = String(Number.MAX_SAFE_INTEGER);
        f.row.action = 'withdraw';
      }
      await expect(applyStatementConsentTransition(f.capability, f.input)).rejects.toThrow(
        'statement_consent_receipt_invalid'
      );
      expect(f.writes()).toBe(0);
    }
  );
  it('accepts the last safe result without returning a string or overflowing', async () => {
    const input = transitionInput();
    input.expected.revision = Number.MAX_SAFE_INTEGER - 1;
    input.expected.withdrawalGeneration = Number.MAX_SAFE_INTEGER - 1;
    const f = await receiptHarness(input);
    const result = await applyStatementConsentTransition(f.capability, input);
    expect(result).toEqual({
      outcome: 'applied',
      revision: Number.MAX_SAFE_INTEGER,
      withdrawalGeneration: Number.MAX_SAFE_INTEGER - 1,
    });
    if (result.outcome === 'rejected') throw new Error('fixture-outcome');
    expect(typeof result.revision).toBe('number');
    expect(typeof result.withdrawalGeneration).toBe('number');
    expect(f.writes()).toBe(0);
  });
  it.each([
    { label: 'undefined', value: undefined },
    { label: 'false', value: false },
    { label: 'zero', value: 0 },
    { label: 'empty string', value: '' },
    { label: 'array', value: [] },
    { label: 'string', value: 'not-a-row' },
  ])('rejects malformed result $label instead of starting a new write', async ({ value }) => {
    const f = await receiptHarness();
    f.setStored(value);
    await expect(applyStatementConsentTransition(f.capability, f.input)).rejects.toThrow(
      'statement_consent_receipt_invalid'
    );
    expect(f.writes()).toBe(0);
  });
});
