const AGENT_ELEVATION_RETURN_PATH = /^\/admin\/agent-access\/elevations\/ael_[A-Za-z0-9-]{1,128}$/;
const AGENT_BULK_RETURN_PATH =
	/^\/admin\/agent-access\/bulk-plans\/abp_[A-Za-z0-9-]{1,128}\/[1-9][0-9]*$/;

/**
 * Limits post-login navigation to the two security journeys that legitimately need to resume.
 * All malformed, external, or unrelated Admin paths fall back to the dashboard.
 */
export function resolveAdminLoginReturnTo(search: string, origin: string): string {
	const value = new URLSearchParams(search).get('return_to');
	if (!value) return '/admin';
	try {
		const target = new URL(value, origin);
		if (target.origin !== origin || target.hash) return '/admin';
		if (target.pathname === '/oauth/admin-agent/authorize') {
			return `${target.pathname}${target.search}`;
		}
		if (!target.search && AGENT_ELEVATION_RETURN_PATH.test(target.pathname)) {
			return target.pathname;
		}
		if (!target.search && AGENT_BULK_RETURN_PATH.test(target.pathname)) {
			return target.pathname;
		}
	} catch {
		// Fall through for malformed or external return targets.
	}
	return '/admin';
}
