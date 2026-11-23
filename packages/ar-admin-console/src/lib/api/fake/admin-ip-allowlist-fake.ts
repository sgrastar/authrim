/**
 * In-memory administrator IP limit for Storybook and tests. Follows the Admin API's rules that the
 * page reacts to: an address or range is checked (400), one already listed is refused (409), and a
 * caller without the write permission is refused (403). The API takes IPv6 too, so an entry like
 * that can be given to show how the page lists one.
 */
import { ApiError } from '../api-error';
import type { IpAllowlist, IpAllowlistClient, IpAllowlistEntry } from '../admin-ip-allowlist';

export type FakeIpAllowlistCall = keyof IpAllowlistClient;

export interface FakeIpAllowlistOptions {
	entries?: IpAllowlistEntry[];
	/** The address the API sees (default: an office address). */
	currentIp?: string | null;
	delay?: number;
	failOn?: Partial<Record<FakeIpAllowlistCall, 403 | 404 | 409 | 500>>;
}

const NOW = Date.UTC(2026, 10, 20, 2, 0, 0);
const DAY = 86_400_000;

export function sampleIpEntries(): IpAllowlistEntry[] {
	return [
		{
			id: 'ip-1',
			ip_range: '203.0.113.0/24',
			ip_version: 4,
			description: 'Head office network',
			enabled: true,
			created_at: NOW - 40 * DAY,
			updated_at: NOW - 40 * DAY
		},
		{
			id: 'ip-2',
			ip_range: '198.51.100.17',
			ip_version: 4,
			description: 'Operations VPN',
			enabled: true,
			created_at: NOW - 12 * DAY,
			updated_at: NOW - 3 * DAY
		},
		{
			id: 'ip-3',
			ip_range: '192.0.2.0/28',
			ip_version: 4,
			description: null,
			enabled: false,
			created_at: NOW - 2 * DAY,
			updated_at: NOW - 2 * DAY
		}
	];
}

/** The client, and what it holds now (to see in a test what a change did). */
export type FakeIpAllowlist = IpAllowlistClient & { entries(): IpAllowlistEntry[] };

export function fakeIpAllowlist(options: FakeIpAllowlistOptions = {}): FakeIpAllowlist {
	let entries = (options.entries ?? sampleIpEntries()).map((entry) => ({ ...entry }));
	let next = 100;
	const currentIp = options.currentIp === undefined ? '203.0.113.5' : options.currentIp;

	async function enter(call: FakeIpAllowlistCall) {
		if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
		const status = options.failOn?.[call];
		if (status) throw new ApiError(status, status === 403 ? 'forbidden' : 'error', `${status}`);
	}

	function invalid(range: string) {
		// What the API accepts: an address or a range, IPv4 or IPv6 (the page only makes IPv4).
		const ok =
			/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(range) || /^[0-9a-f:]+(\/\d{1,3})?$/i.test(range);
		if (!ok) throw new ApiError(400, 'invalid_request', 'Invalid IP range');
	}

	return {
		entries: () => entries.map((entry) => ({ ...entry })),
		async list(): Promise<IpAllowlist> {
			await enter('list');
			return { entries: entries.map((entry) => ({ ...entry })), currentIp };
		},
		async create(input) {
			await enter('create');
			const range = input.ip_range.trim();
			invalid(range);
			if (entries.some((entry) => entry.ip_range === range)) {
				throw new ApiError(409, 'conflict', 'IP range already exists');
			}
			const entry: IpAllowlistEntry = {
				id: `ip-${next++}`,
				ip_range: range,
				ip_version: range.includes(':') ? 6 : 4,
				description: input.description.trim() || null,
				enabled: true,
				created_at: Date.now(),
				updated_at: Date.now()
			};
			entries = [...entries, entry];
			return { ...entry };
		},
		async update(id, changes) {
			await enter('update');
			const found = entries.find((entry) => entry.id === id);
			if (!found) throw new ApiError(404, 'not_found', 'Not found');
			if (changes.ip_range !== undefined) {
				const range = changes.ip_range.trim();
				invalid(range);
				if (entries.some((entry) => entry.id !== id && entry.ip_range === range)) {
					throw new ApiError(409, 'conflict', 'IP range already exists');
				}
				found.ip_range = range;
				found.ip_version = range.includes(':') ? 6 : 4;
			}
			if (changes.description !== undefined) found.description = changes.description.trim() || null;
			found.updated_at = Date.now();
			return { ...found };
		},
		async setEnabled(id, enabled) {
			await enter('setEnabled');
			const found = entries.find((entry) => entry.id === id);
			if (!found) throw new ApiError(404, 'not_found', 'Not found');
			found.enabled = enabled;
			found.updated_at = Date.now();
		},
		async remove(id) {
			await enter('remove');
			if (!entries.some((entry) => entry.id === id)) {
				throw new ApiError(404, 'not_found', 'Not found');
			}
			entries = entries.filter((entry) => entry.id !== id);
		}
	};
}
