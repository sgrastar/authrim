/**
 * In-memory custom domains for Storybook and tests. Follows the Admin API's rules the card reacts
 * to: a hostname active anywhere is refused (400), only an active domain can become primary
 * (400), a tenant in lite Login UI mode refuses a change that moves its primary domain (409
 * `lite_mode_unsupported`), and verifying a domain set up by hand marks it active.
 */
import { ApiError } from '../api-error';
import type { TenantDomain, TenantDomainsClient } from '../tenant-domains';
import { normalizeHostname } from '../tenant-domains';

export type FakeTenantDomainsCall = keyof TenantDomainsClient;

export interface FakeTenantDomainsOptions {
	domains?: TenantDomain[];
	cloudflareConfigured?: boolean;
	delay?: number;
	failOn?: Partial<Record<FakeTenantDomainsCall, 403 | 404 | 500>>;
	/** Tenants in lite Login UI mode. */
	liteTenants?: string[];
}

const NOW = Date.UTC(2026, 10, 14, 2, 0, 0);
const DAY = 86_400_000;

export function sampleTenantDomains(): TenantDomain[] {
	return [
		{
			id: 'dom_login',
			tenantId: 'acme',
			hostname: 'login.acme.example',
			isPrimary: true,
			isActive: true,
			status: 'active',
			sslStatus: 'active',
			managedByCloudflare: true,
			validationRecords: [],
			lastSyncAt: NOW - DAY,
			createdAt: NOW - 30 * DAY
		},
		{
			id: 'dom_id',
			tenantId: 'acme',
			hostname: 'id.acme.example',
			isPrimary: false,
			isActive: true,
			status: 'pending',
			sslStatus: 'pending_validation',
			managedByCloudflare: true,
			validationRecords: [
				{
					kind: 'ownership',
					type: 'TXT',
					name: '_cf-custom-hostname.id.acme.example',
					value: '5c1d2b4a-7e0f-4f1b-9a2c-3d4e5f6a7b8c'
				},
				{
					kind: 'certificate',
					type: 'TXT',
					name: '_acme-challenge.id.acme.example',
					value: 'Xy9kQ2v1Lm8nP0rS3tU6wZ'
				}
			],
			lastSyncAt: NOW - 3_600_000,
			createdAt: NOW - 3_600_000
		}
	];
}

export function fakeTenantDomains(options: FakeTenantDomainsOptions = {}): TenantDomainsClient {
	const domains = (options.domains ?? sampleTenantDomains()).map((domain) => ({ ...domain }));
	const cloudflare = options.cloudflareConfigured ?? true;
	const delay = options.delay ?? 0;
	let next = 1;
	const fail = async (call: FakeTenantDomainsCall) => {
		await new Promise((resolve) => setTimeout(resolve, delay));
		const status = options.failOn?.[call];
		if (status) throw new ApiError(status, status === 403 ? 'forbidden' : 'error', 'fake');
	};
	const find = (id: string) => {
		const domain = domains.find((candidate) => candidate.id === id);
		if (!domain) throw new ApiError(404, 'not_found', 'Domain not found');
		return domain;
	};
	const lite = (tenantId: string) => {
		if (options.liteTenants?.includes(tenantId)) {
			throw new ApiError(409, 'lite_mode_unsupported', 'The tenant uses the lite Login UI');
		}
	};
	const setPrimary = (domain: TenantDomain) => {
		if (domain.status !== 'active' || !domain.isActive) {
			throw new ApiError(
				400,
				'invalid_request',
				'Primary vanity domain must be active before it can become canonical'
			);
		}
		for (const other of domains) if (other.tenantId === domain.tenantId) other.isPrimary = false;
		domain.isPrimary = true;
	};

	return {
		async list(tenantId) {
			await fail('list');
			return {
				domains: domains
					.filter((domain) => domain.tenantId === tenantId)
					.map((domain) => ({ ...domain })),
				cloudflareConfigured: cloudflare
			};
		},
		async add(tenantId, hostname, makePrimary) {
			await fail('add');
			if (makePrimary) lite(tenantId);
			const name = normalizeHostname(hostname);
			if (domains.some((domain) => domain.hostname === name && domain.isActive)) {
				throw new ApiError(400, 'invalid_request', 'An active vanity domain already exists');
			}
			const domain: TenantDomain = {
				id: `dom_new_${next++}`,
				tenantId,
				hostname: name,
				isPrimary: false,
				isActive: true,
				status: cloudflare ? 'pending' : 'pending_manual',
				sslStatus: cloudflare ? 'pending_validation' : null,
				managedByCloudflare: cloudflare,
				validationRecords: cloudflare
					? [
							{
								kind: 'ownership',
								type: 'TXT',
								name: `_cf-custom-hostname.${name}`,
								value: '0f9e8d7c-6b5a-4f3e-2d1c-0b9a8f7e6d5c'
							}
						]
					: [],
				lastSyncAt: cloudflare ? NOW : null,
				createdAt: NOW
			};
			domains.push(domain);
			return { domain: { ...domain }, cloudflareError: null };
		},
		async makePrimary(domainId) {
			await fail('makePrimary');
			const domain = find(domainId);
			lite(domain.tenantId);
			setPrimary(domain);
			return { ...domain };
		},
		async verify(domainId) {
			await fail('verify');
			const domain = find(domainId);
			if (domain.isPrimary) lite(domain.tenantId);
			if (!domain.managedByCloudflare) {
				domain.status = 'active';
				domain.sslStatus = 'active';
			}
			domain.lastSyncAt = NOW;
			return { ...domain };
		},
		async remove(domainId) {
			await fail('remove');
			const domain = find(domainId);
			if (domain.isPrimary) lite(domain.tenantId);
			domains.splice(domains.indexOf(domain), 1);
		}
	};
}
