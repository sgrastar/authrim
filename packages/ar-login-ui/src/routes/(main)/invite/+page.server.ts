import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	const target = new URL('/discover', url);
	if (token) {
		target.searchParams.set('invite_token', token);
	}

	throw redirect(303, `${target.pathname}${target.search}`);
};
