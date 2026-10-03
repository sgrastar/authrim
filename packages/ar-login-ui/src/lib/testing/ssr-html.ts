/**
 * SSR test helpers. Svelte's server render marks hydration points with HTML comments, which split
 * text from the surrounding tags; tests compare the markup without them.
 */

/** The markup without HTML comments (scanned, so nested or overlapping markers cannot survive). */
export function withoutHtmlComments(html: string): string {
	let out = '';
	let index = 0;
	for (;;) {
		const start = html.indexOf('<!--', index);
		if (start < 0) return out + html.slice(index);
		out += html.slice(index, start);
		const end = html.indexOf('-->', start + 4);
		if (end < 0) return out;
		index = end + 3;
	}
}

/** For `body.replace(HYDRATION_MARKERS, '')`: removes every hydration comment. */
export const HYDRATION_MARKERS = {
	[Symbol.replace](html: string): string {
		return withoutHtmlComments(html);
	}
};
