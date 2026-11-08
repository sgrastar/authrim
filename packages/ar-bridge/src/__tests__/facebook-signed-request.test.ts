import { describe, expect, it } from 'vitest';
import {
  FACEBOOK_SIGNED_REQUEST_CLOCK_SKEW_SECONDS,
  verifyFacebookSignedRequest,
} from '../utils/facebook-signed-request';
import { b64url, hmacB64url, signFacebookRequest as sign } from './helpers/facebook-signed-request';

const SECRET = 'facebook-app-secret';
const NOW = 1_800_000_000;
const MAX_AGE = 600;

const signFacebookRequest = (
  payload: Record<string, unknown>,
  secret = SECRET,
  options: { pad?: boolean } = {}
) => sign(payload, secret, options);

const valid = { algorithm: 'HMAC-SHA256', issued_at: NOW - 30, user_id: '10200000000000001' };
const verify = (signedRequest: string, secret = SECRET, now = NOW) =>
  verifyFacebookSignedRequest(signedRequest, secret, { nowSeconds: now, maxAgeSeconds: MAX_AGE });

describe('verifyFacebookSignedRequest', () => {
  it('accepts a request signed with the app secret', async () => {
    await expect(verify(signFacebookRequest(valid))).resolves.toEqual({
      ok: true,
      userId: '10200000000000001',
      issuedAt: NOW - 30,
    });
  });

  it('accepts padded base64url and a numeric user_id', async () => {
    await expect(
      verify(signFacebookRequest({ ...valid, user_id: 1234567 }, SECRET, { pad: true }))
    ).resolves.toMatchObject({ ok: true, userId: '1234567' });
  });

  it('refuses a request signed with another secret', async () => {
    await expect(verify(signFacebookRequest(valid, 'another-secret'))).resolves.toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });

  it('refuses a payload changed after signing', async () => {
    const [signature] = signFacebookRequest(valid).split('.');
    const forged = b64url(JSON.stringify({ ...valid, user_id: '999' }));
    await expect(verify(`${signature}.${forged}`)).resolves.toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });

  it('refuses an algorithm other than HMAC-SHA256, even when correctly signed', async () => {
    for (const algorithm of ['HMAC-SHA1', 'none', 'RS256', undefined]) {
      await expect(verify(signFacebookRequest({ ...valid, algorithm }))).resolves.toEqual({
        ok: false,
        error: 'unsupported_algorithm',
      });
    }
  });

  it('refuses a request issued too long ago, or too far in the future', async () => {
    await expect(
      verify(signFacebookRequest({ ...valid, issued_at: NOW - MAX_AGE - 1 }))
    ).resolves.toEqual({ ok: false, error: 'stale' });
    await expect(
      verify(
        signFacebookRequest({
          ...valid,
          issued_at: NOW + FACEBOOK_SIGNED_REQUEST_CLOCK_SKEW_SECONDS + 1,
        })
      )
    ).resolves.toEqual({ ok: false, error: 'stale' });
    await expect(
      verify(signFacebookRequest({ ...valid, issued_at: String(NOW) }))
    ).resolves.toEqual({ ok: false, error: 'stale' });
    // At the edges it is still accepted.
    await expect(
      verify(signFacebookRequest({ ...valid, issued_at: NOW - MAX_AGE }))
    ).resolves.toMatchObject({ ok: true });
    await expect(
      verify(
        signFacebookRequest({
          ...valid,
          issued_at: NOW + FACEBOOK_SIGNED_REQUEST_CLOCK_SKEW_SECONDS,
        })
      )
    ).resolves.toMatchObject({ ok: true });
  });

  it('refuses a login-flow signed request (code or token) signed with the same secret', async () => {
    for (const extra of [{ code: 'abc' }, { oauth_token: 'token' }]) {
      await expect(verify(signFacebookRequest({ ...valid, ...extra }))).resolves.toEqual({
        ok: false,
        error: 'wrong_purpose',
      });
    }
  });

  it('refuses a missing or non-numeric user_id', async () => {
    for (const user_id of [undefined, '', 'abc', '12 34', 1.5]) {
      await expect(verify(signFacebookRequest({ ...valid, user_id }))).resolves.toEqual({
        ok: false,
        error: 'invalid_user_id',
      });
    }
  });

  it('refuses malformed input before checking anything else', async () => {
    const good = signFacebookRequest(valid);
    const [signature, payload] = good.split('.') as [string, string];
    for (const input of [
      '',
      'no-dot',
      `${good}.extra`,
      `.${payload}`,
      `${signature}.`,
      `${signature.slice(0, -2)}.${payload}`, // not 32 bytes
      `${signature}.${payload}*`,
      'x'.repeat(5000),
    ]) {
      await expect(verify(input)).resolves.toEqual({ ok: false, error: 'malformed' });
    }
    await expect(verify(good, '')).resolves.toEqual({ ok: false, error: 'malformed' });
    // Signed, but not a JSON object.
    const notObject = b64url('[1,2]');
    const notObjectSignature = hmacB64url(notObject, SECRET);
    await expect(verify(`${notObjectSignature}.${notObject}`)).resolves.toEqual({
      ok: false,
      error: 'malformed',
    });
  });
});
