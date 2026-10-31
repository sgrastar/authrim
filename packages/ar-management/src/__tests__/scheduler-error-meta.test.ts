import { describe, expect, it } from 'vitest';
import { schedulerErrorMeta } from '../scheduler-error-meta';

describe('schedulerErrorMeta', () => {
  it('names the failed step when the message is a fixed error code', () => {
    expect(schedulerErrorMeta(new Error('environment_tenant_directory_unavailable'))).toEqual({
      errorType: 'Error',
      errorCode: 'environment_tenant_directory_unavailable',
    });
  });

  it.each([
    'Failed for tenant acme: user@example.com',
    'D1_ERROR: no such table: statement_consent_projection_jobs',
    'x',
    'a'.repeat(200),
    '',
  ])('does not carry free text from the message: %s', (message) => {
    expect(schedulerErrorMeta(new Error(message))).toEqual({ errorType: 'Error' });
  });

  it('keeps only the type for values that are not errors', () => {
    expect(schedulerErrorMeta('boom')).toEqual({ errorType: 'Unknown' });
    expect(schedulerErrorMeta(undefined)).toEqual({ errorType: 'Unknown' });
  });
});
