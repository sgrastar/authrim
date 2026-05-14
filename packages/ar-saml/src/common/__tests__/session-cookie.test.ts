import { describe, expect, it } from 'vitest';
import { extractAuthrimSessionIdFromCookieHeader } from '../session-cookie';

describe('extractAuthrimSessionIdFromCookieHeader', () => {
  it('decodes encoded sharded session cookie values', () => {
    expect(
      extractAuthrimSessionIdFromCookieHeader(
        'authrim_session=g1%3Aenam%3A0%3Asession_abc; authrim_browser_state=state'
      )
    ).toBe('g1:enam:0:session_abc');
  });

  it('returns raw cookie value when it is already decoded', () => {
    expect(
      extractAuthrimSessionIdFromCookieHeader(
        'authrim_browser_state=state; authrim_session=g1:weur:2:session_xyz'
      )
    ).toBe('g1:weur:2:session_xyz');
  });

  it('returns null when no session cookie is present', () => {
    expect(extractAuthrimSessionIdFromCookieHeader('authrim_browser_state=state')).toBeNull();
  });
});
