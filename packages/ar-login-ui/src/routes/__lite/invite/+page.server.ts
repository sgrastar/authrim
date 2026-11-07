/**
 * `/invite?token=` on a lite tenant: to the invitation's resolution, as the normal Login UI does
 * (`/discover?invite_token=`, which stays on the normal UI and leads to the sign-up page with it),
 * the token passed on as it is (the resolution says what is wrong with it).
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const token = url.searchParams.get('token');
	const target = new URL('/discover', url);
	if (token) target.searchParams.set('invite_token', token);
	redirect(303, `${target.pathname}${target.search}`);
};
