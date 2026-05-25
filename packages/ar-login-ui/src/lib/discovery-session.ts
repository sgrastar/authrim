import type { DiscoveryCandidate } from './discovery-entry';

export const REMEMBERED_TENANT_COOKIE = 'authrim_last_tenant';

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
