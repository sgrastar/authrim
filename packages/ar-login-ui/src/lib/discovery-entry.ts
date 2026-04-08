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
	default_candidate?: DiscoveryCandidate;
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
