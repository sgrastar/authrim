/**
 * The HTML document of a lite page. The shared app.html carries the normal Login UI's first-paint
 * styling (a <style> block, style attributes, a theme-color placeholder and a script slot); the
 * lite pages bring their own stylesheet and run without scripts, so all of it is removed: under
 * the lite CSP only hashed inline elements are allowed, and style attributes never are.
 */
export function liteTransformPageChunk(
	html: string,
	document: { language: string; direction: 'ltr' | 'rtl' }
): string {
	return html
		.replace('__AUTHRIM_DOCUMENT_LANGUAGE__', document.language)
		.replace('__AUTHRIM_DOCUMENT_DIRECTION__', document.direction)
		.replace('__AUTHRIM_THEME_FIRST_PAINT__', '')
		.replace(/<style>[^<]*__AUTHRIM_INITIAL_BACKGROUND__[^<]*<\/style>/u, '')
		.replace(/<meta name="theme-color" content="__AUTHRIM_INITIAL_BACKGROUND__"\s*\/?>/u, '')
		.replace(/\s+style="[^"]*"/gu, '')
		.replace(/\s+data-sveltekit-preload-data="[^"]*"/u, '');
}
