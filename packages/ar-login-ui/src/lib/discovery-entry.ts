export interface DiscoveryCandidate {
	tenant_id: string;
	tenant_code: string;
	display_name: string;
	logo_url?: string | null;
	login_url: string;
	source: string;
}

export interface DiscoveryConfigResponse {
	config: {
		tenant_id: string;
		mode: 'tenant_only' | 'discovery_optional' | 'discovery_required';
		discovery_methods: string[];
		email_resolution_policy: 'exact_email_then_domain' | 'exact_email_only' | 'disabled';
		selection_policy: 'auto_if_single' | 'always_select' | 'select_if_multiple' | 'manual_only';
		allow_manual_tenant_entry: boolean;
		remember_last_tenant: boolean;
		redirect_default_login_to_discovery: boolean;
		require_common_discovery_before_login: boolean;
		skip_discovery_if_only_one_tenant: boolean;
		redirect_tenant_discover_to_common_entry: boolean;
	};
	ui: {
		theme: string;
		variant: string;
		brand_name: string;
		logo_url: string | null;
		page_title: string;
		kicker_text: string;
		title_text: string;
		subtitle_text: string;
	};
	single_tenant_mode: boolean;
	is_common_entry_host: boolean;
	common_discover_url: string | null;
	single_active_tenant_candidate?: DiscoveryCandidate;
	default_candidate?: DiscoveryCandidate;
}

export interface DiscoveryGrantIssueRequest {
	tenant_id: string;
	return_to?: string;
	expected_tenant_id?: string;
	login_hint?: string;
}

export interface DiscoveryGrantIssueResponse {
	grant: string;
	login_url: string;
}

export interface DiscoveryGrantVerifyResponse {
	valid: boolean;
	tenant_id: string;
	target_url: string;
}

interface DiscoveryRequestEventLike {
	request: Request;
	url: URL;
}

export function getDiscoveryRequestHeaders(
	event: DiscoveryRequestEventLike
): HeadersInit | undefined {
	const originalHost = event.request.headers.get('x-authrim-original-host')?.trim();
	const forwardedHost = originalHost || event.url.host;

	return forwardedHost ? { 'x-authrim-original-host': forwardedHost } : undefined;
}

export async function fetchDiscoveryConfig(
	fetchFn: typeof fetch,
	headers?: HeadersInit
): Promise<DiscoveryConfigResponse> {
	const response = await fetchFn('/api/auth/discovery', headers ? { headers } : undefined);
	if (!response.ok) {
		throw new Error('Failed to load discovery config');
	}
	return (await response.json()) as DiscoveryConfigResponse;
}

export async function issueDiscoveryGrant(
	fetchFn: typeof fetch,
	request: DiscoveryGrantIssueRequest,
	headers?: HeadersInit
): Promise<DiscoveryGrantIssueResponse> {
	const requestHeaders = new Headers(headers);
	requestHeaders.set('Content-Type', 'application/json');

	const response = await fetchFn('/api/auth/discovery/grant', {
		method: 'POST',
		headers: requestHeaders,
		body: JSON.stringify(request)
	});

	if (!response.ok) {
		throw new Error('Failed to issue discovery grant');
	}

	return (await response.json()) as DiscoveryGrantIssueResponse;
}

export async function verifyDiscoveryGrant(
	fetchFn: typeof fetch,
	request: { grant: string; current_url: string },
	headers?: HeadersInit
): Promise<DiscoveryGrantVerifyResponse> {
	const requestHeaders = new Headers(headers);
	requestHeaders.set('Content-Type', 'application/json');

	const response = await fetchFn('/api/auth/discovery/grant/verify', {
		method: 'POST',
		headers: requestHeaders,
		body: JSON.stringify(request)
	});

	if (!response.ok) {
		throw new Error('Failed to verify discovery grant');
	}

	return (await response.json()) as DiscoveryGrantVerifyResponse;
}
