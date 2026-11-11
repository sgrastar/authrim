import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
	return readFileSync(resolve(__dirname, '..', path), 'utf8');
}

function expectPageShellOrder(pageSource: string) {
	const headerIndex = pageSource.indexOf('class="auth-header"');
	const mainIndex = pageSource.indexOf('class="auth-main"');
	const panelIndex = pageSource.indexOf('class="auth-container"');
	const footerIndex = pageSource.search(/<ConfiguredFooter\s+class="auth-page-footer"/);

	expect(headerIndex).toBeGreaterThan(-1);
	expect(panelIndex).toBeGreaterThan(mainIndex);
	expect(headerIndex).toBeGreaterThan(panelIndex);
	expect(footerIndex).toBeGreaterThan(headerIndex);
	expect(pageSource).not.toContain('auth-page-header');
}

const SHELL_PAGES = [
	'routes/(main)/login/+page.svelte',
	'routes/(main)/signup/+page.svelte',
	'routes/(main)/verify-email-code/+page.svelte'
];

/** The custom properties of the rule that starts a line with `selector`. */
function ruleTokens(css: string, selector: string): Record<string, string> {
	const at = css.indexOf(`\n${selector}`);
	if (at < 0) throw new Error(`No rule for ${selector}`);
	const open = css.indexOf('{', at);
	const close = css.indexOf('}', open);
	const result: Record<string, string> = {};
	for (const match of css.slice(open + 1, close).matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
		result[match[1]] = match[2].trim();
	}
	return result;
}

/** The selectors of the rule whose selector list starts at `start`, with Prettier's breaks undone. */
function selectorsAt(css: string, start: number): string[] {
	const list = css.slice(start, css.indexOf('{', start));
	return list
		.replace(/\s+/g, ' ')
		.replace(/\( /g, '(')
		.replace(/ \)/g, ')')
		.split(/,(?![^(]*\))/)
		.map((selector) => selector.trim())
		.filter(Boolean);
}

describe('split page shell', () => {
	it('keeps the header in the auth panel and the full-width footer outside the main area', () => {
		expectPageShellOrder(source('lib/components/AuthPageShell.svelte'));
	});

	it('renders login, signup and verify-email-code through the one shared shell', () => {
		for (const page of SHELL_PAGES) {
			const pageSource = source(page);

			expect(pageSource).toContain(
				"import AuthPageShell from '#lib/components/AuthPageShell.svelte'"
			);
			expect(pageSource).toContain('<AuthPageShell');
			// The shell markup lives in the component; a page that repeats it would drift from it.
			expect(pageSource).not.toContain('class="auth-main"');
			expect(pageSource).not.toContain('class="auth-header"');
			expect(pageSource).not.toContain('<ConfiguredFooter');
			expect(pageSource).not.toContain('<LanguageSwitcher');
		}
	});

	it('anchors bottom theme and language controls above an enabled footer', () => {
		const css = source('app.css');

		expect(source('lib/components/AuthPageShell.svelte')).toContain(
			'class:auth-page--has-footer={loginUIPageStore.footerEnabled}'
		);
		expect(css).toContain('.auth-page--has-footer .auth-main');
		expect(css).toContain(
			"[data-topbar-position='bottom_right'] .auth-page--has-footer .auth-main > .auth-topbar"
		);
		expect(css).toMatch(
			/\[data-topbar-position='bottom_right'\] \.auth-page--has-footer[\s\S]*?position: absolute;/
		);
	});

	it('keeps the language controls inside the shared main shell', () => {
		const shell = source('lib/components/AuthPageShell.svelte');
		const mainStart = shell.indexOf('<div class="auth-main">');
		const externalTopbar = shell.indexOf(
			"loginUIPageStore.topbarPosition !== 'in_card'",
			mainStart
		);
		const containerStart = shell.indexOf('<div class="auth-container"', externalTopbar);

		expect(mainStart).toBeGreaterThan(-1);
		expect(externalTopbar).toBeGreaterThan(mainStart);
		expect(containerStart).toBeGreaterThan(externalTopbar);
	});

	it('uses the same configurable shell on every tenant-resolved continuation screen', () => {
		const shell = source('lib/components/AuthPageShell.svelte');

		for (const pagePath of [
			'routes/(main)/callback/+page.svelte',
			'routes/(main)/ciba/+page.svelte',
			'routes/(main)/consent/+page.svelte',
			'routes/(main)/device/+page.svelte',
			'routes/(main)/error/+page.svelte',
			'routes/(main)/reauth/+page.svelte'
		]) {
			const page = source(pagePath);

			expect(page).toContain("import AuthPageShell from '#lib/components/AuthPageShell.svelte'");
			expect(page).toContain('<AuthPageShell');
			expect(page).not.toContain('<LanguageSwitcher');
			expect(page).not.toContain('<footer class="auth-footer">');
		}
		for (const pagePath of [
			'routes/(main)/logged-out/+page.svelte',
			'routes/(main)/logout-complete/+page.svelte'
		]) {
			expect(source(pagePath)).toContain(
				"import LogoutCompletePage from '#lib/components/LogoutCompletePage.svelte'"
			);
		}
		const logoutComplete = source('lib/components/LogoutCompletePage.svelte');
		expect(logoutComplete).toContain(
			"import AuthPageShell from '#lib/components/AuthPageShell.svelte'"
		);
		expect(logoutComplete).toContain('<AuthPageShell>');
		expect(logoutComplete).not.toContain('<LanguageSwitcher');

		expect(shell).toContain('class:auth-page--has-footer={loginUIPageStore.footerEnabled}');
		expect(shell).toContain('<div class="auth-main">');
		expect(shell).toContain('<aside class="auth-brand-panel"');
		expect(shell).toContain("loginUIPageStore.topbarPosition !== 'in_card'");
		expect(shell).toContain("loginUIPageStore.topbarPosition === 'in_card'");
		expect(shell).toMatch(/<ConfiguredFooter\s+class="auth-page-footer"/);
		expect(shell).toContain('style:--login-page-background-layer');
		expect(shell).toContain('style:--login-panel-background-layer');
	});

	it('uses viewport rows without reserving hidden footer space', () => {
		const css = source('app.css');

		expect(css).toContain('grid-template-rows: minmax(0, 1fr) auto;');
		expect(css).toContain("[data-page-layout='split_panel'] .auth-main");
		expect(css).toContain('height: 100dvh;');
		expect(css).not.toContain("[data-page-layout='split_panel'] .auth-page-header");
		expect(css).toContain("[data-page-layout='split_panel'] .auth-page-footer");
		expect(css).toContain('grid-row: 2;');
	});

	it('extends the split panel surface across the full mobile main region', () => {
		const css = source('app.css');

		expect(css).toMatch(
			/@media \(max-width: 640px\)[\s\S]*?\[data-split-background-mode='shared'\] \.auth-main,[\s\S]*?backdrop-filter: blur\(32px\) saturate\(160%\);/
		);
		expect(css).toMatch(
			/@media \(max-width: 640px\)[\s\S]*?\[data-split-background-mode='shared'\] \.auth-container,[\s\S]*?background: transparent;[\s\S]*?backdrop-filter: none;/
		);
		expect(css).toContain(
			"[data-page-layout='split_panel'][data-has-login-panel-background-image='true']"
		);
	});

	it('insets mobile display controls and keeps short split panels touch-scrollable', () => {
		const css = source('app.css');

		expect(css).toMatch(
			/@media \(max-width: 640px\)[\s\S]*?\.auth-main > \.auth-topbar \{[\s\S]*?max-width: calc\(100% - 24px\);[\s\S]*?margin-inline: max\(12px, env\(safe-area-inset-left\)\)[\s\S]*?max\(12px, env\(safe-area-inset-right\)\);/
		);
		expect(css).toMatch(
			/\[data-page-layout='split_panel'\] \.auth-brand-panel \{[\s\S]*?align-items: safe center;[\s\S]*?overflow-y: auto;[\s\S]*?-webkit-overflow-scrolling: touch;[\s\S]*?touch-action: pan-y;/
		);
		expect(css).toMatch(
			/\[data-page-layout='split_panel'\] \.auth-container \{[\s\S]*?justify-content: safe center;[\s\S]*?overflow-y: auto;[\s\S]*?-webkit-overflow-scrolling: touch;[\s\S]*?touch-action: pan-y;/
		);
	});

	it('removes the card surface for forms in the split auth panel', () => {
		const css = source('app.css');

		expect(css).toContain("[data-page-layout='split_panel'] .auth-container > form > .card");
		expect(css).toContain('background: transparent;');
		expect(css).toContain('box-shadow: none;');
	});

	it('expands only runtime screens configured with a wide canvas', () => {
		const css = source('app.css');

		expect(css).toContain('.auth-container.auth-container--wide > form > .card');
		expect(css).toContain('max-width: 760px;');
		expect(source('lib/components/AuthPageShell.svelte')).toContain(
			'class:auth-container--wide={wide}'
		);
		for (const page of ['routes/(main)/login/+page.svelte', 'routes/(main)/signup/+page.svelte']) {
			expect(source(page)).toContain('wide={runtimeScreenWide}');
		}
	});

	it('keeps the shared email widget available when either email method is enabled', () => {
		for (const page of ['routes/(main)/login/+page.svelte', 'routes/(main)/signup/+page.svelte']) {
			expect(source(page)).toContain('mail_otp_totp: showRuntimeEmailCode || showRuntimeTotp');
		}
	});

	it('uses the shared compact scale for every login theme layout', () => {
		const css = source('app.css');

		expect(css).toContain('--auth-card-padding: 20px;');
		expect(css).toContain('--auth-control-height: 2.75rem;');
		expect(css).toContain('--auth-heading-size: 1.25rem;');
		expect(css).toContain("[data-login-theme='swiss-grid'] .runtime-screen-heading h2");
		expect(css).toContain('font-size: var(--auth-heading-size);');
		expect(css).not.toContain("[data-page-layout='split_panel'] .runtime-auth-button {");
	});

	it("draws Swiss Grid with the Admin console's Swiss Grid tokens", () => {
		const css = source('app.css');
		const admin = readFileSync(
			new URL('../../../ar-admin-console/src/lib/ui/themes/swiss-grid.css', import.meta.url),
			'utf8'
		);
		const adminLight = ruleTokens(admin, "[data-admin-theme='swiss-grid'] {");
		const adminDark = ruleTokens(admin, "[data-admin-theme='swiss-grid'][data-scheme='dark'] {");
		const light = ruleTokens(
			css,
			":is(:root, .login-ui-theme-boundary)[data-login-theme='swiss-grid'] {"
		);
		const dark = ruleTokens(
			css,
			":is(:root, .login-ui-theme-boundary)[data-theme='dark'][data-login-theme='swiss-grid'] {"
		);

		// The colours are the Admin console's: paper, ink, the rule, the status tones, the focus ring.
		const pairs: Array<[string, string]> = [
			['--bg-page', '--bg-page'],
			['--bg-card', '--bg-card'],
			['--bg-subtle', '--bg-subtle'],
			['--bg-input', '--bg-input'],
			['--text-primary', '--text-primary'],
			['--text-secondary', '--text-secondary'],
			['--text-muted', '--text-muted'],
			['--focus-ring', '--focus-ring'],
			['--success', '--success'],
			['--warning', '--warning'],
			['--danger', '--danger'],
			['--success-light', '--success-bg'],
			['--warning-light', '--warning-bg'],
			['--danger-light', '--danger-bg']
		];
		for (const [login, adminKey] of pairs) {
			expect(light[login], `light ${login}`).toBe(adminLight[adminKey]);
		}
		// Dark overrides only what the Admin console's dark overrides (status tints are translucent).
		for (const [login, adminKey] of pairs.filter(([, key]) => adminDark[key] !== undefined)) {
			expect(dark[login], `dark ${login}`).toBe(adminDark[adminKey]);
		}
		// The shape: square, rules in place of shadows, heavy tight headings.
		expect(adminLight['--radius-control']).toBe('0px');
		expect(light['--card-radius']).toBe('0px');
		expect(light['--button-radius']).toBe('0px');
		expect(light['--shadow-sm']).toBe('0 0 0 1px #141412');
		expect(adminLight['--shadow-md']).toBe('0 0 0 1px var(--border-strong)');
		expect(css).toMatch(
			/\[data-login-theme='swiss-grid'\] \.auth-page \.auth-header__title,[\s\S]*?font-weight: 700;[\s\S]*?letter-spacing: -0\.03em;/
		);
		expect(adminLight['--heading-weight']).toBe('700');
		expect(adminLight['--heading-tracking']).toBe('-0.03em');
		// Nothing is translucent, blurred or lifted.
		expect(light['--blur-sm']).toBe('none');
		expect(light['--bg-card']).toBe(light['--bg-page']);
	});

	it('draws Glass as frosted glass: a blurred, translucent pane with a grain and a light rim', () => {
		const css = source('app.css');
		const light = ruleTokens(
			css,
			":is(:root, .login-ui-theme-boundary)[data-login-theme='glass'] {"
		);

		expect(light['--bg-card']).toMatch(/^rgba\(255, 255, 255, 0\.\d+\)$/);
		// Frosted: the page behind is well blurred.
		expect(light['--blur-sm']).toMatch(/^blur\((1[6-9]|2\d|3\d)px\) saturate\(\d+%\)$/);
		expect(light['--card-radius']).toBe('20px');
		expect(light['--glass-grain']).toContain('feTurbulence');
		expect(light['--glass-rim']).toMatch(/^inset 0 1px 0 rgba\(255, 255, 255, 0\.\d+\)$/);
		// The grain is drawn over the card's face; a button has no gloss band and no glow inside it.
		expect(css).toContain("[data-login-theme='glass'] .card::before");
		expect(css).not.toContain("[data-login-theme='glass'] .auth-page .runtime-auth-button::before");
	});

	it('draws Clear glass by its edges: an iridescent rim, glints and a reflection', () => {
		const css = source('app.css');
		const light = ruleTokens(
			css,
			":is(:root, .login-ui-theme-boundary)[data-login-theme='clear-glass'] {"
		);

		// Clear: the page behind stays nearly sharp, and the face is nearly clear.
		expect(light['--blur-sm']).toMatch(/^blur\([0-4]px\) saturate\(\d+%\)$/);
		expect(light['--bg-card']).toMatch(/^rgba\(255, 255, 255, 0\.(0\d|1\d?)\)$/);
		expect(light['--button-radius']).toBe('999px');
		expect(light['--glass-sheen']).toContain('120deg');
		expect(light['--glass-glints']).toContain('radial-gradient');
		expect(light['--glass-iris']).toContain('radial-gradient');
		// The rim is a ring cut out of a filled box, on the card and on the buttons.
		const rim = css.slice(css.indexOf("[data-login-theme='clear-glass'] .card::after,"));
		expect(rim).toMatch(/^[^{]*\.runtime-auth-button::after,[^{]*\.btn::after \{/);
		expect(rim.slice(0, rim.indexOf('}'))).toMatch(/content-box exclude/);
		// A form on the page itself is no pane, so it has no rim either.
		expect(css).toContain(
			"[data-login-theme='clear-glass'][data-login-template='minimal'] .card::after"
		);
	});

	it('lets the form area colour set the density of the glass panes over a page picture', () => {
		const css = source('app.css');
		// The small panes of the page's own text, and the card of a minimal form, over a picture.
		const panes = css.indexOf('\t.auth-bottom-link:not(.auth-bottom-link--in-card)\n\t) {');
		expect(panes).toBeGreaterThan(0);
		expect(css.slice(panes, css.indexOf('}', panes))).toContain(
			'background: var(--login-form-area-color, var(--bg-card));'
		);
		const minimal = css.indexOf(
			"[data-has-page-background-image='true'][data-login-template='minimal']"
		);
		expect(minimal).toBeGreaterThan(0);
		expect(css.slice(minimal, css.indexOf('}', minimal))).toContain(
			'background: var(--login-form-area-color, var(--bg-card));'
		);
	});

	it('makes both glasses opaque without the blur in the split card, and leaves a page picture alone', () => {
		const css = source('app.css');
		// Over the page's own picture the glass stays as the palette draws it (as the admin console's
		// preview shows it); only the split card, which floats over the brand panel, is protected.
		expect(css).not.toContain("[data-login-theme='glass'][data-has-page-background-image='true'],");
		const lightProtection =
			"\n[data-login-theme='glass'][data-page-layout='split_panel'][data-form-frame='card']:not(";
		const darkProtection =
			"\n[data-theme='dark'][data-login-theme='glass'][data-page-layout='split_panel'][data-form-frame='card'],";
		const light = selectorsAt(css, css.indexOf(lightProtection) + 1);
		const dark = selectorsAt(css, css.indexOf(darkProtection) + 1);
		// The split card floats over the tenant's brand panel in either scheme.
		expect(light).toContain(
			"[data-login-theme='clear-glass'][data-page-layout='split_panel'][data-form-frame='card']:not([data-theme='dark'])"
		);
		expect(dark).toContain(
			"[data-theme='dark'][data-login-theme='clear-glass'][data-page-layout='split_panel'][data-form-frame='card']"
		);

		const fallbacks = [
			'@media (prefers-reduced-transparency: reduce) {',
			'@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {'
		].map((opening) => {
			const glassAt = css.indexOf(
				"\n\t:is(:root, .login-ui-theme-boundary):is(\n\t\t[data-login-theme='glass']",
				css.lastIndexOf(opening)
			);
			expect(glassAt).toBeGreaterThan(0);
			const lightFallback = selectorsAt(css, glassAt + 1);
			const darkFallback = selectorsAt(css, css.indexOf('}', glassAt) + 1);
			return { glassAt, lightFallback, darkFallback };
		});
		for (const { glassAt, lightFallback, darkFallback } of fallbacks) {
			const lightBody = css.slice(css.indexOf('{', glassAt), css.indexOf('}', glassAt));
			expect(lightBody).toContain('--bg-card: #f3f4f7;');
			expect(lightBody).toContain('--glass-sheen: linear-gradient(transparent, transparent);');
			// Each protection more specific than the palette's own rule is repeated in the fallback
			// (which comes later), so that the fallback still wins there.
			for (const selector of light.filter((s) => s.includes('split_panel'))) {
				expect(lightFallback).toContain(selector);
			}
			for (const selector of dark.filter((s) => s.includes('split_panel'))) {
				expect(darkFallback).toContain(selector);
			}
		}
		// Reduced transparency takes the blur away in both schemes: the dark scheme sets its own blur
		// more specifically than the light fallback.
		const [reducedFallback] = fallbacks;
		const darkAt = css.indexOf('}', reducedFallback.glassAt) + 1;
		for (const at of [reducedFallback.glassAt, darkAt]) {
			expect(css.slice(css.indexOf('{', at), css.indexOf('}', at))).toContain('--blur-sm: none;');
		}
		// The page text's own panes over a picture lose their blur too.
		const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-transparency: reduce) {'));
		expect(reduced.slice(0, reduced.indexOf('@supports'))).toMatch(
			/:is\(\s*\.auth-header,\s*\.auth-footer:not\(\.auth-bar\),\s*\.auth-bottom-link:not\(\.auth-bottom-link--in-card\)\s*\) \{\s*backdrop-filter: none;/
		);
	});

	it('draws the glass fields’ keyboard focus ring over the rule that clears a pointer focus', () => {
		const all = source('app.css');
		const css = all.slice(all.indexOf('/* === Glass (login-ui.palette = glass, clear-glass) ==='));
		const pointer = css.indexOf('\tinput:focus,');
		const ring = css.indexOf('outline: 2px solid var(--primary);');
		expect(pointer).toBeGreaterThan(0);
		// It comes after the pointer-focus rule, which is as specific.
		expect(ring).toBeGreaterThan(pointer);
		const selectors = selectorsAt(css, css.lastIndexOf('}', ring) + 1);
		expect(selectors).toContain(
			":is([data-login-theme='glass'], [data-login-theme='clear-glass']) .auth-page .runtime-screen-field input:focus-visible"
		);
		expect(selectors).toContain(
			":is([data-login-theme='glass'], [data-login-theme='clear-glass']) .auth-page .runtime-screen-field select:focus-visible"
		);
	});

	it('keeps the reflection from behind a tenant accent’s label on Clear glass', () => {
		const css = source('app.css');
		const at = css.indexOf("\n[data-login-theme='clear-glass'][data-has-accent-color='true']") + 1;
		expect(at).toBeGreaterThan(0);
		// On the boundary (the document, the layout, a story's frame) or on the page shell itself.
		expect(selectorsAt(css, at)).toEqual([
			"[data-login-theme='clear-glass'][data-has-accent-color='true'] .auth-page :is(.runtime-auth-button:not(.secondary), .btn-primary)",
			"[data-login-theme='clear-glass'] .auth-page[data-has-accent-color='true'] .runtime-auth-button:not(.secondary)",
			"[data-login-theme='clear-glass'] .auth-page[data-has-accent-color='true'] .btn-primary"
		]);
		expect(css.slice(css.indexOf('{', at), css.indexOf('}', at))).toMatch(
			// The shared Button paints its hover from the surface, so both drop the reflection.
			/^\{\s*--button-primary-surface: var\(--glass-glints\), var\(--button-primary-bg\);\s*background: var\(--glass-glints\), var\(--button-primary-bg\);\s*$/
		);
		for (const file of [
			'lib/components/AuthPageShell.svelte',
			'routes/(main)/+layout.svelte',
			'lib/storybook/LoginUIFrame.svelte'
		]) {
			expect(source(file)).toContain(
				"data-has-accent-color={loginUIPageStore.accentColor ? 'true' : 'false'}"
			);
		}
	});

	it('keeps a tenant accent’s lightness when its glass button is hovered or pressed', () => {
		const css = source('app.css');
		const at =
			css.indexOf(
				"\n[data-has-accent-color='true']:is([data-login-theme='glass'], [data-login-theme='clear-glass'])"
			) + 1;
		expect(at).toBeGreaterThan(0);
		expect(selectorsAt(css, at)).toEqual([
			"[data-has-accent-color='true']:is([data-login-theme='glass'], [data-login-theme='clear-glass']) .auth-page :is(.runtime-auth-button:not(.secondary), .btn-primary):not(:disabled):is(:hover, :active)",
			":is([data-login-theme='glass'], [data-login-theme='clear-glass']) .auth-page[data-has-accent-color='true'] :is(.runtime-auth-button:not(.secondary), .btn-primary):not(:disabled):is(:hover, :active)"
		]);
		expect(css.slice(css.indexOf('{', at), css.indexOf('}', at))).toMatch(
			/^\{\s*filter: none;\s*$/
		);
		// It comes after the rules that brighten and darken the buttons.
		expect(css.indexOf('filter: brightness(0.97);')).toBeLessThan(at);
	});

	it('shapes the shared Button by the palette’s button radius; the scrolling split side has no rim', () => {
		const css = source('app.css');
		expect(css).toMatch(
			/:is\(\[data-login-theme='glass'\], \[data-login-theme='clear-glass'\]\) \.auth-page \.btn \{\s*border-radius: var\(--button-radius\);/
		);
		// A rim drawn inside the scrolling form side would scroll with the form.
		expect(css).not.toMatch(/\.auth-container::after/);
	});

	it('moves the shared Button on hover as the sign-in buttons: no lift, no deep shadow', () => {
		const css = source('app.css');
		// Button.svelte lifts the button 2px with a deep shadow and outlines a secondary one in the
		// accent; the glasses take those back, before the press rule that moves it down.
		const frosted = css.indexOf(
			"\n[data-login-theme='glass'] .auth-page .btn:not(:disabled):hover {"
		);
		const clear = css.indexOf(
			"\n[data-login-theme='clear-glass'] .auth-page .btn:not(:disabled):hover {"
		);
		const press = css.indexOf('filter: brightness(0.97);');
		for (const at of [frosted, clear]) {
			expect(at).toBeGreaterThan(0);
			expect(at).toBeLessThan(press);
			expect(css.slice(at, css.indexOf('}', at))).toContain('transform: none;');
		}
		expect(css.slice(frosted, css.indexOf('}', frosted))).toContain(
			'box-shadow: var(--glass-drop), var(--glass-rim);'
		);
		expect(css).toMatch(
			/\[data-login-theme='glass'\] \.auth-page \.btn-secondary:not\(:disabled\):hover \{\s*border-color: var\(--button-secondary-border\);/
		);
		// Clear glass keeps its reflection on hover: Button.svelte paints the hover from the surface.
		expect(css).toContain(
			'--button-primary-surface: var(--glass-glints), var(--glass-sheen), var(--button-primary-bg);'
		);
	});

	it('makes both glasses’ small parts glass: alerts, badges, switches and sunken fields', () => {
		// Prettier breaks long selector lists over lines: compared with the breaks undone.
		const css = source('app.css').replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')');
		const B =
			":is(:root, .login-ui-theme-boundary):is([data-login-theme='glass'], [data-login-theme='clear-glass'])";
		// These outweigh the components' scoped rules (a class and the scope): a boundary, the theme
		// and the class.
		for (const selector of [
			`${B} .alert {`,
			`${B} .alert::after {`,
			`${B} .toggle-switch {`,
			`${B} .toggle-switch-thumb {`
		]) {
			expect(css).toContain(` ${selector}`);
		}
		// A badge's rule names its status class too: StatusBadge's `.status-badge.<status>` is as
		// specific as a boundary, the theme and one class, and its shorthand would clear the gloss.
		expect(css).toMatch(
			/ :is\(:root, \.login-ui-theme-boundary\):is\(\[data-login-theme='glass'\], \[data-login-theme='clear-glass'\]\)\s+\.status-badge:is\(\.active, \.inactive, \.success, \.warning, \.danger, \.info, \.neutral\) \{\s*border: 1px solid var\(--glass-edge-light\);/
		);
		// An on switch takes the palette's tint, which the contrast test knows, not a tenant's accent.
		const on = css.indexOf('.toggle-switch.toggle-switch-checked {');
		expect(css.slice(on, css.indexOf('}', on))).toMatch(/background: var\(--glass-primary-bg\);/);
		// Without the glass (reduced transparency, no backdrop-filter) the small parts are opaque.
		for (const opening of [
			'@media (prefers-reduced-transparency: reduce) {',
			'@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {'
		]) {
			const block = css.slice(css.lastIndexOf(opening));
			for (const token of [
				'--glass-alert-sheen: linear-gradient(transparent, transparent);',
				'--glass-gloss: linear-gradient(transparent, transparent);',
				'--glass-toggle-track: #e6e9ee;',
				'--glass-toggle-track: #2a2d34;'
			]) {
				expect(block).toContain(token);
			}
		}
		// An alert's outline is no longer its tone in full; a ring of light takes it.
		const alert = css.slice(css.indexOf(` ${B} .alert {`));
		expect(alert.slice(0, alert.indexOf('}'))).toContain('border-color: transparent;');
		// The switch and its thumb keep the 3:1 hairline (theme-contrast.test.ts checks its colour).
		for (const part of ['.toggle-switch {', '.toggle-switch-thumb {']) {
			const at = css.indexOf(` ${B} ${part}`);
			expect(css.slice(at, css.indexOf('}', at))).toContain('var(--glass-line)');
		}
		// The shared Input is sunk like the sign-in fields; one in error keeps its red outline.
		expect(css).toMatch(
			/:is\(\[data-login-theme='glass'\], \[data-login-theme='clear-glass'\]\)\s+\.auth-page\s+:is\(\.form-input, \.form-select\):not\(\.has-error\) \{/
		);
		expect(css).toMatch(/:is\(\.form-input, \.form-select\):focus-visible/);
	});

	it('gives Clear glass secondary buttons a thinner rim of light alone', () => {
		const css = source('app.css');
		const light = ruleTokens(
			css,
			":is(:root, .login-ui-theme-boundary)[data-login-theme='clear-glass'] {"
		);
		expect(light['--glass-iris-soft']).not.toMatch(/hsl\(220/);
		expect(css).toMatch(
			/\[data-login-theme='clear-glass'\]\s+\.auth-page\s+:is\(\.runtime-auth-button\.secondary, \.btn-secondary\)::after \{\s*padding: 1px;\s*background: var\(--glass-iris-soft\);/
		);
	});

	it('scrolls the split form side rather than shrinking the form inside it', () => {
		const css = source('app.css');
		// A card is overflow: hidden, so a shrunk one clipped its own last buttons.
		expect(css).toMatch(
			/\[data-page-layout='split_panel'\] \.auth-container > \* \{\s*position: relative;\s*z-index: 1;\s*flex-shrink: 0;/
		);
	});

	it('puts the split template\u2019s switches below the card in the form column, not over its foot', () => {
		const shell = source('lib/components/AuthPageShell.svelte');
		expect(shell).toMatch(
			/topbarPosition === 'below_card' &&\s*loginUIPageStore\.layout === 'split_panel'/
		);
		const css = source('app.css');
		// The switches no longer share the form column's grid cell, laid over its last lines.
		expect(css).not.toContain(
			"[data-page-layout='split_panel'][data-topbar-position='below_card'] .auth-main > .auth-topbar"
		);
		expect(css).toContain(
			"[data-page-layout='split_panel'][data-topbar-position='below_card'] .auth-container > .auth-topbar {"
		);
	});

	it('draws no decorative icon circles on the pages', () => {
		const roots = ['lib/views', 'lib/components', 'routes'];
		const files = roots.flatMap((root) =>
			(readdirSync(resolve(__dirname, '..', root), { recursive: true }) as string[])
				.filter((file) => file.endsWith('.svelte') && !file.includes('.stories.'))
				.map((file) => `${root}/${file}`)
		);
		expect(files.length).toBeGreaterThan(20);
		for (const file of files) {
			expect(source(file), file).not.toContain('auth-icon-badge');
		}
		expect(source('app.css')).not.toContain('.auth-icon-badge');
	});

	it('keeps split brand copy readable independently from light form colors', () => {
		const css = source('app.css');

		expect(css).toContain('--brand-panel-title-color: #f4f7ff;');
		expect(css).toContain('--brand-panel-copy-color: #c7d2eb;');
		expect(css).toContain(
			'color: var(--brand-panel-title-color, var(--login-title-color, var(--text-primary)));'
		);
		expect(css).toContain(
			'color: var(--brand-panel-copy-color, var(--login-copy-color, var(--text-secondary)));'
		);
	});

	it('keeps authentication actions on one line at narrow mobile widths', () => {
		const appCss = source('app.css');
		const runtimeScreen = source('lib/components/RuntimeScreen.svelte');

		expect(appCss).toContain('-webkit-text-size-adjust: 100%;');
		expect(appCss).toMatch(
			/@media \(max-width: 640px\)[\s\S]*?\.auth-container \{\s*max-width: 100%;/
		);
		expect(runtimeScreen).toContain('white-space: nowrap;');
		expect(runtimeScreen).toMatch(
			/@media \(max-width: 400px\)[\s\S]*?font-size: clamp\(0\.75rem, 3\.8vw, 0\.875rem\);/
		);
		expect(runtimeScreen).toMatch(
			/@media \(max-width: 400px\)[\s\S]*?\.runtime-code-actions \{\s*grid-template-columns: minmax\(0, 1fr\);/
		);
	});

	it('shows one generic accepted status on the email-code screen without branching on identity', () => {
		const page = source('routes/(main)/verify-email-code/+page.svelte');
		const view = source('lib/views/VerifyEmailCodeView.svelte');

		expect(page).toContain('<VerifyEmailCodeView');
		expect(view).toContain('role="status" aria-live="polite"');
		expect(view).toContain('$LL.emailCode_subtitle()');
		for (const each of [page, view]) {
			expect(each).not.toMatch(/userExists|accountExists|emailExists/);
		}
	});

	it('announces email-code send progress on both login and signup', () => {
		for (const [pagePath, viewPath] of [
			['routes/(main)/login/+page.svelte', 'lib/views/LoginView.svelte'],
			['routes/(main)/signup/+page.svelte', 'lib/views/SignupView.svelte']
		]) {
			const page = source(pagePath);
			const view = source(viewPath);

			expect(page).toContain('const emailCodeProgressMessage');
			expect(page).toContain('emailCodeProgress: emailCodeProgressMessage');
			expect(view).toMatch(
				/\{#if alerts\.emailCodeProgress\}\s*<div class="auth-progress mb-4" role="status" aria-live="polite">/
			);
		}
	});
});
