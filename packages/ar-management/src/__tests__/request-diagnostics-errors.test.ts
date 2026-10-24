import { describe, expect, it } from 'vitest';
import { app } from '../index';

const securityRegressionIt =
  process.env.AUTHRIM_SECURITY_REGRESSION_SUITE === 'true' ? it : it.skip;

/**
 * Operator diagnostics on; the first read of any other binding throws `thrown`, so the first
 * middleware after the diagnostic one that reads the env fails. Later reads (the error handler's)
 * see the binding unset.
 */
function envFailingAfterDiagnostics(thrown: unknown): never {
  const values: Record<string, unknown> = {
    AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: '1',
    AUTHRIM_ENVIRONMENT_management: undefined,
  };
  let failed = false;
  return new Proxy(values, {
    get(target, key) {
      if (typeof key !== 'string' || key in target || failed) return target[key as string];
      failed = true;
      throw thrown;
    },
  }) as never;
}

function diagnosticRequest(thrown: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(
      'https://op.example.com/api/auth/authentication-methods',
      { method: 'POST', headers: { 'X-Diagnostic-Session-Id': 'operator-session' } },
      envFailingAfterDiagnostics(thrown)
    )
  );
}

describe('management request diagnostics on a failing request', () => {
  securityRegressionIt(
    'keeps the error handler response when a later middleware fails',
    async () => {
      const response = await diagnosticRequest(new Error('binding unavailable'));

      expect(response.status).toBe(500);
      expect(response.headers.get('X-Authrim-Diagnostic-Session-Id')).toBe('operator-session');
    }
  );

  securityRegressionIt('rethrows a failure the error handler does not take', async () => {
    // Hono hands only Error instances to onError; anything else reaches the diagnostic middleware's
    // finally as a rejection of next(), which must not be turned into a response there.
    await expect(diagnosticRequest('downstream-failure')).rejects.toBe('downstream-failure');
  });
});
