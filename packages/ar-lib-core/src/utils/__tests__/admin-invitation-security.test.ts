import { describe, expect, it } from 'vitest';
import {
  adminInvitationIpMatches,
  generateAdminInvitationCode,
  isAdminInvitationCodeFormatValid,
  normalizeAdminInvitationCode,
  normalizeAdminInvitationIpRanges,
} from '../admin-invitation-security';

describe('admin invitation security', () => {
  it('generates grouped, normalized bootstrap codes with 80 bits of symbol entropy', () => {
    const code = generateAdminInvitationCode();
    expect(code).toMatch(/^[23456789A-HJ-NP-Z]{4}(?:-[23456789A-HJ-NP-Z]{4}){3}$/);
    expect(normalizeAdminInvitationCode(code)).toHaveLength(16);
    expect(isAdminInvitationCodeFormatValid(code)).toBe(true);
  });

  it('accepts at most five unique single, CIDR, or explicit IP ranges', () => {
    expect(
      normalizeAdminInvitationIpRanges([
        '192.0.2.10',
        '192.0.2.0/24',
        '192.0.2.20 - 192.0.2.30',
        '2001:db8::/64',
        '2001:db8::1-2001:db8::ffff',
      ])
    ).toMatchObject({ valid: true, ranges: expect.any(Array) });

    expect(normalizeAdminInvitationIpRanges(Array(6).fill('192.0.2.1'))).toMatchObject({
      valid: false,
    });
    expect(normalizeAdminInvitationIpRanges(['1'.repeat(129)])).toMatchObject({
      valid: false,
      error: 'IP range is too long',
    });
  });

  it.each([
    ['192.0.2.10', '192.0.2.10'],
    ['192.0.2.10', '192.0.2.0/24'],
    ['192.0.2.25', '192.0.2.20-192.0.2.30'],
    ['2001:db8::42', '2001:db8::/64'],
    ['2001:db8::42', '2001:db8::1-2001:db8::ffff'],
  ])('matches %s against %s', (clientIp, range) => {
    expect(adminInvitationIpMatches(clientIp, range)).toBe(true);
  });

  it.each([
    ['192.0.3.10', '192.0.2.0/24'],
    ['192.0.2.31', '192.0.2.20-192.0.2.30'],
    ['2001:db9::1', '2001:db8::/64'],
    ['not-an-ip', '192.0.2.0/24'],
  ])('rejects %s against %s', (clientIp, range) => {
    expect(adminInvitationIpMatches(clientIp, range)).toBe(false);
  });
});
