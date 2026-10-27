/** Failure-only diagnostics for the isolated synthetic SP; never import in serving entries. */
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';

function classification(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const value = error as { code?: unknown; name?: unknown };
  const codes: Record<string, string> = {
    ECONNRESET: 'connection_reset',
    ETIMEDOUT: 'transport_timeout',
    EPIPE: 'broken_pipe',
    ECONNREFUSED: 'connection_refused',
  };
  const names: Record<string, string> = {
    AccessDeniedException: 'access_denied',
    ResourceNotFoundException: 'resource_missing',
    ConditionalCheckFailedException: 'condition_rejected',
    ValidationException: 'request_rejected',
    ThrottlingException: 'throttled',
    ProvisionedThroughputExceededException: 'throttled',
    InternalServerError: 'service_unavailable',
    ServiceUnavailable: 'service_unavailable',
    TimeoutError: 'transport_timeout',
    AbortError: 'aborted',
  };
  return (
    (typeof value.code === 'string' && Object.hasOwn(codes, value.code)
      ? codes[value.code]
      : undefined) ??
    (typeof value.name === 'string' && Object.hasOwn(names, value.name)
      ? names[value.name]
      : undefined) ??
    'unknown'
  );
}

/** Installs before first use; the returned callback marks successful cold readiness once. */
export function installSyntheticSpStateDiagnostics(
  client: DynamoDBClient,
  write: (line: string) => unknown = (line) => process.stderr.write(line)
): () => void {
  let warm = false;
  client.middlewareStack.add(
    (next, context) => async (args) => {
      try {
        return await next(args);
      } catch (error) {
        const stage =
          context.commandName === 'GetItemCommand'
            ? 'warm_seal_read'
            : context.commandName === 'PutItemCommand'
              ? 'challenge_put'
              : undefined;
        if (warm && stage) {
          try {
            write(
              JSON.stringify({
                timestamp: new Date().toISOString(),
                level: 'WARN',
                event: 'authrim.synthetic_sp_state_failure',
                stage,
                errorClass: classification(error),
              }) + '\n'
            );
          } catch {
            // Diagnostic failure must preserve the original authentication failure.
          }
        }
        throw error;
      }
    },
    { step: 'initialize', priority: 'high', name: 'syntheticSpStateFailureDiagnostic' }
  );
  return () => {
    warm = true;
  };
}
