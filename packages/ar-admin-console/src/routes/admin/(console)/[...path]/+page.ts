import { error } from '@sveltejs/kit';
import { resolveNavPath } from '$lib/shell/nav';
import type { PageLoad } from './$types';

/**
 * Every navigation item that has no dedicated route yet lands here. Dedicated routes (added as
 * features are rebuilt) take precedence over this rest parameter automatically.
 */
export const load: PageLoad = ({ url }) => {
	const location = resolveNavPath(url.pathname);
	if (!location) error(404, 'Not found');
	return { location };
};
