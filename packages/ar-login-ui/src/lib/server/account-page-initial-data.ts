import type { AccountCapabilities } from '$lib/api/account';

export type AccountPageInitialData = {
	capabilities: AccountCapabilities | null;
	capabilitiesResolved: boolean;
	placementConditions: {
		consentRecordsAvailable: boolean | null;
		multipleSessions: boolean | null;
	};
};

type ServerFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function fetchJson<T>(
	fetch: ServerFetch,
	path: string,
	headers?: HeadersInit
): Promise<T | null> {
	try {
		const response = await fetch(path, {
			headers: {
				Accept: 'application/json',
				...headers
			},
			cache: 'no-store'
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

export async function loadAccountPageInitialData(
	fetch: ServerFetch,
	locale?: string | null
): Promise<AccountPageInitialData> {
	const capabilities = await fetchJson<AccountCapabilities>(fetch, '/api/account/capabilities');
	if (!capabilities) {
		return {
			capabilities: null,
			capabilitiesResolved: false,
			placementConditions: {
				consentRecordsAvailable: null,
				multipleSessions: null
			}
		};
	}

	const configuredConditions = new Set(
		capabilities.account_page?.definition.screens
			.filter((screen) => screen.enabled)
			.map((screen) => screen.condition) ?? []
	);
	const needsConsents = configuredConditions.has('consent_records_available');
	const needsSessions = configuredConditions.has('multiple_sessions');
	const [consentResult, sessionResult] = await Promise.all([
		needsConsents
			? fetchJson<{ consents: unknown[] }>(
					fetch,
					'/api/account/consents',
					locale ? { 'Accept-Language': locale.replace('_', '-') } : undefined
				)
			: null,
		needsSessions ? fetchJson<{ sessions: unknown[] }>(fetch, '/api/account/sessions') : null
	]);

	return {
		capabilities,
		capabilitiesResolved: true,
		placementConditions: {
			consentRecordsAvailable: needsConsents
				? consentResult
					? consentResult.consents.length > 0
					: null
				: null,
			multipleSessions: needsSessions
				? sessionResult
					? sessionResult.sessions.length > 1
					: null
				: null
		}
	};
}
