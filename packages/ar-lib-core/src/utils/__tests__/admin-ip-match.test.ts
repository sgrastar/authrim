import { describe, expect, it } from 'vitest';
import { adminIpMatchesRange, getAdminRequestClientIp } from '../admin-ip-match';

describe('adminIpMatchesRange', () => {
  it('matches the same text exactly, and nothing else without a prefix', () => {
    expect(adminIpMatchesRange('203.0.113.5', '203.0.113.5')).toBe(true);
    expect(adminIpMatchesRange('203.0.113.6', '203.0.113.5')).toBe(false);
    expect(adminIpMatchesRange('2001:db8::1', '2001:db8::1')).toBe(true);
    // A single IPv6 address is the same text only (as the middleware has always read it).
    expect(adminIpMatchesRange('2001:db8:0::1', '2001:db8::1')).toBe(false);
  });

  it('matches an IPv4 address by the fixed bits of a range', () => {
    expect(adminIpMatchesRange('203.0.113.200', '203.0.113.0/24')).toBe(true);
    expect(adminIpMatchesRange('203.0.114.1', '203.0.113.0/24')).toBe(false);
    expect(adminIpMatchesRange('1.2.3.4', '0.0.0.0/0')).toBe(true);
    expect(adminIpMatchesRange('203.0.113.9', '203.0.113.9/32')).toBe(true);
    // Host bits in the range are ignored.
    expect(adminIpMatchesRange('203.0.113.9', '203.0.113.77/24')).toBe(true);
  });

  it('matches an IPv6 address by the fixed bits of a range', () => {
    expect(adminIpMatchesRange('2001:db8:1::7', '2001:db8:1::/48')).toBe(true);
    expect(adminIpMatchesRange('2001:db8:2::7', '2001:db8:1::/48')).toBe(false);
    expect(adminIpMatchesRange('2001:db8::1', '::/0')).toBe(true);
  });

  it('refuses a prefix out of range, a malformed one, and a mix of families', () => {
    expect(adminIpMatchesRange('203.0.113.9', '203.0.113.0/33')).toBe(false);
    expect(adminIpMatchesRange('2001:db8::1', '2001:db8::/129')).toBe(false);
    expect(adminIpMatchesRange('203.0.113.9', '203.0.113.0/')).toBe(false);
    expect(adminIpMatchesRange('203.0.113.9', '203.0.113.0/2x')).toBe(false);
    expect(adminIpMatchesRange('203.0.113.9', '203.0.113.0/24/8')).toBe(false);
    expect(adminIpMatchesRange('203.0.113.9', '2001:db8::/32')).toBe(false);
    expect(adminIpMatchesRange('2001:db8::1', '203.0.113.0/24')).toBe(false);
    expect(adminIpMatchesRange('not-an-ip', '203.0.113.0/24')).toBe(false);
  });
});

describe('getAdminRequestClientIp', () => {
  const from = (headers: Record<string, string>) => (name: string) => headers[name];

  it('takes the Cloudflare header, else the first forwarded address', () => {
    expect(
      getAdminRequestClientIp(
        from({ 'CF-Connecting-IP': '203.0.113.5', 'X-Forwarded-For': '10.0.0.1' })
      )
    ).toBe('203.0.113.5');
    expect(getAdminRequestClientIp(from({ 'X-Forwarded-For': ' 10.0.0.1 , 10.0.0.2' }))).toBe(
      '10.0.0.1'
    );
    expect(getAdminRequestClientIp(from({}))).toBeNull();
  });
});
