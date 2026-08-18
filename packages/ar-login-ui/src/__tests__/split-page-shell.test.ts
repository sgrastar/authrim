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
	const footerIndex = pageSource.indexOf('<ConfiguredFooter class="auth-page-footer" />');

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
		expectPageShellOrder(source('routes/verify-email-code/+page.svelte'));
	});

	it('anchors bottom theme and language controls above an enabled footer', () => {
		const css = source('app.css');

		for (const page of [
			'routes/login/+page.svelte',
			'routes/signup/+page.svelte',
			'routes/verify-email-code/+page.svelte'
		]) {
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

	it('keeps the language controls inside the shared main shell on every primary auth page', () => {
		for (const pagePath of [
			'routes/login/+page.svelte',
			'routes/signup/+page.svelte',
			'routes/verify-email-code/+page.svelte'
		]) {
			const page = source(pagePath);
			const mainStart = page.indexOf('<div class="auth-main">');
			const externalTopbar = page.indexOf(
				"loginUIPageStore.topbarPosition !== 'in_card'",
				mainStart
			);
			const containerStart = page.indexOf('<div class="auth-container"', externalTopbar);

			expect(mainStart).toBeGreaterThan(-1);
			expect(externalTopbar).toBeGreaterThan(mainStart);
			expect(containerStart).toBeGreaterThan(externalTopbar);
		}
	});

	it('uses the same configurable shell on every tenant-resolved continuation screen', () => {
		const shell = source('lib/components/AuthPageShell.svelte');

		for (const pagePath of [
			'routes/callback/+page.svelte',
			'routes/ciba/+page.svelte',
			'routes/consent/+page.svelte',
			'routes/device/+page.svelte',
			'routes/error/+page.svelte',
			'routes/reauth/+page.svelte'
		]) {
			const page = source(pagePath);

			expect(page).toContain("import AuthPageShell from '$lib/components/AuthPageShell.svelte'");
			expect(page).toContain('<AuthPageShell');
			expect(page).not.toContain('<LanguageSwitcher');
			expect(page).not.toContain('<footer class="auth-footer">');
		}
		for (const pagePath of [
			'routes/logged-out/+page.svelte',
			'routes/logout-complete/+page.svelte'
		]) {
			expect(source(pagePath)).toContain(
				"import LogoutCompletePage from '$lib/components/LogoutCompletePage.svelte'"
			);
		}
		const logoutComplete = source('lib/components/LogoutCompletePage.svelte');
		expect(logoutComplete).toContain(
			"import AuthPageShell from '$lib/components/AuthPageShell.svelte'"
		);
		expect(logoutComplete).toContain('<AuthPageShell>');
		expect(logoutComplete).not.toContain('<LanguageSwitcher');

		expect(shell).toContain('class:auth-page--has-footer={loginUIPageStore.footerEnabled}');
		expect(shell).toContain('<div class="auth-main">');
		expect(shell).toContain('<aside class="auth-brand-panel"');
		expect(shell).toContain("loginUIPageStore.topbarPosition !== 'in_card'");
		expect(shell).toContain("loginUIPageStore.topbarPosition === 'in_card'");
		expect(shell).toContain('<ConfiguredFooter class="auth-page-footer" />');
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
			"[data-split-background-mode='panel'][data-has-login-panel-background-image='true']"
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

	it('shows one generic accepted status on the email-code screen without branching on identity', () => {
		const page = source('routes/verify-email-code/+page.svelte');

		expect(page).toContain('role="status" aria-live="polite"');
		expect(page).toContain('$LL.emailCode_subtitle()');
		expect(page).not.toMatch(/userExists|accountExists|emailExists/);
	});

	it('announces email-code send progress on both login and signup', () => {
		for (const pagePath of ['routes/login/+page.svelte', 'routes/signup/+page.svelte']) {
			const page = source(pagePath);

			expect(page).toContain('const emailCodeProgressMessage');
			expect(page).toContain('{#if emailCodeProgressMessage}');
			expect(page).toContain('role="status" aria-live="polite"');
		}
	});
});
