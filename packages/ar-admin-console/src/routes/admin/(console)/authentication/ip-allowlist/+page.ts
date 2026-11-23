import { redirect } from '@sveltejs/kit';

/**
 * The administrator IP limit used to be listed under Authentication. It limits administrators,
 * not end users' sign-in, so it now sits with the administrators (Settings), and an old link
 * lands there.
 */
export const load = () => {
	redirect(308, '/admin/settings/team-ip-allowlist');
};
