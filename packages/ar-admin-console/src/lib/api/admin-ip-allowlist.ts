/**
 * The administrator IP limit (`/api/admin/ip-allowlist`): the addresses and ranges the tenant's
 * administrators may use to reach the admin console and the Admin API. With no enabled entry
 * every address is let in; with one, only the addresses in an enabled range are. It does not
 * touch end users' sign-in.
 *
 * The API also answers `restriction_active` on the list, but counts disabled entries when they
 * are asked for too, so the page works the limit out from the entries itself.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';

export interface IpAllowlistEntry {
	id: string;
	/** A single address or a CIDR range, as saved. */
	ip_range: string;
	ip_version: 4 | 6;
	description: string | null;
	enabled: boolean;
	created_at: number;
	updated_at: number;
}

export interface IpAllowlist {
	entries: IpAllowlistEntry[];
	/** The address the API sees for this request (the administrator's); null when it could not tell. */
	currentIp: string | null;
}

export interface IpAllowlistClient {
	/** Every entry, disabled ones too. */
	list(signal?: AbortSignal): Promise<IpAllowlist>;
	/** A range already listed answers 409; an address the API does not accept, 400. */
	create(input: { ip_range: string; description: string }): Promise<IpAllowlistEntry>;
	update(
		id: string,
		changes: { ip_range?: string; description?: string }
	): Promise<IpAllowlistEntry>;
	setEnabled(id: string, enabled: boolean): Promise<void>;
	remove(id: string): Promise<void>;
}

type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0;

export function ipAllowlistEntryFromRow(value: unknown): IpAllowlistEntry {
	const row = record(value);
	const range = text(row.ip_range);
	return {
		id: text(row.id),
		ip_range: range,
		ip_version: row.ip_version === 6 || range.includes(':') ? 6 : 4,
		description: text(row.description) || null,
		enabled: row.enabled === true || row.enabled === 1,
		created_at: count(row.created_at),
		updated_at: count(row.updated_at)
	};
}

async function readJson(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	if (response.status === 204) return {};
	return record(await response.json().catch(() => ({})));
}

export function httpIpAllowlist(tenantId: string): IpAllowlistClient {
	const base = `${API_BASE_URL}/api/admin/ip-allowlist`;
	const entryUrl = (id: string) => `${base}/${encodeURIComponent(id)}`;
	const send = (url: string, method: string, body?: unknown) =>
		adminFetch(url, {
			method,
			tenantId,
			...(body === undefined ? {} : { includeJsonContentType: true, body: JSON.stringify(body) })
		});

	return {
		async list(signal) {
			const body = await readJson(
				await adminFetch(`${base}?include_disabled=true`, { signal, tenantId })
			);
			const items = Array.isArray(body.items) ? body.items : [];
			const current = text(body.current_ip).split(',')[0]?.trim() ?? '';
			return {
				entries: items.map(ipAllowlistEntryFromRow),
				currentIp: current && current !== 'unknown' ? current : null
			};
		},
		async create(input) {
			const description = input.description.trim();
			return ipAllowlistEntryFromRow(
				await readJson(
					await send(base, 'POST', {
						ip_range: input.ip_range.trim(),
						...(description ? { description } : {})
					})
				)
			);
		},
		async update(id, changes) {
			return ipAllowlistEntryFromRow(
				await readJson(
					await send(entryUrl(id), 'PATCH', {
						...(changes.ip_range !== undefined ? { ip_range: changes.ip_range.trim() } : {}),
						...(changes.description !== undefined
							? { description: changes.description.trim() }
							: {})
					})
				)
			);
		},
		async setEnabled(id, enabled) {
			await readJson(await send(`${entryUrl(id)}/${enabled ? 'enable' : 'disable'}`, 'POST'));
		},
		async remove(id) {
			await readJson(await send(entryUrl(id), 'DELETE'));
		}
	};
}
