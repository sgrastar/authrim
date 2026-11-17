/**
 * A tenant's custom domains (`/api/admin/platform/tenant-vanity-domains`), as platform
 * administrators manage them: the hostnames a tenant is reached at, which one is its primary
 * (the address its tokens carry as `iss`), and how far each has got with ownership and
 * certificate checks.
 *
 * With Cloudflare custom hostnames configured, a new domain is registered there and its state is
 * read back from it ("Check again" = sync). Without it the domain waits for manual setup, and
 * "Mark as verified" records that the admin has set up DNS and the certificate themselves.
 * Deleting turns a domain `deleted` (the row stays), so deleted domains are left out here.
 *
 * Platform routes: no tenant header is sent. A tenant in lite Login UI mode refuses a change that
 * moves its primary domain (409 `lite_mode_unsupported`).
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';

export type TenantDomainStatus = 'pending' | 'pending_manual' | 'active' | 'failed';

/** A DNS record (or file) the domain's owner has to publish for a check. */
export interface DomainValidationRecord {
	kind: 'ownership' | 'certificate';
	type: 'TXT' | 'HTTP';
	/** The record name, or the URL for an HTTP check. */
	name: string;
	/** The record value, or the file body. */
	value: string;
}

export interface TenantDomain {
	id: string;
	tenantId: string;
	hostname: string;
	isPrimary: boolean;
	isActive: boolean;
	status: TenantDomainStatus;
	/** Cloudflare's certificate state (`active`, `pending_validation`…), when there is one. */
	sslStatus: string | null;
	/** Registered as a Cloudflare custom hostname (checked there), not set up by hand. */
	managedByCloudflare: boolean;
	validationRecords: DomainValidationRecord[];
	/** Epoch ms. */
	lastSyncAt: number | null;
	createdAt: number | null;
}

export interface TenantDomainList {
	domains: TenantDomain[];
	/** New domains are registered with Cloudflare; otherwise they are set up by hand. */
	cloudflareConfigured: boolean;
}

/** What adding a domain did: the domain, and why Cloudflare refused it (status `failed`). */
export interface TenantDomainAdded {
	domain: TenantDomain;
	/** Cloudflare's reason when registering there failed (the domain is kept, `failed`). */
	cloudflareError: string | null;
}

export interface TenantDomainsClient {
	list(tenantId: string, signal?: AbortSignal): Promise<TenantDomainList>;
	/** A hostname already active anywhere answers 400; the tenant must be active (404). */
	add(tenantId: string, hostname: string, makePrimary: boolean): Promise<TenantDomainAdded>;
	/** Only an active domain can become primary. */
	makePrimary(domainId: string): Promise<TenantDomain>;
	/** Reads the state from Cloudflare, or (set up by hand) records it as verified. */
	verify(domainId: string): Promise<TenantDomain>;
	remove(domainId: string): Promise<void>;
}

type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null =>
	typeof value === 'string' && value !== '' ? value : null;

function epochMs(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
	return value < 1e12 ? value * 1000 : value;
}

const STATUSES: readonly TenantDomainStatus[] = ['pending', 'pending_manual', 'active', 'failed'];

/** As hostnames are stored: trimmed, lowercase, without a trailing dot. */
export function normalizeHostname(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, '');
}

/** The API's own check: an ASCII DNS name with at least one dot, up to 253 characters. */
export const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
export const HOSTNAME_MAX = 253;

export function hostnameValid(value: string): boolean {
	const hostname = normalizeHostname(value);
	return hostname.length > 0 && hostname.length <= HOSTNAME_MAX && HOSTNAME_PATTERN.test(hostname);
}

/**
 * The records to publish, from what Cloudflare returned (`ownership_verification`,
 * `ownership_verification_http`, `ssl_validation_records`). Anything not in those shapes is left
 * out.
 */
export function validationRecordsFrom(value: unknown): DomainValidationRecord[] {
	const source = record(value);
	const records: DomainValidationRecord[] = [];
	const ownership = record(source.ownership_verification);
	if (text(ownership.name) && text(ownership.value)) {
		records.push({
			kind: 'ownership',
			type: 'TXT',
			name: text(ownership.name),
			value: text(ownership.value)
		});
	}
	const ownershipHttp = record(source.ownership_verification_http);
	if (text(ownershipHttp.http_url) && text(ownershipHttp.http_body)) {
		records.push({
			kind: 'ownership',
			type: 'HTTP',
			name: text(ownershipHttp.http_url),
			value: text(ownershipHttp.http_body)
		});
	}
	const ssl = Array.isArray(source.ssl_validation_records) ? source.ssl_validation_records : [];
	for (const entry of ssl.map(record)) {
		if (text(entry.txt_name) && text(entry.txt_value)) {
			records.push({
				kind: 'certificate',
				type: 'TXT',
				name: text(entry.txt_name),
				value: text(entry.txt_value)
			});
		} else if (text(entry.http_url) && text(entry.http_body)) {
			records.push({
				kind: 'certificate',
				type: 'HTTP',
				name: text(entry.http_url),
				value: text(entry.http_body)
			});
		}
	}
	return records;
}

/** Null for a deleted domain (or a row without an id). */
export function tenantDomainFromRow(value: unknown): TenantDomain | null {
	const row = record(value);
	if (!text(row.id) || !(STATUSES as readonly unknown[]).includes(row.status)) return null;
	return {
		id: text(row.id),
		tenantId: text(row.tenant_id),
		hostname: text(row.hostname),
		isPrimary: row.is_primary === true,
		isActive: row.is_active === true,
		status: row.status as TenantDomainStatus,
		sslStatus: textOrNull(row.ssl_status),
		managedByCloudflare: Boolean(
			textOrNull(row.cloudflare_zone_id) && textOrNull(row.cloudflare_custom_hostname_id)
		),
		validationRecords: validationRecordsFrom(row.validation_records),
		lastSyncAt: epochMs(row.last_sync_at),
		createdAt: epochMs(row.created_at)
	};
}

async function readJson(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	return record(await response.json().catch(() => ({})));
}

/** One domain from a write's answer, which is either the domain or `{ domain }`. */
function domainOf(body: Row): TenantDomain {
	const domain = tenantDomainFromRow(body.domain ?? body);
	if (!domain) throw new Error('The API answered without the domain');
	return domain;
}

export function httpTenantDomains(): TenantDomainsClient {
	const base = `${API_BASE_URL}/api/admin/platform/tenant-vanity-domains`;
	const domainUrl = (id: string) => `${base}/${encodeURIComponent(id)}`;
	const send = (url: string, method: string, body?: unknown) =>
		adminFetch(url, {
			method,
			skipTenantHeader: true,
			...(body === undefined ? {} : { includeJsonContentType: true, body: JSON.stringify(body) })
		});

	return {
		async list(tenantId, signal) {
			const body = await readJson(
				await adminFetch(`${base}?tenant_id=${encodeURIComponent(tenantId)}`, {
					signal,
					skipTenantHeader: true
				})
			);
			const rows = Array.isArray(body.domains) ? body.domains : [];
			return {
				domains: rows
					.map(tenantDomainFromRow)
					.filter(
						(domain): domain is TenantDomain => domain !== null && domain.tenantId === tenantId
					),
				cloudflareConfigured: body.cloudflare_configured === true
			};
		},
		async add(tenantId, hostname, makePrimary) {
			const body = await readJson(
				await send(base, 'POST', {
					tenant_id: tenantId,
					hostname: normalizeHostname(hostname),
					is_primary: makePrimary
				})
			);
			return { domain: domainOf(body), cloudflareError: textOrNull(body.cloudflare_error) };
		},
		async makePrimary(domainId) {
			return domainOf(await readJson(await send(`${domainUrl(domainId)}/primary`, 'POST')));
		},
		async verify(domainId) {
			return domainOf(await readJson(await send(`${domainUrl(domainId)}/verify`, 'POST')));
		},
		async remove(domainId) {
			await readJson(await send(domainUrl(domainId), 'DELETE'));
		}
	};
}
