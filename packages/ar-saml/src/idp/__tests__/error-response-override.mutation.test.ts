import { describe, expect, it } from 'vitest';
import { STATUS_CODES } from '../../common/constants';
import { applySAMLErrorResponseOverride } from '../error-response';

const base = {
  failureKind: 'required_attribute_missing',
  statusCode: STATUS_CODES.RESPONDER,
  secondLevelStatusCode: STATUS_CODES.INVALID_ATTR_NAME_OR_VALUE,
  statusMessage: 'default',
};

describe('applySAMLErrorResponseOverride with a Success status', () => {
  it('keeps the default status code instead of an override to Success', () => {
    const result = applySAMLErrorResponseOverride(
      {
        errorResponseOverrides: [
          {
            failureKind: 'required_attribute_missing',
            statusCode: STATUS_CODES.SUCCESS,
            statusMessage: 'custom',
          },
        ],
      },
      base
    );

    expect(result.statusCode).toBe(STATUS_CODES.RESPONDER);
    expect(result.statusMessage).toBe('custom');
  });

  it('still applies a non-Success override', () => {
    const result = applySAMLErrorResponseOverride(
      {
        errorResponseOverrides: [
          { failureKind: 'required_attribute_missing', statusCode: STATUS_CODES.REQUESTER },
        ],
      },
      base
    );

    expect(result.statusCode).toBe(STATUS_CODES.REQUESTER);
  });
});
