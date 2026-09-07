/**
 * Keep the browser-owned document surface in sync with the Login UI surface.
 * Safari uses the document background and theme-color for the areas outside
 * the page content, including the top and bottom browser chrome on iPhone.
 */
export function syncLoginUIDocumentSurface(): void {
	if (typeof document === 'undefined') return;

	const html = document.documentElement;
	const background = getComputedStyle(html)
		.getPropertyValue('--login-page-background-color')
		.trim();
	if (!background) return;

	html.style.backgroundColor = background;
	html.style.colorScheme = html.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
	if (document.body) {
		document.body.style.backgroundColor = background;
		document.body.style.colorScheme = html.style.colorScheme;
	}

	const themeColor = document.querySelector<HTMLMetaElement>("meta[name='theme-color']");
	if (themeColor) themeColor.content = background;
}
