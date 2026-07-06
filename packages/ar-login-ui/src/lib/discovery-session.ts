import type { DiscoveryCandidate } from './discovery-entry';

export const REMEMBERED_TENANT_COOKIE = 'authrim_last_tenant';
export const LOGIN_TENANT_HOST_COOKIE = 'authrim_login_tenant_host';

const MAX_TENANT_HOST_LENGTH = 255;

function containsAsciiControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) {
			return true;
		}
	}
	return false;
}

export function normalizeTenantHost(rawValue: string | null | undefined): string | undefined {
	if (!rawValue) {
		return undefined;
	}

	const value = rawValue.trim();
	if (!value || value.length > MAX_TENANT_HOST_LENGTH || containsAsciiControlCharacter(value)) {
		return undefined;
	}

	let parsed: URL;
	try {
		parsed = new URL(value.includes('://') ? value : `https://${value}`);
	} catch {
		return undefined;
	}

	if (
		(parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
		parsed.username ||
		parsed.password ||
		parsed.pathname !== '/' ||
		parsed.search ||
		parsed.hash
	) {
		return undefined;
	}

	const host = parsed.host.toLowerCase();
	if (!host || host.length > MAX_TENANT_HOST_LENGTH || /[\s,]/.test(host)) {
		return undefined;
	}

	return host;
}

export function getLoginTenantHost(rawValue: string | undefined): string | undefined {
	return normalizeTenantHost(rawValue);
}

export function readRememberedTenant(rawValue: string | undefined): DiscoveryCandidate | null {
	if (!rawValue) {
		return null;
	}

	try {
		const parsed = JSON.parse(rawValue) as DiscoveryCandidate;
		if (
			typeof parsed?.tenant_id === 'string' &&
			typeof parsed?.tenant_code === 'string' &&
			typeof parsed?.display_name === 'string' &&
			typeof parsed?.login_url === 'string'
		) {
			return parsed;
		}
	} catch {
		// Ignore invalid cookies.
	}

	return null;
}

export function getRememberedTenantHost(rawValue: string | undefined): string | undefined {
	const candidate = readRememberedTenant(rawValue);
	if (!candidate) {
		return undefined;
	}

	try {
		return new URL(candidate.login_url).host;
	} catch {
		return undefined;
	}
}
