import { describe, expect, it } from 'vitest';
import {
	accessState,
	ipv4Text,
	locksOut,
	parseIpv4,
	parseRange,
	rangeContains,
	serverMatches,
	withChange
} from './ip-allowlist-model';

const on = (ip_range: string) => ({ ip_range, enabled: true });
const off = (ip_range: string) => ({ ip_range, enabled: false });

describe('IPv4 addresses', () => {
	it('reads four numbers 0 to 255', () => {
		expect(parseIpv4('0.0.0.0')).toBe(0);
		expect(parseIpv4('255.255.255.255')).toBe(2 ** 32 - 1);
		expect(ipv4Text(parseIpv4('203.0.113.5')!)).toBe('203.0.113.5');
	});

	it('refuses what the API refuses: a leading zero, a number past 255, a wrong count', () => {
		for (const text of ['01.2.3.4', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.-4', 'a.b.c.d', '']) {
			expect(parseIpv4(text), text).toBeNull();
		}
	});
});

describe('what was typed', () => {
	it('takes a single address as it is', () => {
		const parsed = parseRange(' 203.0.113.5 ');
		expect(parsed).toMatchObject({ ok: true, text: '203.0.113.5' });
		if (parsed.ok) expect(parsed.range).toMatchObject({ prefix: 32, count: 1 });
	});

	it('takes a range from its first address, however the host bits were typed', () => {
		const parsed = parseRange('203.0.113.77/24');
		expect(parsed).toMatchObject({ ok: true, text: '203.0.113.0/24' });
		if (parsed.ok) {
			expect(ipv4Text(parsed.range.first)).toBe('203.0.113.0');
			expect(ipv4Text(parsed.range.last)).toBe('203.0.113.255');
			expect(parsed.range.count).toBe(256);
		}
	});

	it('reads the ends of the prefix length', () => {
		expect(parseRange('1.2.3.4/32')).toMatchObject({ ok: true, text: '1.2.3.4' });
		const everything = parseRange('10.1.2.3/0');
		expect(everything).toMatchObject({ ok: true, text: '0.0.0.0/0' });
		if (everything.ok) expect(everything.range.count).toBe(2 ** 32);
	});

	it('names what is wrong', () => {
		expect(parseRange('  ')).toEqual({ ok: false, problem: 'empty' });
		expect(parseRange('1.2.3')).toEqual({ ok: false, problem: 'address' });
		expect(parseRange('1.2.3.4/33')).toEqual({ ok: false, problem: 'prefix' });
		expect(parseRange('1.2.3.4/')).toEqual({ ok: false, problem: 'prefix' });
		expect(parseRange('1.2.3.4/-1')).toEqual({ ok: false, problem: 'prefix' });
		expect(parseRange('1.2.3.4/8x')).toEqual({ ok: false, problem: 'prefix' });
		expect(parseRange('2001:db8::1')).toEqual({ ok: false, problem: 'ipv6' });
		expect(parseRange('2001:db8::/32')).toEqual({ ok: false, problem: 'ipv6' });
	});

	it('finds an address in a range by the fixed bits', () => {
		const parsed = parseRange('192.168.1.0/24');
		if (!parsed.ok) throw new Error('range');
		expect(rangeContains(parsed.range, parseIpv4('192.168.1.255')!)).toBe(true);
		expect(rangeContains(parsed.range, parseIpv4('192.168.2.0')!)).toBe(false);
	});
});

describe('access under the limit', () => {
	it('lets everyone in while no entry is enabled', () => {
		expect(accessState([], '203.0.113.5')).toBe('open');
		expect(accessState([off('10.0.0.0/8')], '203.0.113.5')).toBe('open');
	});

	it('lets in an address in an enabled range and keeps out the rest', () => {
		const entries = [on('203.0.113.0/24'), off('198.51.100.0/24')];
		expect(accessState(entries, '203.0.113.9')).toBe('allowed');
		expect(accessState(entries, '198.51.100.9')).toBe('blocked');
		expect(accessState(entries, '192.0.2.1')).toBe('blocked');
	});

	it('cannot judge without an address', () => {
		expect(accessState([on('10.0.0.1')], null)).toBe('unknown');
	});

	it('keeps an IPv6 address out of IPv4 ranges and judges it against IPv6 ones', () => {
		expect(accessState([on('10.0.0.0/8')], '2001:db8::1')).toBe('blocked');
		expect(accessState([on('10.0.0.0/8'), on('2001:db8::/32')], '2001:db8::1')).toBe('allowed');
		expect(accessState([on('2001:db8:1::/48'), on('2001:db8:2::/48')], '2001:db8:1::7')).toBe(
			'allowed'
		);
		expect(accessState([on('2001:db8:2::/48')], '2001:db8:1::7')).toBe('blocked');
		// A single address matches only the same text, as the API does.
		expect(accessState([on('2001:db8::1')], '2001:db8::1')).toBe('allowed');
		expect(accessState([on('2001:db8::1')], '2001:db8:0::1')).toBe('blocked');
	});

	it('reads a stored entry the way the API does, a leading zero in the prefix included', () => {
		expect(serverMatches('203.0.113.9', '203.0.113.0/024')).toBe(true);
		expect(serverMatches('203.0.114.9', '203.0.113.0/024')).toBe(false);
		expect(serverMatches('203.0.113.9', '203.0.113.0/33')).toBe(false);
		expect(serverMatches('203.0.113.9', '203.0.113.0/')).toBe(false);
		expect(serverMatches('203.0.113.9', '2001:db8::/32')).toBe(false);
		expect(serverMatches('2001:db8::1', '2001:db8::/129')).toBe(false);
		expect(serverMatches('2001:db8::1', '::1/0')).toBe(true);
	});
});

describe('a change that would shut the administrator out', () => {
	const me = '203.0.113.5';
	const entries = [
		{ id: 'a', ...on('203.0.113.0/24') },
		{ id: 'b', ...on('198.51.100.0/24') }
	];

	it('is the first entry that leaves them outside', () => {
		const after = withChange([], { kind: 'add', entry: on('198.51.100.0/24') });
		expect(locksOut([], after, me)).toBe(true);
		expect(locksOut([], withChange([], { kind: 'add', entry: on('203.0.113.5') }), me)).toBe(false);
	});

	it('is the last range that held them, switched off, deleted or edited away', () => {
		expect(
			locksOut(entries, withChange(entries, { kind: 'enabled', id: 'a', enabled: false }), me)
		).toBe(true);
		expect(locksOut(entries, withChange(entries, { kind: 'remove', id: 'a' }), me)).toBe(true);
		expect(
			locksOut(
				entries,
				withChange(entries, { kind: 'edit', id: 'a', ip_range: '192.0.2.0/24' }),
				me
			)
		).toBe(true);
	});

	it('is not a change that takes the limit off, or one they are still inside', () => {
		const only = [{ id: 'a', ...on('203.0.113.0/24') }];
		expect(locksOut(only, withChange(only, { kind: 'remove', id: 'a' }), me)).toBe(false);
		expect(locksOut(entries, withChange(entries, { kind: 'remove', id: 'b' }), me)).toBe(false);
	});

	it('is a first entry when it cannot be told whether they are inside', () => {
		expect(locksOut([], withChange([], { kind: 'add', entry: on('10.0.0.1') }), null)).toBe(true);
		// With a limit already on and no address, a change is not held (nothing to judge by).
		const listed = [{ id: 'a', ...on('10.0.0.1') }];
		expect(locksOut(listed, withChange(listed, { kind: 'add', entry: on('10.0.0.2') }), null)).toBe(
			false
		);
	});

	it('is not held when only the description changed', () => {
		const listed = [{ id: 'a', ...on('203.0.113.0/24') }];
		expect(
			locksOut(
				listed,
				withChange(listed, { kind: 'edit', id: 'a', ip_range: '203.0.113.0/24' }),
				me
			)
		).toBe(false);
	});

	it('is the last allowed IPv6 range, switched off', () => {
		const six = '2001:db8:1::7';
		const listed = [
			{ id: 'a', ...on('2001:db8:1::/48') },
			{ id: 'b', ...on('2001:db8:2::/48') }
		];
		expect(
			locksOut(listed, withChange(listed, { kind: 'enabled', id: 'a', enabled: false }), six)
		).toBe(true);
	});

	it('is not blamed on a change when they were outside already', () => {
		const outside = [{ id: 'b', ...on('198.51.100.0/24') }];
		expect(
			locksOut(outside, withChange(outside, { kind: 'add', entry: on('192.0.2.0/24') }), me)
		).toBe(false);
	});
});
