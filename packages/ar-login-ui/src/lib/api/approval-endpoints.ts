/**
 * The device flow (RFC 8628) and CIBA approval endpoints the Login UI calls, as ar-async serves
 * them (packages/ar-async/src/index.ts, documented in packages/ar-async/openapi/async.openapi.yaml)
 * and ar-router forwards them.
 *
 * Kept free of SvelteKit imports: test/integration/login-ui-approval-routes-contract.test.ts reads
 * this table and checks every entry against the ar-async route table and the router, so the UI
 * cannot call a path no worker serves again.
 */

export interface ApprovalEndpoint {
	method: 'GET' | 'POST';
	/** Path template; `:name` segments are filled by {@link approvalEndpointPath}. */
	path: string;
}

export const APPROVAL_ENDPOINTS = {
	/** Shows which application a user code belongs to; decides nothing. Body: `{ user_code }`. */
	deviceLookup: { method: 'POST', path: '/api/devices/lookup' },
	/** Approves or denies a user code. Body: `{ user_code, approve }`. */
	deviceDecide: { method: 'POST', path: '/api/devices/verify' },
	/** The signed-in user's pending CIBA requests: `{ requests: [...] }`. */
	cibaPending: { method: 'GET', path: '/api/ciba/pending' },
	/** One CIBA request of the signed-in user. */
	cibaDetails: { method: 'GET', path: '/api/ciba/requests/:auth_req_id' },
	/** Body: `{ auth_req_id }`. */
	cibaApprove: { method: 'POST', path: '/api/ciba/approve' },
	/** Body: `{ auth_req_id }`. */
	cibaDeny: { method: 'POST', path: '/api/ciba/deny' }
} as const satisfies Record<string, ApprovalEndpoint>;

export function approvalEndpointPath(
	endpoint: ApprovalEndpoint,
	params: Record<string, string> = {}
): string {
	return endpoint.path.replace(/:([a-z_]+)/g, (_match, name: string) => {
		const value = params[name];
		if (!value) throw new Error(`Missing path parameter: ${name}`);
		return encodeURIComponent(value);
	});
}
