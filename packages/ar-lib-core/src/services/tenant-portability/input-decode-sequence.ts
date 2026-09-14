import type { TenantBundleKeyEnvelope } from './bundle-key-envelope';
import type { TenantBundleManifestExpectation } from './bundle-manifest';
import type { TenantBackupExecutionInventory } from './execution-inventory';
import { runPlannedTenantBackupInputDecodeStep } from './input-plan';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import { DatabaseTenantBundleReferenceIndex } from './validation-index';

type DecodeInput = Pick<
  Parameters<typeof runPlannedTenantBackupInputDecodeStep>[1],
  'bucket' | 'now'
> & {
  database: Parameters<typeof DatabaseTenantBundleReferenceIndex.createOrResume>[0];
};

function fail(): never {
  throw new Error('backup_input_decode_sequence_invalid');
}

async function validationSessionId(operationId: string, inventoryDigest: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(
        JSON.stringify(['authrim-input-validation-v1', operationId, inventoryDigest])
      )
    )
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Decode one authenticated frame from one pinned input per slice. Input ordering comes from the
 * atomic import request, while the encrypted manifest and R2 identity come from the sealed
 * inventory. After the last input, a deterministic validation session is created or resumed.
 */
export async function runTenantBackupInputDecodeSequenceStep(
  context: TenantBackupStepContext,
  input: DecodeInput & {
    inventory: TenantBackupExecutionInventory;
    inputCount: number;
    loadInput(
      ordinal: number,
      bundleId: string
    ): Promise<{ expected: TenantBundleManifestExpectation; session: TenantBundleKeyEnvelope }>;
  }
): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = context;
  if (
    operation.kind !== 'import' ||
    operation.state !== 'running' ||
    operation.phase !== 'decode_input' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    !Number.isSafeInteger(input.inputCount) ||
    input.inputCount < 1 ||
    input.inputCount > 32
  )
    fail();
  let cursor: { version: 1; inputOrdinal: number };
  try {
    cursor = JSON.parse(operation.cursor_json ?? 'null') as typeof cursor;
  } catch {
    return fail();
  }
  if (
    !cursor ||
    Object.keys(cursor).sort().join(',') !== 'inputOrdinal,version' ||
    cursor.version !== 1 ||
    !Number.isSafeInteger(cursor.inputOrdinal) ||
    cursor.inputOrdinal < 0 ||
    cursor.inputOrdinal >= input.inputCount
  )
    fail();
  signal.throwIfAborted();
  const head = await input.inventory.headForLease(lease);
  if (head.state !== 'sealed' || head.item_count !== input.inputCount) fail();
  const row = (await input.inventory.readPage(cursor.inputOrdinal))[0];
  const prefix = 'backup-input:';
  const bundleId = row?.item_id.startsWith(prefix) ? row.item_id.slice(prefix.length) : '';
  if (!row || row.ordinal !== cursor.inputOrdinal || !/^[a-f0-9]{32}$/.test(bundleId)) fail();
  const loaded = await input.loadInput(cursor.inputOrdinal, bundleId);
  if (loaded.expected.bundleId !== bundleId) fail();
  const result = await runPlannedTenantBackupInputDecodeStep(
    {
      ...context,
      operation: {
        ...operation,
        cursor_json: JSON.stringify({ version: 1, bundleId }),
      },
    },
    {
      inventory: input.inventory,
      ordinal: cursor.inputOrdinal,
      expected: loaded.expected,
      session: loaded.session,
      database: input.database,
      bucket: input.bucket,
      now: input.now,
    }
  );
  if (result.phase === 'decode_input')
    return { phase: 'decode_input', cursor: JSON.stringify(cursor), disposition: 'continue' };
  if (result.phase !== 'validate_input_modules') fail();
  const inputOrdinal = cursor.inputOrdinal + 1;
  if (inputOrdinal < input.inputCount)
    return {
      phase: 'decode_input',
      cursor: JSON.stringify({ version: 1, inputOrdinal }),
      disposition: 'continue',
    };
  const current = await input.inventory.headForLease(lease);
  if (
    current.state !== 'sealed' ||
    current.item_count !== input.inputCount ||
    current.chain_digest !== head.chain_digest
  )
    fail();
  const sessionId = await validationSessionId(operation.id, head.chain_digest);
  await DatabaseTenantBundleReferenceIndex.createOrResume(
    input.database,
    sessionId,
    lease,
    input.now
  );
  await input.inventory.headForLease(lease);
  return {
    phase: 'validate_input_modules',
    cursor: JSON.stringify({ version: 1, sessionId, inputOrdinal: 0, datasetIndex: 0 }),
    disposition: 'continue',
  };
}
