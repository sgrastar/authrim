import { describe, expect, it } from 'vitest';
import {
  createAuthorizationRequestContinuation,
  parseAuthorizationRequestContinuation,
} from '../authorization-continuation';

const request = {
  response_type: 'code',
  client_id: 'client',
  redirect_uri: 'https://client.example.com/callback',
  scope: 'openid',
};

describe('authorization request continuation', () => {
  it('carries that the request came in a signed request object', () => {
    const continuation = createAuthorizationRequestContinuation({
      ...request,
      authorization_request_source: 'par',
      authorization_request_integrity_protected: true,
      authorization_request_signed: true,
    });

    expect(continuation).toMatchObject({ source: 'par', request_object_signed: true });
    expect(parseAuthorizationRequestContinuation(continuation)).toMatchObject({
      request_object_signed: true,
    });
  });

  it('records nothing of the kind for a request that was not signed', () => {
    const continuation = createAuthorizationRequestContinuation({
      ...request,
      authorization_request_signed: 'true',
    });

    expect(continuation).not.toHaveProperty('request_object_signed');
    expect(parseAuthorizationRequestContinuation(continuation)).not.toHaveProperty(
      'request_object_signed'
    );
  });

  it.each([false, 'true', 1])('refuses a continuation whose signed mark is %s', (value) => {
    expect(
      parseAuthorizationRequestContinuation({
        ...request,
        source: 'par',
        authorization_server: 'default',
        integrity_protected: true,
        request_object_signed: value,
      })
    ).toBeNull();
  });
});
