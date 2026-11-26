import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../engine';
import type { PolicyContext } from '../types';

function inRange(clientIp: string | undefined, ...ranges: string[]): boolean {
  const engine = new PolicyEngine({ defaultDecision: 'deny' });
  engine.addRule({
    id: 'r',
    name: 'r',
    priority: 1,
    effect: 'allow',
    conditions: [{ type: 'ip_in_range', params: { ranges } }],
  });
  const context: PolicyContext = {
    subject: { id: 'user-1', roles: [] },
    resource: { type: 'doc', id: 'd1' },
    action: { name: 'read' },
    timestamp: 0,
    environment: clientIp === undefined ? undefined : { clientIp },
  };
  return engine.evaluate(context).allowed;
}

describe('ip_in_range: IPv4', () => {
  it('needs a client IP', () => {
    expect(inRange(undefined, '0.0.0.0/0')).toBe(false);
    expect(inRange('', '0.0.0.0/0')).toBe(false);
  });

  it('matches the prefix of the range', () => {
    expect(inRange('192.168.1.200', '192.168.1.0/24')).toBe(true);
    expect(inRange('192.168.2.1', '192.168.1.0/24')).toBe(false);
    expect(inRange('10.255.255.255', '10.0.0.0/8')).toBe(true);
    expect(inRange('11.0.0.0', '10.0.0.0/8')).toBe(false);
    expect(inRange('1.2.3.4', '1.2.3.4/32')).toBe(true);
    expect(inRange('1.2.3.5', '1.2.3.4/32')).toBe(false);
    expect(inRange('203.0.113.9', '0.0.0.0/0')).toBe(true);
    expect(inRange('255.255.255.255', '128.0.0.0/1')).toBe(true);
    expect(inRange('127.255.255.255', '128.0.0.0/1')).toBe(false);
  });

  it('matches any of several ranges', () => {
    expect(inRange('10.1.1.1', '192.168.0.0/16', '10.0.0.0/8')).toBe(true);
    expect(inRange('172.16.0.1', '192.168.0.0/16', '10.0.0.0/8')).toBe(false);
  });

  it('refuses a range that is not address/bits', () => {
    for (const range of ['10.0.0.1', '/24', '10.0.0.0/', '10.0.0.0/x', '/', '']) {
      expect(inRange('10.0.0.1', range)).toBe(false);
    }
    // The very address, with bits that are not a number, is not in the range either.
    for (const range of ['10.0.0.1/x', '10.0.0.1/', '10.0.0.1/abc']) {
      expect(inRange('10.0.0.1', range)).toBe(false);
    }
    expect(inRange('2001:db8::1', '2001:db8::1/x')).toBe(false);
  });

  it('refuses bits outside 0 to 32, even for the very address', () => {
    expect(inRange('10.0.0.1', '10.0.0.1/33')).toBe(false);
    expect(inRange('10.0.0.1', '10.0.0.1/-1')).toBe(false);
    expect(inRange('10.0.0.1', '10.0.0.1/32')).toBe(true);
    expect(inRange('10.0.0.1', '10.0.0.1/0')).toBe(true);
  });

  it('refuses addresses that are not four octets of 0 to 255', () => {
    for (const bad of ['10.0.0', '10.0.0.1.5', '10.0.0.256', '10.0.0.-1', 'a.b.c.d', '10.0.0.x']) {
      expect(inRange(bad, '0.0.0.0/0')).toBe(false);
      expect(inRange('10.0.0.1', `${bad}/0`)).toBe(false);
    }
    expect(inRange('0.0.0.0', '0.0.0.0/32')).toBe(true);
    expect(inRange('255.255.255.255', '255.255.255.255/32')).toBe(true);
  });

  it('never matches across IP versions', () => {
    expect(inRange('10.0.0.1', '::/0')).toBe(false);
    expect(inRange('::1', '0.0.0.0/0')).toBe(false);
  });
});

describe('ip_in_range: IPv6', () => {
  it('matches the prefix of the range', () => {
    expect(inRange('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(inRange('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(inRange('2001:db8:0:1::1', '2001:db8::/64')).toBe(false);
    expect(inRange('2001:db8::ffff', '2001:db8::/64')).toBe(true);
    expect(inRange('2001:db8::1', '2001:db8::1/128')).toBe(true);
    expect(inRange('2001:db8::2', '2001:db8::1/128')).toBe(false);
    expect(inRange('2001:db8::3', '2001:db8::2/127')).toBe(true);
    expect(inRange('2001:db8::4', '2001:db8::2/127')).toBe(false);
    expect(inRange('ffff::1', '::/0')).toBe(true);
    expect(inRange('8000::', '8000::/1')).toBe(true);
    expect(inRange('7fff::', '8000::/1')).toBe(false);
  });

  it('reads full and compressed forms alike, and ignores a zone', () => {
    expect(inRange('2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::/32')).toBe(true);
    expect(inRange('::1', '::1/128')).toBe(true);
    expect(inRange('::', '::/128')).toBe(true);
    expect(inRange('fe80::1%eth0', 'fe80::/10')).toBe(true);
    expect(inRange('1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8/128')).toBe(true);
    expect(inRange('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'ffff::/16')).toBe(true);
  });

  it('refuses bits outside 0 to 128, even for the very address', () => {
    expect(inRange('::1', '::1/129')).toBe(false);
    expect(inRange('::1', '::1/-1')).toBe(false);
    expect(inRange('::1', '::1/128')).toBe(true);
    expect(inRange('::1', '::1/0')).toBe(true);
  });

  it('refuses addresses that cannot be read', () => {
    const bad = [
      '1:2:3',
      '1:2:3:4:5:6:7:8:9',
      '12345::',
      'g::',
      'zzzz::',
      '-1::',
      '1:2:3:4:5:6:7:8::9',
    ];
    for (const address of bad) {
      expect(inRange(address, '::/0')).toBe(false);
      expect(inRange('::1', `${address}/0`)).toBe(false);
    }
    expect(inRange('ffff::1', '::/0')).toBe(true);
    expect(inRange('0:0:0:0:0:0:0:1', '::/0')).toBe(true);
  });

  it('reads IPv4-mapped addresses', () => {
    expect(inRange('::ffff:192.168.1.1', '::ffff:192.168.0.0/112')).toBe(true);
    expect(inRange('::ffff:192.169.1.1', '::ffff:192.168.0.0/112')).toBe(false);
    expect(inRange('::ffff:192.168.1.1', '::ffff:192.168.1.1/128')).toBe(true);
    expect(inRange('::ffff:192.168.1.2', '::ffff:192.168.1.1/128')).toBe(false);
    expect(inRange('::ffff:c0a8:101', '::ffff:192.168.1.1/128')).toBe(true);
    expect(inRange('2001:db8::10.0.0.1', '2001:db8::/32')).toBe(true);
  });

  it('refuses a mapped address that cannot be read', () => {
    expect(inRange('::ffff:1.2.3', '::/0')).toBe(false);
    expect(inRange('::ffff:1.2.3.256', '::/0')).toBe(false);
    expect(inRange('1:2:3:4:5:6:7:8:1.2.3.4', '::/0')).toBe(false);
    expect(inRange('::1', '::ffff:1.2.3/0')).toBe(false);
  });
});
