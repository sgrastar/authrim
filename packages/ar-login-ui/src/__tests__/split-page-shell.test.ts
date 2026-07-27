import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
	return readFileSync(resolve(__dirname, '..', path), 'utf8');
}

function expectPageShellOrder(pageSource: string) {
	const headerIndex = pageSource.indexOf('class="auth-header"');
	const mainIndex = pageSource.indexOf('class="auth-main"');
	const panelIndex = pageSource.indexOf('class="auth-container"');
	const footerIndex = pageSource.indexOf('class="auth-footer auth-page-footer"');

	expect(headerIndex).toBeGreaterThan(-1);
	expect(panelIndex).toBeGreaterThan(mainIndex);
	expect(headerIndex).toBeGreaterThan(panelIndex);
	expect(footerIndex).toBeGreaterThan(headerIndex);
	expect(pageSource).not.toContain('auth-page-header');
}

describe('split page shell', () => {
	it('keeps the header in the auth panel and the full-width footer outside the main area', () => {
		expectPageShellOrder(source('routes/login/+page.svelte'));
		expectPageShellOrder(source('routes/signup/+page.svelte'));
	});

	it('anchors bottom theme and language controls above an enabled footer', () => {
		const css = source('app.css');

		for (const page of ['routes/login/+page.svelte', 'routes/signup/+page.svelte']) {
			expect(source(page)).toContain(
				'class:auth-page--has-footer={loginUIPageStore.footerEnabled}'
			);
		}
		expect(css).toContain('.auth-page--has-footer .auth-main');
		expect(css).toContain(
			"[data-topbar-position='bottom_right'] .auth-page--has-footer .auth-main > .auth-topbar"
		);
		expect(css).toMatch(
			/\[data-topbar-position='bottom_right'\] \.auth-page--has-footer[\s\S]*?position: absolute;/
		);
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
			"[data-split-background-mode='panel'][data-has-login-panel-background-image='true']"
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
		expect(source('routes/login/+page.svelte')).toContain(
			'class:auth-container--wide={runtimeScreenWide}'
		);
		expect(source('routes/signup/+page.svelte')).toContain(
			'class:auth-container--wide={runtimeScreenWide}'
		);
	});

	it('keeps the shared email widget available when either email method is enabled', () => {
		for (const page of ['routes/login/+page.svelte', 'routes/signup/+page.svelte']) {
			expect(source(page)).toContain('mail_otp_totp: showRuntimeEmailCode || showRuntimeTotp');
		}
	});

	it('uses the shared compact scale for every login theme layout', () => {
		const css = source('app.css');

		expect(css).toContain('--auth-card-padding: 20px;');
		expect(css).toContain('--auth-control-height: 2.75rem;');
		expect(css).toContain('--auth-heading-size: 1.25rem;');
		expect(css).toContain("[data-login-theme='fullbleed-glass'] .runtime-screen-heading h2");
		expect(css).toContain('font-size: var(--auth-heading-size);');
		expect(css).not.toContain("[data-page-layout='split_panel'] .runtime-auth-button {");
	});

	it('keeps fullbleed glass translucent while protecting text placed over imagery', () => {
		const css = source('app.css');

		expect(css).toContain('--bg-card: rgba(14, 10, 9, 0.45);');
		expect(css).toContain('--bg-card: rgba(255, 253, 250, 0.5);');
		expect(css).toContain('--primary: var(--login-accent-color, #e8623f);');
		expect(css).toContain('--primary: var(--login-accent-color, #c93a22);');
		expect(css).toContain('--button-primary-bg: var(--primary);');
		expect(css).toContain("[data-login-theme='fullbleed-glass'] .auth-page .auth-header__title");
		expect(css).toMatch(
			/\[data-login-theme='fullbleed-glass'\] \.auth-page \.auth-header__title \{[\s\S]*?font-size: 2em;[\s\S]*?font-weight: 300;[\s\S]*?letter-spacing: 0\.5em;[\s\S]*?text-indent: 0\.5em;/
		);
		expect(css).toContain("[data-login-theme='fullbleed-glass'] .auth-page .auth-header__subtitle");
		expect(css).toContain("[data-login-theme='fullbleed-glass'] .auth-page .auth-bottom-link");
		expect(css).toContain('rgba(10, 7, 6, 0.58)');
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
});
