import { describe, expect, it } from 'vitest';
import { redactSecretPathsInLogLine } from '@authrim/ar-lib-core';

// The policy worker logs requests through the shared printer (redactingAccessLogPrinter), which
// writes each line as redactSecretPathsInLogLine leaves it.
describe('policy request log', () => {
  it('redacts token and access_token query values, percent-encoded names included', () => {
    for (const name of ['token', '%74oken', 'access_token', 'access%5Ftoken']) {
      const line = redactSecretPathsInLogLine(
        `<-- GET /api/check/subscribe?tenant_id=a&${name}=chk_secret&x=1`
      );
      expect(line).not.toContain('chk_secret');
      expect(line).toContain('tenant_id=a');
    }
    expect(redactSecretPathsInLogLine('<-- GET /api/check/health')).toBe(
      '<-- GET /api/check/health'
    );
  });
});
