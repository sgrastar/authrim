const AGENT_ELEVATION_RETURN_PATH = /^\/admin\/agent-access\/elevations\/ael_[A-Za-z0-9-]{1,128}$/;
const AGENT_BULK_RETURN_PATH =
	/^\/admin\/agent-access\/bulk-plans\/abp_[A-Za-z0-9-]{1,128}\/[1-9][0-9]*$/;
const AGENT_LOGIN_HANDOFF_ID = /^alh_[A-Za-z0-9_-]{32}$/;

/**
 * Limits post-login navigation to the security journeys that legitimately need to resume.
 *
 * Cross-origin Admin Agent authorization resumes through a server-issued one-time handoff code;
 * it is never represented as a browser-controlled return_to URL.
 */
export function resolveAdminAgentLoginHandoffId(search: string): string | null {
	const parameters = new URLSearchParams(search);
	const handoffId = parameters.get('agent_handoff');
	return handoffId && AGENT_LOGIN_HANDOFF_ID.test(handoffId) ? handoffId : null;
}

export function resolveAdminLoginReturnTo(search: string, origin: string): string {
	const parameters = new URLSearchParams(search);
	const value = parameters.get('return_to');
	if (!value) return '/admin';
	try {
		const target = new URL(value, origin);
		if (target.hash) return '/admin';
		if (target.pathname === '/oauth/admin-agent/authorize' && target.origin === origin) {
			return `${target.pathname}${target.search}`;
		}
		if (target.origin !== origin) return '/admin';
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
