import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBackupStepContext, TenantBackupStepResult } from './operation-executor';
import { DatabaseTenantBundleReferenceIndex } from './validation-index';
import { validateTenantBackupReferencePage } from './validate-reference-page';

interface ReferenceCursor {
  version: 1;
  sessionId: string;
  inputSetDigest: string;
  after: string;
  examined: number;
  unresolvedProvenance: number;
}
function fail(): never {
  throw new Error('backup_reference_step_invalid');
}

/** Advance one reference page; all counters and the source cursor are checkpointed together. */
export async function runTenantBackupReferenceValidationStep(
  context: TenantBackupStepContext,
  input: {
    database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
    now: () => number;
    sessionId: string;
    inputSetDigest: string;
    assertCompleteInputInspection: (inputSetDigest: string, sessionId: string) => Promise<void>;
  }
): Promise<TenantBackupStepResult> {
  const { operation, lease, signal } = context;
  if (
    operation.kind !== 'import' ||
    operation.state !== 'running' ||
    operation.phase !== 'validate_input_references' ||
    operation.id !== lease.operationId ||
    operation.tenant_id !== lease.tenantId ||
    !/^[a-f0-9]{64}$/.test(input.inputSetDigest)
  )
    fail();
  let cursor: ReferenceCursor;
  try {
    cursor = JSON.parse(operation.cursor_json ?? 'null') as ReferenceCursor;
  } catch {
    return fail();
  }
  if (
    !cursor ||
    Object.keys(cursor).sort().join(',') !==
      'after,examined,inputSetDigest,sessionId,unresolvedProvenance,version' ||
    cursor.version !== 1 ||
    cursor.sessionId !== input.sessionId ||
    cursor.inputSetDigest !== input.inputSetDigest ||
    typeof cursor.after !== 'string' ||
    cursor.after.length > 4096 ||
    !Number.isSafeInteger(cursor.examined) ||
    cursor.examined < 0 ||
    !Number.isSafeInteger(cursor.unresolvedProvenance) ||
    cursor.unresolvedProvenance < 0 ||
    cursor.unresolvedProvenance > cursor.examined ||
    (cursor.examined === 0) !== (cursor.after === '')
  )
    fail();
  const guard = async () => {
    signal.throwIfAborted();
    await input.assertCompleteInputInspection(input.inputSetDigest, input.sessionId);
    signal.throwIfAborted();
  };
  await guard();
  const index = await DatabaseTenantBundleReferenceIndex.resume(
    input.database,
    input.sessionId,
    lease,
    input.now
  );
  const page = await validateTenantBackupReferencePage({
    index,
    after: cursor.after,
    assertCompleteInputInspection: guard,
  });
  const examined = cursor.examined + page.examined;
  const unresolvedProvenance = cursor.unresolvedProvenance + page.unresolvedProvenance;
  if (
    !Number.isSafeInteger(examined) ||
    !Number.isSafeInteger(unresolvedProvenance) ||
    (!page.done && page.nextCursor === cursor.after)
  )
    fail();
  return {
    phase: page.done ? 'finalize_input_validation' : 'validate_input_references',
    cursor: JSON.stringify({ ...cursor, after: page.nextCursor, examined, unresolvedProvenance }),
    disposition: 'continue',
  };
}
