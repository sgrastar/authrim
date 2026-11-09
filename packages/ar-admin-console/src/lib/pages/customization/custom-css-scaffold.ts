/** Editable examples for the actual Login UI elements. Empty blocks are editor guidance only. */
export const CUSTOM_CSS_SCAFFOLD = `/* Page */
.auth-page {}

/* Header */
.auth-page .auth-bar--header {}
.auth-bar__brand {}
.auth-page .auth-bar__title {}
.auth-page .auth-bar__subtitle {}

/* Form */
.auth-container {}
.auth-page .card {}
.auth-page .auth-section-title {}
.auth-page .input {}

/* Buttons */
.auth-page .btn-primary {}
.auth-page .btn-secondary {}

/* Split brand area */
.auth-brand-panel {}
.auth-brand-panel__content {}

/* Controls */
.auth-page .theme-toggle {}
.auth-page .auth-lang-select {}

/* Footer */
.auth-page .auth-bar--footer {}
.auth-footer__links {}`;

const SECTION_COMMENTS = CUSTOM_CSS_SCAFFOLD.match(/^\/\* .* \*\/$/gm) ?? [];
const EMPTY_SELECTORS = CUSTOM_CSS_SCAFFOLD.match(/^.+(?= \{\})/gm) ?? [];

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Existing rules appear first, so declarations added to the scaffold can override them. */
export function cssForEditor(customCss: string): string {
	return customCss.trim() ? `${customCss}\n\n${CUSTOM_CSS_SCAFFOLD}` : CUSTOM_CSS_SCAFFOLD;
}

/** Keep only rules with declarations for the API's strict custom CSS validator. */
export function cssFromEditor(editorCss: string): string {
	let css = editorCss;
	for (const comment of SECTION_COMMENTS) {
		css = css.replaceAll(comment, '');
	}
	for (const selector of EMPTY_SELECTORS) {
		css = css.replace(new RegExp(`^\\s*${escapeRegExp(selector)}\\s*\\{\\s*\\}\\s*$`, 'gm'), '');
	}
	return css.replace(/\n{3,}/g, '\n\n').trim();
}
