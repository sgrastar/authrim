import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import { decodeTenantBackupInputStep } from './input-decode-step';
import { TenantBackupInputReceipts } from './input-receipts';

type DecodeInput = Omit<
  Parameters<typeof decodeTenantBackupInputStep>[0],
  'checkpoint' | 'signal' | 'assertAuthorized'
>;
function fail(): never {
  throw new Error('backup_decode_input_step_invalid');
}

/**
 * One encrypted input frame per operation slice. Receipts are the authoritative progress so a
 * committed frame is not lost when the outer operation checkpoint response is lost. Preparation
 * must pin the uploaded object, manifest and expected source to this operation before dispatch.
 * Completion advances to module validation, never to restore writes or activation.
 */
export async function runTenantBackupInputDecodeStep(
  context: TenantBackupStepContext,
  input: DecodeInput & {
    database: Pick<DatabaseAdapter, 'queryOne'>;
    now: () => number;
    assertPinnedInput: () => Promise<void>;
  }
): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = context;
  if (
    operation.kind !== 'import' ||
    operation.state !== 'running' ||
    operation.phase !== 'decode_input' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    input.expected.source.tenantId !== lease.tenantId
  )
    fail();
  let cursor: unknown;
  try {
    cursor = JSON.parse(operation.cursor_json ?? 'null');
  } catch {
    fail();
  }
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    Object.keys(cursor).sort().join(',') !== 'bundleId,version' ||
    !('version' in cursor) ||
    cursor.version !== 1 ||
    !('bundleId' in cursor) ||
    cursor.bundleId !== input.expected.bundleId
  )
    fail();
  const receipts = new TenantBackupInputReceipts(input.database, lease, input.now);
  const authorize = async () => {
    signal.throwIfAborted();
    await input.assertPinnedInput();
    await receipts.latest(input.expected.bundleId);
    signal.throwIfAborted();
  };
  await authorize();
  const latest = await receipts.latest(input.expected.bundleId);
  const replayInput = { ...input, signal, assertAuthorized: authorize };
  let complete: boolean;
  if (latest?.checkpoint.complete) {
    const event = await receipts.replay(input.expected.bundleId, latest.sequence, replayInput);
    if (event.kind !== 'complete') fail();
    complete = true;
  } else {
    const result = await decodeTenantBackupInputStep({
      ...replayInput,
      checkpoint: latest?.checkpoint ?? null,
    });
    await receipts.append(
      input.expected.bundleId,
      latest ? latest.sequence + 1 : 0,
      latest?.checkpoint ?? null,
      result
    );
    complete = result.checkpoint.complete;
  }
  await authorize();
  return {
    phase: complete ? 'validate_input_modules' : 'decode_input',
    cursor: JSON.stringify({ version: 1, bundleId: input.expected.bundleId }),
    disposition: 'continue',
  };
}
