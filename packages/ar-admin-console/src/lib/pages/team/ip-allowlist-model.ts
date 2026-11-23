/**
 * The administrator IP limit (Settings → Administrator IP limit): what an address or range is,
 * and whether the administrator looking at the page would still get in.
 *
 * The console takes IPv4 only: a single address (`203.0.113.5`) or a range in CIDR form
 * (`203.0.113.0/24`). The API stores IPv6 too, and an entry made another way is listed as it is,
 * but this page does not make one.
 *
 * Matching follows the Admin API's check (`ipMatchesCidr` in the admin-auth middleware): an
 * address is in a range when both agree on the first `prefix` bits, so `203.0.113.7/24` and
 * `203.0.113.0/24` are the same range.
 */

export interface Ipv4Range {
	/** First address of the range, as a number. */
	first: number;
	/** Last address of the range, as a number. */
	last: number;
	/** Bits that are fixed (0 to 32). 32 is one address. */
	prefix: number;
	/** How many addresses are in it. */
	count: number;
}

export type RangeProblem = 'empty' | 'address' | 'prefix' | 'ipv6';

export type RangeParse =
	| {
			ok: true;
			range: Ipv4Range;
			/** What is saved: the single address, or the range from its first address. */ text: string;
	  }
	| { ok: false; problem: RangeProblem };

/** `203.0.113.5` as a number; null when it is not four numbers 0–255 (a leading zero is refused). */
export function parseIpv4(text: string): number | null {
	const parts = text.split('.');
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const number = Number(part);
		if (number > 255 || String(number) !== part) return null;
		value = value * 256 + number;
	}
	return value;
}

export function ipv4Text(value: number): string {
	return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

/** Reads what was typed: an address, or an address and `/` and a prefix length. */
export function parseRange(input: string): RangeParse {
	const text = input.trim();
	if (!text) return { ok: false, problem: 'empty' };
	if (text.includes(':')) return { ok: false, problem: 'ipv6' };
	const slash = text.indexOf('/');
	const address = slash === -1 ? text : text.slice(0, slash);
	const base = parseIpv4(address);
	if (base === null) return { ok: false, problem: 'address' };
	if (slash === -1) {
		return { ok: true, range: { first: base, last: base, prefix: 32, count: 1 }, text: address };
	}
	const prefixText = text.slice(slash + 1);
	if (!/^\d{1,2}$/.test(prefixText) || Number(prefixText) > 32) {
		return { ok: false, problem: 'prefix' };
	}
	const prefix = Number(prefixText);
	const count = 2 ** (32 - prefix);
	const first = base - (base % count);
	return {
		ok: true,
		range: { first, last: first + count - 1, prefix, count },
		text: prefix === 32 ? ipv4Text(first) : `${ipv4Text(first)}/${prefix}`
	};
}

/** Whether `address` is in `range`. */
export function rangeContains(range: Ipv4Range, address: number): boolean {
	return address >= range.first && address <= range.last;
}

/** What the page needs of an entry to judge access. */
export interface LimitEntry {
	ip_range: string;
	enabled: boolean;
}

/**
 * How the Admin API reads what is stored, which is looser than what this page lets in: a
 * leading zero in a number and in the prefix length are read as the number (an entry made by
 * another route can have them), so judging an entry here uses these and not `parseRange`.
 */
function storedIpv4(ip: string): number | null {
	const parts = ip.split('.');
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
		value = value * 256 + Number(part);
	}
	return value;
}

function storedIpv6(ip: string): bigint | null {
	if (ip.includes('.') || ip.includes(':::') || (ip.match(/::/g) ?? []).length > 1) return null;
	const compressed = ip.includes('::');
	const [leftText, rightText = ''] = compressed ? ip.split('::') : [ip, ''];
	const left = leftText ? leftText.split(':') : [];
	const right = rightText ? rightText.split(':') : [];
	if ((!compressed && left.length !== 8) || (compressed && left.length + right.length >= 8)) {
		return null;
	}
	const groups = compressed
		? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
		: left;
	if (groups.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) return null;
	return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

/**
 * Whether the Admin API lets `address` in by the stored `range` (`ipMatches` in the admin-auth
 * middleware): the same text, or an address in a CIDR range of its own family.
 */
export function serverMatches(address: string, range: string): boolean {
	if (address === range) return true;
	const parts = range.split('/');
	if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return false;
	const prefix = Number(parts[1]);
	if (!address.includes(':') && !parts[0].includes(':')) {
		const a = storedIpv4(address);
		const base = storedIpv4(parts[0]);
		if (a === null || base === null || prefix > 32) return false;
		const mask = prefix === 0 ? 0 : (-1 << (32 - prefix)) >>> 0;
		return (a & mask) >>> 0 === (base & mask) >>> 0;
	}
	if (address.includes(':') && parts[0].includes(':')) {
		const a = storedIpv6(address);
		const base = storedIpv6(parts[0]);
		if (a === null || base === null || prefix > 128) return false;
		const hostBits = BigInt(128 - prefix);
		return a >> hostBits === base >> hostBits;
	}
	return false;
}

/**
 * - `open`: no enabled entry, so every address is let in.
 * - `allowed` / `blocked`: the address is, or is not, in an enabled range.
 * - `unknown`: there is no address for the administrator to judge.
 */
export type AccessState = 'open' | 'allowed' | 'blocked' | 'unknown';

export function accessState(entries: readonly LimitEntry[], address: string | null): AccessState {
	const enabled = entries.filter((entry) => entry.enabled);
	if (enabled.length === 0) return 'open';
	if (!address) return 'unknown';
	return enabled.some((entry) => serverMatches(address, entry.ip_range)) ? 'allowed' : 'blocked';
}

/** How the list will read after one change, to see before saving whether it shuts the administrator out. */
export function withChange(
	entries: readonly (LimitEntry & { id: string })[],
	change:
		| { kind: 'add'; entry: LimitEntry }
		| { kind: 'edit'; id: string; ip_range: string }
		| { kind: 'enabled'; id: string; enabled: boolean }
		| { kind: 'remove'; id: string }
): LimitEntry[] {
	switch (change.kind) {
		case 'add':
			return [...entries, change.entry];
		case 'edit':
			return entries.map((entry) =>
				entry.id === change.id ? { ...entry, ip_range: change.ip_range } : entry
			);
		case 'enabled':
			return entries.map((entry) =>
				entry.id === change.id ? { ...entry, enabled: change.enabled } : entry
			);
		case 'remove':
			return entries.filter((entry) => entry.id !== change.id);
	}
}

/**
 * A change that leaves the administrator outside the limit, or starts a limit when it cannot be
 * told whether they are inside (no address for them).
 */
export function locksOut(
	before: readonly LimitEntry[],
	after: readonly LimitEntry[],
	address: string | null
): boolean {
	const was = accessState(before, address);
	const now = accessState(after, address);
	// Outside already: this change is not what shuts them out.
	if (now === 'blocked') return was !== 'blocked';
	return now === 'unknown' && was === 'open';
}

/** The size of a range for the page: `256`, `4,294,967,296`. */
export function countText(count: number, locale?: string): string {
	return count.toLocaleString(locale);
}
