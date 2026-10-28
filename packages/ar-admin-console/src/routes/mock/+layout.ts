import { error } from '@sveltejs/kit';
import type { LayoutLoad } from './$types';

// The whole-console mock (src/lib/mock) is a dev-server tool with no API behind it: it runs in
// the browser only and answers 404 anywhere else.
export const ssr = false;
export const prerender = false;

export const load: LayoutLoad = () => {
	if (!import.meta.env.DEV) error(404, 'Not found');
};
