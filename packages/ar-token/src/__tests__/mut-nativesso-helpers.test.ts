/**
 * native-sso-token-exchange.ts helpers: the error response (headers, audit outcome, details),
 * the audience and platform normalisation, and which clients take part in Native SSO.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ClientMetadata, Logger } from '@authrim/ar-lib-core';
import { createMockContext, parseJsonResponse } from './helpers/mocks';
import { contextHeader } from './helpers/mut-nativesso-fixtures';
import {
  isNativeSSOClientEnabled,
  isNativeSSOIssuanceEligible,
  isNativeSSONativeChannelAllowed,
  nativeSSOError,
  nativeSSOInvalidGrant,
  normalizeNativeSSOAudience,
  normalizeNativeSSOPlatform,
} from '../native-sso-token-exchange';

function auditLogger() {
  const warn = vi.fn();
  return { warn, logger: { warn } as unknown as Logger };
}

const client = (metadata: Record<string, unknown>) => metadata as unknown as ClientMetadata;

describe('nativeSSOError', () => {
  it('answers uncached, with the details for the code and the options given', async () => {
    const ctx = createMockContext();

    const response = nativeSSOError(
      ctx,
      'slow_down',
      'Wait',
      'native_sso_rate_limited',
      429,
      'retry',
      {
        retryable: false,
        severity: 'error',
        retryAfterSeconds: 30,
      }
    );

    expect(response.status).toBe(429);
    expect(await parseJsonResponse(response)).toEqual({
      error: 'slow_down',
      error_description: 'Wait',
      error_details: {
        code: 'native_sso_rate_limited',
        retryable: false,
        severity: 'error',
        transient: true,
        user_action: 'retry',
      },
    });
    expect(contextHeader(ctx, 'Cache-Control')).toBe('no-store');
    expect(contextHeader(ctx, 'Pragma')).toBe('no-cache');
    expect(contextHeader(ctx, 'Retry-After')).toBe('30');
  });

  it('defaults to 400 and reauthenticate, with no Retry-After', async () => {
    const ctx = createMockContext();

    const response = nativeSSOError(ctx, 'invalid_request', 'Bad', 'dpop_proof_missing');

    expect(response.status).toBe(400);
    expect(await parseJsonResponse(response)).toMatchObject({
      error_details: { user_action: 'reauthenticate', severity: 'error' },
    });
    expect(contextHeader(ctx, 'Retry-After')).toBeUndefined();
    expect(ctx.header).not.toHaveBeenCalledWith('Retry-After', expect.anything());
  });

  it.each([
    ['invalid_grant', 'invalid_grant'],
    ['invalid_request', 'invalid_request'],
    ['access_denied', 'denied'],
  ])('audits a %s failure with the %s outcome', (error, outcome) => {
    const { warn, logger } = auditLogger();

    nativeSSOError(
      createMockContext(),
      error,
      'Failed',
      'id_token_malformed',
      400,
      'reauthenticate',
      {
        audit: { logger, clientId: 'app' },
      }
    );

    expect(warn).toHaveBeenCalledWith('NativeSSO Token Exchange Failure', {
      action: 'NativeSSO',
      outcome,
      clientId: 'app',
      subjectTokenType: undefined,
      actorTokenType: undefined,
      error,
      errorDetailsCode: 'id_token_malformed',
      status: 400,
      requestedAudiences: [],
      requestedResources: [],
    });
  });

  it('answers invalid_grant for nativeSSOInvalidGrant', async () => {
    const { warn, logger } = auditLogger();

    const response = nativeSSOInvalidGrant(createMockContext(), 'Gone', 'device_secret_inactive', {
      audit: { logger },
    });

    expect(response.status).toBe(400);
    expect(await parseJsonResponse(response)).toMatchObject({
      error: 'invalid_grant',
      error_details: { code: 'device_secret_inactive', user_action: 'reauthenticate' },
    });
    expect(warn).toHaveBeenCalledWith(
      'NativeSSO Token Exchange Failure',
      expect.objectContaining({ outcome: 'invalid_grant' })
    );
  });
});

describe('normalizeNativeSSOAudience', () => {
  it('refuses array items that are not strings, even with a length', () => {
    expect(normalizeNativeSSOAudience([['app']])).toBeNull();
    expect(normalizeNativeSSOAudience([{ length: 3 }])).toBeNull();
    expect(normalizeNativeSSOAudience(['app', 'api'])).toEqual(['app', 'api']);
  });
});

describe('Native SSO client eligibility', () => {
  it('enables Native SSO by default only for native applications', () => {
    expect(isNativeSSOClientEnabled(client({ application_type: 'web' }))).toBe(false);
    expect(isNativeSSOClientEnabled(client({}))).toBe(false);
    expect(isNativeSSOClientEnabled(client({ application_type: 'native' }))).toBe(true);
    expect(
      isNativeSSOClientEnabled(client({ application_type: 'web', native_sso_enabled: true }))
    ).toBe(true);
  });

  it('allows the native channel by default only for native applications', () => {
    expect(isNativeSSONativeChannelAllowed(client({ application_type: 'web' }))).toBe(false);
    expect(isNativeSSONativeChannelAllowed(client({ application_type: 'native' }))).toBe(true);
  });

  it('never issues a device secret to a web application, whatever its channels', () => {
    expect(
      isNativeSSOIssuanceEligible(
        client({ application_type: 'web', native_sso_enabled: true, allowed_channels: ['native'] }),
        'native'
      )
    ).toBe(false);
    expect(
      isNativeSSOIssuanceEligible(
        client({ application_type: 'native', allowed_channels: ['native'] }),
        'native'
      )
    ).toBe(true);
  });
});

describe('normalizeNativeSSOPlatform', () => {
  it.each(['ios', 'android', 'macos', 'windows', 'other'])('keeps %s', (platform) => {
    expect(normalizeNativeSSOPlatform(platform)).toBe(platform);
  });

  it('takes anything else for unknown', () => {
    expect(normalizeNativeSSOPlatform('linux')).toBe('unknown');
    expect(normalizeNativeSSOPlatform(undefined)).toBe('unknown');
  });
});
